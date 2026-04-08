// SPDX-License-Identifier: MIT
// Speakeasy — Portable dictation controller
//
// This module orchestrates a single dictation session: starting the
// recorder, opening a crash-safe session log, feeding STT segments
// into the AI cleanup backend, finalizing on stop, saving the
// transcript JSON, and emitting events for the UI.
//
// It is intentionally portable. It does not import any GNOME Shell
// resources, Mutter, Clutter, or St — only GLib and Gio. The same
// class drives both:
//   - extension.js (the Shell extension), which wires the events to
//     the panel icon, recording overlay, and notifications;
//   - gtk-app.js (the standalone test app), which wires the events
//     to a GtkTextView and a level bar.
//
// The split exists so the dictation pipeline can be exercised and
// debugged outside the compositor — the user lost a long session
// last night to a hang inside GNOME Shell, and reproducing /
// instrumenting that hang is impractical when every iteration
// requires logging out.
//
// Architecture:
//
//   caller (extension.js or gtk-app.js)
//      │
//      ▼
//   DictationController       ← state machine, orchestration
//      │
//      ├── recorder            ← STT subprocess (recorder.js)
//      ├── ai                  ← AICleanup or OllamaCleanup
//      ├── output              ← typeText() — clipboard paste, or
//      │                         GtkTextView append for the test app
//      └── sessionLog          ← crash-safe per-session JSONL log
//
// The caller supplies all four components plus a settings object,
// and listens to a small set of callbacks for UI updates.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {SessionLog} from './sessionLog.js';

/**
 * Lifecycle states the controller cycles through. The keybinding
 * state machine in keybinding.js has its own (richer) states for
 * hold/lock/double-tap; this enum is just the controller's view.
 */
export const ControllerState = Object.freeze({
    IDLE: 'idle',
    RECORDING: 'recording',
    PROCESSING: 'processing',
});

export class DictationController {
    /**
     * @param {object} opts
     * @param {object} opts.recorder       - Recorder instance (recorder.js)
     * @param {object} opts.ai             - AICleanup or OllamaCleanup
     * @param {object} opts.output         - { typeText(text):Promise<bool>, init?, destroy? }
     * @param {Gio.Settings} opts.settings - Used for retain-audio + transcript-dir
     * @param {string} [opts.transcriptDirOverride] - Optional explicit
     *   transcript dir, bypassing the GSettings 'transcript-dir' key.
     * @param {string} [opts.sessionsDirOverride] - Optional explicit
     *   sessions dir for the crash-safe session log. Defaults to
     *   ~/.local/share/speakeasy/sessions. Tests should pass this so
     *   they don't pollute the user's real data dir.
     *
     * Callbacks (all optional):
     * @param {function(string)} [opts.onStateChanged]   - controller state
     * @param {function(string)} [opts.onPartialText]    - latest partial STT result
     * @param {function(string)} [opts.onFinalText]      - finalized STT segment
     * @param {function(number,number)} [opts.onLevel]   - audio level (rms,peak in dB)
     * @param {function(object)} [opts.onTranscript]     - transcript saved entry
     * @param {function(string)} [opts.onError]          - non-fatal error message for the UI
     * @param {function(string)} [opts.onLog]            - optional log sink
     *   (defaults to global `log()` if available, otherwise console.log)
     */
    constructor(opts) {
        this._recorder = opts.recorder;
        this._ai = opts.ai;
        this._output = opts.output;
        this._settings = opts.settings;
        this._transcriptDirOverride = opts.transcriptDirOverride ?? null;
        this._sessionsDirOverride = opts.sessionsDirOverride ?? null;

        this._onStateChanged = opts.onStateChanged ?? null;
        this._onPartialText = opts.onPartialText ?? null;
        this._onFinalText = opts.onFinalText ?? null;
        this._onLevel = opts.onLevel ?? null;
        this._onTranscript = opts.onTranscript ?? null;
        this._onError = opts.onError ?? null;
        this._log = opts.onLog ?? ((msg) => {
            // GJS exposes a global log() inside GNOME Shell; outside
            // the compositor we fall back to console.log.
            try { log(msg); } catch (_e) { console.log(msg); }
        });

        this._state = ControllerState.IDLE;

        // Per-session state
        this._sessionLog = null;
        this._audioPath = null;
        this._committed = false;
        this._stopPromise = null;

        // Wire recorder callbacks. We replace any existing callbacks
        // — the controller is the single owner of the recorder
        // forwarding once it's been constructed.
        this._wireRecorderCallbacks();
    }

