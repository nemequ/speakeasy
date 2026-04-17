mod tui;
mod ai;
mod ai_local;

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
    Level { rms: f64 },
    Stopped { text: String },
    Error { message: String },
}

#[derive(Deserialize, Debug)]
pub struct Command {
    pub cmd: String,
}

#[derive(Debug)]
enum TranscribeCmd {
    Transcribe(Vec<f32>),
    TranscribeAndStop(Vec<f32>),
}

#[derive(Debug)]
enum TranscribeResult {
    Partial(String),
    Stopped(String),
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
            let cmd = match cmd_rx.recv() {
                Ok(c) => c,
                Err(_) => break,
            };

            // For partial transcriptions, drain the queue and only process the
            // most recent snapshot — older ones are strict subsets of newer ones
            // since we always send the full buffer from the start.
            let cmd = {
                let mut latest = cmd;
                while let Ok(newer) = cmd_rx.try_recv() {
                    latest = newer;
                }
                latest
            };

            match cmd {
                TranscribeCmd::Transcribe(audio) => {
                    let text = match model.transcribe(&audio) {
                        Ok(t) => t,
                        Err(e) => format!("Error: {}", e),
                    };
                    let _ = result_tx.send(TranscribeResult::Partial(text));
                }
                TranscribeCmd::TranscribeAndStop(audio) => {
                    let text = match model.transcribe(&audio) {
                        Ok(t) => t,
                        Err(e) => format!("Error: {}", e),
                    };
                    let _ = result_tx.send(TranscribeResult::Stopped(text));
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
                for i in (0..FRAME_SIZE).step_by(3) {
                    let avg = (out_frame[i] + out_frame[i+1] + out_frame[i+2]) / 3.0;
                    final_buf.push(avg);
                    sum_sq += (avg * avg) as f64;
                }

                // 4. Send Level (Boosted for TUI visibility)
                let rms = (sum_sq / (FRAME_SIZE as f64 / 3.0)).sqrt() * 5.0;
                let _ = event_tx_audio.send(Event::Level { rms });

                // Consume processed samples
                mono_48k.drain(..FRAME_SIZE);
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

    // Command processor
    loop {
        tokio::select! {
            Some(cmd) = cmd_rx.recv() => {
                match cmd.cmd.as_str() {
                    "start" | "start_file" => {
                        recording.store(true, Ordering::SeqCst);
                        audio_buffer.lock().unwrap().clear();
                        mono_48k_buffer.lock().unwrap().clear();
                        *last_snapshot_len.lock().unwrap() = 0;
                        is_recording = true;
                        partial_timer.reset();
                    }
                    "stop" | "stop_file" => {
                        recording.store(false, Ordering::SeqCst);
                        is_recording = false;

                        let buf = audio_buffer.lock().unwrap().clone();

                        // WAV saving logic
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

                        // Send final transcription to the transcription thread
                        if let Some(ref cmd_tx) = transcribe_cmd_tx {
                            if !buf.is_empty() {
                                let _ = cmd_tx.send(TranscribeCmd::TranscribeAndStop(buf));
                                // Result arrives via transcribe_result_rx, handled below
                            } else {
                                let _ = event_tx.send(Event::Stopped { text: String::new() });
                            }
                        } else {
                            let _ = event_tx.send(Event::Stopped { text: String::new() });
                        }
                    }
                    "quit" => break,
                    _ => {}
                }
            }
            // Handle results from the transcription thread
            Some(result) = transcribe_result_rx.recv() => {
                match result {
                    TranscribeResult::Partial(text) => {
                        let _ = event_tx.send(Event::Partial { text });
                    }
                    TranscribeResult::Stopped(text) => {
                        // If AI cleanup is configured, spawn a task to clean the text
                        let text_for_ai = if ai_config.is_some() { Some(text.clone()) } else { None };
                        let _ = event_tx.send(Event::Stopped { text });

                        if let (Some(ref config), Some(raw_text)) = (&ai_config, text_for_ai) {
                            let config = config.clone();
                            let event_tx_clone = event_tx.clone();
                            tokio::spawn(async move {
                                match ai::cleanup_text(&config, &raw_text).await {
                                    Ok(cleaned) => {
                                        let _ = event_tx_clone.send(Event::Final { text: cleaned });
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
            // Periodic partial transcription while recording
            _ = partial_timer.tick(), if is_recording => {
                if let Some(ref cmd_tx) = transcribe_cmd_tx {
                    let current_len = audio_buffer.lock().unwrap().len();
                    let last_len = *last_snapshot_len.lock().unwrap();

                    // Only transcribe if we have new audio (at least 1s = 16000 samples)
                    if current_len > last_len + 16000 {
                        let buf = audio_buffer.lock().unwrap().clone();
                        *last_snapshot_len.lock().unwrap() = buf.len();
                        let _ = cmd_tx.send(TranscribeCmd::Transcribe(buf));
                    }
                }
            }
        }
    }

    // Drop command sender to signal transcription thread to exit
    drop(transcribe_cmd_tx);

    Ok(())
}