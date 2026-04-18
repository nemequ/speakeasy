mod tui;
mod ai;
mod ai_local;
mod ai_worker;
mod audio_writer;

use anyhow::{Context, Result};
use hound::{WavReader, WavSpec, WavWriter, SampleFormat};
use clap::Parser;
use std::time::Instant;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use nnnoiseless::DenoiseState;
use serde::{Deserialize, Serialize};
use speakeasy::WhisperModel;
use std::io::{self, BufRead};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::sync::mpsc as std_mpsc;
use tokio::sync::mpsc;
use tokio::time::{interval, Duration};

/// Speakeasy Core (Rust) — High-performance STT and Audio engine.
#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// STT backend (only whisper-rs supported in Rust core for now)
    #[arg(short, long, default_value = "whisper-rs")]
    backend: String,

    /// Path to Whisper model directory (containing config.json, etc.)
    #[arg(short, long)]
    model_path: Option<String>,

    /// Enable TUI mode
    #[arg(short, long, default_value_t = false)]
    tui: bool,

    /// Enable noise cancellation
    #[arg(short, long, default_value_t = true)]
    denoise: bool,

    /// Save the recorded audio to a WAV file for debugging
    #[arg(long)]
    debug_save_wav: Option<String>,

    /// Input audio file (WAV or FLAC) instead of microphone
    #[arg(long)]
    file: Option<String>,

    /// Interval for partial transcriptions in seconds
    #[arg(long, default_value_t = 1.5)]
    partial_interval: f64,

    /// Max active-buffer length before a commit-decode fires, in seconds.
    /// Each commit snips off this much audio, decodes it once, and appends the
    /// text to a monotonic committed prefix — keeping post-stop latency bounded
    /// to roughly one commit-window regardless of total recording length.
    #[arg(long, default_value_t = 15.0)]
    commit_window_secs: f64,

    /// AI backend for text cleanup: 'llama' (local GGUF via candle) or 'none'.
    /// When 'llama', set --ai-model to the GGUF file path.
    #[arg(long, default_value = "none")]
    ai_backend: String,

    /// Path to the GGUF model file (for --ai-backend llama).
    #[arg(long)]
    ai_model: Option<String>,

    /// Path to system prompt file.
    #[arg(long)]
    system_prompt_path: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "event", rename_all = "lowercase")]
pub enum Event {
    Ready,
    Partial { text: String },
    Final { text: String },
    // Incremental chunk of AI-cleanup output. Emitted repeatedly from
    // the AI worker's generation loop as tokens are decoded, so the
    // UI can stream the cleaned text into the overlay instead of
    // staring at a spinner. Concatenating every `Delta` between one
    // `Stopped` and the next `Final` reconstructs the cleaned text.
    Delta { text: String },
    Level { rms: f64, peak: f64 },
    // Emitted immediately after a `stop` command is accepted, before
    // the final whisper decode runs. The JS-side stop watchdog treats
    // this as a keep-alive and switches from its "subprocess hasn't
    // even acknowledged stop" timeout to a longer "decode in progress"
    // timeout, so long recordings aren't SIGKILLed mid-decode.
    Transcribing,
    Stopped { text: String },
    Error { message: String },
}

#[derive(Deserialize, Debug)]
pub struct Command {
    pub cmd: String,
    // Path for start_file / delete_audio. Optional so legacy callers
    // that send bare {"cmd":"start"} keep working.
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug)]
enum TranscribeCmd {
    // Preview decode of the current tail. Stale Partials queued behind a
    // newer command are dropped (see coalesce_partials).
    Partial(Vec<f32>),
    // A chunk the main loop has sliced off the front of the active buffer
    // and considers final. Decoded once and appended to committed_text.
    Commit(Vec<f32>),
    // Last tail after stop. Triggers the final Stopped event.
    TranscribeFinal(Vec<f32>),
}

#[derive(Debug)]
enum TranscribeResult {
    Partial(String),
    Committed(String),
    Stopped(String),
}

