mod tui;
mod audio_writer;

use anyhow::{Context, Result};
use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
use clap::{Args as ClapArgs, Parser, Subcommand};
use std::time::Instant;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use nnnoiseless::DenoiseState;
use serde::{Deserialize, Serialize};
use serde_json::json;
use speakeasy::event::Event;
use speakeasy::file_transcribe::{self, FileTranscribeOptions};
use speakeasy::keybinding::{
    Keybinding, KeybindingConfig, KeybindingOutput, KeybindingState, ReleaseMode,
};
use speakeasy::model_catalog;
use speakeasy::session_log::{self, SessionLog};
use speakeasy::transcript_store::{self, TranscriptEntry};
use speakeasy::{data_paths, WhisperModel};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::sync::mpsc as std_mpsc;
use tokio::sync::mpsc;
use tokio::time::{interval, Duration};
use uuid::Uuid;

// ─── CLI definition ─────────────────────────────────────────────────

/// Speakeasy Core (Rust) — High-performance STT and Audio engine.
#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    // Preserve the original top-level flags so `speakeasy --model-path X`
    // with no subcommand keeps working (defaults to running the daemon).
    #[command(flatten)]
    daemon_args: DaemonArgs,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Run the interactive stdin/stdout daemon (default).
    Daemon(DaemonArgs),
    /// Transcribe a single audio file, emitting progress/finals.
    TranscribeFile(TranscribeFileArgs),
    /// List saved transcripts.
    ListTranscripts(ListTranscriptsArgs),
    /// Print a full transcript by id.
    ReadTranscript(ReadTranscriptArgs),
    /// Delete a transcript by id.
    DeleteTranscript(DeleteTranscriptArgs),
    /// Recover orphaned session logs into transcripts.
    RecoverOrphans(RecoverOrphansArgs),
    /// List available Whisper models, marking which are installed.
    ListModels(ListModelsArgs),
    /// Download a model from the catalog.
    DownloadModel(DownloadModelArgs),
    /// List available audio input devices.
    ListInputDevices(ListInputDevicesArgs),
    /// Save a transcript read from stdin into the transcript store.
    ///
    /// Expects a single JSON object on stdin with at least `raw_text`;
    /// generates an id + timestamp when omitted. Designed for external
    /// writers (e.g. the macOS "Recover from Audio File…" flow) that
    /// want the same on-disk shape as live-session saves without
    /// reaching into `transcript_store` directly.
    SaveTranscript(SaveTranscriptArgs),
}

#[derive(ClapArgs, Debug, Clone)]
struct DaemonArgs {
    /// STT backend (only whisper-rs supported in Rust core for now)
    #[arg(short, long, default_value = "whisper-rs")]
    backend: String,

    /// Path to Whisper model directory (containing config.json, etc.)
    #[arg(short, long)]
    model_path: Option<String>,

    /// Enable TUI mode
    #[arg(short, long, default_value_t = false)]
    tui: bool,

    /// Enable RNNoise-based noise cancellation (default: off).
    ///
    /// When enabled, the capture path requests 48 kHz from the device so
    /// RNNoise (which only operates on 48 kHz frames) can run, then
    /// downsamples to 16 kHz for whisper. Whisper is trained on noisy
    /// input and typically performs *worse* with aggressive denoising,
    /// so the default is off.
    ///
    /// Accepts `--denoise` (true), `--denoise=true/false`, and the
    /// explicit negation `--no-denoise`.
    #[arg(
        short,
        long,
        default_value_t = false,
        num_args = 0..=1,
        default_missing_value = "true",
        action = clap::ArgAction::Set,
    )]
    denoise: bool,

    /// Explicit opt-out that forces `denoise=false` regardless of
    /// `--denoise`. Having both lets frontends that always pass
    /// `--denoise` (e.g. from a settings template) send a single
    /// `--no-denoise` to override without having to rewrite their
    /// argument list.
    #[arg(long, default_value_t = false, hide = true)]
    no_denoise: bool,

    /// Save the recorded audio to a WAV file for debugging
    #[arg(long)]
    debug_save_wav: Option<String>,

    /// Input audio file (WAV or FLAC) instead of microphone (legacy path)
    #[arg(long)]
    file: Option<String>,

    /// Interval for partial transcriptions in seconds
    #[arg(long, default_value_t = 1.5)]
    partial_interval: f64,

    /// Max active-buffer length before a commit-decode fires, in seconds.
    #[arg(long, default_value_t = 15.0)]
    commit_window_secs: f64,

    /// Deprecated/no-op. AI text cleanup has been removed — the daemon
    /// always emits raw Whisper text. Still accepted (and ignored, with a
    /// warning when not "none") so existing frontends that pass it don't
    /// break their subprocess launch.
    #[arg(long, default_value = "none")]
    ai_backend: String,

    /// Deprecated/no-op. Accepted but ignored (AI cleanup removed).
    #[arg(long)]
    ai_model: Option<String>,

    /// Deprecated/no-op. Accepted but ignored (AI cleanup removed).
    #[arg(long)]
    system_prompt_path: Option<String>,

    /// Input audio device name (as reported by `list-input-devices`).
    /// If unset or not found, falls back to the system default
    /// input device and logs a warning. The daemon does not
    /// hot-swap on `set_input_device` commands yet — the frontend
    /// respawns the daemon process to pick up changes.
    #[arg(long)]
    input_device: Option<String>,

    /// Override the platform data root (under which
    /// `sessions/`/`transcripts/`/`audio/` are created). Primarily for
    /// integration tests that need to redirect writes into a temp dir.
    #[arg(long, hide = true)]
    app_data_dir: Option<PathBuf>,
}

#[derive(ClapArgs, Debug)]
struct TranscribeFileArgs {
    /// Path to the audio file to transcribe.
    path: PathBuf,
    /// Model path (directory containing a `ggml-*.bin` or a direct
    /// `.bin`). Defaults to the first installed model.
    #[arg(long)]
    model: Option<PathBuf>,
    /// Stream NDJSON events to stdout rather than a human summary.
    #[arg(long, default_value_t = false)]
    json_events: bool,
    /// Chunk size (seconds) for periodic progress/partial events.
    #[arg(long)]
    chunk_seconds: Option<f64>,
    /// Disable streaming partial previews.
    #[arg(long, default_value_t = false)]
    no_partials: bool,
}

#[derive(ClapArgs, Debug)]
struct ListTranscriptsArgs {
    /// Directory of transcript JSONs. Defaults to the platform data dir.
    #[arg(long)]
    dir: Option<PathBuf>,
    /// Emit JSON rather than a readable table.
    #[arg(long, default_value_t = false)]
    json: bool,
}

#[derive(ClapArgs, Debug)]
struct ReadTranscriptArgs {
    /// Transcript id (filename stem, no `.json` extension).
    id: String,
    #[arg(long)]
    dir: Option<PathBuf>,
}

#[derive(ClapArgs, Debug)]
struct DeleteTranscriptArgs {
    id: String,
    #[arg(long)]
    dir: Option<PathBuf>,
}

#[derive(ClapArgs, Debug)]
struct RecoverOrphansArgs {
    /// Directory of session JSONL files. Defaults to the platform data dir.
    #[arg(long)]
    sessions_dir: Option<PathBuf>,
    /// Destination for recovered transcripts. Defaults to the platform data dir.
    #[arg(long)]
    transcripts_dir: Option<PathBuf>,
    /// Emit NDJSON events on stdout as each orphan is processed.
    #[arg(long, default_value_t = false)]
    json_events: bool,
}

#[derive(ClapArgs, Debug)]
struct ListModelsArgs {
    #[arg(long)]
    models_dir: Option<PathBuf>,
    #[arg(long, default_value_t = false)]
    json: bool,
}

#[derive(ClapArgs, Debug)]
struct DownloadModelArgs {
    /// Model name (e.g. `small.en`, `large-v3-turbo`).
    name: String,
    #[arg(long)]
    models_dir: Option<PathBuf>,
    /// Emit NDJSON progress events to stdout.
    #[arg(long, default_value_t = false)]
    json_events: bool,
}

#[derive(ClapArgs, Debug)]
struct ListInputDevicesArgs {
    #[arg(long, default_value_t = false)]
    json: bool,
}

#[derive(ClapArgs, Debug)]
struct SaveTranscriptArgs {
    /// Destination directory. Defaults to the platform transcripts dir.
    #[arg(long)]
    dir: Option<PathBuf>,
    /// Emit the resulting entry id as a JSON object on stdout.
    #[arg(long, default_value_t = false)]
    json: bool,
}

/// Wire shape the `save-transcript` subcommand accepts on stdin. Every
/// field is optional except `raw_text`; anything missing is filled in
/// with a sane default so the caller only needs to send what it knows.
#[derive(Deserialize, Debug, Default)]
struct SaveTranscriptInput {
    /// Transcript id (filename stem). Generated from timestamp if omitted.
    #[serde(default)]
    id: Option<String>,
    /// ISO-8601 timestamp. Defaults to `chrono::Utc::now()` if omitted.
    #[serde(default)]
    timestamp: Option<String>,
    /// Required-ish: the user's original transcribed text. An empty
    /// string is allowed — the frontend may choose to save "no speech
    /// recognized" entries for audit purposes — but the field must be
    /// present.
    raw_text: String,
    #[serde(default)]
    cleaned_text: Option<String>,
    #[serde(default)]
    audio_path: Option<PathBuf>,
    #[serde(default)]
    ai_enabled: Option<bool>,
    #[serde(default)]
    recovered: Option<bool>,
    #[serde(default)]
    recovered_from: Option<String>,
    #[serde(default)]
    recovered_complete: Option<bool>,
}

