// SPDX-License-Identifier: MIT
// Speakeasy — Hold-to-talk keybinding manager with double-tap-to-lock

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/**
 * States for the dictation state machine.
 */
export const State = Object.freeze({
    IDLE: 'idle',
    RECORDING: 'recording',
    LOCKED: 'locked',
    PROCESSING: 'processing',
});

// Default timing constants. These are overridden by GSettings values
// when a settings object is provided to the constructor.
const DEFAULTS = Object.freeze({
    // grab_accelerator fires accelerator-activated on every key repeat (~30ms)
    // while held. There is a keyboard repeat delay (~250-600ms) between the
    // initial press and when repeat starts. We detect "key released" as a gap
    // with no events for RELEASE_GAP_MS. Must be longer than the repeat delay.
    RELEASE_GAP_MS: 700,

    // Key repeat fires every ~30ms. If we see a gap of >60ms between two
    // events, the key was released and re-pressed (a new tap within a stream).
    INTER_TAP_GAP_MS: 60,

    // The keyboard repeat delay (time between initial press and first repeat)
    // is typically 250-600ms. Gaps longer than this threshold are the repeat
    // delay, NOT an inter-tap gap — the user is still holding the key.
    REPEAT_DELAY_MS: 400,

    // After a quick tap (no repeats) is released, wait this long for a second
    // tap before discarding the recording.
    DOUBLE_TAP_WINDOW_MS: 500,

    // Minimum repeat events to consider a keypress a "hold" vs a "tap".
    // Quick taps may produce 1-3 events; a genuine hold produces many more.
    HOLD_THRESHOLD: 5,
});

/**
 * KeybindingManager uses Mutter's grab_accelerator API to intercept
 * a trigger key for hold-to-talk with double-tap-to-lock.
 *
 * Since grab_accelerator doesn't provide release events, we synthesize
 * them via gap detection: key repeat fires every ~30ms, so a gap of
 * RELEASE_GAP_MS with no events means the key was released.
 *
 * We also detect re-presses within a held stream: if the gap between
 * two consecutive events exceeds INTER_TAP_GAP_MS (~60ms vs ~30ms
 * repeat interval), we know the key was released and pressed again.
 *
 * Hold-to-talk:
 *   Press and hold -> recording starts
 *   Release -> stop recording, output text
 *
 * Double-tap-to-lock:
 *   Quick tap -> recording starts
 *   Release -> wait for second tap (recording stays running)
 *   Second tap -> lock recording on
 *   Third tap (while locked) -> stop recording, output text
 *
 * Single accidental tap:
 *   Quick tap -> recording starts
 *   Release -> wait for second tap
 *   Timeout -> stop recording, discard text
 */
export class KeybindingManager {
    /**
     * @param {object} opts
     * @param {string[]} opts.triggerAccels - list of accelerator strings;
     *     pressing any one of them activates the trigger.
     * @param {function} opts.onStartRecording
     * @param {function} opts.onStopRecording
     * @param {function} opts.onStateChanged
     * @param {Gio.Settings} [opts.settings] - GSettings for timing parameters
     */
    constructor({triggerAccels, onStartRecording, onStopRecording, onStateChanged, settings}) {
        this._triggerAccels = [...(triggerAccels ?? [])];
        this._onStartRecording = onStartRecording;
        this._onStopRecording = onStopRecording;
        this._onStateChanged = onStateChanged;
        this._settings = settings ?? null;

        // Load timing parameters from settings (or use defaults)
        this._loadTimingParams();

        this._state = State.IDLE;
        // Map of grab action id -> accelerator string for currently grabbed keys
        this._grabActions = new Map();
        this._activatedId = 0;

        // Gap detection
        this._gapTimeoutId = 0;
        this._keyHeld = false;
        this._repeatCount = 0;
        this._lastEventTime = 0;  // for inter-tap gap detection

        // Double-tap window timeout
        this._doubleTapTimeoutId = 0;

        // Callbacks set after construction
        this._onDiscardRecording = null;
        this._onCommitRecording = null;
        this._commitFired = false;  // only fire once per recording

        // Listen for settings changes to timing parameters
        this._settingsChangedIds = [];
        if (this._settings) {
            const timingKeys = [
                'release-gap-ms', 'inter-tap-gap-ms', 'repeat-delay-ms',
                'double-tap-window-ms', 'hold-threshold',
            ];
            for (const key of timingKeys) {
                this._settingsChangedIds.push(
                    this._settings.connect(`changed::${key}`, () => {
                        this._loadTimingParams();
                    })
                );
            }
        }
    }

