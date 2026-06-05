// File transcription: decode an audio file via symphonia, resample to
// 16 kHz mono f32, then run it through the Whisper pipeline a chunk at
// a time, emitting NDJSON events to the caller's writer.
//
// The event shape matches the protocol used by the GNOME-side driver
// (see tools/transcribe-file.js and fileTranscribe.js): loading →
// ready → progress/partial (interleaved) → final → done. Any error
// path emits an error event and also returns Err so CLI callers can
// map it to an exit status.
//
// Symphonia handles WAV, FLAC, MP3, AAC (M4A), and Ogg-Opus (matching
// what our own audio_writer emits) out of the box when built with
// `features = ["all"]`. Anything else yields an Unsupported error.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::Write;
use std::path::Path;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use crate::WhisperModel;

/// Target sample rate for Whisper.
const TARGET_SAMPLE_RATE: u32 = 16_000;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum FileTranscribeEvent {
    /// Model is loading.
    Loading,
    /// Model is loaded, audio duration is known.
    Ready { duration_secs: f64 },
    /// Progress tick: seconds of audio decoded so far, total duration,
    /// running count of finalized chunks.
    Progress {
        pos: f64,
        dur: f64,
        finals_count: usize,
    },
    /// Streaming partial preview of the current chunk. Emitted when
    /// `emit_partials` is true.
    Partial { text: String },
    /// A chunk of the audio has been committed to the final transcript.
    Final { text: String },
    /// Terminal event: full transcription complete.
    Done {
        raw_text: String,
        finals_count: usize,
    },
    /// Terminal error event.
    Error { message: String },
}

/// Options for [`transcribe_file`].
#[derive(Clone, Debug)]
pub struct FileTranscribeOptions {
    /// How often to emit partial/progress events (in seconds of
    /// decoded audio). Defaults to 5.0.
    pub chunk_seconds: f64,
    /// Whether to emit streaming partial previews. Defaults to true.
    pub emit_partials: bool,
}

impl Default for FileTranscribeOptions {
    fn default() -> Self {
        Self {
            chunk_seconds: 5.0,
            emit_partials: true,
        }
    }
}

/// Summary returned by [`transcribe_file`] for the CLI caller to
/// consume. The full transcription text is in `raw_text`.
#[derive(Clone, Debug)]
pub struct TranscriptionSummary {
    pub raw_text: String,
    pub finals_count: usize,
    pub duration_secs: f64,
}

/// Decode `audio_path`, run it through the Whisper model at
/// `model_path`, and emit one NDJSON `FileTranscribeEvent` per line to
/// `events`. Returns a [`TranscriptionSummary`] on success.
///
/// On error, emits a trailing [`FileTranscribeEvent::Error`] event and
/// returns `Err`.
pub fn transcribe_file(
    audio_path: &Path,
    model_path: &Path,
    opts: &FileTranscribeOptions,
    events: &mut impl Write,
) -> Result<TranscriptionSummary> {
    match transcribe_file_inner(audio_path, model_path, opts, events) {
        Ok(summary) => Ok(summary),
        Err(e) => {
            // Best-effort emit of the error event; don't shadow the
            // original error if the writer itself is broken.
            let _ = emit_event(
                events,
                &FileTranscribeEvent::Error {
                    message: format!("{e:#}"),
                },
            );
            Err(e)
        }
    }
}