// ─── Daemon protocol types ──────────────────────────────────────────
// Event is defined in speakeasy::event and re-imported above.

// We keep the original event serialization (`"event":"ready"`, etc.)
// for the pre-existing variants. Serde's `rename_all = "snake_case"` on
// the tag produces "ready"/"partial"/"final"/"delta"/"level"/
// "transcribing"/"stopped"/"error"/"state_change"/"saved"; the
// first 8 match the pre-1.5 protocol exactly.

/// Command sent via stdin. The optional fields are only populated for
/// the subset of commands that use them; serde ignores unknown keys.
#[derive(Deserialize, Debug, Default)]
pub struct IncomingCommand {
    pub cmd: String,
    // Path for start_file / delete_audio.
    #[serde(default)]
    pub path: Option<String>,
    // Monotonic timestamp (ms) for key_press / key_release / key_repeat.
    #[serde(default)]
    pub ts: Option<u64>,
    // Configuration for configure_keybinding.
    #[serde(default)]
    pub release_gap_ms: Option<u64>,
    #[serde(default)]
    pub inter_tap_gap_ms: Option<u64>,
    #[serde(default)]
    pub repeat_delay_ms: Option<u64>,
    #[serde(default)]
    pub double_tap_window_ms: Option<u64>,
    #[serde(default)]
    pub hold_threshold: Option<u32>,
    // Either "real" or "gap_detected" / "gapdetected" / "gap"
    #[serde(default)]
    pub release_mode: Option<String>,
}

#[derive(Debug)]
enum TranscribeCmd {
    Partial(Vec<f32>),
    Commit(Vec<f32>),
    TranscribeFinal(Vec<f32>),
}

#[derive(Debug)]
enum TranscribeResult {
    Partial(String),
    Committed(String),
    Stopped(String),
}

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
) -> (std_mpsc::Sender<TranscribeCmd>, thread::JoinHandle<()>) {
    let (cmd_tx, cmd_rx) = std_mpsc::channel();

    let handle = thread::spawn(move || {
        if suppress_stderr {
            unsafe {
                let devnull = libc::open(b"/dev/null\0".as_ptr() as *const _, libc::O_WRONLY);
                if devnull >= 0 {
                    libc::dup2(devnull, 2);
                    libc::close(devnull);
                }
            }
        }

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

// ─── Utility helpers ────────────────────────────────────────────────

fn state_label(state: KeybindingState) -> &'static str {
    match state {
        KeybindingState::Idle => "idle",
        KeybindingState::Recording => "recording",
        KeybindingState::Locked => "locked",
        KeybindingState::Processing => "processing",
    }
}

fn monotonic_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    // std::time::Instant is monotonic but opaque; for the state machine
    // we just need a consistent u64 in ms. Wall clock is acceptable for
    // the daemon's own synthetic timestamps — the frontend supplies its
    // own `ts` for every real key event anyway.
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn release_mode_from_str(s: &str) -> Option<ReleaseMode> {
    match s.to_ascii_lowercase().as_str() {
        "real" => Some(ReleaseMode::Real),
        "gap" | "gap_detected" | "gapdetected" => Some(ReleaseMode::GapDetected),
        _ => None,
    }
}

// ─── Entry point ────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        None => run_daemon(cli.daemon_args).await,
        Some(Command::Daemon(args)) => run_daemon(args).await,
        Some(Command::TranscribeFile(args)) => run_transcribe_file(args).await,
        Some(Command::ListTranscripts(args)) => run_list_transcripts(args),
        Some(Command::ReadTranscript(args)) => run_read_transcript(args),
        Some(Command::DeleteTranscript(args)) => run_delete_transcript(args),
        Some(Command::RecoverOrphans(args)) => run_recover_orphans(args),
        Some(Command::ListModels(args)) => run_list_models(args),
        Some(Command::DownloadModel(args)) => run_download_model(args).await,
        Some(Command::ListInputDevices(args)) => run_list_input_devices(args),
        Some(Command::SaveTranscript(args)) => run_save_transcript(args),
    }
}

// ─── Subcommand: transcribe-file ────────────────────────────────────

async fn run_transcribe_file(args: TranscribeFileArgs) -> Result<()> {
    // Pick the model: explicit > first installed catalog entry > error.
    let model_path = match args.model {
        Some(p) => p,
        None => pick_default_model_path()?,
    };

    let mut opts = FileTranscribeOptions::default();
    if let Some(cs) = args.chunk_seconds {
        opts.chunk_seconds = cs;
    }
    if args.no_partials {
        opts.emit_partials = false;
    }

    let stdout = io::stdout();
    let mut handle = stdout.lock();

    if args.json_events {
        let summary =
            file_transcribe::transcribe_file(&args.path, &model_path, &opts, &mut handle)?;
        // Nothing extra — events were streamed inline.
        let _ = summary;
    } else {
        // Human-readable mode: still need to satisfy the module's
        // writer arg. Write events into a sink we ignore.
        let mut sink = io::sink();
        let summary =
            file_transcribe::transcribe_file(&args.path, &model_path, &opts, &mut sink)?;
        writeln!(
            handle,
            "Transcribed {} ({:.2}s audio) into {} chunk(s):",
            args.path.display(),
            summary.duration_secs,
            summary.finals_count,
        )?;
        writeln!(handle, "{}", summary.raw_text)?;
    }
    Ok(())
}

fn pick_default_model_path() -> Result<PathBuf> {
    let models_dir = data_paths::models_dir();
    for info in model_catalog::catalog() {
        if model_catalog::is_installed(&info, &models_dir) {
            return Ok(model_catalog::installed_path(&info, &models_dir));
        }
    }
    // Fall back to the whole models dir so WhisperModel::load() can
    // still find a non-catalog .bin file.
    if models_dir.exists() {
        return Ok(models_dir);
    }
    anyhow::bail!(
        "no model provided and no catalog model installed under {}",
        models_dir.display()
    )
}

// ─── Subcommand: list-transcripts ───────────────────────────────────

fn run_list_transcripts(args: ListTranscriptsArgs) -> Result<()> {
    let dir = args.dir.unwrap_or_else(data_paths::transcripts_dir);
    let entries = transcript_store::list_transcripts(&dir)?;
    let stdout = io::stdout();
    let mut handle = stdout.lock();
    if args.json {
        let json = serde_json::to_string_pretty(&entries).context("serialize transcripts")?;
        writeln!(handle, "{}", json)?;
    } else {
        if entries.is_empty() {
            writeln!(handle, "(no transcripts in {})", dir.display())?;
            return Ok(());
        }
        for e in &entries {
            let snippet: String =
                e.raw_text.chars().take(60).collect::<String>().replace('\n', " ");
            writeln!(handle, "{}  {}  {}", e.timestamp, e.id, snippet)?;
        }
    }
    Ok(())
}

// ─── Subcommand: read-transcript ────────────────────────────────────

fn run_read_transcript(args: ReadTranscriptArgs) -> Result<()> {
    let dir = args.dir.unwrap_or_else(data_paths::transcripts_dir);
    let entry = transcript_store::read_transcript_by_id(&dir, &args.id)?;
    let json = serde_json::to_string_pretty(&entry).context("serialize transcript")?;
    println!("{}", json);
    Ok(())
}

// ─── Subcommand: delete-transcript ──────────────────────────────────

fn run_delete_transcript(args: DeleteTranscriptArgs) -> Result<()> {
    let dir = args.dir.unwrap_or_else(data_paths::transcripts_dir);
    transcript_store::delete_transcript(&dir, &args.id)?;
    println!("deleted transcript id={} from {}", args.id, dir.display());
    Ok(())
}

// ─── Subcommand: recover-orphans ────────────────────────────────────

fn run_recover_orphans(args: RecoverOrphansArgs) -> Result<()> {
    let sessions_dir = args.sessions_dir.unwrap_or_else(data_paths::sessions_dir);
    let transcripts_dir = args
        .transcripts_dir
        .unwrap_or_else(data_paths::transcripts_dir);
    let results = session_log::recover_orphans(&sessions_dir, &transcripts_dir)?;

    let stdout = io::stdout();
    let mut handle = stdout.lock();
    if args.json_events {
        for r in &results {
            let id = r
                .transcript
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            let event = json!({
                "event": "saved",
                "transcript_id": id,
                "recovered": true,
            });
            writeln!(handle, "{}", event)?;
        }
    } else {
        if results.is_empty() {
            writeln!(handle, "(no orphans recovered)")?;
        } else {
            for r in &results {
                writeln!(
                    handle,
                    "recovered {} -> {}",
                    r.source.display(),
                    r.transcript.display()
                )?;
            }
        }
    }
    Ok(())
}

// ─── Subcommand: list-models ────────────────────────────────────────

