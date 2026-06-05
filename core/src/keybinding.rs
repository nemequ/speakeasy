// SPDX-License-Identifier: MIT
// Speakeasy — Push-to-talk keybinding state machine.
//
// This is a pure, platform-agnostic port of the JS `KeybindingManager`
// in `keybinding.js`. It expresses the interaction model for
// hold-to-talk dictation with double-tap-to-lock, accidental-tap
// discard, and a "commit" event that fires once per recording to let
// the frontend warm caches / show UI.
//
// ## Input modes
//
// Different platforms give us different key event streams, so this
// module supports two input modes via [`ReleaseMode`]:
//
// ### `ReleaseMode::Real` (macOS, X11)
//
// The platform delivers real `key_press` and `key_release` events. We
// use them directly: press starts a hold, release ends it. `key_repeat`
// events are optional — if the frontend forwards them they feed the
// hold-threshold counter, which distinguishes a quick tap from a
// sustained hold.
//
// ### `ReleaseMode::GapDetected` (GNOME / Mutter `grab_accelerator`)
//
// Mutter's `grab_accelerator` fires `accelerator-activated` on initial
// press AND on every keyboard repeat (~30 ms), but it provides no
// `key_release` signal on GNOME 49. We therefore synthesize releases
// via gap detection: if no events arrive for [`KeybindingConfig::release_gap_ms`],
// the key was released. Within a held stream, a gap larger than
// [`KeybindingConfig::inter_tap_gap_ms`] but smaller than
// [`KeybindingConfig::repeat_delay_ms`] means the key was released and
// re-pressed (fast double-tap), while a gap >= `repeat_delay_ms` is
// just the keyboard's initial-repeat delay within a single hold.
//
// In this mode `on_key_release` is ignored — the frontend isn't
// providing real releases. Both `on_key_press` and `on_key_repeat`
// are treated as the same "stream event" and feed gap detection.
//
// ## Timer model
//
// The JS version uses `GLib.timeout_add`, scheduling callbacks on the
// shell's main loop. In Rust we avoid coupling to any runtime: the
// state machine stores timer deadlines as plain `u64` monotonic-ms
// values. The caller is expected to:
//
//   1. Call `on_key_press` / `on_key_release` / `on_key_repeat` as
//      events arrive.
//   2. Call [`Keybinding::tick`] on some cadence to let the state
//      machine observe deadline expiry (gap timeout → synthetic
//      release, double-tap window → discard).
//
// `tick` returns the next absolute deadline the caller should wake
// up at (or `None` if no timer is armed), so the daemon's main loop
// can arm an accurate sleep rather than busy-polling.
//
// All times in this module are monotonic milliseconds (`u64`). The
// caller is responsible for supplying a consistent clock via the
// `now_ms` parameter on every method that takes one.

use std::collections::VecDeque;

/// High-level FSM states, matching the JS `State` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum KeybindingState {
    /// No active recording. Fresh press starts one.
    Idle,
    /// A recording is in progress. Key is held (or the state machine
    /// believes it is, per the active [`ReleaseMode`]).
    Recording,
    /// A recording is running "latched" after a double-tap. The key is
    /// no longer held; the next press will stop and finalize.
    Locked,
    /// A stop has been requested and the frontend is finalizing
    /// (running AI cleanup, pasting text, saving the transcript, ...).
    /// Moves back to `Idle` when the caller invokes
    /// [`Keybinding::on_processing_done`].
    Processing,
}

/// Which style of key events the caller is going to feed us.
///
/// Callers pick this at construction time based on what the platform
/// gives them. See the module-level docs for the full semantics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReleaseMode {
    /// Real press/release events. Used on macOS, X11, Wayland clients
    /// with `zwp_virtual_keyboard_v1`, etc.
    Real,
    /// No real release events; synthesize them from gaps in a
    /// press/repeat event stream. Used under GNOME's
    /// `grab_accelerator` API.
    GapDetected,
}

/// Tunable timings and thresholds. All fields are public so the
/// caller can construct and mutate a config directly; the daemon
/// re-hydrates this from its `configure_keybinding` command.
///
/// Defaults match the JS `DEFAULTS` in `keybinding.js` and are
/// exposed as [`KeybindingConfig::default`] for convenience.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeybindingConfig {
    /// In `GapDetected` mode, a gap this long with no events means
    /// the key was released. Must be longer than the OS keyboard
    /// repeat delay. Unused in `Real` mode.
    pub release_gap_ms: u64,
    /// In `GapDetected` mode, a gap larger than this but smaller
    /// than `repeat_delay_ms` between two events means the user
    /// released and re-pressed within a stream (fast double-tap).
    /// Unused in `Real` mode.
    pub inter_tap_gap_ms: u64,
    /// In `GapDetected` mode, gaps this size or larger are treated
    /// as the keyboard's initial-repeat delay within a single hold,
    /// NOT as a re-press. Unused in `Real` mode.
    pub repeat_delay_ms: u64,
    /// After a quick tap is released with `repeat_count < hold_threshold`,
    /// we wait this long for a second tap to arrive before deciding
    /// the first tap was accidental and discarding the recording.
    pub double_tap_window_ms: u64,
    /// Minimum number of key events (press + repeats) to consider a
    /// key-press a genuine "hold" rather than a "tap". Used to
    /// decide between the hold-to-talk stop path and the
    /// double-tap-window discard path, and to time when to fire
    /// [`KeybindingOutput::CommitRecording`] during a hold.
    pub hold_threshold: u32,
    /// Which event-stream style the caller is providing. See
    /// [`ReleaseMode`].
    pub release_mode: ReleaseMode,
}

impl Default for KeybindingConfig {
    fn default() -> Self {
        Self {
            release_gap_ms: 700,
            inter_tap_gap_ms: 60,
            repeat_delay_ms: 400,
            double_tap_window_ms: 500,
            hold_threshold: 5,
            release_mode: ReleaseMode::GapDetected,
        }
    }
}