fn transcribe_file_inner(
    audio_path: &Path,
    model_path: &Path,
    opts: &FileTranscribeOptions,
    events: &mut impl Write,
) -> Result<TranscriptionSummary> {
    emit_event(events, &FileTranscribeEvent::Loading)?;

    // Decode the entire file into a single 16 kHz mono f32 buffer
    // first. Long (multi-minute) files still fit comfortably in
    // memory at this sample rate (~1.9 MB/minute), and decoding
    // up-front keeps the chunking logic simple.
    let (pcm, duration_secs) = decode_to_mono_16k(audio_path)
        .with_context(|| format!("failed to decode audio file {}", audio_path.display()))?;

    let mut model = WhisperModel::load(
        model_path
            .to_str()
            .ok_or_else(|| anyhow!("model path is not valid utf-8"))?,
    )
    .context("failed to load whisper model")?;

    emit_event(
        events,
        &FileTranscribeEvent::Ready { duration_secs },
    )?;

    let chunk_secs = opts.chunk_seconds.max(0.25);
    let chunk_samples = (chunk_secs * TARGET_SAMPLE_RATE as f64).round() as usize;
    let chunk_samples = chunk_samples.max(TARGET_SAMPLE_RATE as usize / 4);

    let total_samples = pcm.len();
    let mut pos_samples: usize = 0;
    let mut finals: Vec<String> = Vec::new();

    while pos_samples < total_samples {
        let end = (pos_samples + chunk_samples).min(total_samples);
        let chunk = &pcm[pos_samples..end];
        pos_samples = end;

        // Partial preview before finalizing the chunk. We decode the
        // chunk once for partial (if enabled) and again for final; the
        // alternative — decoding only once and labeling the output
        // both partial and final — loses the streaming UX since no
        // partial would ever appear before its matching final.
        if opts.emit_partials {
            let partial_text = model
                .transcribe(chunk)
                .context("whisper transcribe (partial) failed")?;
            if !partial_text.trim().is_empty() {
                emit_event(
                    events,
                    &FileTranscribeEvent::Partial {
                        text: partial_text.clone(),
                    },
                )?;
            }
        }

        // Finalize the chunk.
        let final_text = model
            .transcribe(chunk)
            .context("whisper transcribe (final) failed")?;
        let trimmed = final_text.trim();
        if !trimmed.is_empty() {
            finals.push(trimmed.to_string());
            emit_event(
                events,
                &FileTranscribeEvent::Final {
                    text: trimmed.to_string(),
                },
            )?;
        }

        let pos_secs = pos_samples as f64 / TARGET_SAMPLE_RATE as f64;
        emit_event(
            events,
            &FileTranscribeEvent::Progress {
                pos: pos_secs,
                dur: duration_secs,
                finals_count: finals.len(),
            },
        )?;
    }

    let raw_text = finals.join(" ").trim().to_string();
    emit_event(
        events,
        &FileTranscribeEvent::Done {
            raw_text: raw_text.clone(),
            finals_count: finals.len(),
        },
    )?;

    Ok(TranscriptionSummary {
        raw_text,
        finals_count: finals.len(),
        duration_secs,
    })
}

fn emit_event(w: &mut impl Write, event: &FileTranscribeEvent) -> Result<()> {
    let json = serde_json::to_string(event).context("serialize event")?;
    writeln!(w, "{json}").context("write event")?;
    // Best-effort flush; we want the caller (subprocess driver) to see
    // events promptly so progress UIs stay responsive.
    let _ = w.flush();
    Ok(())
}

// ─── Decoding ────────────────────────────────────────────────────────