fn run_list_models(args: ListModelsArgs) -> Result<()> {
    let models_dir = args.models_dir.unwrap_or_else(data_paths::models_dir);
    let catalog = model_catalog::catalog();

    #[derive(Serialize)]
    struct ModelRow<'a> {
        name: &'a str,
        filename: &'a str,
        size_bytes: u64,
        installed: bool,
        path: Option<String>,
    }

    let rows: Vec<ModelRow> = catalog
        .iter()
        .map(|m| {
            let installed = model_catalog::is_installed(m, &models_dir);
            let path = if installed {
                Some(model_catalog::installed_path(m, &models_dir))
            } else {
                None
            };
            ModelRow {
                name: &m.name,
                filename: &m.filename,
                size_bytes: m.size_bytes,
                installed,
                path: path.map(|p| p.to_string_lossy().into_owned()),
            }
        })
        .collect();

    let stdout = io::stdout();
    let mut handle = stdout.lock();
    if args.json {
        writeln!(handle, "{}", serde_json::to_string_pretty(&rows)?)?;
    } else {
        writeln!(handle, "Models dir: {}", models_dir.display())?;
        for r in &rows {
            let marker = if r.installed { "[x]" } else { "[ ]" };
            writeln!(
                handle,
                "{} {:<16} {:>12} B  ({})",
                marker, r.name, r.size_bytes, r.filename
            )?;
        }
    }
    Ok(())
}

// ─── Subcommand: download-model ─────────────────────────────────────

async fn run_download_model(args: DownloadModelArgs) -> Result<()> {
    let models_dir = args.models_dir.unwrap_or_else(data_paths::models_dir);
    let info = model_catalog::find(&args.name)
        .ok_or_else(|| anyhow::anyhow!("unknown model: {}", args.name))?;

    let json_events = args.json_events;
    let stdout = io::stdout();
    // Share `stdout` across the progress closure — the closure fires
    // synchronously inside the downloader's task.
    let stdout_mutex = Arc::new(Mutex::new(stdout));
    let stdout_for_cb = Arc::clone(&stdout_mutex);

    let result = model_catalog::download(info, &models_dir, move |p| {
        if !json_events {
            return;
        }
        if let Ok(handle) = stdout_for_cb.lock() {
            let event = json!({
                "event": "progress",
                "downloaded": p.downloaded,
                "total": p.total,
            });
            let _ = writeln!(handle.lock(), "{}", event);
        }
    })
    .await?;

    if json_events {
        if let Ok(handle) = stdout_mutex.lock() {
            let event = json!({
                "event": "downloaded",
                "name": info.name,
                "path": result.to_string_lossy(),
            });
            let _ = writeln!(handle.lock(), "{}", event);
        }
    } else {
        println!("downloaded {} -> {}", info.name, result.display());
    }
    Ok(())
}

// ─── Subcommand: list-input-devices ─────────────────────────────────

fn run_list_input_devices(args: ListInputDevicesArgs) -> Result<()> {
    let host = cpal::default_host();
    let default_name = host
        .default_input_device()
        .and_then(|d| d.name().ok());

    #[derive(Serialize)]
    struct DeviceRow {
        name: String,
        default: bool,
    }

    let mut rows: Vec<DeviceRow> = Vec::new();
    match host.input_devices() {
        Ok(iter) => {
            for dev in iter {
                let name = dev.name().unwrap_or_else(|_| "(unknown)".to_string());
                let is_default = default_name.as_deref() == Some(name.as_str());
                rows.push(DeviceRow {
                    name,
                    default: is_default,
                });
            }
        }
        Err(e) => {
            // Surface the error as an empty list on non-JSON, or a JSON
            // error event. Don't bail — a user with no devices should
            // still get a clean exit.
            if args.json {
                println!("{}", json!({"event": "error", "message": e.to_string()}));
                return Ok(());
            } else {
                eprintln!("error enumerating input devices: {}", e);
            }
        }
    }

    if args.json {
        println!("{}", serde_json::to_string_pretty(&rows)?);
    } else if rows.is_empty() {
        println!("(no input devices)");
    } else {
        for r in &rows {
            let marker = if r.default { "*" } else { " " };
            println!("{} {}", marker, r.name);
        }
    }
    Ok(())
}

// ─── Subcommand: save-transcript ────────────────────────────────────

/// Read a single JSON object from stdin and persist it as a transcript.
/// Missing optional fields are filled in:
///   - `timestamp` defaults to now
///   - `id` is derived from the timestamp (mirroring the live-session
///     path in `save_transcript_and_emit`), suffixed with `-recovered`
///     when `recovered == true`
///   - `ai_enabled` defaults to false
///
/// On success (and with `--json`), prints
/// `{"id": "...", "path": "...", "timestamp": "..."}` so the caller can
/// correlate the saved transcript back to its live state. This exists
/// so external writers (Swift frontend's "Recover from Audio File…"
/// flow) can use the same on-disk schema as live-session saves without
/// reimplementing `transcript_store.rs`.
fn run_save_transcript(args: SaveTranscriptArgs) -> Result<()> {
    let dir = args.dir.unwrap_or_else(data_paths::transcripts_dir);

    // Slurp stdin. Transcripts are small (at most a few KB of text) so
    // a single read is fine.
    let mut buf = String::new();
    io::Read::read_to_string(&mut io::stdin(), &mut buf)
        .context("read stdin")?;
    if buf.trim().is_empty() {
        anyhow::bail!("save-transcript: empty stdin (expected a JSON object)");
    }

    let input: SaveTranscriptInput = serde_json::from_str(buf.trim())
        .context("parse transcript JSON from stdin")?;

    let timestamp = input.timestamp.unwrap_or_else(|| {
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    });
    let ts_for_file = timestamp.replace([':', '.'], "-");
    let recovered = input.recovered.unwrap_or(false);
    let id = input.id.unwrap_or_else(|| {
        if recovered {
            format!("transcript-{}-recovered", ts_for_file)
        } else {
            format!("transcript-{}", ts_for_file)
        }
    });

    let entry = TranscriptEntry {
        id: id.clone(),
        timestamp: timestamp.clone(),
        raw_text: input.raw_text,
        cleaned_text: input.cleaned_text,
        audio_path: input.audio_path,
        ai_enabled: input.ai_enabled.unwrap_or(false),
        recovered,
        recovered_from: input.recovered_from,
        recovered_complete: input.recovered_complete,
    };

    let path = transcript_store::save_transcript(&dir, &entry)?;

    if args.json {
        let event = json!({
            "id": id,
            "timestamp": timestamp,
            "path": path.to_string_lossy(),
        });
        println!("{}", event);
    } else {
        println!("saved transcript id={} -> {}", id, path.display());
    }
    Ok(())
}

// ─── Daemon ─────────────────────────────────────────────────────────