/// Side-effects the state machine asks the caller to perform.
///
/// These are pure value-typed intents — the state machine never
/// touches the recorder, the clipboard, or any I/O. The caller
/// drains `Vec<KeybindingOutput>` values returned from each method
/// and dispatches them in order.
///
/// `StateChanged` is emitted on every transition and will always
/// appear in the same `Vec` as the `Start/Commit/Stop/Discard`
/// intent that caused it, in dispatch order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeybindingOutput {
    /// Begin capturing audio and running STT. Emitted on the first
    /// press of a new recording.
    StartRecording,
    /// This recording has been "confirmed" — either the hold crossed
    /// [`KeybindingConfig::hold_threshold`], or the user double-tapped
    /// into `Locked`. Frontend should warm anything expensive (AI
    /// prompt cache, overlay styling, etc.). Fires at most once per
    /// recording session.
    CommitRecording,
    /// Finalize the recording: stop capture, run AI cleanup, paste
    /// text, save transcript. FSM has transitioned to `Processing`;
    /// caller should invoke [`Keybinding::on_processing_done`] when
    /// finalization completes.
    StopRecording,
    /// Discard the recording without saving. Emitted when the
    /// `double_tap_window_ms` expires after an accidental tap.
    DiscardRecording,
    /// FSM transitioned to a new state. The caller uses this to
    /// drive UI (panel icon color, overlay mode, etc.).
    StateChanged(KeybindingState),
}

/// The keybinding state machine itself.
///
/// Construct with [`Keybinding::new`]. Feed it events via
/// [`on_key_press`](Keybinding::on_key_press),
/// [`on_key_repeat`](Keybinding::on_key_repeat),
/// [`on_key_release`](Keybinding::on_key_release). Drive timer
/// expiry via [`tick`](Keybinding::tick). When the frontend is
/// done finalizing a stopped recording, call
/// [`on_processing_done`](Keybinding::on_processing_done).
///
/// The FSM is NOT thread-safe; the caller must serialize all
/// method calls (typically by running the daemon's event loop on
/// a single thread).
pub struct Keybinding {
    config: KeybindingConfig,
    state: KeybindingState,

    // ── gap-detection bookkeeping (GapDetected mode) ──
    /// True while we believe the key is held down. In `Real` mode
    /// this is set on `on_key_press` and cleared on `on_key_release`;
    /// in `GapDetected` mode it is set on the first stream event and
    /// cleared by gap timeout or inter-tap detection.
    key_held: bool,
    /// Monotonic-ms timestamp of the last press/repeat we observed,
    /// used for inter-tap gap detection in `GapDetected` mode.
    last_event_time_ms: u64,
    /// Monotonic-ms timestamp of the most recent key_release observed
    /// in `Real` mode. Used to debounce spurious release→press pairs
    /// that real keyboards (notably the MacBook Fn/Globe key) emit as
    /// key-chatter on a single human press.
    last_release_time_ms: Option<u64>,
    /// Count of events (press + repeats) since the last synthetic or
    /// real release. Drives hold-threshold detection in `GapDetected`
    /// mode.
    repeat_count: u32,
    /// Monotonic-ms timestamp of the most recent real key_press (Real
    /// mode only). Used at release time to decide "was the key held
    /// long enough to count as a hold, or was it just a tap?". In
    /// `GapDetected` mode we use `repeat_count` instead because
    /// Mutter sends us a repeat stream rather than press/release
    /// pairs, so elapsed time is confounded by keyboard repeat delay.
    press_time_ms: Option<u64>,

    // ── timer deadlines (monotonic ms, absolute) ──
    /// If set, the synthetic-release deadline. Only used in
    /// `GapDetected` mode.
    gap_deadline_ms: Option<u64>,
    /// If set, the accidental-tap discard deadline. Set when a
    /// short tap is released; cleared on a second press or on
    /// expiry.
    double_tap_deadline_ms: Option<u64>,

    // ── per-session bookkeeping ──
    /// True once a `CommitRecording` has been emitted for the
    /// current recording. Reset when a fresh recording starts.
    commit_fired: bool,

    /// Scratch buffer for outputs the state machine builds up across
    /// a single entrypoint call. Re-used to avoid per-call
    /// allocation in tight loops, but returned as a fresh `Vec` to
    /// the caller each time.
    ///
    /// Using `VecDeque` for the (rare) case where a single event
    /// needs to push multiple outputs in the front-to-back order
    /// they should be dispatched.
    out: VecDeque<KeybindingOutput>,
}

impl Keybinding {
    /// Construct a fresh state machine in [`KeybindingState::Idle`]
    /// with the supplied timings.
    pub fn new(config: KeybindingConfig) -> Self {
        Self {
            config,
            state: KeybindingState::Idle,
            key_held: false,
            last_event_time_ms: 0,
            repeat_count: 0,
            press_time_ms: None,
            last_release_time_ms: None,
            gap_deadline_ms: None,
            double_tap_deadline_ms: None,
            commit_fired: false,
            out: VecDeque::new(),
        }
    }

    /// Swap in a new configuration. Safe to call at any state;
    /// timings take effect for subsequently-armed timers. Already-
    /// armed timers (e.g. a gap deadline from a previous event)
    /// keep their existing deadlines — the new values only apply
    /// to the next armed timer. This matches the JS behavior
    /// where the GSettings change handler updates the fields but
    /// doesn't rearm running timers.
    pub fn configure(&mut self, config: KeybindingConfig) {
        self.config = config;
    }

    /// Force the FSM into a specific state. Used by the daemon when a
    /// frontend issues a direct `start` / `stop` / `discard` command
    /// (e.g. from a status-bar menu click) so the FSM tracks recording
    /// state correctly alongside hotkey events. Cancels any in-flight
    /// deadline timers and clears physical-key tracking on a real
    /// transition.
    ///
    /// Idempotent when the FSM is already in the target state: returns
    /// with no outputs and no side-effects. This matters because the
    /// daemon calls force_state from its `start`/`stop`/`discard`
    /// handlers, which are themselves re-entered via
    /// `dispatch_keybinding_outputs` when the FSM emits
    /// Start/Stop/Discard. If force_state cleared `key_held`
    /// unconditionally, the press that triggered StartRecording would
    /// leave the FSM thinking the key is no longer held, and the
    /// subsequent on_key_release would be ignored — the FSM would
    /// stay stuck in Recording until the user pressed again.
    pub fn force_state(&mut self, new_state: KeybindingState) -> Vec<KeybindingOutput> {
        if self.state == new_state {
            return Vec::new();
        }
        self.gap_deadline_ms = None;
        self.double_tap_deadline_ms = None;
        self.key_held = false;
        self.repeat_count = 0;
        self.press_time_ms = None;
        self.last_release_time_ms = None;
        self.commit_fired = false; // fresh slate
        self.state = new_state;
        self.out
            .push_back(KeybindingOutput::StateChanged(new_state));
        self.drain_out()
    }

    /// Current FSM state.
    pub fn state(&self) -> KeybindingState {
        self.state
    }