/// Decode `path` into a 16 kHz mono f32 PCM buffer. Returns the
/// samples and the audio duration in seconds.
fn decode_to_mono_16k(path: &Path) -> Result<(Vec<f32>, f64)> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let fmt_opts = FormatOptions {
        enable_gapless: true,
        ..Default::default()
    };
    let meta_opts = MetadataOptions::default();

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &fmt_opts, &meta_opts)
        .map_err(|e| match e {
            SymphoniaError::Unsupported(msg) => {
                anyhow!("unsupported audio format: {msg}")
            }
            other => anyhow!(other).context("probe format"),
        })?;

    let mut format = probed.format;
    let track = format
        .default_track()
        .ok_or_else(|| anyhow!("no default audio track in file"))?;
    let track_id = track.id;
    let codec_params = track.codec_params.clone();

    let src_rate = codec_params
        .sample_rate
        .ok_or_else(|| anyhow!("audio track has no sample rate"))?;
    let src_channels = codec_params
        .channels
        .map(|c| c.count())
        .ok_or_else(|| anyhow!("audio track has no channel layout"))?;

    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(|e| match e {
            SymphoniaError::Unsupported(msg) => {
                anyhow!("unsupported audio codec: {msg}")
            }
            other => anyhow!(other).context("make decoder"),
        })?;

    // Accumulate source-rate mono f32 samples, resample at the end.
    //
    // Use a lazily-allocated SampleBuffer<f32> so we don't have to
    // match on every AudioBufferRef variant manually — symphonia
    // handles the int/float/planar/interleaved conversions. The
    // buffer is allocated once (using the first decoded packet's
    // capacity) and reused.
    let mut mono_src: Vec<f32> = Vec::new();
    let mut sample_buf: Option<SampleBuffer<f32>> = None;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymphoniaError::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(SymphoniaError::ResetRequired) => {
                // Streaming formats can request a decoder reset on
                // container-level discontinuities. For file inputs we
                // treat this as end-of-stream.
                break;
            }
            Err(e) => return Err(anyhow!(e).context("read packet")),
        };

        if packet.track_id() != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(decoded) => {
                // Pull spec/capacity *before* moving `decoded` into
                // copy_interleaved_ref, which takes it by value.
                let spec = *decoded.spec();
                let capacity = decoded.capacity() as u64;
                if sample_buf.is_none() {
                    sample_buf = Some(SampleBuffer::<f32>::new(capacity, spec));
                }
                if let Some(ref mut sb) = sample_buf {
                    // copy_interleaved_ref produces frame-by-frame
                    // interleaved samples, which we then downmix to
                    // mono.
                    sb.copy_interleaved_ref(decoded);
                    let interleaved = sb.samples();
                    if src_channels == 1 {
                        mono_src.extend_from_slice(interleaved);
                    } else {
                        for frame in interleaved.chunks_exact(src_channels) {
                            let sum: f32 = frame.iter().sum();
                            mono_src.push(sum / src_channels as f32);
                        }
                    }
                }
            }
            Err(SymphoniaError::DecodeError(msg)) => {
                // A single bad packet shouldn't abort the whole file —
                // log via a side-channel (stderr) and keep going.
                eprintln!("Speakeasy file_transcribe: decode error (skipped): {msg}");
                continue;
            }
            Err(SymphoniaError::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(e) => return Err(anyhow!(e).context("decode packet")),
        }
    }

    let resampled = resample_linear(&mono_src, src_rate, TARGET_SAMPLE_RATE);
    let duration = resampled.len() as f64 / TARGET_SAMPLE_RATE as f64;
    Ok((resampled, duration))
}

