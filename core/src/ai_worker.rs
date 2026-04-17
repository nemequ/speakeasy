// Background AI-cleanup worker — keeps the GGUF loaded between
// recordings so post-stop cleanup only pays for prefill + generation.
//
// The problem this solves: the original cleanup path ran the GGUF
// parse and weight materialization (the dominant ~1-3s cost) on
// every stop. The system prompt is fixed for a session, and most
// users record multiple utterances per session, so reloading the
// 400 MB model every time is pure waste.
//
// Design: a dedicated thread owns the model lifecycle with one
// warm slot. The main command loop signals `PreWarm` when
// recording starts, and the worker loads the GGUF in the
// background if the slot is empty. When recording stops and raw
// STT text is ready, the main loop sends `Cleanup { raw_text,
// reply }` and the worker runs the full prompt through the
// already-loaded weights. Afterward it re-loads for the next
// recording.
//
// What was NOT done: pre-filling the fixed prefix tokens into the
// KV cache during warm-up. candle 0.8's quantized_qwen2 forward
// builds a square causal mask sized to the input's seq_len and
// broadcasts it across `[batch, seq_len, heads, kv_len]`. For
// multi-token inputs past an existing cache (`seq_len > 1` and
// `index_pos > 0`) the broadcast fails. So the prefill itself
// stays on the post-stop critical path. The savings here come
// entirely from eliminating the cold-load cost.
//
// Why a thread and not a tokio task: candle runs fully-blocking
// CPU-bound forward passes. A dedicated thread keeps the tokio
// runtime free for the audio/IPC tasks without saturating a
// `spawn_blocking` slot for the life of the subprocess.
//
// candle 0.8 constraint: `ModelWeights`'s KV cache grows
// monotonically with each `forward` call, and there is no public
// reset API. So a warm model can be used for at most one cleanup
// sequence — after that we drop it and load a fresh one.

use anyhow::{anyhow, Result};
use candle_core::Device;
use candle_transformers::models::quantized_qwen2::ModelWeights;
use std::path::PathBuf;
use std::thread;
use std::time::Instant;
use tokio::sync::{mpsc, oneshot};

use crate::ai::AiConfig;
use crate::ai_local;
use crate::Event;

/// Commands the main loop can send to the worker.
pub enum AiWorkerCmd {
    /// The user started a recording. If the warm slot is empty,
    /// kick off a GGUF load so the post-stop cleanup doesn't have
    /// to pay for it on the user's critical path.
    PreWarm,
    /// Produce the cleaned text for `raw_text`. Consumes the warm
    /// slot if one is ready, otherwise falls through to a cold
    /// load (correct but slower — same latency as the pre-worker
    /// implementation).
    ///
    /// If `event_tx` is provided, the worker emits an
    /// `Event::Delta { text }` for each generated chunk so the
    /// parent UI can stream cleanup into the overlay instead of
    /// showing an opaque spinner. The terminal full-text result
    /// still arrives via `reply` — the caller is responsible for
    /// turning that into an `Event::Final`.
    Cleanup {
        raw_text: String,
        event_tx: Option<mpsc::UnboundedSender<Event>>,
        reply: oneshot::Sender<Result<String>>,
    },
}

/// One-slot warm pool: either nothing loaded, a ready model, or a
/// terminal load error.
enum WorkerState {
    Empty,
    Warm { model: ModelWeights },
    Errored(String),
}

pub struct AiWorker {
    cmd_tx: mpsc::UnboundedSender<AiWorkerCmd>,
}

impl AiWorker {
    /// Spawn the worker thread. Returns a handle whose `send()` is
    /// cheap and non-blocking. The config's `backend` is not
    /// checked here — callers should skip spawning for
    /// `backend == "none"`.
    pub fn spawn(config: AiConfig) -> Self {
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        thread::Builder::new()
            .name("ai-worker".to_string())
            .spawn(move || {
                if let Err(e) = run(config, cmd_rx) {
                    eprintln!("ai_worker: fatal: {}", e);
                }
            })
            .expect("failed to spawn ai-worker thread");
        Self { cmd_tx }
    }

    pub fn send(&self, cmd: AiWorkerCmd) -> Result<()> {
        self.cmd_tx
            .send(cmd)
            .map_err(|_| anyhow!("ai_worker channel closed"))
    }
}

