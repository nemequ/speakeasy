// On-disk audio retention for crash recovery and debugging.
//
// Runs on a dedicated writer thread so the audio capture callback
// (which has hard real-time requirements) never blocks on disk I/O
// or opus encoding. PCM samples downsampled to 16 kHz mono float are
// pushed in via push(); the thread buffers them, encodes to 20 ms
// opus packets, and wraps them in an Ogg container.
//
// The writer is intentionally best-effort: any I/O or encode error
// is logged to stderr and the writer gives up silently so a bad disk
// or bad codec build never takes down a recording. Losing an audio
// file is bad, but losing the recording itself is worse.

use anyhow::{anyhow, Context, Result};
use ogg::writing::{PacketWriteEndInfo, PacketWriter};
use opusic_c::{Application, Bitrate, Channels, Encoder, SampleRate};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;

const SAMPLE_RATE_HZ: u32 = 16_000;
const FRAME_SAMPLES: usize = 320;       // 20 ms at 16 kHz
const FRAME_GRANPOS_48K: u64 = 960;     // 20 ms at the 48 kHz granpos clock
const OGG_SERIAL: u32 = 0x5f_57_52_54;  // ASCII "_WRT"; arbitrary per-stream id
const MAX_PACKET_BYTES: usize = 4000;   // Per opus recommendations

enum Cmd {
    Samples(Vec<f32>),
    Close,
}

pub struct OpusAudioWriter {
    cmd_tx: mpsc::Sender<Cmd>,
    handle: Option<thread::JoinHandle<()>>,
}

impl OpusAudioWriter {
    // Open `path` for writing and start the encoder thread. Fails only
    // if the parent directory can't be created or the file can't be
    // opened; encode errors inside the worker are logged, not surfaced.
    pub fn new(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create audio dir {}", parent.display()))?;
        }
        let file = File::create(&path)
            .with_context(|| format!("create audio file {}", path.display()))?;

        let (cmd_tx, cmd_rx) = mpsc::channel::<Cmd>();

        let handle = thread::spawn(move || {
            if let Err(e) = run(BufWriter::new(file), cmd_rx) {
                eprintln!(
                    "Speakeasy audio_writer: encoder thread failed for {}: {}",
                    path.display(),
                    e
                );
            }
        });