    /**
     * Load timing parameters from GSettings, falling back to defaults.
     */
    _loadTimingParams() {
        if (this._settings) {
            this._releaseGapMs = this._settings.get_uint('release-gap-ms');
            this._interTapGapMs = this._settings.get_uint('inter-tap-gap-ms');
            this._repeatDelayMs = this._settings.get_uint('repeat-delay-ms');
            this._doubleTapWindowMs = this._settings.get_uint('double-tap-window-ms');
            this._holdThreshold = this._settings.get_uint('hold-threshold');
        } else {
            this._releaseGapMs = DEFAULTS.RELEASE_GAP_MS;
            this._interTapGapMs = DEFAULTS.INTER_TAP_GAP_MS;
            this._repeatDelayMs = DEFAULTS.REPEAT_DELAY_MS;
            this._doubleTapWindowMs = DEFAULTS.DOUBLE_TAP_WINDOW_MS;
            this._holdThreshold = DEFAULTS.HOLD_THRESHOLD;
        }
        log(`Speakeasy: timing params — release=${this._releaseGapMs} interTap=${this._interTapGapMs} repeatDelay=${this._repeatDelayMs} doubleTap=${this._doubleTapWindowMs} hold=${this._holdThreshold}`);
    }

    enable() {
        this._activatedId = global.display.connect(
            'accelerator-activated',
            (_display, action, _device, _timestamp) => {
                if (this._grabActions.has(action))
                    this._onKeyEvent();
            });

        this._grabAll(this._triggerAccels);
        log(`Speakeasy: keybinding enabled (accels=[${this._triggerAccels.join(', ')}], actions=[${[...this._grabActions.keys()].join(', ')}])`);
    }

    disable() {
        this._ungrabAll();

        if (this._activatedId) {
            global.display.disconnect(this._activatedId);
            this._activatedId = 0;
        }

        this._clearTimeouts();

        if (this._state === State.RECORDING || this._state === State.LOCKED) {
            this._setState(State.IDLE);
            this._onStopRecording();
        }
    }

    _clearTimeouts() {
        if (this._gapTimeoutId) {
            GLib.source_remove(this._gapTimeoutId);
            this._gapTimeoutId = 0;
        }
        if (this._doubleTapTimeoutId) {
            GLib.source_remove(this._doubleTapTimeoutId);
            this._doubleTapTimeoutId = 0;
        }
    }

    _grabAll(accels) {
        this._ungrabAll();

        for (const accel of accels) {
            if (!accel)
                continue;
            const action = global.display.grab_accelerator(accel, 0);
            if (action === Meta.KeyBindingAction.NONE) {
                log(`Speakeasy: failed to grab accelerator "${accel}"`);
                continue;
            }
            const name = Meta.external_binding_name_for_action(action);
            Main.wm.allowKeybinding(name, Shell.ActionMode.ALL);
            this._grabActions.set(action, accel);
            log(`Speakeasy: grabbed "${accel}" as action ${action} (binding: ${name})`);
        }
    }

    _ungrabAll() {
        for (const [action, accel] of this._grabActions) {
            const name = Meta.external_binding_name_for_action(action);
            Main.wm.allowKeybinding(name, Shell.ActionMode.NONE);
            global.display.ungrab_accelerator(action);
            log(`Speakeasy: ungrabbed action ${action} ("${accel}")`);
        }
        this._grabActions.clear();
    }

    setTriggerAccels(accels) {
        this._triggerAccels = [...accels];
        this._grabAll(this._triggerAccels);
    }

    getState() {
        return this._state;
    }

    processingDone() {
        if (this._state === State.PROCESSING)
            this._setState(State.IDLE);
    }

    forceState(newState) {
        this._setState(newState);
    }

    onDiscardRecording(callback) {
        this._onDiscardRecording = callback;
    }

    /**
     * Set callback for when recording is committed — meaning we are
     * confident this is a real recording that will produce output
     * (not an accidental tap). Fires once per recording session.
     *
     * Trigger points:
     *  - Hold-to-talk: when repeat count crosses hold threshold
     *  - Double-tap-to-lock: when entering LOCKED state
     *
     * Use this to warm the AI cache in parallel with recording.
     * @param {function} callback
     */
    onCommitRecording(callback) {
        this._onCommitRecording = callback;
    }

    /**
     * Fire the commit callback exactly once per recording session.
     */
    _fireCommit() {
        if (this._commitFired)
            return;
        this._commitFired = true;
        log('Speakeasy: recording committed');
        if (this._onCommitRecording)
            this._onCommitRecording();
    }