// Drop any Partial that's made stale by a later Commit/Final in the same
// drain window, and keep at most one trailing Partial. Audio in a stale
// Partial is a superset of audio in the following Commit, so decoding it
// would redundantly process the committed chunk.
fn coalesce_partials(pending: Vec<TranscribeCmd>) -> Vec<TranscribeCmd> {
    let mut out: Vec<TranscribeCmd> = Vec::with_capacity(pending.len());
    let mut trailing_partial: Option<Vec<f32>> = None;
    for cmd in pending {
        match cmd {
            TranscribeCmd::Partial(audio) => {
                trailing_partial = Some(audio);
            }
            other => {
                trailing_partial = None;
                out.push(other);
            }
        }
    }
    if let Some(audio) = trailing_partial {
        out.push(TranscribeCmd::Partial(audio));
    }
    out
}

// Locate a cut point inside `audio` at-or-before `target` that lands in the
// quietest 200ms window within the last `search_back` samples. Returns the
// sample index at the end of that quiet window, so the committed chunk ends
// in silence and the tail starts fresh.
fn find_silent_cut(audio: &[f32], target: usize, search_back: usize, window: usize) -> usize {
    let target = target.min(audio.len());
    if target < window {
        return target;
    }
    let start = target.saturating_sub(search_back);
    if target - start < window {
        return target;
    }
    let hop = (window / 4).max(1);
    let mut best_rms = f32::INFINITY;
    let mut best_cut = target;
    let mut pos = start;
    while pos + window <= target {
        let slice = &audio[pos..pos + window];
        let rms: f32 = (slice.iter().map(|s| s * s).sum::<f32>() / window as f32).sqrt();
        if rms < best_rms {
            best_rms = rms;
            best_cut = pos + window;
        }
        pos += hop;
    }
    best_cut
}

