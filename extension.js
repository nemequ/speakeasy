// SPDX-License-Identifier: MIT
// Speakeasy — Main extension entry point

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {Recorder} from './recorder.js';
import {KeybindingManager, State} from './keybinding.js';
import {Output} from './output.js';
import {AICleanup} from './ai.js';
import {OllamaCleanup} from './ollama.js';
import {PanelIcon} from './ui/panelIcon.js';
import {TranscriptDialog} from './ui/transcriptDialog.js';
import {RecordingOverlay} from './ui/recordingOverlay.js';

// SessionManager inhibit flags
const INHIBIT_IDLE = 8;  // prevent idle → screen lock

export default class SpeakeasyExtension extends Extension {
    enable() {
        const t0 = GLib.get_monotonic_time();
        log('Speakeasy: enable() start');

        // Idle inhibit state
        this._inhibitCookie = 0;
        this._sessionBus = null;

        // Track in-flight async stop so disable() can wait for it
        this._pendingStop = null;

        // Load settings
        this._settings = this.getSettings();
        log(`Speakeasy:   settings loaded (+${((GLib.get_monotonic_time() - t0) / 1000).toFixed(1)}ms)`);

        // Create components (constructors are lightweight — no I/O)
        this._recorder = new Recorder();
        this._output = new Output();
        this._panelIcon = new PanelIcon();
        log(`Speakeasy:   components created (+${((GLib.get_monotonic_time() - t0) / 1000).toFixed(1)}ms)`);

        // Configure recorder from settings (reads stt-backend, model paths)
        this._recorder.setExtensionDir(this.path);
        this._recorder.setSettings(this._settings);

        // Create and configure the AI cleanup backend (Soup.Session only — fast)
        this._createAIBackend();
        log(`Speakeasy:   AI backend created (+${((GLib.get_monotonic_time() - t0) / 1000).toFixed(1)}ms)`);

        // Initialize output (virtual keyboard for clipboard paste)
        if (!this._output.init()) {
            log('Speakeasy: WARNING — virtual keyboard not available, paste output will fail');
        }
        log(`Speakeasy:   output init (+${((GLib.get_monotonic_time() - t0) / 1000).toFixed(1)}ms)`);

        // Create recording overlay
        this._overlay = new RecordingOverlay();
        Main.layoutManager.addTopChrome(this._overlay);
        log(`Speakeasy:   overlay created (+${((GLib.get_monotonic_time() - t0) / 1000).toFixed(1)}ms)`);

        // Position overlay near bottom center of primary monitor.
        // Deferred because primaryMonitor may be null during early enable().
        this._positionOverlay();
        if (!Main.layoutManager.primaryMonitor) {
            this._monitorsChangedId = Main.layoutManager.connect(
                'monitors-changed', () => {
                    this._positionOverlay();
                    if (this._monitorsChangedId) {
                        Main.layoutManager.disconnect(this._monitorsChangedId);
                        this._monitorsChangedId = 0;
                    }
                });
        }

        // Wire overlay cancel button — discard the current recording
        this._overlay.onCancel(() => {
            log('Speakeasy: recording cancelled via overlay button');
            this._keybinding.forceState(State.IDLE);
            this._discardRecording();
        });

        // Wire recorder callbacks — partial/final text goes to both
        // the panel icon and the recording overlay; level events go
        // to the overlay waveform; final text is also fed to the AI.
        this._recorder.onPartialText((text) => {
            this._panelIcon.setPartialText(text);
            this._overlay.setPartialText(text);
        });
        this._recorder.onFinalText((text) => {
            this._ai.feedText(text);
            this._overlay.addFinalText(text);
        });
        this._recorder.onLevel((rms, peak) => {
            this._overlay.setLevel(rms, peak);
        });
        this._recorder.onReady(() => {
            log(`Speakeasy: STT subprocess ready (+${((GLib.get_monotonic_time() - t0) / 1000).toFixed(1)}ms from enable start)`);
        });

        // Spawn the STT subprocess.  This returns immediately — the
        // heavy work (GStreamer init, VOSK model load) happens in the
        // child process.  The recorder fires onReady() when the model
        // is loaded and it's ready to accept recording commands.
        if (!this._recorder.init()) {
            log('Speakeasy: WARNING — STT subprocess failed to launch');
        }
        log(`Speakeasy:   subprocess spawned (+${((GLib.get_monotonic_time() - t0) / 1000).toFixed(1)}ms)`);

        // Developer mode state (controls audio retention only)
        this._devMode = this._settings.get_boolean('developer-mode');
        this._transcriptDir = this._settings.get_string('transcript-dir');

        // Transcript history — loaded from disk so it survives lock/unlock.
        // Loaded asynchronously to avoid blocking the compositor main loop.
        this._maxTranscripts = this._settings.get_uint('max-transcripts');
        this._transcripts = [];
        this._loadTranscriptsFromDiskAsync();
        log(`Speakeasy:   transcript load queued (+${((GLib.get_monotonic_time() - t0) / 1000).toFixed(1)}ms)`);

        // Create keybinding manager with settings for timing parameters
        this._keybinding = new KeybindingManager({
            triggerAccel: this._settings.get_string('trigger-accel'),
            onStartRecording: () => this._startRecording(),
            onStopRecording: () => this._stopRecording(),
            onStateChanged: (state) => this._panelIcon.setState(state),
            settings: this._settings,
        });

        // Handle discard (single quick tap, no follow-up)
        this._keybinding.onDiscardRecording(() => this._discardRecording());

        // Handle commit (hold confirmed or double-tap locked) — begin AI session
        this._keybinding.onCommitRecording(() => {
            this._ai.beginSession();
        });

        // Listen for settings changes
        this._settingsChangedIds = [];
        this._settingsChangedIds.push(
            this._settings.connect('changed::trigger-accel', () => {
                this._keybinding.setTriggerAccel(
                    this._settings.get_string('trigger-accel'));
            })
        );
        this._settingsChangedIds.push(
            this._settings.connect('changed::developer-mode', () => {
                this._devMode = this._settings.get_boolean('developer-mode');
                log(`Speakeasy: developer mode ${this._devMode ? 'enabled' : 'disabled'}`);
            })
        );
        this._settingsChangedIds.push(
            this._settings.connect('changed::transcript-dir', () => {
                this._transcriptDir = this._settings.get_string('transcript-dir');
            })
        );
        this._settingsChangedIds.push(
            this._settings.connect('changed::max-transcripts', () => {
                this._maxTranscripts = this._settings.get_uint('max-transcripts');
                this._trimTranscripts();
            })
        );
        this._settingsChangedIds.push(
            this._settings.connect('changed::ai-backend', () => {
                log('Speakeasy: AI backend changed, recreating');
                this._createAIBackend();
            })
        );

        // Wire up the toggle switch for click-to-record
        this._panelIcon.onToggleRecording((active) => {
            if (active) {
                // Start recording via toggle (bypass keybinding state machine)
                this._keybinding.forceState(State.RECORDING);
                this._startRecording();
                // Toggle implies intentional recording — begin AI session immediately
                this._ai.beginSession();
            } else {
                // Stop recording via toggle
                this._keybinding.forceState(State.PROCESSING);
                this._stopRecording();
            }
        });

        // Wire up "Show Transcripts" menu item
        this._panelIcon.onShowTranscripts(() => this._showTranscripts());

        // Wire up "Preferences" menu item
        this._panelIcon.onShowPreferences(() => this._openPreferences());

        // Add panel icon
        Main.panel.addToStatusArea('speakeasy', this._panelIcon);

        // Enable keybinding
        this._keybinding.enable();
        log(`Speakeasy:   keybinding enabled (+${((GLib.get_monotonic_time() - t0) / 1000).toFixed(1)}ms)`);

        // Set initial state
        this._panelIcon.setState(State.IDLE);

        log(`Speakeasy: enable() complete (+${((GLib.get_monotonic_time() - t0) / 1000).toFixed(1)}ms)`);
    }