fn run(config: AiConfig, mut cmd_rx: mpsc::UnboundedReceiver<AiWorkerCmd>) -> Result<()> {
    if config.model.is_empty() {
        return Err(anyhow!("model path empty"));
    }

    let model_path: PathBuf = config.model.clone().into();
    let device = Device::Cpu;

    // Tokenizer is session-constant — load it once up front. If
    // this fails the worker can't function; drain the channel with
    // error replies so callers get a clear diagnostic instead of
    // hanging on the oneshot.
    let (tokenizer, eos_token_id) = match ai_local::load_tokenizer(&model_path) {
        Ok(pair) => pair,
        Err(e) => {
            let msg = format!("ai_worker tokenizer load failed: {}", e);
            eprintln!("{}", msg);
            while let Some(cmd) = cmd_rx.blocking_recv() {
                if let AiWorkerCmd::Cleanup { reply, .. } = cmd {
                    let _ = reply.send(Err(anyhow!("{}", msg)));
                }
            }
            return Ok(());
        }
    };

    let mut state = WorkerState::Empty;

    while let Some(cmd) = cmd_rx.blocking_recv() {
        match cmd {
            AiWorkerCmd::PreWarm => {
                if matches!(state, WorkerState::Empty) {
                    state = load_warm(&model_path, &device);
                }
            }

            AiWorkerCmd::Cleanup { raw_text, event_tx, reply } => {
                // Streaming callback: emit each new chunk of decoded
                // output through the event channel as `Event::Delta`.
                // Shadowed per-call so we don't accidentally reuse a
                // closure across requests.
                let delta_sender = event_tx.clone();
                let mut delta_cb = move |text: &str| {
                    if text.is_empty() {
                        return;
                    }
                    if let Some(ref tx) = delta_sender {
                        let _ = tx.send(Event::Delta { text: text.to_string() });
                    }
                };
                let on_delta: Option<&mut dyn FnMut(&str)> = if event_tx.is_some() {
                    Some(&mut delta_cb)
                } else {
                    None
                };

                let result = match std::mem::replace(&mut state, WorkerState::Empty) {
                    WorkerState::Warm { mut model } => {
                        let t = Instant::now();
                        let res = ai_local::run_cleanup_on_fresh_model(
                            &mut model,
                            &tokenizer,
                            eos_token_id,
                            &config.system_prompt,
                            &raw_text,
                            &device,
                            on_delta,
                        );
                        eprintln!(
                            "ai_worker: warm cleanup took {:.2}s",
                            t.elapsed().as_secs_f64()
                        );
                        // `model` is consumed — state stays Empty.
                        res
                    }
                    WorkerState::Empty => {
                        // Cold fallback: the user released PTT before
                        // warm-up finished (very short utterance, or
                        // PreWarm never arrived). Do the full path
                        // inline so the result is still produced, just
                        // with the pre-worker latency. Streaming
                        // still works — we just pay the cold load
                        // before the first delta arrives.
                        eprintln!("ai_worker: no warm slot, running cold cleanup");
                        let t = Instant::now();
                        let res = (|| -> Result<String> {
                            let model_path: PathBuf = config.model.clone().into();
                            let mut model = ai_local::load_model(&model_path, &device)?;
                            ai_local::run_cleanup_on_fresh_model(
                                &mut model,
                                &tokenizer,
                                eos_token_id,
                                &config.system_prompt,
                                &raw_text,
                                &device,
                                on_delta,
                            )
                        })();
                        eprintln!(
                            "ai_worker: cold cleanup took {:.2}s",
                            t.elapsed().as_secs_f64()
                        );
                        res
                    }
                    WorkerState::Errored(msg) => {
                        // Keep the Errored state so subsequent cleanups
                        // get the same diagnostic rather than retrying
                        // a load that'll hit the same failure.
                        let out = Err(anyhow!("ai_worker errored: {}", msg));
                        state = WorkerState::Errored(msg);
                        out
                    }
                };

                let _ = reply.send(result);

                // Re-warm in background for the next recording. Holds
                // ~400 MB resident between recordings — acceptable for
                // an active dictation session; if that becomes a
                // concern we can drop the slot after some idle period.
                if matches!(state, WorkerState::Empty) {
                    state = load_warm(&model_path, &device);
                }
            }
        }
    }

    Ok(())
}

/// Load a fresh ModelWeights into a Warm slot, or record the
/// failure as Errored so downstream cleanups fail loudly instead
/// of silently retrying.
fn load_warm(model_path: &std::path::Path, device: &Device) -> WorkerState {
    let t = Instant::now();
    match ai_local::load_model(model_path, device) {
        Ok(model) => {
            eprintln!(
                "ai_worker: warm slot ready in {:.2}s",
                t.elapsed().as_secs_f64()
            );
            WorkerState::Warm { model }
        }
        Err(e) => {
            eprintln!("ai_worker: warm-up failed: {}", e);
            WorkerState::Errored(e.to_string())
        }
    }
}