    // ─── Public API ──────────────────────────────────────────────────

    getState() {
        return this._state;
    }

    /**
     * Get the path of the currently in-progress (or last) recording.
     * @returns {string|null}
     */
    getAudioPath() {
        return this._audioPath;
    }

    /**
     * Replace the AI backend (used when the user switches between
     * Anthropic and Ollama at runtime). The new backend should
     * already be init()'d.
     */
    setAi(ai) {
        this._ai = ai;
    }

    /**
     * Begin a recording session. Opens the crash-safe session log
     * and tells the recorder to start capturing. Does NOT begin the
     * AI session — the caller must call commit() separately for
     * that. (This split exists so the keybinding state machine can
     * defer the AI cache warmup until it knows the user is really
     * holding the key, not just bumping it accidentally.)
     *
     * @returns {boolean} true if the recorder started, false otherwise
     */
    start() {
        if (this._state !== ControllerState.IDLE) {
            this._log(`Speakeasy controller: start() while in ${this._state}, ignoring`);
            return false;
        }

        if (!this._recorder.isReady?.()) {
            this._log('Speakeasy controller: recorder not ready');
            this._fireError('STT model still loading, please wait.');
            return false;
        }

        const started = this._recorder.start();
        if (!started) {
            this._log('Speakeasy controller: recorder.start() returned false');
            this._fireError('Failed to start recording.');
            return false;
        }

        this._audioPath = this._recorder.getAudioPath();

        // Open the session log BEFORE entering RECORDING so the
        // very first final segment lands on disk.
        try {
            this._sessionLog = new SessionLog(this._sessionsDirOverride);
            this._sessionLog.start({
                audioPath: this._audioPath,
                uuid: null,
            });
        } catch (e) {
            this._log(`Speakeasy controller: SessionLog start failed (non-fatal): ${e.message}`);
            this._sessionLog = null;
        }

        this._committed = false;
        this._setState(ControllerState.RECORDING);
        return true;
    }

    /**
     * Commit the session — call this when you're confident the
     * recording is "real" (e.g. hold threshold reached, or
     * double-tap-lock entered). Begins the AI cleanup session,
     * which kicks off the cache-warmup HTTP request.
     *
     * Idempotent: calling commit() twice is a no-op.
     */
    commit() {
        if (this._state !== ControllerState.RECORDING) {
            this._log(`Speakeasy controller: commit() while in ${this._state}, ignoring`);
            return;
        }
        if (this._committed)
            return;
        this._committed = true;

        try {
            this._ai.beginSession();
        } catch (e) {
            this._log(`Speakeasy controller: ai.beginSession failed (non-fatal): ${e.message}`);
        }
    }

    /**
     * Stop the active recording, run AI cleanup, output the cleaned
     * text, and save the transcript. Returns a promise that resolves
     * with the saved transcript entry (or null on failure / discard).
     *
     * Safe to await from anywhere — the controller snapshots all
     * the resources it needs internally so the caller can dispose
     * of its references while the stop is in flight.
     */
    async stop() {
        if (this._state === ControllerState.IDLE)
            return null;

        // If a stop is already in flight, return its promise
        // instead of starting a new one.
        if (this._stopPromise)
            return this._stopPromise;

        const recorder = this._recorder;
        const ai = this._ai;
        const output = this._output;
        const sessionLog = this._sessionLog;
        const audioPath = this._audioPath;
        const wasCommitted = this._committed;
        const retainAudio = this._readRetainAudio();

        // Reset live state immediately so a follow-up start() can run.
        this._sessionLog = null;
        this._committed = false;

        const rawText = await recorder.stop();
        this._setState(ControllerState.PROCESSING);

        this._stopPromise = (async () => {
            try {
                return await this._stopInner({
                    rawText,
                    audioPath,
                    recorder,
                    ai,
                    output,
                    sessionLog,
                    wasCommitted,
                    retainAudio,
                });
            } finally {
                this._stopPromise = null;
                this._setState(ControllerState.IDLE);
            }
        })();
        return this._stopPromise;
    }