    disable() {
        log('Speakeasy: disabling');

        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }

        // Release idle inhibit immediately
        this._uninhibitIdle();
        this._sessionBus = null;

        // Disconnect settings
        if (this._settingsChangedIds) {
            for (const id of this._settingsChangedIds)
                this._settings.disconnect(id);
            this._settingsChangedIds = null;
        }

        // Always destroy the recorder immediately to begin subprocess
        // shutdown.  The STT subprocess is the heaviest resource (~1.5 GB
        // for the VOSK model) and must not linger — if enable() is called
        // again quickly (e.g. screen lock/unlock), the new Recorder.init()
        // will wait for the dying subprocess to exit before respawning.
        //
        // Recorder.destroy() resolves any pending stop promise with empty
        // text, which is acceptable since we're disabling.  The snapshot
        // references held by _stopRecordingInner are sufficient for the
        // async pipeline to finish (AI cleanup, output, transcript save).
        if (this._recorder) {
            this._recorder.destroy();
            this._recorder = null;
        }

        // If a recording is being finalized, let it complete before
        // destroying the AI and output backends.  The async
        // _stopRecordingInner holds snapshot references to these
        // objects, so it can finish even after we null our own
        // references — but only if we don't call destroy() on them
        // while they're in use.
        if (this._pendingStop) {
            log('Speakeasy: waiting for in-flight recording to finish');
            const pendingAi = this._ai;
            const pendingOutput = this._output;
            this._pendingStop.finally(() => {
                log('Speakeasy: deferred cleanup after in-flight recording');
                pendingAi?.destroy();
                pendingOutput?.destroy();
            });
            this._ai = null;
            this._output = null;
        } else {
            // No in-flight recording — destroy immediately
            if (this._ai) {
                this._ai.destroy();
                this._ai = null;
            }
            if (this._output) {
                this._output.destroy();
                this._output = null;
            }
        }