        Ok(Self { cmd_tx, handle: Some(handle) })
    }

    // Push a batch of 16 kHz mono float samples (-1.0..=1.0). Best-effort;
    // if the worker has already exited (e.g. after an I/O error) the send
    // silently fails — the recording itself is unaffected.
    pub fn push(&self, samples: &[f32]) {
        if samples.is_empty() {
            return;
        }
        let _ = self.cmd_tx.send(Cmd::Samples(samples.to_vec()));
    }

    // Signal the worker to flush any remaining partial frame, write the
    // EOS page, and exit. Blocks until the file has been fully written.
    pub fn close(mut self) {
        let _ = self.cmd_tx.send(Cmd::Close);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

fn run(mut writer: BufWriter<File>, cmd_rx: mpsc::Receiver<Cmd>) -> Result<()> {
    let mut packet_writer = PacketWriter::new(&mut writer);
    let mut encoder = Encoder::new(Channels::Mono, SampleRate::Hz16000, Application::Voip)
        .map_err(|e| anyhow!("opus encoder init: {:?}", e))?;
    // libopus' default VoIP bitrate is already pretty tight (~24 kbps);
    // explicit setting keeps file sizes stable across libopus versions.
    let _ = encoder.set_bitrate(Bitrate::Value(24_000));

    // Header packets: OpusHead + OpusTags. Each must be on its own page
    // per the Ogg Opus spec. granpos is 0 for header pages.
    packet_writer
        .write_packet(build_opus_head(), OGG_SERIAL, PacketWriteEndInfo::EndPage, 0)
        .context("write OpusHead")?;
    packet_writer
        .write_packet(build_opus_tags(), OGG_SERIAL, PacketWriteEndInfo::EndPage, 0)
        .context("write OpusTags")?;

    let mut buffered: Vec<f32> = Vec::with_capacity(FRAME_SAMPLES * 4);
    let mut scratch = vec![0u8; MAX_PACKET_BYTES];
    let mut granpos: u64 = 0;
    let mut closing = false;

    // Track whether we've emitted the final EndStream packet. If the
    // close path exits the main loop without producing one (common
    // when `buffered` happens to be empty at the moment of Close),
    // we inject one silent frame below to flush the ogg page to
    // disk. Without this, `PacketWriter` holds every accumulated
    // audio packet in memory until either an EndPage/EndStream or a
    // 255-segment page overflow — leaving the file at header-only
    // size (~100 bytes) for short recordings.
    let mut frames_encoded: u64 = 0;
    let mut audio_written: bool = false;
    let mut end_stream_written: bool = false;
    loop {
        match cmd_rx.recv() {
            Ok(Cmd::Samples(pcm)) => {
                buffered.extend_from_slice(&pcm);
            }
            Ok(Cmd::Close) => {
                closing = true;
            }
            Err(_) => {
                closing = true;
            }
        }

        // Drain any additional commands that have accumulated while we were blocked.
        loop {
            match cmd_rx.try_recv() {
                Ok(Cmd::Samples(pcm)) => buffered.extend_from_slice(&pcm),
                Ok(Cmd::Close) => closing = true,
                Err(_) => break,
            }
        }

        // Encode all full frames. When closing with a partial frame left
        // over, pad with silence so the final packet is emittable.
        //
        // A single bad encode (NaN/out-of-range input) must not take
        // down the whole stream: we log the error, drop the offending
        // frame, and keep going. This used to be a `?` that killed the
        // worker thread and left the file as header-only — which is
        // what callers observed when the capture path was feeding
        // corrupt samples into the encoder.
        while buffered.len() >= FRAME_SAMPLES
            || (closing && !buffered.is_empty())
        {
            let mut frame: Vec<f32> = if buffered.len() >= FRAME_SAMPLES {
                buffered.drain(..FRAME_SAMPLES).collect()
            } else {
                let mut f = std::mem::take(&mut buffered);
                f.resize(FRAME_SAMPLES, 0.0);
                f
            };

            // Sanitize: clamp NaN/out-of-range so a bad upstream
            // never prevents an otherwise-good recording from
            // flushing to disk. libopus tolerates small clipping;
            // it would not tolerate NaN.
            for s in frame.iter_mut() {
                if !s.is_finite() {
                    *s = 0.0;
                } else if *s > 1.0 {
                    *s = 1.0;
                } else if *s < -1.0 {
                    *s = -1.0;
                }
            }

            let is_final_packet = closing && buffered.is_empty();
            match encoder.encode_float_to_slice(&frame, &mut scratch) {
                Ok(bytes) => {
                    frames_encoded += 1;
                    granpos += FRAME_GRANPOS_48K;
                    // Emit an EndPage every ~1 second (50 frames of
                    // 20 ms each) so pages land on disk incrementally
                    // — without this the ogg `PacketWriter` holds
                    // every packet in a single in-memory page until
                    // either a 255-segment overflow or an EndStream,
                    // which leaves the file at header-only size if
                    // the recording is short.
                    const PAGE_FLUSH_INTERVAL: u64 = 50;
                    let end_info = if is_final_packet {
                        PacketWriteEndInfo::EndStream
                    } else if frames_encoded % PAGE_FLUSH_INTERVAL == 0 {
                        PacketWriteEndInfo::EndPage
                    } else {
                        PacketWriteEndInfo::NormalPacket
                    };
                    if let Err(e) = packet_writer.write_packet(
                        scratch[..bytes].to_vec(),
                        OGG_SERIAL,
                        end_info,
                        granpos,
                    ) {
                        eprintln!(
                            "Speakeasy audio_writer: write_packet failed, aborting stream: {:?}",
                            e
                        );
                        return Err(anyhow!(e).context("write opus audio packet"));
                    }
                    audio_written = true;
                    if end_info == PacketWriteEndInfo::EndStream {
                        end_stream_written = true;
                    }
                }
                Err(e) => {
                    eprintln!(
                        "Speakeasy audio_writer: opus encode_float failed (dropping frame): {:?}",
                        e
                    );
                    // If this was the final packet, we still owe the
                    // stream an EndStream marker. Emit a tiny silent
                    // frame to carry it so the Ogg file stays
                    // well-formed. Failing that, fall through — a
                    // truncated Ogg is still parseable by most tools.
                    if is_final_packet {
                        let silent = [0.0f32; FRAME_SAMPLES];
                        if let Ok(bytes) = encoder.encode_float_to_slice(&silent, &mut scratch) {
                            granpos += FRAME_GRANPOS_48K;
                            let _ = packet_writer.write_packet(
                                scratch[..bytes].to_vec(),
                                OGG_SERIAL,
                                PacketWriteEndInfo::EndStream,
                                granpos,
                            );
                            audio_written = true;
                            end_stream_written = true;
                        }
                    }
                }
            }

            if is_final_packet {
                break;
            }
        }

        if closing {
            if audio_written && !end_stream_written {
                // Inject a silent frame to carry the EndStream marker
                // so the ogg PacketWriter flushes its accumulated
                // page to disk. Normally the final-packet branch
                // above produces EndStream, but if `buffered` is
                // already empty when Close arrives, the while loop
                // doesn't execute at all — and without this nudge
                // the entire page (all encoded audio) is lost when
                // BufWriter flushes only the headers.
                let silent = [0.0f32; FRAME_SAMPLES];
                if let Ok(bytes) = encoder.encode_float_to_slice(&silent, &mut scratch) {
                    granpos += FRAME_GRANPOS_48K;
                    let _ = packet_writer.write_packet(
                        scratch[..bytes].to_vec(),
                        OGG_SERIAL,
                        PacketWriteEndInfo::EndStream,
                        granpos,
                    );
                }
            }
            break;
        }
    }

    drop(packet_writer);
    writer.flush().context("flush ogg file")?;
    let _ = frames_encoded; // silence unused warning when the debug
                            // counter isn't otherwise consumed
    Ok(())
}

// OpusHead packet layout per RFC 7845 §5.1.
fn build_opus_head() -> Vec<u8> {
    let mut buf = Vec::with_capacity(19);
    buf.extend_from_slice(b"OpusHead");
    buf.push(1); // version
    buf.push(1); // channel count (mono)
    // pre-skip: libopus at 16 kHz has ~312 samples of encoder lookahead,
    // scaled to the 48 kHz granpos clock that's 936. We use a round 3840
    // (80 ms) as a safe padding so decoders drop the initial ramp cleanly.
    buf.extend_from_slice(&3840u16.to_le_bytes());
    buf.extend_from_slice(&SAMPLE_RATE_HZ.to_le_bytes()); // original sample rate (informational)
    buf.extend_from_slice(&0i16.to_le_bytes());           // output gain
    buf.push(0);                                          // channel mapping family 0
    buf
}

// OpusTags packet layout per RFC 7845 §5.2.
fn build_opus_tags() -> Vec<u8> {
    let vendor = b"speakeasy";
    let mut buf = Vec::with_capacity(8 + 4 + vendor.len() + 4);
    buf.extend_from_slice(b"OpusTags");
    buf.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
    buf.extend_from_slice(vendor);
    buf.extend_from_slice(&0u32.to_le_bytes()); // 0 user comments
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    // End-to-end round trip: write a synthetic sine wave through the
    // writer and read the resulting file headers back to confirm it's
    // a valid Ogg Opus stream. Catches regressions in packet framing
    // without needing ffprobe or a decoder on the build machine.
    #[test]
    fn writes_parseable_ogg_opus_file() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("speakeasy_test_{}.opus", std::process::id()));
        let writer = OpusAudioWriter::new(path.clone()).expect("open writer");

        // 1 s of 440 Hz sine at 16 kHz mono.
        let mut samples = Vec::with_capacity(SAMPLE_RATE_HZ as usize);
        for i in 0..SAMPLE_RATE_HZ as usize {
            let t = i as f32 / SAMPLE_RATE_HZ as f32;
            samples.push((2.0 * std::f32::consts::PI * 440.0 * t).sin() * 0.25);
        }
        // Push in ~100 ms chunks to exercise the buffering path.
        for chunk in samples.chunks(1600) {
            writer.push(chunk);
        }
        writer.close();

        let bytes = std::fs::read(&path).expect("read back file");
        assert!(bytes.len() > 200, "file suspiciously small: {} bytes", bytes.len());
        // First page starts with "OggS" and contains "OpusHead".
        assert_eq!(&bytes[..4], b"OggS", "not an Ogg file");
        assert!(
            bytes.windows(8).any(|w| w == b"OpusHead"),
            "OpusHead marker missing",
        );
        assert!(
            bytes.windows(8).any(|w| w == b"OpusTags"),
            "OpusTags marker missing",
        );
        let _ = std::fs::remove_file(&path);
    }

    // Regression guard for the "file came out at 100 bytes" bug. With
    // a known 1-second input, the encoded file must be substantially
    // larger than the 40-byte header pair — otherwise the worker
    // silently died before processing any samples (the symptom that
    // motivated the audio_writer hardening in this module).
    #[test]
    fn one_second_of_audio_produces_audio_pages_over_1kb() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "speakeasy_audio_pages_{}.opus",
            std::process::id()
        ));
        let writer = OpusAudioWriter::new(path.clone()).expect("open writer");

        // 16 000 samples = 1 second at 16 kHz. At ~24 kbps that's
        // ~3 KB of compressed audio once framed; a header-only file
        // is ~100 bytes, so a 1 KB threshold comfortably distinguishes
        // the two.
        let mut samples = Vec::with_capacity(SAMPLE_RATE_HZ as usize);
        for i in 0..SAMPLE_RATE_HZ as usize {
            let t = i as f32 / SAMPLE_RATE_HZ as f32;
            // Mix two tones so the encoder has something non-trivial
            // to compress — pure silence compresses to almost nothing.
            let v = (2.0 * std::f32::consts::PI * 440.0 * t).sin() * 0.2
                + (2.0 * std::f32::consts::PI * 880.0 * t).sin() * 0.1;
            samples.push(v);
        }
        writer.push(&samples);
        writer.close();

        let bytes = std::fs::read(&path).expect("read back file");
        assert!(
            bytes.len() > 1024,
            "file too small ({}B) — worker likely died before encoding samples",
            bytes.len()
        );
        // Verify there are audio pages after the two header pages:
        // count occurrences of the "OggS" capture pattern. Header +
        // tags = 2 pages; anything above that means audio was written.
        let page_count = bytes.windows(4).filter(|w| *w == b"OggS").count();
        assert!(
            page_count >= 3,
            "expected >=3 Ogg pages (2 headers + audio), got {}",
            page_count
        );
        let _ = std::fs::remove_file(&path);
    }

    // Pathological input (NaN, infinities, huge magnitudes) must not
    // take the writer thread down — the sanitize step clamps them so
    // the rest of the recording still makes it to disk. This guards
    // against the failure mode where RNNoise was being fed a wrong-
    // rate signal and emitted NaNs into the encoder.
    #[test]
    fn writer_tolerates_nan_and_out_of_range_samples() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("speakeasy_nan_{}.opus", std::process::id()));
        let writer = OpusAudioWriter::new(path.clone()).expect("open writer");

        // A frame's worth of NaN/inf/huge samples, then a second of
        // real audio. The bad frame would previously crash the worker.
        let bad: Vec<f32> = (0..FRAME_SAMPLES)
            .map(|i| match i % 4 {
                0 => f32::NAN,
                1 => f32::INFINITY,
                2 => -f32::INFINITY,
                _ => 50.0,
            })
            .collect();
        writer.push(&bad);

        let mut good = Vec::with_capacity(SAMPLE_RATE_HZ as usize);
        for i in 0..SAMPLE_RATE_HZ as usize {
            let t = i as f32 / SAMPLE_RATE_HZ as f32;
            good.push((2.0 * std::f32::consts::PI * 440.0 * t).sin() * 0.25);
        }
        writer.push(&good);
        writer.close();

        let bytes = std::fs::read(&path).expect("read back file");
        assert!(
            bytes.len() > 1024,
            "writer died on bad samples (file: {}B)",
            bytes.len()
        );
        let _ = std::fs::remove_file(&path);
    }
}