fn start_transcription_thread(
    model_path: String,
    result_tx: mpsc::UnboundedSender<TranscribeResult>,
    suppress_stderr: bool,
) -> (
    std_mpsc::Sender<TranscribeCmd>,
    thread::JoinHandle<()>,
) {
    let (cmd_tx, cmd_rx) = std_mpsc::channel();

    let handle = thread::spawn(move || {
        // Redirect stderr to /dev/null when in TUI mode — whisper.cpp prints
        // diagnostic messages (model params, GPU status, buffer sizes) directly
        // to stderr via C code, which corrupts the ratatui terminal.
        if suppress_stderr {
            unsafe {
                let devnull = libc::open(b"/dev/null\0".as_ptr() as *const _, libc::O_WRONLY);
                if devnull >= 0 {
                    libc::dup2(devnull, 2);
                    libc::close(devnull);
                }
            }
        }

        // Load the model in this thread (only once)
        let mut model = match WhisperModel::load(&model_path) {
            Ok(m) => m,
            Err(e) => {
                let _ = result_tx.send(TranscribeResult::Stopped(
                    format!("Failed to load model: {}", e),
                ));
                return;
            }
        };

        loop {
            let first = match cmd_rx.recv() {
                Ok(c) => c,
                Err(_) => break,
            };
            let mut pending = vec![first];
            while let Ok(next) = cmd_rx.try_recv() {
                pending.push(next);
            }

            for cmd in coalesce_partials(pending) {
                match cmd {
                    TranscribeCmd::Partial(audio) => {
                        let text = match model.transcribe(&audio) {
                            Ok(t) => t,
                            Err(e) => format!("Error: {}", e),
                        };
                        let _ = result_tx.send(TranscribeResult::Partial(text));
                    }
                    TranscribeCmd::Commit(audio) => {
                        let text = match model.transcribe(&audio) {
                            Ok(t) => t,
                            Err(e) => format!("Error: {}", e),
                        };
                        let _ = result_tx.send(TranscribeResult::Committed(text));
                    }
                    TranscribeCmd::TranscribeFinal(audio) => {
                        let text = match model.transcribe(&audio) {
                            Ok(t) => t,
                            Err(e) => format!("Error: {}", e),
                        };
                        let _ = result_tx.send(TranscribeResult::Stopped(text));
                    }
                }
            }
        }
    });

    (cmd_tx, handle)
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let is_tui = args.tui;
    let partial_interval_secs = args.partial_interval;

    if !is_tui {
        eprintln!("Speakeasy Core (Rust) starting. Backend: {}, Denoise: {}", args.backend, args.denoise);
    }

    let ai_config = if args.ai_backend != "none" {
        let binary_path = std::env::current_exe().unwrap_or_default();
        Some(ai::AiConfig {
            backend: args.ai_backend.clone(),
            model: args.ai_model.clone().unwrap_or_default(),
            system_prompt: ai::load_system_prompt(args.system_prompt_path.as_deref(), &binary_path),
        })
    } else {
        None
    };

    if let Some(ref config) = ai_config {
        if !is_tui {
            eprintln!("AI Backend: {}, Model: {}", config.backend, config.model);
        }
    }

    fn load_audio_file(path: &str) -> Result<Vec<f32>> {
        let path = std::path::Path::new(path);
        let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");

        match ext.to_lowercase().as_str() {
            "wav" => {
                let mut reader = WavReader::open(path).context("Failed to open WAV file")?;
                let spec = reader.spec();

                let samples: Vec<f32> = match spec.sample_format {
                    SampleFormat::Int => match spec.bits_per_sample {
                        8 => reader.samples::<i8>().map(|s| s.unwrap() as f32 / 128.0).collect(),
                        16 => reader.samples::<i16>().map(|s| s.unwrap() as f32 / 32768.0).collect(),
                        24 => reader.samples::<i32>().map(|s| s.unwrap() as f32 / 8388608.0).collect(),
                        32 => reader.samples::<i32>().map(|s| s.unwrap() as f32 / 2147483648.0).collect(),
                        b => anyhow::bail!("Unsupported bit depth: {}", b),
                    },
                    SampleFormat::Float => reader.samples::<f32>().map(|s| s.unwrap()).collect(),
                };

                convert_to_mono_16k(samples, spec.channels as u32, spec.sample_rate as u32)
            }
            "flac" => {
                anyhow::bail!("FLAC not supported. Please convert to WAV using ffmpeg: ffmpeg -i input.flac -ar 16000 -ac 1 output.wav")
            }
            _ => anyhow::bail!("Unsupported file format: {}. Supported: WAV", ext),
        }
    }

    fn convert_to_mono_16k(samples: Vec<f32>, channels: u32, sample_rate: u32) -> Result<Vec<f32>> {
        let mono: Vec<f32> = if channels > 1 {
            samples
                .chunks(channels as usize)
                .map(|chunk| chunk.iter().sum::<f32>() / channels as f32)
                .collect()
        } else {
            samples
        };

        if sample_rate == 16000 {
            return Ok(mono);
        }

        let ratio = sample_rate as f32 / 16000.0;
        let target_len = (mono.len() as f32 / ratio) as usize;
        let mut resampled = Vec::with_capacity(target_len);

        for i in 0..target_len {
            let src_idx = i as f32 * ratio;
            let idx = src_idx as usize;
            if idx + 1 < mono.len() {
                let frac = src_idx - idx as f32;
                let sample = mono[idx] * (1.0 - frac) + mono[idx + 1] * frac;
                resampled.push(sample);
            } else if idx < mono.len() {
                resampled.push(mono[idx]);
            }
        }

        Ok(resampled)
    }

    // Handle file input mode
    if let Some(file_path) = &args.file {
        if let Some(model_path) = &args.model_path {
            let load_start = Instant::now();
            let mut model = WhisperModel::load(model_path)
                .context("Failed to load model")?;
            let load_time = load_start.elapsed().as_secs_f64();

            eprintln!("Model loaded in {:.2}s", load_time);

            let pcm_data = load_audio_file(file_path)
                .context("Failed to load audio file")?;
            eprintln!("Loaded {} samples ({}s)", pcm_data.len(), pcm_data.len() as f64 / 16000.0);

            let transcribe_start = Instant::now();
            let text = model.transcribe(&pcm_data)
                .context("Transcription failed")?;
            let transcribe_time = transcribe_start.elapsed().as_secs_f64();

            println!("Transcription: {}", text);

            if let Some(ref config) = ai_config {
                let cleanup_start = Instant::now();
                match ai::cleanup_text(config, &text).await {
                    Ok(cleaned) => {
                        let cleanup_time = cleanup_start.elapsed().as_secs_f64();
                        println!("AI Cleaned: {}", cleaned);
                        eprintln!("AI cleanup time: {:.2}s", cleanup_time);
                    }
                    Err(e) => {
                        eprintln!("AI cleanup failed: {}", e);
                    }
                }
            }

            eprintln!("Model loading time: {:.2}s", load_time);
            eprintln!("Transcription time: {:.2}s", transcribe_time);

            return Ok(());
        } else {
            anyhow::bail!("--model-path is required when using --file");
        }
    }

    // Channels for Core -> UI/stdout communication
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<Event>();
    // Channels for UI/stdin -> Core communication
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<Command>();

    // Spawn the AI worker if we have a local (llama) backend. The
    // worker pre-loads the GGUF while the user is speaking so the
    // post-stop cleanup doesn't pay the ~1-3s load cost on the
    // critical path. For backend=none we leave this as None and
    // the TranscribeResult::Stopped handler simply emits the raw
    // STT text as the final result.
    let ai_worker = match &ai_config {
        Some(cfg) if cfg.backend == "llama" => {
            if !is_tui {
                eprintln!("Spawning AI worker (warm-model cleanup)");
            }
            Some(ai_worker::AiWorker::spawn(cfg.clone()))
        }
        _ => None,
    };

    // Transcription result channel (tokio mpsc so we can select on it)
    let (transcribe_result_tx, mut transcribe_result_rx) =
        mpsc::unbounded_channel::<TranscribeResult>();

    // Start transcription thread if model path is provided
    let transcribe_cmd_tx = if let Some(ref model_path) = args.model_path {
        let (cmd_tx, _handle) =
            start_transcription_thread(model_path.clone(), transcribe_result_tx.clone(), is_tui);
        Some(cmd_tx)
    } else {
        None
    };

    // Shared state
    let recording = Arc::new(AtomicBool::new(false));
    let audio_buffer = Arc::new(Mutex::new(Vec::<f32>::new()));
    let mono_48k_buffer = Arc::new(Mutex::new(Vec::<f32>::new()));
    let last_snapshot_len = Arc::new(Mutex::new(0usize));
    // On-disk audio retention. The audio callback pushes 16 kHz mono
    // samples into this writer (via try_lock so a main-thread stop
    // transition can't stall the RT thread); start_file opens a new
    // one, stop / stop_file closes it. delete_audio deletes the file.
    let audio_writer: Arc<Mutex<Option<audio_writer::OpusAudioWriter>>> =
        Arc::new(Mutex::new(None));
    let mut last_audio_path: Option<std::path::PathBuf> = None;

    // Initialize Audio
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .context("No input device found")?;

    let config: cpal::StreamConfig = device.default_input_config()?.into();
    if !is_tui {
        eprintln!("Audio device: {}, Channels: {}, Rate: {}",
            device.name()?, config.channels, config.sample_rate.0);
    }

    // Denoise state (RNNoise operates at 48kHz)
    let mut denoiser = if args.denoise {
        Some(DenoiseState::new())
    } else {
        None
    };

    let recording_cb = Arc::clone(&recording);
    let buffer_cb = Arc::clone(&audio_buffer);
    let mono_cb = Arc::clone(&mono_48k_buffer);
    let writer_cb = Arc::clone(&audio_writer);
    let channels = config.channels as usize;
    let event_tx_audio = event_tx.clone();

    let _stream = device.build_input_stream(
        &config,
        move |data: &[f32], _: &cpal::InputCallbackInfo| {
            if !recording_cb.load(Ordering::SeqCst) {
                return;
            }

            let mut mono_48k = mono_cb.lock().unwrap();
            let mut final_buf = buffer_cb.lock().unwrap();
            // Collect the newly-produced 16 kHz samples so we can hand
            // them to the on-disk writer once per callback without
            // holding its lock through the encode loop.
            let mut fresh_samples: Vec<f32> = Vec::new();

            // 1. Downmix to Mono
            for frame in data.chunks(channels) {
                let mono = frame.iter().sum::<f32>() / channels as f32;
                mono_48k.push(mono);
            }

            // 2. Process RNNoise frames (480 samples = 10ms @ 48kHz)
            const FRAME_SIZE: usize = 480;
            while mono_48k.len() >= FRAME_SIZE {
                let in_frame = &mono_48k[..FRAME_SIZE];
                let mut out_frame = [0.0f32; FRAME_SIZE];

                if let Some(ref mut ds) = denoiser {
                    ds.process_frame(&mut out_frame, in_frame);
                } else {
                    out_frame.copy_from_slice(in_frame);
                }

                // 3. Downsample 48kHz -> 16kHz (Average 3 samples)
                let mut sum_sq = 0.0;
                let mut peak_lin = 0.0f32;
                for i in (0..FRAME_SIZE).step_by(3) {
                    let avg = (out_frame[i] + out_frame[i+1] + out_frame[i+2]) / 3.0;
                    final_buf.push(avg);
                    fresh_samples.push(avg);
                    sum_sq += (avg * avg) as f64;
                    let a = avg.abs();
                    if a > peak_lin { peak_lin = a; }
                }

                // 4. Send Level. rms is boosted 5x because the TUI's
                //    level bar is calibrated for that scale (see
                //    tui.rs: `level * 200.0`). peak is raw linear so
                //    the Shell overlay's 20*log10() conversion lands
                //    in a natural [-60, 0] dB range for speech.
                let rms = (sum_sq / (FRAME_SIZE as f64 / 3.0)).sqrt() * 5.0;
                let peak = peak_lin as f64;
                let _ = event_tx_audio.send(Event::Level { rms, peak });

                // Consume processed samples
                mono_48k.drain(..FRAME_SIZE);
            }

            // Release the heavy locks before touching the writer — the
            // writer's push() only sends to a channel but try_lock still
            // costs us a Mutex contention hop on every callback.
            drop(final_buf);
            drop(mono_48k);
            if !fresh_samples.is_empty() {
                if let Ok(guard) = writer_cb.try_lock() {
                    if let Some(w) = guard.as_ref() {
                        w.push(&fresh_samples);
                    }
                }
                // If try_lock fails, the main loop is mid-start/stop and
                // will own the next frame window anyway. Dropping one
                // callback's worth of audio from the retention file is
                // acceptable; the in-memory audio_buffer still has it.
            }
        },
        |err| eprintln!("Audio stream error: {}", err),
        None
    )?;

    _stream.play()?;
    let _ = event_tx.send(Event::Ready);

    // Spawn TUI if requested, otherwise spawn stdin/stdout handlers
    if is_tui {
        let cmd_tx_tui = cmd_tx.clone();
        tokio::spawn(async move {
            if let Err(e) = tui::run_tui(event_rx, cmd_tx_tui).await {
                eprintln!("TUI Error: {}", e);
            }
            std::process::exit(0);
        });
    } else {
        // Task to handle stdout output
        tokio::spawn(async move {
            while let Some(event) = event_rx.recv().await {
                if let Ok(json) = serde_json::to_string(&event) {
                    println!("{}", json);
                }
            }
        });

        // Task to handle stdin commands
        let cmd_tx_stdin = cmd_tx.clone();
        tokio::spawn(async move {
            let stdin = io::stdin();
            for line in stdin.lock().lines() {
                if let Ok(line) = line {
                    if let Ok(cmd) = serde_json::from_str::<Command>(&line) {
                        let _ = cmd_tx_stdin.send(cmd);
                    }
                }
            }
        });
    }

    let mut is_recording = false;
    let mut partial_timer = interval(Duration::from_secs_f64(partial_interval_secs));

    // Sliding-window commit state: audio captured into `audio_buffer` is
    // periodically snipped at a silent boundary, decoded, and appended to
    // `committed_text`. The active buffer only ever holds the current tail,
    // so both partials and the final stop decode run on bounded audio.
    let commit_window_samples = (args.commit_window_secs * 16000.0) as usize;
    let cut_search_samples: usize = 16000 * 3; // look back 3s for a quiet cut point
    let cut_window_samples: usize = 3200;      // 200ms silence window
    let mut committed_text = String::new();

    fn combine_text(prefix: &str, tail: &str) -> String {
        let prefix = prefix.trim_end();
        let tail = tail.trim_start();
        if prefix.is_empty() {
            tail.to_string()
        } else if tail.is_empty() {
            prefix.to_string()
        } else {
            format!("{} {}", prefix, tail)
        }
    }

    // Command processor
    loop {
        tokio::select! {
            Some(cmd) = cmd_rx.recv() => {
                match cmd.cmd.as_str() {
                    "start" | "start_file" => {
                        let is_start_file = cmd.cmd == "start_file";

                        // Writer management must come BEFORE we flip the
                        // recording flag — only "start_file" touches the
                        // writer. Doing this on plain "start" would close
                        // a writer that a preceding "start_file" just
                        // opened (the JS recorder sends them back-to-back),
                        // leaving the retention file with only its two
                        // Ogg header pages and zero audio payload.
                        if is_start_file {
                            if let Some(old) = audio_writer.lock().unwrap().take() {
                                tokio::task::spawn_blocking(move || old.close());
                            }
                            if let Some(path_str) = cmd.path.as_ref() {
                                let path = std::path::PathBuf::from(path_str);
                                match audio_writer::OpusAudioWriter::new(path.clone()) {
                                    Ok(w) => {
                                        *audio_writer.lock().unwrap() = Some(w);
                                        last_audio_path = Some(path);
                                    }
                                    Err(e) => {
                                        eprintln!(
                                            "Speakeasy: audio retention disabled for this recording ({}): {}",
                                            path.display(), e
                                        );
                                        last_audio_path = None;
                                    }
                                }
                            } else {
                                last_audio_path = None;
                            }
                        }

                        recording.store(true, Ordering::SeqCst);
                        audio_buffer.lock().unwrap().clear();
                        mono_48k_buffer.lock().unwrap().clear();
                        *last_snapshot_len.lock().unwrap() = 0;
                        committed_text.clear();
                        is_recording = true;
                        partial_timer.reset();

                        // Kick off the background model warm-up so the
                        // post-stop cleanup doesn't have to load the
                        // GGUF and prefill the system prompt on the
                        // user's critical path. No-op when the worker
                        // is already Warm from a previous recording.
                        if let Some(ref worker) = ai_worker {
                            let _ = worker.send(ai_worker::AiWorkerCmd::PreWarm);
                        }
                    }
                    "stop" | "stop_file" => {
                        // Ignore double-stops. Without this guard, a
                        // second stop drains the (already-empty) tail
                        // buffer, takes `buf.is_empty()` branch below,
                        // and emits Stopped{text:""} — which overrides
                        // the real transcription that the first stop
                        // handed off to the whisper worker.
                        if !is_recording {
                            continue;
                        }
                        recording.store(false, Ordering::SeqCst);
                        is_recording = false;

                        // Keep-alive to the parent: we accepted the stop
                        // and are about to run the final decode. Lets the
                        // parent's stop watchdog extend itself instead of
                        // firing on a legitimately-slow long-audio decode.
                        let _ = event_tx.send(Event::Transcribing);

                        // Drain the remaining tail atomically — anything the
                        // audio callback writes after this point is discarded
                        // (recording flag is already false) but the clear keeps
                        // state consistent for the next recording.
                        let buf: Vec<f32> =
                            std::mem::take(&mut *audio_buffer.lock().unwrap());
                        *last_snapshot_len.lock().unwrap() = 0;

                        // Close the on-disk writer on a blocking pool so
                        // the async runtime stays responsive while the
                        // writer's worker thread flushes its final page.
                        if let Some(w) = audio_writer.lock().unwrap().take() {
                            tokio::task::spawn_blocking(move || w.close());
                        }

                        // WAV saving logic — only captures the tail since
                        // prior chunks have already been committed. Good
                        // enough for short-utterance debugging; for full
                        // recordings we need proper on-disk retention.
                        if let Some(wav_path) = args.debug_save_wav.clone() {
                            let spec = WavSpec {
                                channels: 1,
                                sample_rate: 16000,
                                bits_per_sample: 16,
                                sample_format: SampleFormat::Int,
                            };
                            let mut writer = WavWriter::create(wav_path, spec).unwrap();
                            for &sample in &buf {
                                let amplitude = i16::MAX as f32;
                                writer.write_sample((sample * amplitude) as i16).unwrap();
                            }
                            writer.finalize().unwrap();
                        }

                        // If the tail is empty (user hit stop before any new
                        // audio since the last commit), we can emit Stopped
                        // immediately from committed_text alone.
                        if buf.is_empty() {
                            let final_text = std::mem::take(&mut committed_text);
                            let final_text = final_text.trim().to_string();
                            let _ = event_tx.send(Event::Stopped { text: final_text });
                        } else if let Some(ref cmd_tx) = transcribe_cmd_tx {
                            let _ = cmd_tx.send(TranscribeCmd::TranscribeFinal(buf));
                            // Result arrives via transcribe_result_rx; the
                            // handler combines it with committed_text and
                            // emits Stopped.
                        } else {
                            let _ = event_tx.send(Event::Stopped { text: String::new() });
                        }
                    }
                    "delete_audio" => {
                        // Make sure the writer (if still open) is closed
                        // so its worker has released the file handle
                        // before we unlink. Close on a blocking task to
                        // avoid stalling the runtime, then delete.
                        let writer_opt = audio_writer.lock().unwrap().take();
                        let path = cmd.path
                            .as_ref()
                            .map(std::path::PathBuf::from)
                            .or_else(|| last_audio_path.clone());
                        last_audio_path = None;
                        if let Some(path) = path {
                            tokio::task::spawn_blocking(move || {
                                if let Some(w) = writer_opt {
                                    w.close();
                                }
                                if let Err(e) = std::fs::remove_file(&path) {
                                    if e.kind() != std::io::ErrorKind::NotFound {
                                        eprintln!(
                                            "Speakeasy: delete_audio failed for {}: {}",
                                            path.display(), e
                                        );
                                    }
                                }
                            });
                        } else if let Some(w) = writer_opt {
                            tokio::task::spawn_blocking(move || w.close());
                        }
                    }
                    "quit" => {
                        // Make sure any in-flight retention file is flushed
                        // before the process exits; otherwise a long
                        // recording could lose its tail on an abrupt quit.
                        if let Some(w) = audio_writer.lock().unwrap().take() {
                            w.close();
                        }
                        break;
                    }
                    _ => {}
                }
            }
            // Handle results from the transcription thread
            Some(result) = transcribe_result_rx.recv() => {
                match result {
                    TranscribeResult::Partial(text) => {
                        // Preview = committed prefix + current tail decode.
                        // committed_text is stable across Partial events, so
                        // the UI can keep replacing its display without
                        // flicker.
                        let combined = combine_text(&committed_text, &text);
                        let _ = event_tx.send(Event::Partial { text: combined });
                    }
                    TranscribeResult::Committed(text) => {
                        // Promote the chunk into the committed prefix and
                        // emit a Partial so the UI sees the stable portion
                        // grow. The next tail decode will re-preview
                        // whatever the user has said since this commit.
                        let piece = text.trim();
                        if !piece.is_empty() {
                            committed_text = combine_text(&committed_text, piece);
                        }
                        let _ = event_tx.send(Event::Partial { text: committed_text.clone() });
                    }
                    TranscribeResult::Stopped(tail_text) => {
                        let final_text =
                            combine_text(&committed_text, &tail_text)
                                .trim()
                                .to_string();
                        committed_text.clear();

                        // If AI cleanup is configured, snapshot the raw
                        // text before shipping Stopped so we can feed it
                        // to either the worker (hot path) or the inline
                        // fallback (no worker, e.g. cloud backends if
                        // they ever come back).
                        let text = final_text;
                        let text_for_ai = if ai_config.is_some() { Some(text.clone()) } else { None };
                        let _ = event_tx.send(Event::Stopped { text });

                        if let (Some(ref config), Some(raw_text)) = (&ai_config, text_for_ai) {
                            let event_tx_clone = event_tx.clone();

                            if let Some(ref worker) = ai_worker {
                                // Hot path: the worker likely has a warm
                                // slot (load + prefix prefill already done
                                // while the user was speaking). Only tail
                                // prefill + generation remain. Pass a
                                // clone of `event_tx` so the worker can
                                // emit streaming `Delta` events.
                                let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
                                if worker
                                    .send(ai_worker::AiWorkerCmd::Cleanup {
                                        raw_text,
                                        event_tx: Some(event_tx.clone()),
                                        reply: reply_tx,
                                    })
                                    .is_ok()
                                {
                                    tokio::spawn(async move {
                                        match reply_rx.await {
                                            Ok(Ok(cleaned)) => {
                                                let _ = event_tx_clone
                                                    .send(Event::Final { text: cleaned });
                                            }
                                            Ok(Err(e)) => {
                                                eprintln!("AI cleanup failed: {}", e);
                                            }
                                            Err(_) => {
                                                eprintln!("AI worker dropped cleanup reply");
                                            }
                                        }
                                    });
                                } else {
                                    eprintln!("AI worker channel closed; cleanup skipped");
                                }
                            } else {
                                // Fallback: no worker (future non-llama
                                // backend, or the worker failed to spawn).
                                // Run the dispatcher in a blocking task.
                                let config = config.clone();
                                tokio::spawn(async move {
                                    match ai::cleanup_text(&config, &raw_text).await {
                                        Ok(cleaned) => {
                                            let _ = event_tx_clone
                                                .send(Event::Final { text: cleaned });
                                        }
                                        Err(e) => {
                                            eprintln!("AI cleanup failed: {}", e);
                                        }
                                    }
                                });
                            }
                        }
                    }
                }
            }
            // Periodic partial transcription while recording.
            // When the active buffer has grown past commit_window_samples we
            // snip it at a silent boundary and promote that chunk into the
            // committed prefix; otherwise we just preview the current tail.
            _ = partial_timer.tick(), if is_recording => {
                if let Some(ref cmd_tx) = transcribe_cmd_tx {
                    let mut buf = audio_buffer.lock().unwrap();
                    if buf.len() >= commit_window_samples {
                        let target = commit_window_samples.min(buf.len());
                        let cut = find_silent_cut(
                            &buf,
                            target,
                            cut_search_samples,
                            cut_window_samples,
                        );
                        // Guard: never commit zero (would spin) and never
                        // commit past the buffer end.
                        let cut = cut.clamp(cut_window_samples.min(buf.len()), buf.len());
                        let committed_chunk: Vec<f32> = buf.drain(..cut).collect();
                        drop(buf);
                        *last_snapshot_len.lock().unwrap() = 0;
                        let _ = cmd_tx.send(TranscribeCmd::Commit(committed_chunk));
                    } else {
                        let current_len = buf.len();
                        let last_len = *last_snapshot_len.lock().unwrap();
                        if current_len > last_len + 16000 {
                            let snapshot = buf.clone();
                            drop(buf);
                            *last_snapshot_len.lock().unwrap() = current_len;
                            let _ = cmd_tx.send(TranscribeCmd::Partial(snapshot));
                        }
                    }
                }
            }
        }
    }

    // Drop command sender to signal transcription thread to exit
    drop(transcribe_cmd_tx);

    Ok(())
}