    /**
     * Discard the active recording without running AI cleanup or
     * saving a transcript. The audio file is deleted and the
     * session log is moved out of the orphan-recovery path.
     */
    discard() {
        if (this._state === ControllerState.IDLE)
            return;

        try { this._recorder.stop(); } catch (_e) { /* ignore */ }
        try { this._recorder.deleteAudio(); } catch (_e) { /* ignore */ }
        try { this._ai.cancelSession?.(); } catch (_e) { /* ignore */ }
        try { this._sessionLog?.markCompleted(); } catch (_e) { /* ignore */ }
        this._sessionLog = null;
        this._committed = false;
        this._audioPath = null;
        this._setState(ControllerState.IDLE);
    }

    /**
     * Release any held state. Does NOT destroy the recorder/ai/output
     * — those are owned by the caller.
     */
    dispose() {
        if (this._sessionLog) {
            try { this._sessionLog.close(); } catch (_e) { /* ignore */ }
            this._sessionLog = null;
        }
        this._onStateChanged = null;
        this._onPartialText = null;
        this._onFinalText = null;
        this._onLevel = null;
        this._onTranscript = null;
        this._onError = null;
    }

    // ─── Internal: stop pipeline ─────────────────────────────────────

    async _stopInner({rawText, audioPath, recorder, ai, output, sessionLog, wasCommitted, retainAudio}) {
        // No text recognized — discard.
        if (!rawText || rawText.trim() === '') {
            this._log('Speakeasy controller: no text recognized');
            this._fireError('No speech detected.');
            try { recorder.deleteAudio(); } catch (_e) { /* ignore */ }
            try { ai.cancelSession?.(); } catch (_e) { /* ignore */ }
            try { sessionLog?.markCompleted(); } catch (_e) { /* ignore */ }
            return null;
        }

        this._log(`Speakeasy controller: raw STT text: "${rawText}"`);

        // AI cleanup (only if commit() was called and AI is available)
        let textToOutput = rawText;
        let aiUsed = false;

        if (!wasCommitted) {
            this._log('Speakeasy controller: session never committed — skipping AI');
        } else if (!ai.isAvailable?.()) {
            this._log('Speakeasy controller: AI unavailable — outputting raw STT text');
        } else {
            try {
                const cleaned = await ai.finalize(null);
                if (cleaned !== null && cleaned.trim() !== '') {
                    this._log(`Speakeasy controller: AI cleanup complete: "${cleaned}"`);
                    textToOutput = cleaned;
                    aiUsed = true;
                } else {
                    this._log('Speakeasy controller: AI returned empty, using raw STT text');
                }
            } catch (e) {
                // CRITICAL: catching here is what protects the
                // transcript save from a hung Anthropic finalize.
                // The user lost a session because finalize() blocked
                // forever — now we fall through to raw text output
                // and the transcript still saves.
                this._log(`Speakeasy controller: AI cleanup error: ${e.message}`);
            }
        }

        // Output the text (clipboard paste in Shell, GtkTextView
        // append in test app, etc.). transcriptOk stays true even
        // on output failure — we still save the transcript.
        let transcriptOk = false;
        if (textToOutput !== null) {
            this._log(`Speakeasy controller: outputting text: "${textToOutput}"`);
            if (output) {
                try {
                    const success = await output.typeText(textToOutput);
                    transcriptOk = true;
                    if (!success) {
                        this._log('Speakeasy controller: output failed (paste)');
                        this._fireError(
                            'Please activate a text input before completing recording. ' +
                            'Transcript has been saved.');
                    }
                } catch (e) {
                    this._log(`Speakeasy controller: output error: ${e.message}`);
                    transcriptOk = true;  // we still have the text
                }
            } else {
                transcriptOk = true;
            }
        }

        // Write the stop record into the session log BEFORE the
        // transcript save, so a disk-full failure on the transcript
        // path leaves a recoverable .jsonl behind.
        try {
            sessionLog?.stop({
                rawText,
                cleanedText: textToOutput,
                aiUsed,
            });
        } catch (e) {
            this._log(`Speakeasy controller: SessionLog stop failed: ${e.message}`);
        }

        // Save transcript JSON
        let entry = null;
        if (transcriptOk) {
            entry = this.saveTranscript(
                rawText, textToOutput, retainAudio ? audioPath : null, aiUsed);
            if (entry) {
                try {
                    this._onTranscript?.(entry);
                } catch (e) {
                    this._log(`Speakeasy controller: onTranscript callback error: ${e.message}`);
                }
            }
            // Move the session log out of the live dir
            try { sessionLog?.markCompleted(); } catch (_e) { /* ignore */ }
        }

        // Audio retention
        if (transcriptOk && !retainAudio) {
            try { recorder.deleteAudio(); } catch (_e) { /* ignore */ }
        } else if (audioPath) {
            this._log(`Speakeasy controller: keeping audio at ${audioPath}`);
        }

        return entry;
    }