async fn run_daemon(args: DaemonArgs) -> Result<()> {
    let is_tui = args.tui;
    let partial_interval_secs = args.partial_interval;

    let denoise_requested = args.denoise && !args.no_denoise;
    if !is_tui {
        eprintln!(
            "Speakeasy Core (Rust) starting. Backend: {}, Denoise: {}",
            args.backend, denoise_requested
        );
    }

    // AI text cleanup has been removed — the daemon always emits raw
    // Whisper output. `--ai-backend`/`--ai-model`/`--system-prompt-path`
    // are still accepted (so existing frontends don't break) but ignored.
    if args.ai_backend != "none" && !is_tui {
        eprintln!(
            "Speakeasy: AI cleanup was removed; ignoring --ai-backend={} (emitting raw text)",
            args.ai_backend
        );
    }

    // Legacy --file path — kept so existing callers/tests work. Does
    // not run the daemon loop. The transcribe-file subcommand is the
    // preferred path.
    if let Some(file_path) = &args.file {
        return run_legacy_file_mode(&args, file_path).await;
    }

    // ─── Data dirs + orphan recovery ────────────────────────────
    //
    // Running orphan recovery before the event loop matches the JS
    // controller behavior: a crashed session left behind a JSONL log
    // that now becomes a recovered transcript. Each recovery emits a
    // `saved` event so the frontend can surface a notification.
    // Honor `--app-data-dir` when provided so tests can redirect the
    // session log + transcript writes into a scratch directory.
    let (sessions_dir, transcripts_dir) = match args.app_data_dir.as_ref() {
        Some(root) => {
            let paths = data_paths::DataPaths::with_root(root.clone());
            (paths.sessions(), paths.transcripts())
        }
        None => (
            data_paths::sessions_dir(),
            data_paths::transcripts_dir(),
        ),
    };

    let recovered = session_log::recover_orphans(&sessions_dir, &transcripts_dir)
        .unwrap_or_else(|e| {
            eprintln!("Speakeasy: orphan recovery failed: {}", e);
            Vec::new()
        });

    // Channels for Core -> UI/stdout communication
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<Event>();
    // Channels for UI/stdin -> Core communication
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<IncomingCommand>();

    for r in recovered {
        let id = r
            .transcript
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let _ = event_tx.send(Event::Saved {
            transcript_id: id,
            recovered: true,
            updated: None,
            skip_paste: false,
        });
    }

    // Transcription result channel
    let (transcribe_result_tx, mut transcribe_result_rx) =
        mpsc::unbounded_channel::<TranscribeResult>();

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
    // Scratch buffer used by the denoise path to accumulate up to one
    // RNNoise frame (480 samples at 48 kHz). Kept out of `audio_buffer`
    // so the active-buffer + commit-window math stays in whisper's 16
    // kHz frame of reference.
    let denoise_scratch = Arc::new(Mutex::new(Vec::<f32>::new()));
    let last_snapshot_len = Arc::new(Mutex::new(0usize));
    let audio_writer: Arc<Mutex<Option<audio_writer::OpusAudioWriter>>> =
        Arc::new(Mutex::new(None));
    let mut last_audio_path: Option<PathBuf> = None;

    // Session log + per-recording uuid.
    let mut session_log: Option<SessionLog> = None;
    let mut session_uuid: Option<String> = None;
    let mut session_audio_path: Option<PathBuf> = None;

    // Id of the most recently saved transcript. Used by the AI-cleanup
    // path to backfill `cleaned_text` onto the on-disk transcript once
    // the worker replies with the cleaned version.
    let mut last_saved_transcript_id: Option<String> = None;

    // When true the next `Saved` event emitted for this recording will
    // carry `skip_paste: true`. Set by the `cancel` command (a stop
    // that saves the transcript but suppresses the auto-paste). Cleared
    // after the Saved event fires.
    let mut skip_paste_for_current_recording: bool = false;

    // Keybinding FSM. Default to GapDetected so the (legacy) GNOME
    // frontend works out of the box; the macOS frontend sends a
    // `configure_keybinding {release_mode:"real"}` on startup.
    let mut keybinding = Keybinding::new(KeybindingConfig::default());
    let mut last_fsm_state = KeybindingState::Idle;

    // ─── Audio capture setup ────────────────────────────────────
    //
    // Two modes:
    //   - Denoise OFF (default): request 16 kHz mono from cpal. On
    //     macOS CoreAudio will transparently resample from any input
    //     device's native rate (MacBook mic, Shokz OpenComm2 @ 16 kHz,
    //     Zoom virtual device, etc.). If cpal can't honor the request
    //     (rare: some USB interfaces), fall back to the device default
    //     and resample in software below.
    //   - Denoise ON: request 48 kHz because RNNoise only operates on
    //     48 kHz frames. Run denoise, then resample down to 16 kHz.
    //
    // Requesting rather than always taking the device default
    // replaces the old "assume 48 kHz, average triples to 'downsample'"
    // path in this callback — that path produced 3× speed audio when
    // the device was natively 16 kHz (e.g. Shokz headsets). See
    // `plans/sgtm-ancient-starfish.md` for the bug history.
    //
    // The stream itself is held as `Option<cpal::Stream>` below so the
    // start handler can rebuild it on each `start` command. This is
    // what makes "system default means current default at record time"
    // actually true — if the user plugs in a headset after the daemon
    // launched, the next `start` re-queries cpal and targets the new
    // device. See the rebuild block in the `start`/`start_file` arm.
    //
    // cpal::Stream is `!Send`. `run_daemon` is the top-level future of
    // `#[tokio::main]`'s `block_on`, which doesn't migrate the main
    // future across worker threads, so keeping the stream as a local
    // held across awaits is safe — same pattern as before this refactor.
    let denoise_enabled = denoise_requested;
    let host = cpal::default_host();

    let initial_device = resolve_input_device(&host, args.input_device.as_deref(), is_tui)?;
    let (initial_stream, initial_device_name) = build_input_stream(
        &initial_device,
        denoise_enabled,
        is_tui,
        &recording,
        &audio_buffer,
        &denoise_scratch,
        &audio_writer,
        &event_tx,
    )?;
    let mut current_stream: Option<cpal::Stream> = Some(initial_stream);
    let mut current_device_name: Option<String> = Some(initial_device_name);
    let _ = event_tx.send(Event::Ready);

    if is_tui {
        let cmd_tx_tui = cmd_tx.clone();
        tokio::spawn(async move {
            if let Err(e) = tui::run_tui(event_rx, cmd_tx_tui).await {
                eprintln!("TUI Error: {}", e);
            }
            std::process::exit(0);
        });
    } else {
        // stdout writer
        tokio::spawn(async move {
            while let Some(event) = event_rx.recv().await {
                if let Ok(json) = serde_json::to_string(&event) {
                    println!("{}", json);
                }
            }
        });

        // stdin reader
        let cmd_tx_stdin = cmd_tx.clone();
        tokio::spawn(async move {
            let stdin = io::stdin();
            for line in stdin.lock().lines().flatten() {
                if let Ok(cmd) = serde_json::from_str::<IncomingCommand>(&line) {
                    let _ = cmd_tx_stdin.send(cmd);
                }
            }
        });
    }

    let mut is_recording = false;
    let mut partial_timer = interval(Duration::from_secs_f64(partial_interval_secs));

    // Keybinding timer: wake every 50ms while recording to let the FSM
    // fire synthesized releases / discard timeouts; otherwise sleep
    // until we hear something.
    let mut kb_timer = interval(Duration::from_millis(50));
    kb_timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let commit_window_samples = (args.commit_window_secs * 16000.0) as usize;
    let cut_search_samples: usize = 16000 * 3;
    let cut_window_samples: usize = 3200;
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

    // Start/stop logic extracted into closures so the keybinding FSM
    // dispatcher can share them with the direct `start`/`stop`
    // command handlers.
    //
    // These can't be real closures because they close over too much
    // mutable state; instead, the inline blocks at the two call sites
    // (cmd match arm + FSM dispatch) share a helper that mutates the
    // owned state in place. We use a simple "inline" pattern rather
    // than extracting, since the state graph is already quite flat.

    // Command processor
    loop {
        // Compute the next keybinding deadline before awaiting so we
        // can cap the kb_timer wait. Not used directly by select! (we
        // rely on the 50ms cadence), but dispatched each tick below.

        tokio::select! {
            Some(cmd) = cmd_rx.recv() => {
                match cmd.cmd.as_str() {
                    "start" | "start_file" => {
                        // Re-resolve the audio input device before
                        // starting the recording. This is the fix for
                        // the "daemon keeps streaming from the device
                        // present at launch" bug: if the user plugged
                        // in a headset after startup, calling
                        // `default_input_device()` NOW picks up that
                        // new default. If the resolved device differs
                        // from the one currently driving `current_stream`
                        // (or no stream exists), we tear the old stream
                        // down and build a new one — this re-picks
                        // channel count + sample rate for the new
                        // device, rebuilds the denoiser if applicable,
                        // and re-shares the same `Arc`-held state with
                        // the new audio callback so in-flight session
                        // writers / buffers stay intact.
                        //
                        // If resolution or build fails we eprintln! and
                        // keep the existing stream running (better than
                        // crashing the daemon); the start proceeds so
                        // the old device's audio still captures.
                        match resolve_input_device(&host, args.input_device.as_deref(), is_tui) {
                            Ok(new_device) => {
                                let new_name = new_device
                                    .name()
                                    .unwrap_or_else(|_| "(unknown)".to_string());
                                let needs_rebuild = current_stream.is_none()
                                    || current_device_name.as_deref() != Some(new_name.as_str());
                                if needs_rebuild {
                                    if !is_tui {
                                        match current_device_name.as_deref() {
                                            Some(old) => eprintln!(
                                                "Speakeasy: input device changed ({} -> {}); rebuilding capture stream",
                                                old, new_name
                                            ),
                                            None => eprintln!(
                                                "Speakeasy: building capture stream for {}",
                                                new_name
                                            ),
                                        }
                                    }
                                    // Drop the old stream *before*
                                    // building the new one so CoreAudio
                                    // releases the previous device.
                                    current_stream = None;
                                    current_device_name = None;
                                    // Clear the denoise-frame tail from
                                    // any previous stream — the new
                                    // device may have a different rate
                                    // so stale 48 kHz samples would be
                                    // mis-processed.
                                    denoise_scratch.lock().unwrap().clear();
                                    match build_input_stream(
                                        &new_device,
                                        denoise_enabled,
                                        is_tui,
                                        &recording,
                                        &audio_buffer,
                                        &denoise_scratch,
                                        &audio_writer,
                                        &event_tx,
                                    ) {
                                        Ok((stream, name)) => {
                                            current_stream = Some(stream);
                                            current_device_name = Some(name);
                                        }
                                        Err(e) => {
                                            eprintln!(
                                                "Speakeasy: failed to rebuild input stream for {}: {}",
                                                new_name, e
                                            );
                                            let _ = event_tx.send(Event::Error {
                                                message: format!(
                                                    "failed to open input device {}: {}",
                                                    new_name, e
                                                ),
                                            });
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                eprintln!(
                                    "Speakeasy: could not resolve input device for start: {}",
                                    e
                                );
                                let _ = event_tx.send(Event::Error {
                                    message: format!("resolve input device: {}", e),
                                });
                            }
                        }

                        handle_start(
                            &cmd,
                            &recording,
                            &audio_buffer,
                            &denoise_scratch,
                            &last_snapshot_len,
                            &audio_writer,
                            &mut last_audio_path,
                            &mut session_log,
                            &mut session_uuid,
                            &mut session_audio_path,
                            &sessions_dir,
                            &mut committed_text,
                            &mut is_recording,
                            &mut skip_paste_for_current_recording,
                            &mut partial_timer,
                            &event_tx,
                            &mut keybinding,
                            &mut last_fsm_state,
                        );
                    }
                    "cancel" => {
                        // Cancel is a stop that saves the transcript but
                        // tells the frontend not to auto-paste. Set the
                        // flag before calling handle_stop so the flag is
                        // in place when the Saved event fires.
                        skip_paste_for_current_recording = true;
                        let saved_synchronously = handle_stop(
                            &recording,
                            &audio_buffer,
                            &last_snapshot_len,
                            &audio_writer,
                            &mut is_recording,
                            args.debug_save_wav.as_deref(),
                            &transcribe_cmd_tx,
                            &mut committed_text,
                            &event_tx,
                            &mut keybinding,
                            &mut last_fsm_state,
                            &mut session_log,
                            &mut session_uuid,
                            &mut session_audio_path,
                            &transcripts_dir,
                            false, // ai_enabled: AI cleanup removed
                            &mut last_saved_transcript_id,
                            skip_paste_for_current_recording,
                        );
                        // Empty-tail path: Saved already fired synchronously;
                        // reset the flag now. For the non-empty-tail path, the
                        // TranscribeResult::Stopped arm will reset it after the
                        // async save completes.
                        if saved_synchronously {
                            skip_paste_for_current_recording = false;
                        }
                    }
                    "stop" | "stop_file" => {
                        let _ = handle_stop(
                            &recording,
                            &audio_buffer,
                            &last_snapshot_len,
                            &audio_writer,
                            &mut is_recording,
                            args.debug_save_wav.as_deref(),
                            &transcribe_cmd_tx,
                            &mut committed_text,
                            &event_tx,
                            &mut keybinding,
                            &mut last_fsm_state,
                            &mut session_log,
                            &mut session_uuid,
                            &mut session_audio_path,
                            &transcripts_dir,
                            false, // ai_enabled: AI cleanup removed
                            &mut last_saved_transcript_id,
                            skip_paste_for_current_recording,
                        );
                    }
                    "discard" => {
                        // No-op on recording state from the stream's
                        // POV — we simply close the session log without
                        // marking completed, flip the flag, and emit a
                        // state_change. Used by the keybinding FSM's
                        // DiscardRecording output.
                        handle_discard(
                            &recording,
                            &audio_buffer,
                            &last_snapshot_len,
                            &audio_writer,
                            &mut is_recording,
                            &mut session_log,
                            &mut session_uuid,
                            &mut session_audio_path,
                            &mut committed_text,
                            &event_tx,
                            &mut keybinding,
                            &mut last_fsm_state,
                        );
                        // Discard is always terminal — clear per-recording state.
                        skip_paste_for_current_recording = false;
                    }
                    "delete_audio" => {
                        let writer_opt = audio_writer.lock().unwrap().take();
                        let path = cmd.path
                            .as_ref()
                            .map(PathBuf::from)
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
                    "key_press" => {
                        let ts = cmd.ts.unwrap_or_else(monotonic_ms);
                        let outs = keybinding.on_key_press(ts);
                        dispatch_keybinding_outputs(
                            outs,
                            &mut last_fsm_state,
                            &event_tx,
                            &cmd_tx,
                        );
                    }
                    "key_release" => {
                        let ts = cmd.ts.unwrap_or_else(monotonic_ms);
                        let outs = keybinding.on_key_release(ts);
                        dispatch_keybinding_outputs(
                            outs,
                            &mut last_fsm_state,
                            &event_tx,
                            &cmd_tx,
                        );
                    }
                    "key_repeat" => {
                        let ts = cmd.ts.unwrap_or_else(monotonic_ms);
                        let outs = keybinding.on_key_repeat(ts);
                        dispatch_keybinding_outputs(
                            outs,
                            &mut last_fsm_state,
                            &event_tx,
                            &cmd_tx,
                        );
                    }
                    "configure_keybinding" => {
                        // Start from the current config so the caller only
                        // needs to send the fields they want to change.
                        let mut new_cfg = *keybinding.config();
                        if let Some(v) = cmd.release_gap_ms { new_cfg.release_gap_ms = v; }
                        if let Some(v) = cmd.inter_tap_gap_ms { new_cfg.inter_tap_gap_ms = v; }
                        if let Some(v) = cmd.repeat_delay_ms { new_cfg.repeat_delay_ms = v; }
                        if let Some(v) = cmd.double_tap_window_ms { new_cfg.double_tap_window_ms = v; }
                        if let Some(v) = cmd.hold_threshold { new_cfg.hold_threshold = v; }
                        if let Some(ref s) = cmd.release_mode {
                            if let Some(rm) = release_mode_from_str(s) {
                                new_cfg.release_mode = rm;
                            }
                        }
                        keybinding.configure(new_cfg);
                    }
                    "quit" => {
                        if let Some(w) = audio_writer.lock().unwrap().take() {
                            w.close();
                        }
                        if let Some(log) = session_log.take() {
                            // Abandon the log; orphan recovery will pick
                            // it up on next launch.
                            log.close();
                        }
                        break;
                    }
                    "set_input_device" | "select_model" => {
                        // Intentional TODO: these hot-swap commands are
                        // declared in the protocol and the macOS frontend
                        // sends them on Preferences close, but the daemon
                        // doesn't yet rebuild the cpal stream or restart
                        // the transcription thread in response. Emit an
                        // error so the frontend can surface "takes effect
                        // on next launch" rather than silently losing the
                        // user's preference change.
                        let _ = event_tx.send(Event::Error {
                            message: format!(
                                "{} is not yet hot-swappable in the daemon; takes effect on next launch",
                                cmd.cmd
                            ),
                        });
                    }
                    other => {
                        // Unknown command — log once to stderr so it
                        // surfaces in the frontend's daemon-stderr drain
                        // without us having to grow a dedicated diagnostic
                        // channel.
                        eprintln!(
                            "Speakeasy daemon: ignoring unknown command {:?}",
                            other
                        );
                    }
                }
            }
            Some(result) = transcribe_result_rx.recv() => {
                match result {
                    TranscribeResult::Partial(text) => {
                        let combined = combine_text(&committed_text, &text);
                        let _ = event_tx.send(Event::Partial { text: combined });
                    }
                    TranscribeResult::Committed(text) => {
                        let piece = text.trim();
                        if !piece.is_empty() {
                            committed_text = combine_text(&committed_text, piece);
                            // Persist to the session log BEFORE any AI
                            // cleanup touches the text, so a crash here
                            // leaves the committed prefix recoverable.
                            if let Some(ref mut log) = session_log {
                                let _ = log.append_final(piece);
                            }
                        }
                        let _ = event_tx.send(Event::Partial { text: committed_text.clone() });
                    }
                    TranscribeResult::Stopped(tail_text) => {
                        let tail_trim = tail_text.trim();
                        if !tail_trim.is_empty() {
                            if let Some(ref mut log) = session_log {
                                let _ = log.append_final(tail_trim);
                            }
                        }
                        let final_text = combine_text(&committed_text, &tail_text)
                            .trim()
                            .to_string();
                        committed_text.clear();

                        let text = final_text;
                        let _ = event_tx.send(Event::Stopped { text: text.clone() });

                        // Save the transcript using the raw Whisper text.
                        // AI cleanup has been removed, so the saved text is
                        // always the raw text and `ai_enabled` is false.
                        let saved_id = if let Some(log) = session_log.take() {
                            save_completed_session(
                                log,
                                &transcripts_dir,
                                session_uuid.take().as_deref(),
                                session_audio_path.take().as_deref(),
                                text.as_str(),
                                None,
                                false,
                                skip_paste_for_current_recording,
                                &event_tx,
                            )
                        } else {
                            None
                        };
                        last_saved_transcript_id = saved_id.clone();

                        // Whisper decode + save complete — back to Idle.
                        let fsm_outs = keybinding.force_state(KeybindingState::Idle);
                        for out in fsm_outs {
                            if let KeybindingOutput::StateChanged(s) = out {
                                emit_state_change(s, &mut last_fsm_state, &event_tx);
                            }
                        }

                        // Recording fully complete — clear per-recording state.
                        skip_paste_for_current_recording = false;

                        // FSM → Idle.
                        let outs = keybinding.on_processing_done();
                        dispatch_keybinding_outputs(
                            outs,
                            &mut last_fsm_state,
                            &event_tx,
                            &cmd_tx,
                        );
                    }
                }
            }
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
            _ = kb_timer.tick() => {
                // Ticking the FSM can fire synthesized releases or
                // discard timeouts. The 50ms cadence here is a
                // simplification of the "wake at exact deadline" API
                // the FSM offers; at a few ms of latency per output
                // it's fine for dictation use.
                let now = monotonic_ms();
                let (outs, _next) = keybinding.tick(now);
                dispatch_keybinding_outputs(
                    outs,
                    &mut last_fsm_state,
                    &event_tx,
                    &cmd_tx,
                );
            }
        }

    }

    drop(transcribe_cmd_tx);

    Ok(())
}

// ─── Daemon helpers ────────────────────────────────────────────────

/// Resolve the audio input device the capture stream should target.
///
/// If `requested_name` is `Some`, enumerate devices and match by name;
/// fall back to the system default (with a stderr warning) when the
/// named device is missing or enumeration fails. If `requested_name`
/// is `None`, take the *current* system default — this is the key
/// property that makes hot-swap work: every call re-queries the host
/// so a headset plugged in after daemon start is picked up.
fn resolve_input_device(
    host: &cpal::Host,
    requested_name: Option<&str>,
    is_tui: bool,
) -> Result<cpal::Device> {
    match requested_name {
        Some(requested) => match host.input_devices() {
            Ok(devices) => {
                let mut found: Option<cpal::Device> = None;
                for d in devices {
                    if let Ok(name) = d.name() {
                        if name == requested {
                            found = Some(d);
                            break;
                        }
                    }
                }
                match found {
                    Some(d) => Ok(d),
                    None => {
                        if !is_tui {
                            eprintln!(
                                "Speakeasy: input device {:?} not found; falling back to system default",
                                requested
                            );
                        }
                        host.default_input_device()
                            .context("No input device found")
                    }
                }
            }
            Err(e) => {
                if !is_tui {
                    eprintln!(
                        "Speakeasy: couldn't enumerate input devices ({}); using system default",
                        e
                    );
                }
                host.default_input_device()
                    .context("No input device found")
            }
        },
        None => host
            .default_input_device()
            .context("No input device found"),
    }
}

/// Build and start a cpal input stream for `device`, wiring the audio
/// callback to the supplied shared state Arcs.
///
/// Stream-dependent state (channels, negotiated sample rate, denoiser)
/// is all derived inside this helper because it varies per device —
/// MacBook mic (stereo 48k) vs. Shokz headset (mono 16k) vs. USB
/// interface (whatever it advertises). Capturing `channels` and
/// `input_sample_rate` from an outer scope would defeat the whole
/// point of hot-swap.
///
/// Returns the playing stream plus the resolved device name (used by
/// the caller to decide whether a subsequent `start` needs to rebuild).
#[allow(clippy::too_many_arguments)]
fn build_input_stream(
    device: &cpal::Device,
    denoise_enabled: bool,
    is_tui: bool,
    recording: &Arc<AtomicBool>,
    audio_buffer: &Arc<Mutex<Vec<f32>>>,
    denoise_scratch: &Arc<Mutex<Vec<f32>>>,
    audio_writer: &Arc<Mutex<Option<audio_writer::OpusAudioWriter>>>,
    event_tx: &mpsc::UnboundedSender<Event>,
) -> Result<(cpal::Stream, String)> {
    let device_name = device.name().unwrap_or_else(|_| "(unknown)".to_string());

    // Desired stream-level rate: 48 kHz if we need denoise, else 16 kHz.
    let desired_sample_rate: u32 = if denoise_enabled { 48_000 } else { 16_000 };

    // Pick a config. Prefer an explicitly-advertised config at the
    // desired rate so cpal doesn't silently refuse at build_stream
    // time; if none matches, fall back to the device's default.
    let (config, input_sample_rate, used_fallback): (cpal::StreamConfig, u32, bool) = {
        let desired_rate = cpal::SampleRate(desired_sample_rate);

        let mut picked: Option<cpal::SupportedStreamConfig> = None;
        if let Ok(configs) = device.supported_input_configs() {
            for c in configs {
                if c.min_sample_rate() <= desired_rate && desired_rate <= c.max_sample_rate() {
                    picked = Some(c.with_sample_rate(desired_rate));
                    break;
                }
            }
        }

        match picked {
            Some(supported) => {
                let mut cfg: cpal::StreamConfig = supported.into();
                cfg.channels = cfg.channels.max(1);
                let rate = cfg.sample_rate.0;
                (cfg, rate, false)
            }
            None => {
                if !is_tui {
                    eprintln!(
                        "Speakeasy: device doesn't advertise {} Hz; falling back to device default",
                        desired_sample_rate
                    );
                }
                let default_cfg: cpal::StreamConfig =
                    device.default_input_config()?.into();
                let rate = default_cfg.sample_rate.0;
                (default_cfg, rate, true)
            }
        }
    };

    if !is_tui {
        eprintln!(
            "Audio device: {}, Channels: {}, Rate: {}, Denoise: {}{}",
            device_name,
            config.channels,
            input_sample_rate,
            denoise_enabled,
            if used_fallback { " (fallback)" } else { "" },
        );
    }

    // Frame size expected by RNNoise: 10 ms at 48 kHz = 480 samples.
    const RNNOISE_FRAME: usize = 480;

    // Only construct a denoiser if we'll actually use it. Guard on
    // both the flag AND the actual stream rate — if we asked for 48
    // kHz but fell back to something else, denoise can't safely run.
    let denoiser = if denoise_enabled && input_sample_rate == 48_000 {
        Some(DenoiseState::new())
    } else {
        if denoise_enabled && input_sample_rate != 48_000 && !is_tui {
            eprintln!(
                "Speakeasy: denoise disabled because device stream is {} Hz (need 48000)",
                input_sample_rate
            );
        }
        None
    };
    let denoiser_cb: Arc<Mutex<Option<Box<DenoiseState<'static>>>>> =
        Arc::new(Mutex::new(denoiser));

    let recording_cb = Arc::clone(recording);
    let buffer_cb = Arc::clone(audio_buffer);
    let scratch_cb = Arc::clone(denoise_scratch);
    let writer_cb = Arc::clone(audio_writer);
    let denoiser_for_cb = Arc::clone(&denoiser_cb);
    let channels = config.channels as usize;
    let event_tx_audio = event_tx.clone();

    let stream = device.build_input_stream(
        &config,
        move |data: &[f32], _: &cpal::InputCallbackInfo| {
            if !recording_cb.load(Ordering::SeqCst) {
                return;
            }

            // 1. Downmix to mono at the stream's native rate.
            let mut mono_input: Vec<f32> = if channels <= 1 {
                data.to_vec()
            } else {
                data.chunks(channels)
                    .map(|frame| frame.iter().sum::<f32>() / channels as f32)
                    .collect()
            };

            // 2. Denoise (if enabled & rate is 48 kHz). We buffer into
            //    the scratch vec, process 480-sample frames, and feed
            //    the denoised output forward. Any tail smaller than
            //    480 samples waits for the next callback.
            if let Ok(mut denoiser_guard) = denoiser_for_cb.lock() {
                if let Some(ref mut ds) = *denoiser_guard {
                    let mut scratch = scratch_cb.lock().unwrap();
                    scratch.extend_from_slice(&mono_input);
                    mono_input.clear();
                    while scratch.len() >= RNNOISE_FRAME {
                        let in_frame: Vec<f32> = scratch.drain(..RNNOISE_FRAME).collect();
                        let mut out_frame = [0.0f32; RNNOISE_FRAME];
                        ds.process_frame(&mut out_frame, &in_frame);
                        mono_input.extend_from_slice(&out_frame);
                    }
                }
            }

            // 3. Resample to 16 kHz if the stream is higher-rate.
            let samples_16k: Vec<f32> = if input_sample_rate == 16_000 {
                mono_input
            } else {
                // Linear-interp resample. For the common 48 kHz → 16
                // kHz case this is a clean 3:1 decimation with
                // linearly-interpolated midpoints.
                speakeasy::file_transcribe::resample_linear(
                    &mono_input,
                    input_sample_rate,
                    16_000,
                )
            };

            if samples_16k.is_empty() {
                return;
            }

            // 4. RMS + peak for the Level event. Operate on the 16 kHz
            //    samples so the reported level tracks what whisper
            //    actually sees.
            let mut sum_sq = 0.0f64;
            let mut peak_lin = 0.0f32;
            for &s in &samples_16k {
                sum_sq += (s as f64) * (s as f64);
                let a = s.abs();
                if a > peak_lin {
                    peak_lin = a;
                }
            }
            // Boost RMS 5x so `tui.rs`'s `level * 200.0` gauge maps the
            // 0.0–0.5 speech range onto 0–100 %. Wire format predates
            // the callback refactor; don't change it without updating
            // the TUI renderer in lockstep.
            let rms = (sum_sq / samples_16k.len() as f64).sqrt() * 5.0;
            let _ = event_tx_audio.send(Event::Level {
                rms,
                peak: peak_lin as f64,
            });

            // 5. Append to the active whisper buffer and push to the
            //    retention writer. Keep mutex scopes tight so we never
            //    hold both at once.
            {
                let mut final_buf = buffer_cb.lock().unwrap();
                final_buf.extend_from_slice(&samples_16k);
            }
            if let Ok(guard) = writer_cb.try_lock() {
                if let Some(w) = guard.as_ref() {
                    w.push(&samples_16k);
                }
            }
        },
        |err| eprintln!("Audio stream error: {}", err),
        None,
    )?;

    stream.play()?;
    Ok((stream, device_name))
}

#[allow(clippy::too_many_arguments)]
fn handle_start(
    cmd: &IncomingCommand,
    recording: &AtomicBool,
    audio_buffer: &Mutex<Vec<f32>>,
    denoise_scratch: &Mutex<Vec<f32>>,
    last_snapshot_len: &Mutex<usize>,
    audio_writer: &Mutex<Option<audio_writer::OpusAudioWriter>>,
    last_audio_path: &mut Option<PathBuf>,
    session_log_slot: &mut Option<SessionLog>,
    session_uuid: &mut Option<String>,
    session_audio_path: &mut Option<PathBuf>,
    sessions_dir: &Path,
    committed_text: &mut String,
    is_recording: &mut bool,
    skip_paste_for_current_recording: &mut bool,
    partial_timer: &mut tokio::time::Interval,
    event_tx: &mpsc::UnboundedSender<Event>,
    keybinding: &mut Keybinding,
    last_fsm_state: &mut KeybindingState,
) {
    let is_start_file = cmd.cmd == "start_file";

    if is_start_file {
        // Synchronous close — see the matching comment in handle_stop
        // for why we don't use spawn_blocking here.
        if let Some(old) = audio_writer.lock().unwrap().take() {
            old.close();
        }
        if let Some(path_str) = cmd.path.as_ref() {
            let path = PathBuf::from(path_str);
            match audio_writer::OpusAudioWriter::new(path.clone()) {
                Ok(w) => {
                    *audio_writer.lock().unwrap() = Some(w);
                    *last_audio_path = Some(path.clone());
                    *session_audio_path = Some(path);
                }
                Err(e) => {
                    eprintln!(
                        "Speakeasy: audio retention disabled for this recording ({}): {}",
                        path.display(),
                        e
                    );
                    *last_audio_path = None;
                    *session_audio_path = None;
                }
            }
        } else {
            *last_audio_path = None;
            *session_audio_path = None;
        }
    }

    recording.store(true, Ordering::SeqCst);
    audio_buffer.lock().unwrap().clear();
    // Wipe any leftover denoise-frame tail from the previous recording
    // so the next session starts on a clean 480-sample boundary.
    denoise_scratch.lock().unwrap().clear();
    *last_snapshot_len.lock().unwrap() = 0;
    committed_text.clear();
    *is_recording = true;
    // A cancel/stop while idle pre-arms this flag via the caller but
    // then hits handle_stop's !is_recording early-return, so the flag
    // never resets on that path. Clearing it here guarantees every
    // fresh recording starts from a known state.
    *skip_paste_for_current_recording = false;
    partial_timer.reset();

    // Open a fresh session log. If a previous one is still open
    // (shouldn't happen in practice, but defensive), close it — it
    // will be recovered as an orphan next boot.
    if let Some(prev) = session_log_slot.take() {
        prev.close();
    }
    let uuid = Uuid::new_v4().to_string();
    match SessionLog::start(
        sessions_dir,
        session_audio_path.as_deref(),
        Some(&uuid),
    ) {
        Ok(log) => {
            *session_log_slot = Some(log);
            *session_uuid = Some(uuid);
        }
        Err(e) => {
            eprintln!("Speakeasy: session log open failed: {}", e);
            *session_uuid = None;
        }
    }

    // Drive the FSM into Recording so a subsequent hotkey event (from a
    // user mixing menu-start with hotkey-stop, or vice versa) doesn't
    // see stale Idle state and open a second recording on top of this
    // one. force_state cancels in-flight timers and emits StateChanged
    // iff there's a real transition.
    let outs = keybinding.force_state(KeybindingState::Recording);
    for out in outs {
        if let KeybindingOutput::StateChanged(s) = out {
            emit_state_change(s, last_fsm_state, event_tx);
        }
    }
}

/// Returns `true` when the empty-tail path ran and the `Saved` event
/// was emitted synchronously inside this call. In that case the caller
/// must reset `skip_paste_for_current_recording` immediately. Returns
/// `false` when the non-empty-tail path dispatched work to the
/// transcriber thread; the `TranscribeResult::Stopped` arm will reset
/// the flag after the async save completes.
#[allow(clippy::too_many_arguments)]
fn handle_stop(
    recording: &AtomicBool,
    audio_buffer: &Mutex<Vec<f32>>,
    last_snapshot_len: &Mutex<usize>,
    audio_writer: &Mutex<Option<audio_writer::OpusAudioWriter>>,
    is_recording: &mut bool,
    debug_save_wav: Option<&str>,
    transcribe_cmd_tx: &Option<std_mpsc::Sender<TranscribeCmd>>,
    committed_text: &mut String,
    event_tx: &mpsc::UnboundedSender<Event>,
    keybinding: &mut Keybinding,
    last_fsm_state: &mut KeybindingState,
    session_log_slot: &mut Option<SessionLog>,
    session_uuid: &mut Option<String>,
    session_audio_path: &mut Option<PathBuf>,
    transcripts_dir: &Path,
    ai_enabled: bool,
    last_saved_transcript_id: &mut Option<String>,
    skip_paste: bool,
) -> bool {
    if !*is_recording {
        return false;
    }
    recording.store(false, Ordering::SeqCst);
    *is_recording = false;

    let _ = event_tx.send(Event::Transcribing);
    // Drive FSM to Processing so subsequent hotkey events respect the
    // transition (and so direct-stop callers that never exercised the
    // hotkey path still leave the FSM in a sane state for later use).
    let fsm_outs = keybinding.force_state(KeybindingState::Processing);
    for out in fsm_outs {
        if let KeybindingOutput::StateChanged(s) = out {
            emit_state_change(s, last_fsm_state, event_tx);
        }
    }

    let buf: Vec<f32> = std::mem::take(&mut *audio_buffer.lock().unwrap());
    *last_snapshot_len.lock().unwrap() = 0;

    // Close the Opus retention writer synchronously so the file is
    // fully flushed to disk before this function returns. We used to
    // `spawn_blocking(move || w.close())` here, but that left the
    // close racing against a subsequent `quit` command — when the
    // runtime shuts down the blocking task can be dropped mid-flush,
    // leaving a header-only (~100 byte) file on disk. The close
    // itself is bounded: it just drains a few MB of already-buffered
    // samples through the opus encoder, which takes well under a
    // second even for minute-long recordings. Blocking the select!
    // arm here is fine because the user has already requested stop.
    if let Some(w) = audio_writer.lock().unwrap().take() {
        w.close();
    }

    if let Some(wav_path) = debug_save_wav {
        let spec = WavSpec {
            channels: 1,
            sample_rate: 16000,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        if let Ok(mut writer) = WavWriter::create(wav_path, spec) {
            for &sample in &buf {
                let amplitude = i16::MAX as f32;
                let _ = writer.write_sample((sample * amplitude) as i16);
            }
            let _ = writer.finalize();
        }
    }

    if buf.is_empty() {
        // Empty-tail stop: no pending final decode will fire a
        // `TranscribeResult::Stopped`, so we must persist the
        // transcript and emit `saved` synchronously here. We skip
        // the AI backfill on this branch — there is no audio tail
        // to clean up, so the committed prefix (already appended
        // via session_log.append_final) is the full transcript.
        let final_text = std::mem::take(committed_text).trim().to_string();
        let _ = event_tx.send(Event::Stopped { text: final_text.clone() });

        let saved_id = if let Some(log) = session_log_slot.take() {
            save_completed_session(
                log,
                transcripts_dir,
                session_uuid.take().as_deref(),
                session_audio_path.take().as_deref(),
                &final_text,
                None,
                ai_enabled,
                skip_paste,
                event_tx,
            )
        } else {
            None
        };
        *last_saved_transcript_id = saved_id;

        // Empty-tail stop completes synchronously — transition straight
        // back to Idle so the frontend's status bar / overlay don't get
        // stuck on Processing.
        let fsm_outs = keybinding.force_state(KeybindingState::Idle);
        for out in fsm_outs {
            if let KeybindingOutput::StateChanged(s) = out {
                emit_state_change(s, last_fsm_state, event_tx);
            }
        }
        // Saved event fired synchronously — caller must reset flag.
        true
    } else if let Some(cmd_tx) = transcribe_cmd_tx {
        let _ = cmd_tx.send(TranscribeCmd::TranscribeFinal(buf));
        // Saved event will fire later via TranscribeResult::Stopped.
        false
    } else {
        // No transcription thread (e.g. missing --model-path). Emit an
        // empty Stopped and return to Idle so the UI doesn't stall.
        let _ = event_tx.send(Event::Stopped { text: String::new() });
        let fsm_outs = keybinding.force_state(KeybindingState::Idle);
        for out in fsm_outs {
            if let KeybindingOutput::StateChanged(s) = out {
                emit_state_change(s, last_fsm_state, event_tx);
            }
        }
        // No save happened at all (no transcriber) — clear flag anyway.
        true
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_discard(
    recording: &AtomicBool,
    audio_buffer: &Mutex<Vec<f32>>,
    last_snapshot_len: &Mutex<usize>,
    audio_writer: &Mutex<Option<audio_writer::OpusAudioWriter>>,
    is_recording: &mut bool,
    session_log_slot: &mut Option<SessionLog>,
    session_uuid: &mut Option<String>,
    session_audio_path: &mut Option<PathBuf>,
    committed_text: &mut String,
    event_tx: &mpsc::UnboundedSender<Event>,
    keybinding: &mut Keybinding,
    last_fsm_state: &mut KeybindingState,
) {
    recording.store(false, Ordering::SeqCst);
    *is_recording = false;
    audio_buffer.lock().unwrap().clear();
    *last_snapshot_len.lock().unwrap() = 0;
    committed_text.clear();
    // Synchronous close — matches handle_stop; see the comment there
    // for the rationale. For discard we'll delete the file anyway,
    // but we still want the writer thread to have actually exited
    // before we return.
    if let Some(w) = audio_writer.lock().unwrap().take() {
        w.close();
    }
    // Close session log without marking completed — the file stays in
    // `sessions/` and the next run's orphan recovery will handle it.
    if let Some(log) = session_log_slot.take() {
        log.close();
    }
    *session_uuid = None;
    *session_audio_path = None;
    let fsm_outs = keybinding.force_state(KeybindingState::Idle);
    for out in fsm_outs {
        if let KeybindingOutput::StateChanged(s) = out {
            emit_state_change(s, last_fsm_state, event_tx);
        }
    }
}

/// Finalize a session log, persist the transcript entry, and emit the
/// `Saved` event. Returns the transcript id on success so callers can
/// backfill the cleaned text once the AI worker replies. On any
/// failure we eprintln! and swallow — losing a transcript write should
/// not deadlock the daemon.
#[allow(clippy::too_many_arguments)]
fn save_completed_session(
    mut log: SessionLog,
    transcripts_dir: &Path,
    uuid: Option<&str>,
    audio_path: Option<&Path>,
    raw_text: &str,
    cleaned_text: Option<&str>,
    ai_used: bool,
    skip_paste: bool,
    event_tx: &mpsc::UnboundedSender<Event>,
) -> Option<String> {
    if let Err(e) = log.stop(raw_text, cleaned_text, ai_used) {
        eprintln!("Speakeasy: session_log.stop failed: {}", e);
        log.close();
        return None;
    }

    // Build a transcript id. Prefer a UUID-based id so the frontend
    // can correlate with live state; fall back to a timestamp.
    let timestamp = chrono::Utc::now()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let ts_for_file = timestamp.replace([':', '.'], "-");
    let id = match uuid {
        Some(u) if !u.is_empty() => format!("transcript-{}-{}", ts_for_file, u),
        _ => format!("transcript-{}", ts_for_file),
    };

    let entry = TranscriptEntry {
        id: id.clone(),
        timestamp,
        raw_text: raw_text.to_string(),
        cleaned_text: cleaned_text.map(str::to_owned),
        audio_path: audio_path.map(Path::to_path_buf),
        ai_enabled: ai_used,
        recovered: false,
        recovered_from: None,
        recovered_complete: None,
    };

    match transcript_store::save_transcript(transcripts_dir, &entry) {
        Ok(_) => {
            // Move the session log into `completed/` so orphan
            // recovery on next start doesn't re-recover it.
            if let Err(e) = log.mark_completed() {
                eprintln!("Speakeasy: mark_completed failed: {}", e);
            }
            let _ = event_tx.send(Event::Saved {
                transcript_id: id.clone(),
                recovered: false,
                updated: None,
                skip_paste,
            });
            Some(id)
        }
        Err(e) => {
            eprintln!("Speakeasy: save_transcript failed: {}", e);
            log.close();
            None
        }
    }
}

fn emit_state_change(
    new_state: KeybindingState,
    last: &mut KeybindingState,
    event_tx: &mpsc::UnboundedSender<Event>,
) {
    if *last != new_state {
        *last = new_state;
        let _ = event_tx.send(Event::StateChange {
            state: state_label(new_state).to_string(),
        });
    }
}

fn dispatch_keybinding_outputs(
    outs: Vec<KeybindingOutput>,
    last_fsm_state: &mut KeybindingState,
    event_tx: &mpsc::UnboundedSender<Event>,
    cmd_tx: &mpsc::UnboundedSender<IncomingCommand>,
) {
    for out in outs {
        match out {
            KeybindingOutput::StartRecording => {
                let _ = cmd_tx.send(IncomingCommand {
                    cmd: "start".to_string(),
                    ..Default::default()
                });
            }
            KeybindingOutput::CommitRecording => {
                // The start path already issues PreWarm. Commit is a
                // keep-alive / lock-in signal; for now it's a no-op at
                // the protocol level. (Frontends that want a Commit
                // visualization can infer it from the Locked
                // state_change event or from our own pre-warm kick
                // inside start.)
            }
            KeybindingOutput::StopRecording => {
                let _ = cmd_tx.send(IncomingCommand {
                    cmd: "stop".to_string(),
                    ..Default::default()
                });
            }
            KeybindingOutput::DiscardRecording => {
                let _ = cmd_tx.send(IncomingCommand {
                    cmd: "discard".to_string(),
                    ..Default::default()
                });
            }
            KeybindingOutput::StateChanged(state) => {
                emit_state_change(state, last_fsm_state, event_tx);
            }
        }
    }
}

// ─── Legacy --file mode ─────────────────────────────────────────────

async fn run_legacy_file_mode(
    args: &DaemonArgs,
    file_path: &str,
) -> Result<()> {
    let model_path = args
        .model_path
        .as_ref()
        .context("--model-path is required when using --file")?;

    let load_start = Instant::now();
    let mut model = WhisperModel::load(model_path).context("Failed to load model")?;
    let load_time = load_start.elapsed().as_secs_f64();
    eprintln!("Model loaded in {:.2}s", load_time);

    let pcm_data = load_audio_file(file_path).context("Failed to load audio file")?;
    eprintln!(
        "Loaded {} samples ({}s)",
        pcm_data.len(),
        pcm_data.len() as f64 / 16000.0
    );

    let transcribe_start = Instant::now();
    let text = model.transcribe(&pcm_data).context("Transcription failed")?;
    let transcribe_time = transcribe_start.elapsed().as_secs_f64();
    println!("Transcription: {}", text);

    eprintln!("Model loading time: {:.2}s", load_time);
    eprintln!("Transcription time: {:.2}s", transcribe_time);
    Ok(())
}

fn load_audio_file(path: &str) -> Result<Vec<f32>> {
    let path = Path::new(path);
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
        "flac" => anyhow::bail!(
            "FLAC not supported here; use `speakeasy transcribe-file` instead"
        ),
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

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_labels_are_lowercase() {
        assert_eq!(state_label(KeybindingState::Idle), "idle");
        assert_eq!(state_label(KeybindingState::Recording), "recording");
        assert_eq!(state_label(KeybindingState::Locked), "locked");
        assert_eq!(state_label(KeybindingState::Processing), "processing");
    }

    #[test]
    fn release_mode_parsing_accepts_both_names() {
        assert_eq!(release_mode_from_str("real"), Some(ReleaseMode::Real));
        assert_eq!(release_mode_from_str("REAL"), Some(ReleaseMode::Real));
        assert_eq!(
            release_mode_from_str("gap_detected"),
            Some(ReleaseMode::GapDetected)
        );
        assert_eq!(
            release_mode_from_str("gapdetected"),
            Some(ReleaseMode::GapDetected)
        );
        assert_eq!(release_mode_from_str("gap"), Some(ReleaseMode::GapDetected));
        assert_eq!(release_mode_from_str(""), None);
        assert_eq!(release_mode_from_str("bogus"), None);
    }

    #[test]
    fn incoming_command_deserializes_minimal_start() {
        let cmd: IncomingCommand = serde_json::from_str(r#"{"cmd":"start"}"#).unwrap();
        assert_eq!(cmd.cmd, "start");
        assert!(cmd.ts.is_none());
        assert!(cmd.path.is_none());
    }

    #[test]
    fn incoming_command_deserializes_key_press_with_ts() {
        let cmd: IncomingCommand =
            serde_json::from_str(r#"{"cmd":"key_press","ts":12345}"#).unwrap();
        assert_eq!(cmd.cmd, "key_press");
        assert_eq!(cmd.ts, Some(12345));
    }

    #[test]
    fn incoming_command_deserializes_configure_keybinding() {
        let cmd: IncomingCommand = serde_json::from_str(
            r#"{"cmd":"configure_keybinding","release_gap_ms":300,"release_mode":"real"}"#,
        )
        .unwrap();
        assert_eq!(cmd.cmd, "configure_keybinding");
        assert_eq!(cmd.release_gap_ms, Some(300));
        assert_eq!(cmd.release_mode.as_deref(), Some("real"));
    }

    #[test]
    fn event_state_change_serializes_as_snake_case_event_tag() {
        let ev = Event::StateChange {
            state: "recording".to_string(),
        };
        let json = serde_json::to_string(&ev).unwrap();
        // Must contain the snake_case tag "state_change" so the
        // existing frontends can pattern-match.
        assert!(
            json.contains("\"event\":\"state_change\""),
            "got: {json}"
        );
        assert!(json.contains("\"state\":\"recording\""));
    }

    #[test]
    fn event_saved_serializes_with_transcript_id_and_recovered_flag() {
        let ev = Event::Saved {
            transcript_id: "transcript-abc".to_string(),
            recovered: true,
            updated: None,
            skip_paste: false,
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains("\"event\":\"saved\""));
        assert!(json.contains("\"transcript_id\":\"transcript-abc\""));
        assert!(json.contains("\"recovered\":true"));
        // `updated` must be absent when None so pre-existing consumers
        // continue to see the original shape.
        assert!(!json.contains("updated"), "got: {json}");
        // `skip_paste` must be absent when false so pre-existing consumers
        // tolerate the missing field.
        assert!(!json.contains("skip_paste"), "got: {json}");
    }

    #[test]
    fn event_saved_omits_recovered_when_false() {
        let ev = Event::Saved {
            transcript_id: "x".to_string(),
            recovered: false,
            updated: None,
            skip_paste: false,
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(!json.contains("recovered"));
        assert!(!json.contains("updated"));
        assert!(!json.contains("skip_paste"));
    }

    #[test]
    fn event_saved_includes_updated_when_set() {
        let ev = Event::Saved {
            transcript_id: "transcript-abc".to_string(),
            recovered: false,
            updated: Some(true),
            skip_paste: false,
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains("\"event\":\"saved\""));
        assert!(json.contains("\"updated\":true"));
    }

    #[test]
    fn event_saved_includes_skip_paste_when_true() {
        let ev = Event::Saved {
            transcript_id: "transcript-abc".to_string(),
            recovered: false,
            updated: None,
            skip_paste: true,
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains("\"event\":\"saved\""), "got: {json}");
        assert!(json.contains("\"skip_paste\":true"), "got: {json}");
    }

    #[test]
    fn incoming_command_cancel_deserializes() {
        let cmd: IncomingCommand = serde_json::from_str(r#"{"cmd":"cancel"}"#).unwrap();
        assert_eq!(cmd.cmd, "cancel");
        // cancel carries no extra fields — all optional fields must be None.
        assert!(cmd.path.is_none());
    }

    #[test]
    fn event_ready_serializes_unchanged() {
        let json = serde_json::to_string(&Event::Ready).unwrap();
        assert_eq!(json, r#"{"event":"ready"}"#);
    }

    #[test]
    fn event_level_keeps_rms_and_peak_keys() {
        let ev = Event::Level {
            rms: 0.5,
            peak: 0.25,
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains("\"event\":\"level\""));
        assert!(json.contains("\"rms\":0.5"));
        assert!(json.contains("\"peak\":0.25"));
    }

}