    /**
     * Handle every accelerator-activated event (press + repeats).
     */
    _onKeyEvent() {
        const now = GLib.get_monotonic_time() / 1000;
        const sinceLast = now - this._lastEventTime;
        this._lastEventTime = now;

        // Detect re-press: if the gap between events is larger than
        // normal repeat interval (~30ms) but shorter than the keyboard
        // repeat delay (~500ms), the key was released and pressed again
        // (fast double-tap). Gaps >= REPEAT_DELAY_MS are the initial
        // repeat delay during a sustained hold — NOT a re-press.
        if (this._keyHeld && sinceLast > this._interTapGapMs && sinceLast < this._repeatDelayMs) {
            // Synthesize a release for the previous hold, then handle
            // this event as a new press.
            log(`Speakeasy: inter-tap gap detected (${Math.round(sinceLast)}ms)`);
            this._keyHeld = false;
            this._onRelease();
            this._repeatCount = 0;
        }

        const wasHeld = this._keyHeld;
        this._keyHeld = true;
        this._repeatCount++;

        // Reset gap timeout on every event
        this._resetGapTimeout();

        // Fire commit when hold crosses the threshold — we now know
        // this is a real hold-to-talk, not an accidental tap.
        if (this._repeatCount === this._holdThreshold && this._state === State.RECORDING)
            this._fireCommit();

        // Only act on first event of a key-hold
        if (wasHeld)
            return;

        this._onPress();
    }

    /**
     * Synthetic press — first event of a new key-hold.
     */
    _onPress() {
        log(`Speakeasy: key press in state ${this._state}`);

        // Check if we're in the double-tap window
        const wasWaitingForDoubleTap = this._doubleTapTimeoutId !== 0;
        if (this._doubleTapTimeoutId) {
            GLib.source_remove(this._doubleTapTimeoutId);
            this._doubleTapTimeoutId = 0;
        }

        switch (this._state) {
            case State.IDLE:
                if (wasWaitingForDoubleTap) {
                    // Second tap — recording is still running, lock it
                    log('Speakeasy: double-tap detected, locking');
                    this._setState(State.LOCKED);
                    this._fireCommit();
                } else {
                    // Fresh first press — start recording
                    this._commitFired = false;
                    this._setState(State.RECORDING);
                    this._onStartRecording();
                }
                break;

            case State.RECORDING:
                // Shouldn't happen (repeats filtered), ignore
                break;

            case State.LOCKED:
                // Tap while locked -> stop and output
                this._setState(State.PROCESSING);
                this._onStopRecording();
                break;

            case State.PROCESSING:
                break;
        }
    }

    /**
     * Synthetic release — either gap timeout or inter-tap gap detected.
     */
    _onRelease() {
        const wasHeld = this._repeatCount >= this._holdThreshold;
        log(`Speakeasy: key release in state ${this._state} (events=${this._repeatCount}, held=${wasHeld})`);

        switch (this._state) {
            case State.RECORDING:
                if (wasHeld) {
                    // Hold-to-talk: stop and output text
                    this._setState(State.PROCESSING);
                    this._onStopRecording();
                } else {
                    // Quick tap: keep recording, wait for second tap
                    this._setState(State.IDLE);
                    this._doubleTapTimeoutId = GLib.timeout_add(
                        GLib.PRIORITY_DEFAULT, this._doubleTapWindowMs, () => {
                            this._doubleTapTimeoutId = 0;
                            log('Speakeasy: single tap, no follow-up — discarding');
                            if (this._onDiscardRecording)
                                this._onDiscardRecording();
                            return GLib.SOURCE_REMOVE;
                        });
                }
                break;

            case State.LOCKED:
                // Released while locked — stay locked
                break;

            case State.IDLE:
            case State.PROCESSING:
                break;
        }
    }

    _resetGapTimeout() {
        if (this._gapTimeoutId) {
            GLib.source_remove(this._gapTimeoutId);
            this._gapTimeoutId = 0;
        }
        this._gapTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._releaseGapMs, () => {
            this._gapTimeoutId = 0;
            this._keyHeld = false;
            this._onRelease();
            this._repeatCount = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _setState(newState) {
        const oldState = this._state;
        this._state = newState;
        log(`Speakeasy: state ${oldState} -> ${newState}`);
        if (this._onStateChanged)
            this._onStateChanged(newState);
    }

    destroy() {
        this.disable();

        // Disconnect settings change listeners
        if (this._settings && this._settingsChangedIds) {
            for (const id of this._settingsChangedIds)
                this._settings.disconnect(id);
            this._settingsChangedIds = [];
        }
        this._settings = null;
    }
}