    // ─── Internal: callbacks ─────────────────────────────────────────

    _wireRecorderCallbacks() {
        const r = this._recorder;
        if (!r)
            return;

        if (typeof r.onPartialText === 'function') {
            r.onPartialText((text) => {
                try {
                    this._onPartialText?.(text);
                } catch (e) {
                    this._log(`Speakeasy controller: onPartialText error: ${e.message}`);
                }
            });
        }

        if (typeof r.onFinalText === 'function') {
            r.onFinalText((text) => {
                // Crash-safety: hit disk first.
                try { this._sessionLog?.appendFinal(text); } catch (_e) { /* ignore */ }
                try { this._ai?.feedText?.(text); } catch (e) {
                    this._log(`Speakeasy controller: ai.feedText error: ${e.message}`);
                }
                try {
                    this._onFinalText?.(text);
                } catch (e) {
                    this._log(`Speakeasy controller: onFinalText error: ${e.message}`);
                }
            });
        }

        if (typeof r.onLevel === 'function') {
            r.onLevel((rms, peak) => {
                try {
                    this._onLevel?.(rms, peak);
                } catch (e) {
                    this._log(`Speakeasy controller: onLevel error: ${e.message}`);
                }
            });
        }
    }

    _setState(newState) {
        if (this._state === newState)
            return;
        const oldState = this._state;
        this._state = newState;
        this._log(`Speakeasy controller: state ${oldState} -> ${newState}`);
        try {
            this._onStateChanged?.(newState);
        } catch (e) {
            this._log(`Speakeasy controller: onStateChanged error: ${e.message}`);
        }
    }

    _fireError(msg) {
        try {
            this._onError?.(msg);
        } catch (e) {
            this._log(`Speakeasy controller: onError callback error: ${e.message}`);
        }
    }

    _readRetainAudio() {
        try {
            return !!this._settings?.get_boolean('retain-audio');
        } catch (_e) {
            return false;
        }
    }

    // ─── Transcript save ─────────────────────────────────────────────

    /**
     * Resolve the transcript save directory, creating it if needed.
     * @returns {string} Absolute path
     */
    _getTranscriptDir() {
        let dir = this._transcriptDirOverride;
        if (!dir || dir === '') {
            try {
                dir = this._settings?.get_string('transcript-dir') ?? '';
            } catch (_e) {
                dir = '';
            }
        }
        if (!dir || dir === '') {
            dir = GLib.build_filenamev([
                GLib.get_user_data_dir(), 'speakeasy', 'transcripts',
            ]);
        }
        GLib.mkdir_with_parents(dir, 0o755);
        return dir;
    }

    /**
     * Save a transcript JSON file. Public so callers (and tests)
     * can use the same code path.
     */
    saveTranscript(rawText, cleanedText, audioPath, aiUsed) {
        try {
            const dir = this._getTranscriptDir();
            const now = new Date();
            const tsForFile = now.toISOString().replace(/[:.]/g, '-');
            const filename = `transcript-${tsForFile}.json`;
            const filepath = GLib.build_filenamev([dir, filename]);

            const transcript = {
                timestamp: now.toISOString(),
                raw_text: rawText,
                cleaned_text: cleanedText,
                audio_path: audioPath ?? null,
                ai_enabled: aiUsed ?? false,
            };

            const json = JSON.stringify(transcript, null, 2);
            const file = Gio.File.new_for_path(filepath);
            file.replace_contents(
                new TextEncoder().encode(json),
                null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );

            this._log(`Speakeasy controller: transcript saved: ${filepath}`);
            return {
                timestamp: transcript.timestamp,
                rawText,
                cleanedText,
                aiEnabled: aiUsed ?? false,
                filePath: filepath,
            };
        } catch (e) {
            this._log(`Speakeasy controller: failed to save transcript: ${e.message}`);
            return null;
        }
    }
}
