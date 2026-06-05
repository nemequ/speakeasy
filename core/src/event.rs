// SPDX-License-Identifier: MIT
// Speakeasy — daemon protocol event types.
//
// Shared between the binary (main.rs) and library modules that need
// to emit or forward events.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    Ready,
    Partial { text: String },
    Level { rms: f64, peak: f64 },
    // Emitted immediately after a `stop` command is accepted, before
    // the final whisper decode runs.
    Transcribing,
    Stopped { text: String },
    Error { message: String },
    /// FSM transitioned to a new state. Emitted by the keybinding state
    /// machine and by direct start/stop paths.
    StateChange { state: String },
    /// A transcript has been written to disk (either from a live session
    /// or during orphan recovery).
    Saved {
        transcript_id: String,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        recovered: bool,
        /// `true` when this `saved` event reflects a rewrite of an
        /// existing transcript (e.g. AI cleanup backfill). Omitted for
        /// fresh saves so existing consumers see the original shape.
        #[serde(skip_serializing_if = "Option::is_none")]
        updated: Option<bool>,
        /// When `true`, the frontend should not auto-paste the transcript.
        /// Set by the `cancel` command — the transcript is still saved so
        /// it can be recovered from the transcripts window, but the user
        /// explicitly cancelled rather than completing the recording.
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        skip_paste: bool,
    },
}