    /// Current effective config (useful for tests and for the
    /// daemon to echo the active values back to the frontend).
    pub fn config(&self) -> &KeybindingConfig {
        &self.config
    }

    /// Handle a real or synthesized key-press.
    ///
    /// In `Real` mode: marks the key as held, starts the repeat
    /// counter, and drives any press-sensitive state transitions
    /// (start recording, lock out of double-tap window, stop out of
    /// locked state).
    ///
    /// In `GapDetected` mode: treated identically to
    /// [`on_key_repeat`] — it's just the first event in a
    /// stream. The caller is free to deliver the "initial" event
    /// via either entrypoint since Mutter's API makes them
    /// indistinguishable.
    #[must_use = "caller must dispatch the returned outputs"]
    pub fn on_key_press(&mut self, now_ms: u64) -> Vec<KeybindingOutput> {
        // Key-chatter debounce (Real mode only). MacBook Fn/Globe keys
        // occasionally emit a release→press pair mid-hold that's
        // physically impossible for a human to produce. Without
        // filtering, the FSM reads the spurious press as a deliberate
        // double-tap and locks.
        //
        // Threshold tension: the earlier 80 ms value was set to cover
        // an observed ~60 ms Fn chatter event, but real users turn
        // out to double-tap faster than that — 80 ms swallowed
        // legitimate deliberate double-taps as chatter. 30 ms sits
        // above normal electrical bounce (5–30 ms) while letting
        // sub-100-ms human double-taps through. If hardware chatter
        // >30 ms ever shows up again we'll need a smarter filter
        // (e.g. require two chatter-gap presses in a row before
        // suppressing), not a wider window.
        //
        // Harmless in GapDetected mode because `last_release_time_ms`
        // is only set by on_key_release, which that mode ignores.
        const CHATTER_DEBOUNCE_MS: u64 = 30;
        if self.config.release_mode == ReleaseMode::Real {
            if let Some(last_release) = self.last_release_time_ms {
                if now_ms.saturating_sub(last_release) < CHATTER_DEBOUNCE_MS {
                    // Spurious press within the bounce window. Roll
                    // back the effects of the preceding (also
                    // spurious) release: cancel the double-tap
                    // window, restore Recording if we were there,
                    // and mark the key as still held. Press-time is
                    // kept from the original first press so the real
                    // release still sees the true total hold duration.
                    self.last_release_time_ms = None;
                    self.double_tap_deadline_ms = None;
                    self.key_held = true;
                    if self.state == KeybindingState::Idle {
                        // Was a tap in flight; undo the transition
                        // to Idle so the user's continuous hold
                        // survives the chatter.
                        self.set_state(KeybindingState::Recording);
                    }
                    return self.drain_out();
                }
            }
        }
        self.handle_event(now_ms, EventKind::Press);
        self.drain_out()
    }

    /// Handle a key-repeat event.
    ///
    /// In both modes this increments the repeat counter. In
    /// `GapDetected` mode it also drives the inter-tap-gap and
    /// release-gap timer logic, and acts as the initial-press
    /// event if no earlier event has been seen (since Mutter
    /// makes no distinction).
    #[must_use = "caller must dispatch the returned outputs"]
    pub fn on_key_repeat(&mut self, now_ms: u64) -> Vec<KeybindingOutput> {
        self.handle_event(now_ms, EventKind::Repeat);
        self.drain_out()
    }

    /// Handle a real key-release.
    ///
    /// In `Real` mode this immediately processes the release. In
    /// `GapDetected` mode it's ignored — the frontend isn't
    /// providing real releases, so honoring a stray one would
    /// conflict with the gap-detection machinery. (The daemon
    /// should gate which entrypoints it forwards per platform,
    /// but we defend against misrouted events here.)
    #[must_use = "caller must dispatch the returned outputs"]
    pub fn on_key_release(&mut self, now_ms: u64) -> Vec<KeybindingOutput> {
        if self.config.release_mode == ReleaseMode::Real && self.key_held {
            self.key_held = false;
            // Remember release time for chatter-debounce on the next
            // press. We record this regardless of whether the FSM
            // decided it was a tap or a hold — the debounce applies
            // to the physical key, not the logical classification.
            self.last_release_time_ms = Some(now_ms);
            self.cancel_gap_timer();
            self.handle_release(now_ms);
            self.repeat_count = 0;
        }
        self.drain_out()
    }

    /// Signal that the frontend has finished finalizing a stopped
    /// recording (AI cleanup done, text pasted, transcript saved).
    /// Moves the FSM from `Processing` back to `Idle` so the next
    /// press starts a new recording.
    ///
    /// No-op if the FSM is not in `Processing`.
    #[must_use = "caller must dispatch the returned outputs"]
    pub fn on_processing_done(&mut self) -> Vec<KeybindingOutput> {
        if self.state == KeybindingState::Processing {
            self.set_state(KeybindingState::Idle);
        }
        self.drain_out()
    }

    /// Advance the internal clock. Fires any armed timers whose
    /// deadline has passed. Returns the next absolute deadline the
    /// caller should wake up at (or `None` if no timer is armed) so
    /// the daemon's main loop can sleep precisely rather than
    /// busy-polling.
    ///
    /// Safe to call at any frequency — the machine only fires each
    /// deadline once. Recommended cadence: every ~50 ms during an
    /// active recording, on-demand otherwise. Callers who have a
    /// wait-with-deadline primitive available are encouraged to use
    /// the returned deadline to wake up exactly when needed.
    #[must_use = "caller must dispatch the returned outputs"]
    pub fn tick(&mut self, now_ms: u64) -> (Vec<KeybindingOutput>, Option<u64>) {
        // Gap timer: synthesize a release when it fires.
        if let Some(deadline) = self.gap_deadline_ms {
            if now_ms >= deadline {
                self.gap_deadline_ms = None;
                self.key_held = false;
                // The JS schedules the double-tap window timer from
                // the moment the gap callback fires (i.e. "now").
                // `deadline` is the scheduled fire time; `now_ms` is
                // when the caller woke us up, so the true fire time
                // is `max(deadline, now_ms) == now_ms` (we already
                // know `now_ms >= deadline`). Pass `now_ms` through.
                self.handle_release(now_ms);
                self.repeat_count = 0;
            }
        }

        // Double-tap window timer: fire discard when it elapses
        // without a second press.
        if let Some(deadline) = self.double_tap_deadline_ms {
            if now_ms >= deadline {
                self.double_tap_deadline_ms = None;
                self.out.push_back(KeybindingOutput::DiscardRecording);
            }
        }

        let next = match (self.gap_deadline_ms, self.double_tap_deadline_ms) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        };

