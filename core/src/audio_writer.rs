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

    loop {
        match cmd_rx.recv() {
            Ok(Cmd::Samples(pcm)) => buffered.extend_from_slice(&pcm),
            Ok(Cmd::Close) => closing = true,
            Err(_) => closing = true, // sender dropped
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
        while buffered.len() >= FRAME_SAMPLES
            || (closing && !buffered.is_empty())
        {
            let frame: Vec<f32> = if buffered.len() >= FRAME_SAMPLES {
                buffered.drain(..FRAME_SAMPLES).collect()
            } else {
                let mut f = std::mem::take(&mut buffered);
                f.resize(FRAME_SAMPLES, 0.0);
                f
            };

            let bytes = encoder
                .encode_float_to_slice(&frame, &mut scratch)
                .map_err(|e| anyhow!("opus encode_float: {:?}", e))?;

            granpos += FRAME_GRANPOS_48K;
            let is_final_packet = closing && buffered.is_empty();
            let end_info = if is_final_packet {
                PacketWriteEndInfo::EndStream
            } else {
                PacketWriteEndInfo::NormalPacket
            };

            packet_writer
                .write_packet(scratch[..bytes].to_vec(), OGG_SERIAL, end_info, granpos)
                .context("write opus audio packet")?;

            if is_final_packet {
                break;
            }
        }

        if closing {
            break;
        }
    }

    writer.flush().context("flush ogg file")?;
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
}