        // Destroy components that are safe to tear down immediately
        if (this._keybinding) {
            this._keybinding.destroy();
            this._keybinding = null;
        }

        if (this._panelIcon) {
            this._panelIcon.destroy();
            this._panelIcon = null;
        }

        if (this._overlay) {
            Main.layoutManager.removeChrome(this._overlay);
            this._overlay.destroy();
            this._overlay = null;
        }

        this._transcripts = null;
        this._settings = null;
        this._pendingStop = null;

        log('Speakeasy: disabled');
    }

    /**
     * Show a desktop notification via GNOME Shell's MessageTray.
     * @param {string} body - Notification body text
     */
    _notify(body) {
        try {
            const source = new MessageTray.Source({
                title: 'Speakeasy',
                iconName: 'audio-input-microphone-symbolic',
            });
            Main.messageTray.add(source);
            const notification = new MessageTray.Notification({
                source,
                title: 'Speakeasy',
                body,
            });
            source.addNotification(notification);
        } catch (e) {
            log(`Speakeasy: notification failed: ${e.message} — body was: ${body}`);
        }
    }

    /**
     * Create (or recreate) the AI cleanup backend based on settings.
     * Both AICleanup and OllamaCleanup implement the same interface,
     * so extension.js doesn't need to know which one is active.
     */
    _createAIBackend() {
        if (this._ai) {
            this._ai.destroy();
            this._ai = null;
        }

        const backend = this._settings.get_string('ai-backend');
        if (backend === 'ollama') {
            log('Speakeasy: using Ollama backend');
            this._ai = new OllamaCleanup();
        } else {
            log('Speakeasy: using Anthropic backend');
            this._ai = new AICleanup();
        }

        this._ai.setExtensionDir(this.path);
        this._ai.setSettings(this._settings);
        this._ai.init();
    }

    // ─── Idle inhibit ─────────────────────────────────────────────────

    /**
     * Prevent the session from going idle (and locking the screen)
     * while recording is in progress.
     *
     * Uses async D-Bus calls to avoid blocking the compositor main loop.
     */
    _inhibitIdle() {
        if (this._inhibitCookie !== 0)
            return;  // already inhibited

        Gio.bus_get(Gio.BusType.SESSION, null, (obj, busResult) => {
            try {
                const bus = Gio.bus_get_finish(busResult);
                this._sessionBus = bus;

                bus.call(
                    'org.gnome.SessionManager',
                    '/org/gnome/SessionManager',
                    'org.gnome.SessionManager',
                    'Inhibit',
                    new GLib.Variant('(susu)', [
                        'speakeasy', 0,
                        'Recording in progress', INHIBIT_IDLE,
                    ]),
                    new GLib.VariantType('(u)'),
                    Gio.DBusCallFlags.NONE, -1, null,
                    (_bus, callResult) => {
                        try {
                            const reply = bus.call_finish(callResult);
                            this._inhibitCookie = reply.get_child_value(0).get_uint32();
                            log(`Speakeasy: idle inhibited (cookie=${this._inhibitCookie})`);
                        } catch (e) {
                            log(`Speakeasy: failed to inhibit idle: ${e.message}`);
                        }
                    }
                );
            } catch (e) {
                log(`Speakeasy: failed to get session bus: ${e.message}`);
            }
        });
    }

    /**
     * Re-allow idle/screen-lock.
     *
     * Uses async D-Bus calls to avoid blocking the compositor main loop.
     */
    _uninhibitIdle() {
        if (this._inhibitCookie === 0)
            return;

        const cookie = this._inhibitCookie;
        this._inhibitCookie = 0;

        const bus = this._sessionBus;
        if (!bus) {
            Gio.bus_get(Gio.BusType.SESSION, null, (obj, busResult) => {
                try {
                    const newBus = Gio.bus_get_finish(busResult);
                    this._uninhibitWithBus(newBus, cookie);
                } catch (e) {
                    log(`Speakeasy: failed to get session bus for uninhibit: ${e.message}`);
                }
            });
        } else {
            this._uninhibitWithBus(bus, cookie);
        }
    }

    /**
     * Send the Uninhibit D-Bus call asynchronously.
     * @param {Gio.DBusConnection} bus
     * @param {number} cookie
     */
    _uninhibitWithBus(bus, cookie) {
        bus.call(
            'org.gnome.SessionManager',
            '/org/gnome/SessionManager',
            'org.gnome.SessionManager',
            'Uninhibit',
            new GLib.Variant('(u)', [cookie]),
            null,
            Gio.DBusCallFlags.NONE, -1, null,
            (_bus, result) => {
                try {
                    bus.call_finish(result);
                    log(`Speakeasy: idle uninhibited (cookie=${cookie})`);
                } catch (e) {
                    log(`Speakeasy: failed to uninhibit idle: ${e.message}`);
                }
            }
        );
    }

    /**
     * Position the recording overlay near the bottom center of the
     * primary monitor.  Safe to call when primaryMonitor is null.
     */
    _positionOverlay() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this._overlay) return;
        const overlayH = this._overlay.height || 160;
        this._overlay.set_position(
            Math.floor(monitor.x + (monitor.width - this._overlay.width) / 2),
            Math.floor(monitor.y + monitor.height - overlayH - 40)
        );
    }

    // ─── Recording lifecycle ──────────────────────────────────────────

    /**
     * Called when recording should start (from keybinding or toggle).
     */
    _startRecording() {
        log('Speakeasy: starting recording');

        if (!this._recorder.isReady()) {
            log('Speakeasy: STT model still loading');
            this._notify('STT model still loading, please wait.');
            this._keybinding.forceState(State.IDLE);
            return;
        }

        this._inhibitIdle();
        const started = this._recorder.start();
        if (!started) {
            log('Speakeasy: failed to start recording');
            this._uninhibitIdle();
            this._notify('Failed to start recording. Check STT model.');
            // Force back to IDLE regardless of current state
            this._keybinding.forceState(State.IDLE);
        } else {
            // Show the overlay in recording state
            this._overlay.open('recording');
        }
    }

    /**
     * Called by the keybinding manager when recording should stop.
     * Pipeline: recorder.stop() → ai.finalize() → stream to wtype.
     *
     * Audio is retained on disk until we know the transcription succeeded.
     * On AI failure, the audio file is kept and the user is notified.
     */
    async _stopRecording() {
        log('Speakeasy: stopping recording');

        // Snapshot resources we need -- disable() may null them while we're async.
        const recorder = this._recorder;
        const ai = this._ai;
        const output = this._output;
        const settings = this._settings;
        const devMode = this._devMode;

        const audioPath = recorder.getAudioPath();
        const rawText = await recorder.stop();

        // Show overlay in processing state
        this._overlay.setMode('processing');

        // Track this async operation so disable() can wait for it.
        const stopPromise = this._stopRecordingInner(
            rawText, audioPath, recorder, ai, output, settings, devMode);
        this._pendingStop = stopPromise;
        try {
            await stopPromise;
        } finally {
            if (this._pendingStop === stopPromise)
                this._pendingStop = null;
            this._uninhibitIdle();
        }
    }

    /**
     * Inner implementation of _stopRecording, using only snapshot
     * references so it survives disable() tearing down this._*.
     */
    async _stopRecordingInner(rawText, audioPath, recorder, ai, output, settings, devMode) {
        if (!rawText || rawText.trim() === '') {
            log('Speakeasy: no text recognized');
            this._notify('No speech detected.');
            recorder.deleteAudio();
            ai.cancelSession();
            this._keybinding?.processingDone();
            this._overlay?.close();
            return;
        }

        log(`Speakeasy: raw STT text: "${rawText}"`);

        // AI cleanup
        let textToOutput = rawText;
        let aiUsed = false;

        if (!ai.isAvailable()) {
            const backend = settings?.get_string('ai-backend') ?? '?';
            const debugInfo = ai.getDebugInfo?.() ?? {};
            const details = Object.entries(debugInfo)
                .map(([k, v]) => `${k}=${v}`)
                .join(', ');
            log(`Speakeasy: AI cleanup unavailable — outputting raw STT text ` +
                `(backend=${backend}${details ? `, ${details}` : ''})`);
        } else {
            log('Speakeasy: finalizing AI session');
            try {
                const cleanedText = await ai.finalize(null);

                if (cleanedText !== null && cleanedText.trim() !== '') {
                    log(`Speakeasy: AI cleanup complete: "${cleanedText}"`);
                    textToOutput = cleanedText;
                    aiUsed = true;
                } else {
                    // AI returned nothing — fall through to output raw text.
                    // No notification: the raw text is still usable and the
                    // transcript is always saved regardless.
                    log('Speakeasy: AI cleanup returned empty, using raw STT text');
                }
            } catch (e) {
                // AI request failed — fall through to output raw text.
                log(`Speakeasy: AI cleanup error: ${e.message}`);
            }
        }

        // Output text — skip paste if output was destroyed (screen locked)
        let transcriptOk = false;
        if (textToOutput !== null) {
            log(`Speakeasy: outputting text: "${textToOutput}"`);
            if (output) {
                try {
                    const success = await output.typeText(textToOutput);
                    transcriptOk = true;
                    if (!success) {
                        log('Speakeasy: output failed (paste)');
                        this._notify(
                            'Please activate a text input before completing recording. ' +
                            'Transcript has been saved.');
                    }
                } catch (e) {
                    // Output was destroyed mid-paste (screen lock)
                    log(`Speakeasy: output error (likely screen lock): ${e.message}`);
                    transcriptOk = true;  // we still have the text
                }
            } else {
                // Output already destroyed — still save the transcript
                log('Speakeasy: output unavailable (extension disabled), saving transcript only');
                transcriptOk = true;
            }
        }

        // Always save transcript to disk and update in-memory list.
        // This uses only GLib/Gio, so it works even mid-teardown.
        if (transcriptOk) {
            const entry = this._saveTranscript(
                rawText, textToOutput, devMode ? audioPath : null, aiUsed);
            if (entry && this._transcripts)
                this._transcripts.push(entry);
            this._trimTranscripts();
        }

        // Audio retention: dev mode keeps audio, otherwise delete
        if (transcriptOk && !devMode) {
            try { recorder.deleteAudio(); } catch (_e) { /* ignore */ }
        } else if (audioPath) {
            log(`Speakeasy: keeping audio at ${audioPath}`);
        }

        this._keybinding?.processingDone();
        this._overlay?.close();
    }

    /**
     * Called when a recording should be discarded (single quick tap, no follow-up).
     * Stops the recorder, cancels any AI session, deletes audio.
     */
    _discardRecording() {
        log('Speakeasy: discarding recording');
        this._recorder.stop();
        this._recorder.deleteAudio();
        this._ai.cancelSession();
        this._uninhibitIdle();
        this._overlay?.close();
    }

    // ─── Transcript history ────────────────────────────────────────

    /**
     * Load transcript history from saved JSON files on disk asynchronously.
     * Called on enable() so history survives lock/unlock cycles.
     * Uses async file enumeration to avoid blocking the compositor.
     */
    _loadTranscriptsFromDiskAsync() {
        const dirPath = this._getTranscriptDir();
        const dir = Gio.File.new_for_path(dirPath);

        dir.enumerate_children_async(
            'standard::name', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_LOW, null,
            (source, result) => {
                let enumerator;
                try {
                    enumerator = source.enumerate_children_finish(result);
                } catch (e) {
                    log(`Speakeasy: failed to enumerate transcripts: ${e.message}`);
                    return;
                }
                this._loadNextTranscriptBatch(enumerator, dirPath, []);
            }
        );
    }

    /**
     * Recursively load transcript files in async batches.
     * @param {Gio.FileEnumerator} enumerator
     * @param {string} dirPath
     * @param {Array} transcripts - accumulator
     */
    _loadNextTranscriptBatch(enumerator, dirPath, transcripts) {
        // Load up to 10 entries per async call to avoid long main loop blocks
        enumerator.next_files_async(
            10, GLib.PRIORITY_LOW, null,
            (source, result) => {
                let infos;
                try {
                    infos = source.next_files_finish(result);
                } catch (e) {
                    log(`Speakeasy: error reading transcript batch: ${e.message}`);
                    this._finishTranscriptLoad(enumerator, transcripts);
                    return;
                }

                if (infos.length === 0) {
                    // No more files — done
                    this._finishTranscriptLoad(enumerator, transcripts);
                    return;
                }

                for (const info of infos) {
                    const name = info.get_name();
                    if (!name.endsWith('.json'))
                        continue;
                    try {
                        const path = GLib.build_filenamev([dirPath, name]);
                        const file = Gio.File.new_for_path(path);
                        // Individual file reads are small (~1KB) — sync is acceptable
                        const [ok, contents] = file.load_contents(null);
                        if (!ok) continue;

                        const data = JSON.parse(new TextDecoder().decode(contents));
                        transcripts.push({
                            timestamp: data.timestamp,
                            rawText: data.raw_text,
                            cleanedText: data.cleaned_text,
                            aiEnabled: data.ai_enabled ?? false,
                            filePath: path,
                        });
                    } catch (_e) {
                        // Skip unreadable/malformed files
                    }
                }

                // Continue with next batch
                this._loadNextTranscriptBatch(enumerator, dirPath, transcripts);
            }
        );
    }

    /**
     * Finalize async transcript loading — sort, merge into in-memory
     * list, and trim to the configured maximum.
     * @param {Gio.FileEnumerator} enumerator
     * @param {Array} transcripts
     */
    _finishTranscriptLoad(enumerator, transcripts) {
        try {
            enumerator.close(null);
        } catch (_e) { /* ignore */ }

        // Sort by timestamp ascending (oldest first) to match in-memory order
        transcripts.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

        // Merge: any transcripts saved between enable() and now go at the end
        if (this._transcripts && this._transcripts.length > 0) {
            // Keep entries added during the async load (from new recordings)
            const newEntries = this._transcripts;
            this._transcripts = transcripts.concat(newEntries);
        } else {
            this._transcripts = transcripts;
        }

        this._trimTranscripts();
        log(`Speakeasy: loaded ${transcripts.length} transcripts from disk`);
    }

    /**
     * Trim transcript history to respect the max-transcripts setting.
     * Deletes excess files from disk (oldest first).
     */
    _trimTranscripts() {
        if (!this._transcripts)
            return;
        while (this._transcripts.length > this._maxTranscripts) {
            const removed = this._transcripts.shift();
            if (removed?.filePath) {
                try {
                    Gio.File.new_for_path(removed.filePath).delete(null);
                } catch (_e) { /* file may already be gone */ }
            }
        }
    }

    /**
     * Delete all transcript files and clear the in-memory list.
     */
    clearTranscripts() {
        if (!this._transcripts)
            return;

        let deleted = 0;
        for (const entry of this._transcripts) {
            if (entry.filePath) {
                try {
                    Gio.File.new_for_path(entry.filePath).delete(null);
                    deleted++;
                } catch (_e) { /* ignore */ }
            }
        }
        this._transcripts = [];
        log(`Speakeasy: cleared transcript history (${deleted} files deleted)`);
    }

    /**
     * Open the extension preferences window.
     */
    _openPreferences() {
        try {
            this.openPreferences();
        } catch (e) {
            log(`Speakeasy: failed to open preferences: ${e.message}`);
            // Fallback: spawn the command
            try {
                GLib.spawn_command_line_async(
                    'gnome-extensions prefs speakeasy@speakeasy.local');
            } catch (e2) {
                log(`Speakeasy: fallback prefs launch failed: ${e2.message}`);
            }
        }
    }

    /**
     * Open a modal dialog showing transcript history.
     */
    _showTranscripts() {
        const dialog = new TranscriptDialog(this._transcripts, {
            onClear: () => {
                this.clearTranscripts();
                dialog.close();
            },
        });
        dialog.open();
    }

    // ─── Developer mode ──────────────────────────────────────────────

    /**
     * Resolve the transcript save directory, creating it if needed.
     * @returns {string} Absolute path to the transcript directory
     */
    _getTranscriptDir() {
        let dir = this._transcriptDir;
        if (!dir || dir === '') {
            // Default: $XDG_DATA_HOME/speakeasy/transcripts
            dir = GLib.build_filenamev([
                GLib.get_user_data_dir(), 'speakeasy', 'transcripts',
            ]);
        }

        // Ensure the directory exists
        GLib.mkdir_with_parents(dir, 0o755);
        return dir;
    }

    /**
     * Save a transcript JSON file to disk.
     * Uses only GLib/Gio so it works even if the extension is mid-teardown.
     * @param {string} rawText - Raw STT text
     * @param {string} cleanedText - AI-cleaned text (or raw if AI unavailable)
     * @param {string|null} audioPath - Path to the audio file, if retained
     * @param {boolean} [aiUsed] - Whether AI cleanup was used
     * @returns {object|null} The transcript entry (with filePath), or null on error
     */
    _saveTranscript(rawText, cleanedText, audioPath, aiUsed) {
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

            log(`Speakeasy: transcript saved: ${filepath}`);
            return {
                timestamp: transcript.timestamp,
                rawText,
                cleanedText,
                aiEnabled: aiUsed ?? false,
                filePath: filepath,
            };
        } catch (e) {
            log(`Speakeasy: failed to save transcript: ${e.message}`);
            return null;
        }
    }
}