        (self.drain_out(), next)
    }

    // ── internal helpers ──

    /// Core event-stream logic shared by `on_key_press` and
    /// `on_key_repeat`. Mirrors the JS `_onKeyEvent` method.
    ///
    /// The `_kind` parameter is informational only — in GapDetected
    /// mode Mutter doesn't distinguish press from repeat, and in
    /// Real mode both entrypoints feed the same counter. It's
    /// preserved so future code can branch on the distinction if
    /// needed without changing the call sites.
    fn handle_event(&mut self, now_ms: u64, _kind: EventKind) {
        let gap_mode = self.config.release_mode == ReleaseMode::GapDetected;

        // Inter-tap gap detection (GapDetected mode only). If we're
        // already tracking a hold and the gap since the last event
        // is longer than the "normal repeat interval" but shorter
        // than the keyboard repeat delay, the user released and
        // re-pressed — synthesize a release, then fall through and
        // treat this event as a new press.
        if gap_mode
            && self.key_held
            && self.last_event_time_ms != 0
            && now_ms.saturating_sub(self.last_event_time_ms) > self.config.inter_tap_gap_ms
            && now_ms.saturating_sub(self.last_event_time_ms) < self.config.repeat_delay_ms
        {
            self.key_held = false;
            // Synthetic release happens "now" from the perspective
            // of any double-tap window being armed.
            self.handle_release(now_ms);
            self.repeat_count = 0;
        }

        self.last_event_time_ms = now_ms;

        let was_held = self.key_held;
        if !was_held {
            // Fresh press — record timestamp so Real-mode release can
            // measure the held duration.
            self.press_time_ms = Some(now_ms);
        }
        self.key_held = true;
        self.repeat_count = self.repeat_count.saturating_add(1);

        // Rearm the gap timer on every stream event (GapDetected
        // mode only). `Real` mode gets real releases, so it doesn't
        // need synthetic ones.
        if gap_mode {
            self.gap_deadline_ms = Some(now_ms + self.config.release_gap_ms);
        }

        // Fire commit when the hold counter crosses the threshold.
        // The JS uses `== holdThreshold` (exact match) so it only
        // fires once, even if no guard is in place — we keep the
        // same shape and also guard with `commit_fired`.
        if self.repeat_count == self.config.hold_threshold
            && self.state == KeybindingState::Recording
            && !self.commit_fired
        {
            self.fire_commit();
        }

        // Only the first event of a key-hold drives a state
        // transition. Subsequent repeats just feed the counter.
        if was_held {
            return;
        }

        self.handle_press();
    }

    /// The "synthetic press" path — first event of a new key-hold.
    /// Mirrors the JS `_onPress`.
    fn handle_press(&mut self) {
        // Snapshot whether a double-tap window was open before we
        // cancel it. Cancelling has to happen unconditionally so a
        // stale timer doesn't fire after we've already transitioned.
        let was_waiting_for_double_tap = self.double_tap_deadline_ms.is_some();
        self.double_tap_deadline_ms = None;

        match self.state {
            KeybindingState::Idle => {
                if was_waiting_for_double_tap {
                    // Second tap inside the window — lock in.
                    self.set_state(KeybindingState::Locked);
                    self.fire_commit();
                } else {
                    // Fresh first press.
                    self.commit_fired = false;
                    self.set_state(KeybindingState::Recording);
                    self.out.push_back(KeybindingOutput::StartRecording);
                }
            }
            KeybindingState::Recording => {
                // Should not happen in practice (repeats filter out
                // above), and if it does we treat it as a no-op.
            }
            KeybindingState::Locked => {
                // Tap while locked — stop and finalize.
                self.set_state(KeybindingState::Processing);
                self.out.push_back(KeybindingOutput::StopRecording);
            }
            KeybindingState::Processing => {
                // Ignored — finalization still in flight.
            }
        }
    }

    /// The "synthetic or real release" path. Mirrors the JS
    /// `_onRelease`. `release_now_ms` is the wall-clock moment at
    /// which the release happened (real `on_key_release` arg, or
    /// the `now_ms` that `tick` was called with when the gap timer
    /// fired): the double-tap window deadline is anchored to this.
    fn handle_release(&mut self, release_now_ms: u64) {
        // Two paths for deciding "was this a hold or just a tap":
        //
        // - GapDetected mode: compare repeat_count to hold_threshold.
        //   `hold_threshold` is a count (number of stream events seen
        //   while the key was held). Works because Mutter gives us a
        //   repeat stream at a known cadence.
        // - Real mode: compare elapsed press-to-release time to a
        //   time-based threshold. We don't get repeat events on
        //   macOS/X11, so repeat_count would stay at 1 and every
        //   release would get classified as a tap — dropping out
        //   of Recording immediately and losing the audio. Use
        //   `hold_threshold * repeat_delay_ms` as the equivalent
        //   millisecond budget (default 5 * 400 ms = 2s is too long;
        //   clamp to the empirical-sweet-spot 200 ms minimum so a
        //   deliberate-feeling half-second hold counts).
        let was_held = match self.config.release_mode {
            ReleaseMode::GapDetected => self.repeat_count >= self.config.hold_threshold,
            ReleaseMode::Real => {
                let press = self.press_time_ms.unwrap_or(release_now_ms);
                let held_ms = release_now_ms.saturating_sub(press);
                // 200 ms is the inter-keystroke threshold that
                // separates "deliberate hold to talk" from
                // "accidental tap" empirically; it's also what most
                // push-to-talk UIs use.
                let real_hold_ms: u64 = 200;
                held_ms >= real_hold_ms
            }
        };
        // Keep press_time_ms around — if a spurious bounce press
        // arrives within the debounce window, on_key_press uses the
        // stored value so the "hold duration" measured against the
        // eventual real release still spans from the original first
        // press, not the post-bounce moment.

        match self.state {
            KeybindingState::Recording => {
                if was_held {
                    // Hold-to-talk stop: finalize.
                    self.set_state(KeybindingState::Processing);
                    self.out.push_back(KeybindingOutput::StopRecording);
                } else {
                    // Quick tap: drop into the double-tap window,
                    // scheduled relative to the release time (same
                    // contract as the JS `GLib.timeout_add` call).
                    self.set_state(KeybindingState::Idle);
                    self.double_tap_deadline_ms =
                        Some(release_now_ms + self.config.double_tap_window_ms);
                }
            }
            KeybindingState::Locked => {
                // Release while locked — stay locked.
            }
            KeybindingState::Idle | KeybindingState::Processing => {
                // Either already idle or finalizing; nothing to do.
            }
        }
    }

    /// Fire the one-shot `CommitRecording` output if it hasn't
    /// already been fired for this recording session.
    fn fire_commit(&mut self) {
        if self.commit_fired {
            return;
        }
        self.commit_fired = true;
        self.out.push_back(KeybindingOutput::CommitRecording);
    }

    fn set_state(&mut self, new_state: KeybindingState) {
        if self.state == new_state {
            // JS fires the change callback unconditionally. We match
            // the JS exactly here even though a same-state change
            // would be redundant, because `forceState(currentState)`
            // in tests expects a callback fire. Emit it.
            self.state = new_state;
            self.out.push_back(KeybindingOutput::StateChanged(new_state));
            return;
        }
        self.state = new_state;
        self.out.push_back(KeybindingOutput::StateChanged(new_state));
    }

    fn cancel_gap_timer(&mut self) {
        self.gap_deadline_ms = None;
    }

    fn drain_out(&mut self) -> Vec<KeybindingOutput> {
        self.out.drain(..).collect()
    }
}