/// Mirror of the linear-interp resampling from the old
/// `convert_to_mono_16k` in main.rs. Adequate for speech-STT use.
///
/// Public so the live-capture path (`main.rs`) can reuse it when cpal
/// hands us audio at a non-16 kHz rate (e.g. some USB audio interfaces
/// won't let us request 16 kHz directly). The quality is fine for
/// whisper STT — it's trained on noisy phone-quality speech and this
/// interpolator's aliasing is well below its tolerance.
pub fn resample_linear(input: &[f32], src_rate: u32, dst_rate: u32) -> Vec<f32> {
    if src_rate == dst_rate || input.is_empty() {
        return input.to_vec();
    }
    let ratio = src_rate as f64 / dst_rate as f64;
    let target_len = (input.len() as f64 / ratio) as usize;
    let mut out = Vec::with_capacity(target_len);
    for i in 0..target_len {
        let src_idx = i as f64 * ratio;
        let idx = src_idx as usize;
        if idx + 1 < input.len() {
            let frac = (src_idx - idx as f64) as f32;
            let s = input[idx] * (1.0 - frac) + input[idx + 1] * frac;
            out.push(s);
        } else if idx < input.len() {
            out.push(input[idx]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use hound::{SampleFormat, WavSpec, WavWriter};
    use std::io::Cursor;
    use std::path::PathBuf;

    // ─── Event serialization round-trip ─────────────────────────────

    #[test]
    fn loading_event_serializes() {
        let j = serde_json::to_string(&FileTranscribeEvent::Loading).unwrap();
        assert_eq!(j, r#"{"event":"loading"}"#);
    }

    #[test]
    fn ready_event_serializes() {
        let j = serde_json::to_string(&FileTranscribeEvent::Ready {
            duration_secs: 12.5,
        })
        .unwrap();
        assert_eq!(j, r#"{"event":"ready","duration_secs":12.5}"#);
    }

    #[test]
    fn progress_event_serializes() {
        let j = serde_json::to_string(&FileTranscribeEvent::Progress {
            pos: 5.0,
            dur: 30.0,
            finals_count: 2,
        })
        .unwrap();
        assert_eq!(
            j,
            r#"{"event":"progress","pos":5.0,"dur":30.0,"finals_count":2}"#
        );
    }

    #[test]
    fn partial_event_serializes() {
        let j = serde_json::to_string(&FileTranscribeEvent::Partial {
            text: "hello".into(),
        })
        .unwrap();
        assert_eq!(j, r#"{"event":"partial","text":"hello"}"#);
    }

    #[test]
    fn final_event_serializes() {
        let j = serde_json::to_string(&FileTranscribeEvent::Final {
            text: "committed".into(),
        })
        .unwrap();
        assert_eq!(j, r#"{"event":"final","text":"committed"}"#);
    }

    #[test]
    fn done_event_serializes() {
        let j = serde_json::to_string(&FileTranscribeEvent::Done {
            raw_text: "hi there".into(),
            finals_count: 3,
        })
        .unwrap();
        assert_eq!(
            j,
            r#"{"event":"done","raw_text":"hi there","finals_count":3}"#
        );
    }

    #[test]
    fn error_event_serializes() {
        let j = serde_json::to_string(&FileTranscribeEvent::Error {
            message: "boom".into(),
        })
        .unwrap();
        assert_eq!(j, r#"{"event":"error","message":"boom"}"#);
    }

    #[test]
    fn event_roundtrip_every_variant() {
        let cases = vec![
            FileTranscribeEvent::Loading,
            FileTranscribeEvent::Ready { duration_secs: 1.0 },
            FileTranscribeEvent::Progress {
                pos: 0.5,
                dur: 2.0,
                finals_count: 1,
            },
            FileTranscribeEvent::Partial { text: "a".into() },
            FileTranscribeEvent::Final { text: "b".into() },
            FileTranscribeEvent::Done {
                raw_text: "c".into(),
                finals_count: 4,
            },
            FileTranscribeEvent::Error {
                message: "oops".into(),
            },
        ];
        for ev in cases {
            let j = serde_json::to_string(&ev).unwrap();
            let back: FileTranscribeEvent = serde_json::from_str(&j).unwrap();
            assert_eq!(back, ev);
        }
    }

    #[test]
    fn parse_ndjson_matches_js_protocol_order() {
        // Feed the parser a canned NDJSON stream that mirrors what a
        // real transcription emits, and confirm we get the expected
        // variants in order. This is the Rust analogue of the JS
        // parser tests.
        let lines = [
            r#"{"event":"loading"}"#,
            r#"{"event":"ready","duration_secs":3.0}"#,
            r#"{"event":"progress","pos":1.5,"dur":3.0,"finals_count":0}"#,
            r#"{"event":"partial","text":"hello"}"#,
            r#"{"event":"final","text":"hello world"}"#,
            r#"{"event":"done","raw_text":"hello world","finals_count":1}"#,
        ];
        let parsed: Vec<FileTranscribeEvent> = lines
            .iter()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert!(matches!(parsed[0], FileTranscribeEvent::Loading));
        assert!(matches!(parsed[1], FileTranscribeEvent::Ready { .. }));
        assert!(matches!(parsed[2], FileTranscribeEvent::Progress { .. }));
        assert!(matches!(parsed[3], FileTranscribeEvent::Partial { .. }));
        assert!(matches!(parsed[4], FileTranscribeEvent::Final { .. }));
        assert!(matches!(parsed[5], FileTranscribeEvent::Done { .. }));
    }

    // ─── WAV synthesis helpers ───────────────────────────────────────

    fn write_wav(path: &Path, sample_rate: u32, channels: u16, samples: &[f32]) {
        let spec = WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let mut w = WavWriter::create(path, spec).unwrap();
        for &s in samples {
            let clipped = s.clamp(-1.0, 1.0);
            let v = (clipped * i16::MAX as f32) as i16;
            w.write_sample(v).unwrap();
        }
        w.finalize().unwrap();
    }

    fn synth_sine(seconds: f64, sample_rate: u32, channels: u16, freq: f64) -> Vec<f32> {
        let total_frames = (seconds * sample_rate as f64) as usize;
        let mut out = Vec::with_capacity(total_frames * channels as usize);
        for i in 0..total_frames {
            let t = i as f64 / sample_rate as f64;
            let v = (t * freq * std::f64::consts::TAU).sin() as f32 * 0.3;
            for _ in 0..channels {
                out.push(v);
            }
        }
        out
    }

    // ─── Decoder tests ───────────────────────────────────────────────

    #[test]
    fn decode_wav_16k_mono_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hello.wav");
        let samples = synth_sine(0.5, 16000, 1, 440.0);
        write_wav(&path, 16000, 1, &samples);

        let (pcm, dur) = decode_to_mono_16k(&path).unwrap();
        // Rough shape checks — not sample-exact because 16-bit WAV
        // round-trips through i16 quantization.
        assert!((dur - 0.5).abs() < 0.01, "duration ~= 0.5s, got {dur}");
        assert!(pcm.len() >= 7500 && pcm.len() <= 8500, "len={}", pcm.len());
    }

    #[test]
    fn decode_wav_44k_stereo_resamples_to_16k_mono() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stereo.wav");
        let samples = synth_sine(1.0, 44100, 2, 440.0);
        write_wav(&path, 44100, 2, &samples);

        let (pcm, dur) = decode_to_mono_16k(&path).unwrap();
        assert!((dur - 1.0).abs() < 0.05, "duration ~= 1.0s, got {dur}");
        // 16 kHz * 1s ≈ 16000 samples; linear resampler off-by-one is fine.
        assert!(
            pcm.len() >= 15_500 && pcm.len() <= 16_500,
            "resampled len={}",
            pcm.len()
        );
    }

    // ─── Direct resample_linear unit tests ─────────────────────────
    //
    // These guard the fallback resample path used by `main.rs` when
    // cpal can't deliver the desired rate (e.g. a USB interface that
    // only exposes 44.1 kHz). The live-capture callback is too
    // integration-heavy to test directly, but if these hold the
    // downstream 16 kHz guarantee holds.

    #[test]
    fn resample_linear_passthrough_when_rates_match() {
        let input: Vec<f32> = (0..8000).map(|i| (i as f32).sin()).collect();
        let out = resample_linear(&input, 16_000, 16_000);
        assert_eq!(out.len(), input.len());
        assert_eq!(out, input);
    }

    #[test]
    fn resample_linear_handles_empty_input() {
        let out = resample_linear(&[], 48_000, 16_000);
        assert!(out.is_empty());
    }

    #[test]
    fn resample_linear_48k_to_16k_produces_third_length() {
        // 3 s of audio at 48 kHz -> should be ~3 s at 16 kHz.
        let input: Vec<f32> = (0..(48_000 * 3)).map(|_| 0.0).collect();
        let out = resample_linear(&input, 48_000, 16_000);
        // Off-by-one tolerance; linear interp drops the final frac.
        assert!(
            (out.len() as i64 - 48_000).abs() <= 2,
            "expected ~48000, got {}",
            out.len()
        );
    }

    #[test]
    fn resample_linear_44100_to_16k_matches_expected_length() {
        // 1 second of audio at 44.1 kHz -> should be ~16 000 samples.
        // Covers the "device reports 44.1 kHz" fallback the live
        // capture path exercises.
        let input: Vec<f32> = (0..44_100).map(|_| 0.5).collect();
        let out = resample_linear(&input, 44_100, 16_000);
        assert!(
            out.len() >= 15_900 && out.len() <= 16_100,
            "expected ~16000 samples, got {}",
            out.len()
        );
        // All output values should be ~0.5 (constant input → constant
        // output through linear interp).
        for &v in &out {
            assert!((v - 0.5).abs() < 1e-5, "got {v}");
        }
    }

    #[test]
    fn unsupported_format_returns_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bogus.xyz");
        std::fs::write(&path, b"this is not audio, definitely not").unwrap();

        // Use decode_to_mono_16k directly so we exercise the unsupported
        // path without needing a whisper model loaded.
        let err = decode_to_mono_16k(&path).unwrap_err();
        let msg = format!("{err:#}");
        assert!(
            msg.contains("unsupported") || msg.contains("probe"),
            "error mentions unsupported/probe: {msg}"
        );
    }

    #[test]
    fn transcribe_file_emits_error_event_for_unsupported_format() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("garbage.xyz");
        std::fs::write(&audio, b"not-audio").unwrap();
        // Model path doesn't matter — we fail before loading.
        let model = PathBuf::from("/nonexistent/model.bin");
        let mut buf: Vec<u8> = Vec::new();
        let opts = FileTranscribeOptions::default();

        let res = transcribe_file(&audio, &model, &opts, &mut buf);
        assert!(res.is_err(), "expected Err for unsupported format");

        let text = String::from_utf8(buf).unwrap();
        // Two events expected: Loading, then Error. The Loading event
        // is emitted before decode is attempted.
        let events: Vec<FileTranscribeEvent> = text
            .lines()
            .filter(|l| !l.is_empty())
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert!(
            matches!(events.first(), Some(FileTranscribeEvent::Loading)),
            "first event is loading: {events:?}"
        );
        assert!(
            matches!(events.last(), Some(FileTranscribeEvent::Error { .. })),
            "last event is error: {events:?}"
        );
    }

    #[test]
    fn events_are_newline_delimited_json() {
        // Confirm the emitter writes exactly one JSON line per event
        // and flushes so consumers see it without a full buffer.
        let mut buf: Vec<u8> = Vec::new();
        emit_event(&mut buf, &FileTranscribeEvent::Loading).unwrap();
        emit_event(
            &mut buf,
            &FileTranscribeEvent::Ready { duration_secs: 1.5 },
        )
        .unwrap();
        let s = String::from_utf8(buf).unwrap();
        let lines: Vec<&str> = s.lines().collect();
        assert_eq!(lines.len(), 2, "two lines, got: {s:?}");
        assert!(s.ends_with('\n'));
        let _: FileTranscribeEvent = serde_json::from_str(lines[0]).unwrap();
        let _: FileTranscribeEvent = serde_json::from_str(lines[1]).unwrap();
    }

    // Full transcribe_file on a real WAV. Runs whisper, so it's gated
    // behind --include-ignored with SPEAKEASY_TEST_MODEL pointing to a
    // ggml-*.bin file.
    #[test]
    #[ignore]
    fn transcribe_file_end_to_end_with_real_model() {
        let model_env = match std::env::var("SPEAKEASY_TEST_MODEL") {
            Ok(v) => v,
            Err(_) => {
                eprintln!("SPEAKEASY_TEST_MODEL not set; skipping");
                return;
            }
        };

        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("tone.wav");
        let samples = synth_sine(2.0, 16000, 1, 440.0);
        write_wav(&audio, 16000, 1, &samples);

        let mut buf: Vec<u8> = Vec::new();
        let opts = FileTranscribeOptions {
            chunk_seconds: 2.0,
            emit_partials: false,
        };
        let summary = transcribe_file(
            &audio,
            Path::new(&model_env),
            &opts,
            &mut buf,
        )
        .expect("transcribe_file");

        let text = String::from_utf8(buf).unwrap();
        let events: Vec<FileTranscribeEvent> = text
            .lines()
            .filter(|l| !l.is_empty())
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();

        // Shape: Loading → Ready → (Final? + Progress)* → Done
        assert!(matches!(events.first(), Some(FileTranscribeEvent::Loading)));
        assert!(events
            .iter()
            .any(|e| matches!(e, FileTranscribeEvent::Ready { .. })));
        assert!(matches!(
            events.last(),
            Some(FileTranscribeEvent::Done { .. })
        ));
        // Summary agrees with the terminal Done event.
        if let Some(FileTranscribeEvent::Done {
            raw_text,
            finals_count,
        }) = events.last().cloned()
        {
            assert_eq!(raw_text, summary.raw_text);
            assert_eq!(finals_count, summary.finals_count);
        }
    }

    // Keep the unused Cursor import honest for future callers that
    // want to write to an in-memory buffer backed by Cursor.
    #[test]
    fn writer_can_be_a_cursor() {
        let mut cur = Cursor::new(Vec::<u8>::new());
        emit_event(&mut cur, &FileTranscribeEvent::Loading).unwrap();
        let inner = cur.into_inner();
        assert!(String::from_utf8(inner).unwrap().contains("loading"));
    }
}