/// Internal distinguisher passed into `handle_event`. Not exported —
/// the public API is the three `on_key_*` methods.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EventKind {
    Press,
    Repeat,
}

// ─────────────────────────────────────────────────────────────────────
//
// Tests
//
// Every transition covered by the JS `tests/test-keybinding.js` is
// reproduced below. The JS tests use real GLib timers and wall-clock
// sleeps; we instead drive a virtual clock by passing explicit
// `now_ms` values into every method, and call `tick(now)` to let
// deadline-based transitions fire. This gives deterministic,
// fast, single-threaded tests with no flakes.
//
// ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: construct a `KeybindingConfig` with the compact
    /// short-timing values the JS tests use (so the virtual clock
    /// advances in recognizable numbers), for `GapDetected` mode.
    fn gap_config() -> KeybindingConfig {
        KeybindingConfig {
            release_gap_ms: 80,
            inter_tap_gap_ms: 20,
            repeat_delay_ms: 100,
            double_tap_window_ms: 150,
            hold_threshold: 5,
            release_mode: ReleaseMode::GapDetected,
        }
    }

    /// Filter a slice of outputs to just the non-state-change ones,
    /// for tests that care about commands but not state labels.
    fn effects(outs: &[KeybindingOutput]) -> Vec<KeybindingOutput> {
        outs.iter()
            .filter(|o| !matches!(o, KeybindingOutput::StateChanged(_)))
            .copied()
            .collect()
    }

    /// Count state transitions in a slice of outputs.
    fn state_changes(outs: &[KeybindingOutput]) -> Vec<KeybindingState> {
        outs.iter()
            .filter_map(|o| match o {
                KeybindingOutput::StateChanged(s) => Some(*s),
                _ => None,
            })
            .collect()
    }

    // ── JS: testInitialStateIsIdle ──
    #[test]
    fn initial_state_is_idle() {
        let kb = Keybinding::new(gap_config());
        assert_eq!(kb.state(), KeybindingState::Idle);
    }

    // ── JS: testHoldToTalk ──
    // Press + repeats crossing threshold, then tick past the release
    // gap. We expect StartRecording on the first event, CommitRecording
    // when the repeat counter crosses hold_threshold, and
    // StopRecording when the gap timeout fires.
    #[test]
    fn hold_to_talk_completes_on_release_gap() {
        let cfg = gap_config();
        let mut kb = Keybinding::new(cfg);

        let mut all = vec![];
        // 8 events 10 ms apart — well under the inter-tap gap.
        for i in 0..8u64 {
            let now = 100 + i * 10;
            all.extend(if i == 0 {
                kb.on_key_press(now)
            } else {
                kb.on_key_repeat(now)
            });
        }

        assert_eq!(kb.state(), KeybindingState::Recording);
        assert!(effects(&all).contains(&KeybindingOutput::StartRecording));
        assert!(effects(&all).contains(&KeybindingOutput::CommitRecording));

        // Tick past the gap deadline — last event at 170, gap is 80.
        let last_event = 100 + 7 * 10;
        let (late, _) = kb.tick(last_event + cfg.release_gap_ms + 10);

        assert_eq!(kb.state(), KeybindingState::Processing);
        assert!(effects(&late).contains(&KeybindingOutput::StopRecording));
    }

    // ── JS: testAccidentalSingleTap ──
    // Tap below hold threshold → gap timer synthesizes release →
    // enter IDLE + arm double-tap window → window expires →
    // DiscardRecording.
    #[test]
    fn single_tap_discards_after_double_tap_window() {
        let mut cfg = gap_config();
        cfg.release_gap_ms = 50;
        cfg.double_tap_window_ms = 100;
        cfg.hold_threshold = 5;
        let mut kb = Keybinding::new(cfg);

        // 2 events, well below threshold.
        kb.on_key_press(100);
        kb.on_key_repeat(110);

        // Gap elapses (nothing new arrives). Tick past release gap.
        let (after_release, _) = kb.tick(110 + cfg.release_gap_ms + 5);
        assert_eq!(kb.state(), KeybindingState::Idle);
        assert!(effects(&after_release).is_empty()); // discard not fired yet

        // Now the double-tap window: last event was 110, release
        // synthesized shortly after, double-tap window is 100ms
        // from the release time.
        let release_ts = 110 + cfg.release_gap_ms + 5; // what we passed to tick
        let (discarded, _) = kb.tick(release_ts + cfg.double_tap_window_ms + 5);
        assert!(effects(&discarded).contains(&KeybindingOutput::DiscardRecording));
    }

    // ── JS: testDoubleTapToLock ──
    #[test]
    fn double_tap_locks() {
        let mut cfg = gap_config();
        cfg.release_gap_ms = 60;
        cfg.double_tap_window_ms = 300;
        let mut kb = Keybinding::new(cfg);

        // First tap
        let first = kb.on_key_press(100);
        kb.on_key_repeat(110);
        assert_eq!(kb.state(), KeybindingState::Recording);
        assert!(effects(&first).contains(&KeybindingOutput::StartRecording));

        // Gap elapses → IDLE + double-tap window armed
        let _ = kb.tick(110 + cfg.release_gap_ms + 5);
        assert_eq!(kb.state(), KeybindingState::Idle);

        // Second tap within the double-tap window → LOCKED
        let release_ts = 110 + cfg.release_gap_ms + 5;
        let t2 = release_ts + 50;
        let second = kb.on_key_press(t2);
        kb.on_key_repeat(t2 + 10);
        assert_eq!(kb.state(), KeybindingState::Locked);
        assert!(effects(&second).contains(&KeybindingOutput::CommitRecording));
    }

    // ── JS: testDoubleTapThenStop ──
    // Get to LOCKED, wait for gap timer to fire in LOCKED (no-op),
    // then one more press → PROCESSING + StopRecording.
    #[test]
    fn locked_stops_on_next_press() {
        let mut cfg = gap_config();
        cfg.release_gap_ms = 60;
        cfg.double_tap_window_ms = 300;
        let mut kb = Keybinding::new(cfg);

        // First tap
        kb.on_key_press(100);
        kb.on_key_repeat(110);
        // Release via gap
        let _ = kb.tick(110 + cfg.release_gap_ms + 5);
        assert_eq!(kb.state(), KeybindingState::Idle);

        // Second tap → LOCKED
        let t2 = 110 + cfg.release_gap_ms + 5 + 50;
        kb.on_key_press(t2);
        kb.on_key_repeat(t2 + 10);
        assert_eq!(kb.state(), KeybindingState::Locked);

        // Gap timer fires in LOCKED — state should stay LOCKED
        let last = t2 + 10;
        let (in_lock, _) = kb.tick(last + cfg.release_gap_ms + 5);
        assert_eq!(kb.state(), KeybindingState::Locked);
        assert!(effects(&in_lock).is_empty());

        // Third press → PROCESSING + StopRecording
        let t3 = last + cfg.release_gap_ms + 5 + 50;
        let third = kb.on_key_press(t3);
        assert_eq!(kb.state(), KeybindingState::Processing);
        assert!(effects(&third).contains(&KeybindingOutput::StopRecording));
    }

    // ── JS: testInterTapGapDetection ──
    // Key events arrive with a gap between inter_tap_gap and
    // repeat_delay — the state machine should synthesize a release
    // and treat the next event as a new press.
    //
    // Because the first tap was below hold_threshold, the synthetic
    // release enters IDLE + arms the double-tap window. The next
    // press happens while the window is still open → LOCKED.
    #[test]
    fn inter_tap_gap_reproduces_repeat_delay_boundary() {
        let cfg = KeybindingConfig {
            release_gap_ms: 200,
            inter_tap_gap_ms: 40,
            repeat_delay_ms: 150,
            double_tap_window_ms: 400,
            hold_threshold: 5,
            release_mode: ReleaseMode::GapDetected,
        };
        let mut kb = Keybinding::new(cfg);

        // First tap — two events, 10ms apart, below threshold.
        kb.on_key_press(100);
        kb.on_key_repeat(110);
        assert_eq!(kb.state(), KeybindingState::Recording);

        // Now wait 80 ms: longer than 40ms inter_tap_gap, shorter
        // than 150ms repeat_delay, and well under the 200ms gap
        // timeout — so the gap timer does NOT fire, but the next
        // event triggers inter-tap detection.
        let t3 = 110 + 80; // 190ms
        kb.on_key_press(t3);
        kb.on_key_repeat(t3 + 10);

        // After inter-tap detection synthesized a release: the old
        // tap had repeatCount=2 (< 5), so the release entered IDLE
        // and armed the double-tap window. Then the "new press"
        // saw the window open and transitioned to LOCKED.
        assert_eq!(kb.state(), KeybindingState::Locked);
    }

    // A complementary check: a gap >= repeat_delay_ms is NOT treated
    // as inter-tap, per the comments in keybinding.js explaining
    // why REPEAT_DELAY_MS is a boundary.
    #[test]
    fn inter_tap_gap_above_repeat_delay_is_treated_as_keyboard_repeat() {
        let cfg = KeybindingConfig {
            release_gap_ms: 500,
            inter_tap_gap_ms: 40,
            repeat_delay_ms: 150,
            double_tap_window_ms: 400,
            hold_threshold: 5,
            release_mode: ReleaseMode::GapDetected,
        };
        let mut kb = Keybinding::new(cfg);

        kb.on_key_press(100);
        kb.on_key_repeat(110);
        assert_eq!(kb.state(), KeybindingState::Recording);

        // 200 ms gap — larger than repeat_delay_ms (150). Should
        // be treated as a keyboard repeat delay within one hold,
        // not a re-press. State stays RECORDING.
        let t3 = 110 + 200;
        kb.on_key_repeat(t3);
        assert_eq!(kb.state(), KeybindingState::Recording);
    }

    // ── JS: testProcessingDone ──
    #[test]
    fn processing_done_returns_to_idle() {
        let cfg = gap_config();
        let mut kb = Keybinding::new(cfg);

        // Hold-to-talk → PROCESSING
        for i in 0..8u64 {
            let now = 100 + i * 10;
            if i == 0 {
                kb.on_key_press(now);
            } else {
                kb.on_key_repeat(now);
            }
        }
        let last = 100 + 7 * 10;
        let _ = kb.tick(last + cfg.release_gap_ms + 5);
        assert_eq!(kb.state(), KeybindingState::Processing);

        let outs = kb.on_processing_done();
        assert_eq!(kb.state(), KeybindingState::Idle);
        assert_eq!(
            state_changes(&outs),
            vec![KeybindingState::Idle],
            "StateChanged(Idle) emitted on processing done"
        );

        // When not in Processing, it's a no-op.
        let noop = kb.on_processing_done();
        assert!(noop.is_empty());
    }

    // ── JS: testCommitFiresOnlyOnce ──
    #[test]
    fn commit_fires_only_once_per_session() {
        let cfg = KeybindingConfig {
            release_gap_ms: 80,
            inter_tap_gap_ms: 20,
            repeat_delay_ms: 100,
            double_tap_window_ms: 150,
            hold_threshold: 3,
            release_mode: ReleaseMode::GapDetected,
        };
        let mut kb = Keybinding::new(cfg);

        let mut all = vec![];
        for i in 0..12u64 {
            let now = 100 + i * 10;
            all.extend(if i == 0 {
                kb.on_key_press(now)
            } else {
                kb.on_key_repeat(now)
            });
        }
        let commits = all
            .iter()
            .filter(|o| matches!(o, KeybindingOutput::CommitRecording))
            .count();
        assert_eq!(commits, 1);

        // Past release
        let last = 100 + 11 * 10;
        let (late, _) = kb.tick(last + cfg.release_gap_ms + 5);
        assert_eq!(kb.state(), KeybindingState::Processing);
        let late_commits = late
            .iter()
            .filter(|o| matches!(o, KeybindingOutput::CommitRecording))
            .count();
        assert_eq!(late_commits, 0);
    }

    // ── JS: testCommitResetsOnNewSession ──
    #[test]
    fn commit_resets_on_new_recording_session() {
        let cfg = KeybindingConfig {
            release_gap_ms: 60,
            inter_tap_gap_ms: 20,
            repeat_delay_ms: 100,
            double_tap_window_ms: 100,
            hold_threshold: 3,
            release_mode: ReleaseMode::GapDetected,
        };
        let mut kb = Keybinding::new(cfg);

        // First session
        for i in 0..6u64 {
            let now = 100 + i * 10;
            if i == 0 {
                kb.on_key_press(now);
            } else {
                kb.on_key_repeat(now);
            }
        }
        let _ = kb.tick(100 + 5 * 10 + cfg.release_gap_ms + 5);
        assert_eq!(kb.state(), KeybindingState::Processing);
        let _ = kb.on_processing_done();
        assert_eq!(kb.state(), KeybindingState::Idle);

        // Second session
        let base = 100 + 5 * 10 + cfg.release_gap_ms + 5 + 200;
        let mut all2 = vec![];
        for i in 0..6u64 {
            let now = base + i * 10;
            all2.extend(if i == 0 {
                kb.on_key_press(now)
            } else {
                kb.on_key_repeat(now)
            });
        }
        let starts = all2
            .iter()
            .filter(|o| matches!(o, KeybindingOutput::StartRecording))
            .count();
        let commits = all2
            .iter()
            .filter(|o| matches!(o, KeybindingOutput::CommitRecording))
            .count();
        assert_eq!(starts, 1);
        assert_eq!(commits, 1);
    }

    // ── JS: testLockedStateStaysOnRelease ──
    #[test]
    fn locked_state_stays_on_release() {
        let mut cfg = gap_config();
        cfg.release_gap_ms = 50;
        cfg.double_tap_window_ms = 300;
        let mut kb = Keybinding::new(cfg);

        // First tap
        kb.on_key_press(100);
        kb.on_key_repeat(110);
        let _ = kb.tick(110 + cfg.release_gap_ms + 5);
        assert_eq!(kb.state(), KeybindingState::Idle);

        // Second tap → LOCKED
        let t2 = 110 + cfg.release_gap_ms + 5 + 50;
        kb.on_key_press(t2);
        kb.on_key_repeat(t2 + 10);
        assert_eq!(kb.state(), KeybindingState::Locked);

        // Gap timer fires — stay LOCKED
        let last = t2 + 10;
        let _ = kb.tick(last + cfg.release_gap_ms + 5);
        assert_eq!(kb.state(), KeybindingState::Locked);
    }

    // ── JS: testHoldBelowThresholdNoCommit ──
    #[test]
    fn hold_below_threshold_emits_no_commit() {
        let cfg = KeybindingConfig {
            release_gap_ms: 50,
            inter_tap_gap_ms: 20,
            repeat_delay_ms: 100,
            double_tap_window_ms: 100,
            hold_threshold: 10,
            release_mode: ReleaseMode::GapDetected,
        };
        let mut kb = Keybinding::new(cfg);

        let mut all = vec![];
        for i in 0..4u64 {
            let now = 100 + i * 10;
            all.extend(if i == 0 {
                kb.on_key_press(now)
            } else {
                kb.on_key_repeat(now)
            });
        }
        let commits = all
            .iter()
            .filter(|o| matches!(o, KeybindingOutput::CommitRecording))
            .count();
        assert_eq!(commits, 0);

        let (late, _) = kb.tick(100 + 3 * 10 + cfg.release_gap_ms + 5);
        assert_eq!(kb.state(), KeybindingState::Idle);
        let late_commits = late
            .iter()
            .filter(|o| matches!(o, KeybindingOutput::CommitRecording))
            .count();
        assert_eq!(late_commits, 0);
    }

    // ── JS: testProcessingIgnoresPress ──
    #[test]
    fn processing_ignores_press() {
        let cfg = KeybindingConfig {
            release_gap_ms: 50,
            inter_tap_gap_ms: 20,
            repeat_delay_ms: 100,
            double_tap_window_ms: 100,
            hold_threshold: 3,
            release_mode: ReleaseMode::GapDetected,
        };
        let mut kb = Keybinding::new(cfg);

        // Hold → PROCESSING
        for i in 0..6u64 {
            let now = 100 + i * 10;
            if i == 0 {
                kb.on_key_press(now);
            } else {
                kb.on_key_repeat(now);
            }
        }
        let _ = kb.tick(100 + 5 * 10 + cfg.release_gap_ms + 5);
        assert_eq!(kb.state(), KeybindingState::Processing);

        // Press while PROCESSING is a no-op. We must first clear the
        // key-held flag (the synthesized release did that for us) so
        // that the next event counts as a first press, matching the
        // JS test which manually resets these fields.
        let start = 100 + 5 * 10 + cfg.release_gap_ms + 500;
        let outs = kb.on_key_press(start);
        assert_eq!(kb.state(), KeybindingState::Processing);
        assert!(effects(&outs).is_empty());
    }

    // ── Real-release mode ──
    #[test]
    fn real_release_mode_short_circuits_gap_detection() {
        let cfg = KeybindingConfig {
            release_gap_ms: 10_000, // huge — would never fire in the test
            inter_tap_gap_ms: 20,
            repeat_delay_ms: 100,
            double_tap_window_ms: 150,
            hold_threshold: 5,
            release_mode: ReleaseMode::Real,
        };
        let mut kb = Keybinding::new(cfg);

        let press = kb.on_key_press(100);
        assert_eq!(kb.state(), KeybindingState::Recording);
        assert!(effects(&press).contains(&KeybindingOutput::StartRecording));

        // Pump in 6 repeats — crosses the threshold, fires commit.
        let mut commits = 0;
        for i in 1..=6u64 {
            let outs = kb.on_key_repeat(100 + i * 10);
            commits += outs
                .iter()
                .filter(|o| matches!(o, KeybindingOutput::CommitRecording))
                .count();
        }
        assert_eq!(commits, 1);

        // Real release — immediately transitions to PROCESSING without
        // waiting for any gap timer. Release at 400 ms ensures the
        // hold duration exceeds the 200 ms Real-mode hold threshold
        // (press was at 100).
        let release = kb.on_key_release(400);
        assert_eq!(kb.state(), KeybindingState::Processing);
        assert!(effects(&release).contains(&KeybindingOutput::StopRecording));
    }

    #[test]
    fn real_release_mode_single_tap_discards() {
        let cfg = KeybindingConfig {
            release_gap_ms: 10_000,
            inter_tap_gap_ms: 20,
            repeat_delay_ms: 100,
            double_tap_window_ms: 100,
            hold_threshold: 5,
            release_mode: ReleaseMode::Real,
        };
        let mut kb = Keybinding::new(cfg);

        // Short tap: just a press + release, no repeats.
        kb.on_key_press(100);
        kb.on_key_release(120);
        assert_eq!(kb.state(), KeybindingState::Idle);

        // Double-tap window expires → DiscardRecording
        let (outs, _) = kb.tick(120 + cfg.double_tap_window_ms + 10);
        assert!(effects(&outs).contains(&KeybindingOutput::DiscardRecording));
    }

    #[test]
    fn real_release_mode_double_tap_locks() {
        let cfg = KeybindingConfig {
            release_gap_ms: 10_000,
            inter_tap_gap_ms: 20,
            repeat_delay_ms: 100,
            double_tap_window_ms: 300,
            hold_threshold: 5,
            release_mode: ReleaseMode::Real,
        };
        let mut kb = Keybinding::new(cfg);

        // Tap 1
        kb.on_key_press(100);
        kb.on_key_release(120);
        assert_eq!(kb.state(), KeybindingState::Idle);

        // Tap 2 inside window → LOCKED
        let second = kb.on_key_press(200);
        assert_eq!(kb.state(), KeybindingState::Locked);
        assert!(effects(&second).contains(&KeybindingOutput::CommitRecording));
    }

    // Regression: force_state(current_state) used to clear `key_held`,
    // causing a live hold to be silently lost when the daemon's
    // StartRecording dispatcher re-entered handle_start → force_state.
    // After that, the user's real key_release would hit the `!key_held`
    // guard and the FSM would stay stuck in Recording forever.
    #[test]
    fn force_state_same_state_preserves_physical_key_tracking() {
        let cfg = KeybindingConfig {
            release_gap_ms: 10_000,
            inter_tap_gap_ms: 20,
            repeat_delay_ms: 100,
            double_tap_window_ms: 450,
            hold_threshold: 3,
            release_mode: ReleaseMode::Real,
        };
        let mut kb = Keybinding::new(cfg);

        kb.on_key_press(1_000);
        assert_eq!(kb.state(), KeybindingState::Recording);

        // Simulate the daemon re-entering after StartRecording dispatch.
        let outs = kb.force_state(KeybindingState::Recording);
        assert!(outs.is_empty(), "idempotent no-op when already in state");

        // Short tap (<200ms held): release must still drive to Idle.
        let release = kb.on_key_release(1_100);
        assert_eq!(kb.state(), KeybindingState::Idle);
        assert!(state_changes(&release).contains(&KeybindingState::Idle));
    }

    #[test]
    fn real_release_mode_ignores_stray_release() {
        let cfg = KeybindingConfig {
            release_mode: ReleaseMode::Real,
            ..KeybindingConfig::default()
        };
        let mut kb = Keybinding::new(cfg);

        // Release with no preceding press is a no-op, not a crash.
        let outs = kb.on_key_release(100);
        assert!(outs.is_empty());
        assert_eq!(kb.state(), KeybindingState::Idle);
    }

    // ── configure() ──
    #[test]
    fn configure_mid_session_takes_effect() {
        let mut cfg = gap_config();
        cfg.release_gap_ms = 200;
        cfg.hold_threshold = 5;
        let mut kb = Keybinding::new(cfg);

        // Start a recording
        kb.on_key_press(100);
        kb.on_key_repeat(110);
        assert_eq!(kb.state(), KeybindingState::Recording);

        // Swap in a much shorter release gap.
        let mut new_cfg = cfg;
        new_cfg.release_gap_ms = 30;
        kb.configure(new_cfg);
        assert_eq!(kb.config().release_gap_ms, 30);

        // The NEXT event rearms the gap timer with the new value.
        kb.on_key_repeat(120);

        // 50ms after the last event: new gap (30) has elapsed, old
        // (200) has not.
        let (outs, _) = kb.tick(120 + 50);
        assert_eq!(kb.state(), KeybindingState::Idle);
        // No stop (was a tap, not a hold).
        assert!(!effects(&outs).contains(&KeybindingOutput::StopRecording));
    }

    // ── tick deadline plumbing ──
    #[test]
    fn tick_reports_next_deadline() {
        let cfg = gap_config();
        let mut kb = Keybinding::new(cfg);

        let (_, next) = kb.tick(0);
        assert_eq!(next, None);

        kb.on_key_press(100);
        let (_, next) = kb.tick(100);
        assert_eq!(next, Some(100 + cfg.release_gap_ms));
    }

    // ── Corner case: inter-tap gap triggered by on_key_repeat (not press) ──
    //
    // In GapDetected mode Mutter doesn't distinguish press from
    // repeat, so the JS fires _onKeyEvent on both. Verify inter-tap
    // works no matter which entrypoint delivered the late event.
    #[test]
    fn inter_tap_gap_fires_on_repeat_entrypoint() {
        let cfg = KeybindingConfig {
            release_gap_ms: 500,
            inter_tap_gap_ms: 40,
            repeat_delay_ms: 150,
            double_tap_window_ms: 400,
            hold_threshold: 5,
            release_mode: ReleaseMode::GapDetected,
        };
        let mut kb = Keybinding::new(cfg);

        kb.on_key_press(100);
        kb.on_key_repeat(110);
        kb.on_key_repeat(190); // 80ms gap — inter-tap boundary

        // Same final state as the press-delivered variant.
        assert_eq!(kb.state(), KeybindingState::Locked);
    }

    // ── StateChanged ordering ──
    //
    // The caller depends on Start/Commit/Stop preceding their own
    // StateChanged — verify the order matches what the JS
    // observers expect.
    #[test]
    fn state_changed_follows_recording_control_outputs() {
        let cfg = gap_config();
        let mut kb = Keybinding::new(cfg);
        let outs = kb.on_key_press(100);
        // First event of a fresh session should produce:
        //   StateChanged(Recording), StartRecording
        // in that order — _setState fires FIRST, then the press
        // handler pushes StartRecording (matches the JS ordering).
        assert!(matches!(outs[0], KeybindingOutput::StateChanged(KeybindingState::Recording)));
        assert!(matches!(outs[1], KeybindingOutput::StartRecording));
    }
}
