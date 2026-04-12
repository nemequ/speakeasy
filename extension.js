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
import {recoverOrphans} from './sessionLog.js';
import {DictationController, ControllerState} from './controller.js';
import {FileTranscriber} from './fileTranscribe.js';
import {rerunAiCleanup as rerunAiCleanupOnEntry} from './transcriptStore.js';
import {runRecoveryCleanupWithFeedback} from './recoveryCleanup.js';
import {PanelIcon} from './ui/panelIcon.js';
import {TranscriptDialog} from './ui/transcriptDialog.js';
import {RecoveryDialog} from './ui/recoveryDialog.js';
import {PathPromptDialog} from './ui/pathPromptDialog.js';
import {validateAudioPath} from './ui/pathValidation.js';
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

        // Configure recorder and output from settings
        this._recorder.setExtensionDir(this.path);
        this._recorder.setSettings(this._settings);
        this._output.setSettings(this._settings);

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

        // The DictationController owns the recorder/AI/output
        // callbacks; we wire it up after the session log recovery
        // below. The only recorder callback set here is onReady,
        // which logs and fires any pending recording start that
        // was queued while the subprocess was respawning (e.g.
        // after a watchdog SIGKILL).
        this._recorder.onReady(() => {
            log(`Speakeasy: STT subprocess ready (+${((GLib.get_monotonic_time() - t0) / 1000).toFixed(1)}ms from enable start)`);
            if (this._pendingStartAfterRespawn) {
                log('Speakeasy: firing queued recording start after respawn');
                const cb = this._pendingStartAfterRespawn;
                this._pendingStartAfterRespawn = null;
                try { cb(); } catch (e) {
                    log(`Speakeasy: queued start callback error: ${e.message}`);
                }
            }
        });

        // Spawn the STT subprocess.  This returns immediately — the
        // heavy work (GStreamer init, VOSK model load) happens in the
        // child process.  The recorder fires onReady() when the model
        // is loaded and it's ready to accept recording commands.
        //
        // If init() returns false, surface the specific failure
        // reason (missing model, missing gst-vosk plugin, etc.) as
        // a user-visible notification — the old code just logged a
        // generic warning and left the icon in the perpetual
        // "loading" state with no hint of what to do.
        if (!this._recorder.init()) {
            const reason = this._recorder.getLastInitFailureReason?.();
            const msg = reason?.message ??
                'STT subprocess failed to launch. See journalctl for details.';
            log(`Speakeasy: WARNING — STT subprocess failed to launch: ${msg}`);
            this._notify(msg);
        } else {
            // Arm a ready-timeout watchdog: if the subprocess
            // doesn't fire its "ready" event within 30s, the model
            // load is hung or the process crashed. Tell the user
            // instead of leaving the icon spinning forever.
            this._recorder.armReadyWatchdog?.(30, () => {
                log('Speakeasy: STT subprocess ready-timeout fired after 30s');
                this._notify(
                    'Speakeasy: STT model failed to load within 30 seconds. ' +
                    'The subprocess may be hung or crashing. ' +
                    'Check journalctl --user -g Speakeasy for details.');
            });
        }
        log(`Speakeasy:   subprocess spawned (+${((GLib.get_monotonic_time() - t0) / 1000).toFixed(1)}ms)`);

        // Verbose logging (extra log lines, no behavioral effect).
        this._verboseLogging = this._settings.get_boolean('verbose-logging');
        // Audio retention (independent of verbose-logging).
        this._retainAudio = this._settings.get_boolean('retain-audio');
        this._transcriptDir = this._settings.get_string('transcript-dir');

        // Recover any orphan session logs left behind by a previous
        // hung/killed session. The controller's per-session log is
        // owned by the controller and created on each start().
        try {
            const recovered = recoverOrphans(null, this._getTranscriptDir());
            if (recovered.length > 0) {
                log(`Speakeasy: recovered ${recovered.length} orphan session log(s)`);
                for (const r of recovered) {
                    log(`Speakeasy:   recovered ${r.source} (complete=${r.complete}) -> ${r.transcript}`);
                }
            }
        } catch (e) {
            log(`Speakeasy: orphan recovery failed (non-fatal): ${e.message}`);
        }

        // Transcript history — loaded from disk so it survives lock/unlock.
        // Loaded asynchronously to avoid blocking the compositor main loop.
        this._maxTranscripts = this._settings.get_uint('max-transcripts');
        this._transcripts = [];
        this._loadTranscriptsFromDiskAsync();
        log(`Speakeasy:   transcript load queued (+${((GLib.get_monotonic_time() - t0) / 1000).toFixed(1)}ms)`);

        // Build the portable dictation controller. It owns the
        // recorder/AI/output orchestration, the per-session log,
        // and the transcript save. The Shell extension just wires
        // its UI (panel icon, overlay, notifications, idle inhibit)
        // to the controller's callbacks.
        this._controller = new DictationController({
            recorder: this._recorder,
            ai: this._ai,
            output: this._output,
            settings: this._settings,
            onStateChanged: (state) => {
                if (state === ControllerState.RECORDING)
                    this._overlay?.open('recording');
                else if (state === ControllerState.PROCESSING)
                    this._overlay?.setMode('processing');
                else if (state === ControllerState.IDLE) {
                    this._keybinding?.processingDone();
                    this._overlay?.close();
                    this._uninhibitIdle();
                }
            },
            onPartialText: (text) => {
                this._panelIcon?.setPartialText(text);
                this._overlay?.setPartialText(text);
            },
            onFinalText: (text) => {
                this._overlay?.addFinalText(text);
            },
            onLevel: (rms, peak) => {
                this._overlay?.setLevel(rms, peak);
            },
            onTranscript: (entry) => {
                if (this._transcripts) {
                    this._transcripts.push(entry);
                    this._trimTranscripts();
                }
            },
            onError: (msg) => this._notify(msg),
        });

        // Create keybinding manager with settings for timing parameters
        this._keybinding = new KeybindingManager({
            triggerAccels: this._settings.get_strv('trigger-accels'),
            onStartRecording: () => this._startRecording(),
            onStopRecording: () => this._stopRecording(),
            onStateChanged: (state) => this._panelIcon.setState(state),
            settings: this._settings,
        });

        // Handle discard (single quick tap, no follow-up)
        this._keybinding.onDiscardRecording(() => this._discardRecording());

        // Handle commit (hold confirmed or double-tap locked) — begin AI session
        this._keybinding.onCommitRecording(() => {
            this._controller.commit();
        });

        // Listen for settings changes
        this._settingsChangedIds = [];
        this._settingsChangedIds.push(
            this._settings.connect('changed::trigger-accels', () => {
                this._keybinding.setTriggerAccels(
                    this._settings.get_strv('trigger-accels'));
            })
        );
        this._settingsChangedIds.push(
            this._settings.connect('changed::verbose-logging', () => {
                this._verboseLogging = this._settings.get_boolean('verbose-logging');
                log(`Speakeasy: verbose logging ${this._verboseLogging ? 'enabled' : 'disabled'}`);
            })
        );
        this._settingsChangedIds.push(
            this._settings.connect('changed::retain-audio', () => {
                this._retainAudio = this._settings.get_boolean('retain-audio');
                log(`Speakeasy: audio retention ${this._retainAudio ? 'enabled' : 'disabled'}`);
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

        // Wire up the toggle switch for click-to-record. Toggle
        // implies an intentional recording, so we commit immediately.
        this._panelIcon.onToggleRecording((active) => {
            if (active) {
                this._keybinding.forceState(State.RECORDING);
                this._startRecording();
                this._controller.commit();
            } else {
                this._keybinding.forceState(State.PROCESSING);
                this._stopRecording();
            }
        });

        // Wire up "Show Transcripts" menu item
        this._panelIcon.onShowTranscripts(() => this._showTranscripts());

        // Wire up "Recover from Audio File..." menu item
        this._panelIcon.onRecoverFromFile(() => this._recoverFromAudioFile());

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

        // The DictationController owns the session log; dispose()
        // closes it without marking it completed, so the next
        // enable() recovers it as an orphan.
        if (this._controller) {
            this._controller.dispose();
            this._controller = null;
        }

        // Cancel any in-flight recovery transcription.
        if (this._activeTranscriber) {
            try { this._activeTranscriber.cancel(); } catch (_e) { /* ignore */ }
            this._activeTranscriber = null;
        }

        // Drop any queued start that was waiting on a respawn.
        this._pendingStartAfterRespawn = null;

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

        // Push the new backend into the controller (it may have been
        // constructed with the previous one).
        this._controller?.setAi(this._ai);
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
    //
    // The actual orchestration (recorder + AI + output + session log
    // + transcript save) lives in DictationController. These methods
    // are thin wrappers that handle the Shell-only side effects:
    // idle inhibit, fallback notifications, and tracking the in-flight
    // stop promise so disable() can wait for it.

    _startRecording() {
        log('Speakeasy: starting recording');

        // If the recorder subprocess is mid-respawn (e.g. after a
        // watchdog kill), don't reject the start outright — queue
        // it and fire it from the onReady callback. This closes the
        // window between a watchdog SIGKILL and the new subprocess
        // being ready, so the user's next trigger press isn't lost.
        // We only do this if the recorder is actively respawning;
        // if it's never been ready (e.g. init() failed at startup)
        // we let the controller's normal isReady check fail loudly.
        if (!this._recorder?.isReady() && this._recorder?.isRespawning()) {
            log('Speakeasy: recorder is respawning, queuing start');
            this._notify('Recorder restarting — recording will begin shortly.');
            // Replace any earlier pending start: only the most
            // recent trigger matters. Don't inhibit idle yet — that
            // happens when the queued start actually fires.
            this._pendingStartAfterRespawn = () => {
                this._inhibitIdle();
                const started = this._controller.start();
                if (!started) {
                    this._uninhibitIdle();
                    this._keybinding.forceState(State.IDLE);
                }
            };
            return;
        }

        this._inhibitIdle();
        const started = this._controller.start();
        if (!started) {
            this._uninhibitIdle();
            this._keybinding.forceState(State.IDLE);
        }
    }

    async _stopRecording() {
        log('Speakeasy: stopping recording');
        const stopPromise = this._controller.stop();
        this._pendingStop = stopPromise;
        try {
            await stopPromise;
        } finally {
            if (this._pendingStop === stopPromise)
                this._pendingStop = null;
            // Idle uninhibit is also fired by the controller's
            // onStateChanged(IDLE) callback; this is a belt-and-
            // suspenders extra in case the state callback was
            // missed (e.g. controller already disposed).
            this._uninhibitIdle();
        }
    }

    _discardRecording() {
        log('Speakeasy: discarding recording');
        this._controller.discard();
        this._uninhibitIdle();
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
                            recovered: data.recovered ?? false,
                            audioPath: data.audio_path ?? null,
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
            onDelete: (entry) => this._deleteTranscript(entry),
            onRerunCleanup: (entry) => this._rerunCleanupForEntry(entry),
        });
        dialog.open();
    }

    /**
     * Delete a single transcript: remove from in-memory list and
     * delete the JSON file from disk. Called by TranscriptDialog's
     * per-row delete button.
     */
    _deleteTranscript(entry) {
        if (!entry)
            return false;
        if (this._transcripts) {
            const idx = this._transcripts.indexOf(entry);
            if (idx !== -1)
                this._transcripts.splice(idx, 1);
        }
        if (entry.filePath) {
            try {
                Gio.File.new_for_path(entry.filePath).delete(null);
            } catch (_e) { /* already gone */ }
        }
        log(`Speakeasy: deleted transcript ${entry.filePath ?? '(no path)'}`);
        return true;
    }

    /**
     * Re-run AI cleanup on an existing transcript entry. Uses an
     * isolated AI instance so a live dictation session can be in
     * progress concurrently.
     *
     * @returns {Promise<boolean>} true on success
     */
    async _rerunCleanupForEntry(entry) {
        if (!entry)
            return false;
        const isolatedAi = this._createIsolatedAi();
        if (!isolatedAi) {
            log('Speakeasy: re-run cleanup skipped — no AI available');
            return false;
        }
        try {
            const ok = await rerunAiCleanupOnEntry(entry, isolatedAi);
            if (ok)
                log(`Speakeasy: re-ran AI cleanup on transcript ${entry.filePath ?? ''}`);
            else
                log(`Speakeasy: re-run AI cleanup failed for ${entry.filePath ?? ''}`);
            return ok;
        } finally {
            try { isolatedAi.destroy(); } catch (_e) { /* ignore */ }
        }
    }

    /**
     * Recover a transcript from an existing audio file.
     *
     * Flow:
     *   1. Pick the audio file using whichever picker is available.
     *      We try zenity first, then kdialog, then fall back to a
     *      manual path-entry dialog so the recovery flow always
     *      works regardless of which file pickers are installed.
     *      (gnome-shell can't host a Gtk.FileDialog cleanly from
     *      inside the compositor process — that's why we shell out.)
     *   2. Open a RecoveryDialog and start a FileTranscriber.
     *   3. As events arrive from the subprocess, update the dialog.
     *   4. On done, the user clicks Save, which calls back here to
     *      save the transcript JSON via the controller's
     *      saveTranscript() helper. AI cleanup runs in the
     *      background on an isolated AI instance and the
     *      transcript is updated in place.
     */
    _recoverFromAudioFile() {
        // Defense in depth: if a recovery is already in flight, refuse
        // to start a second one. The menu item should also be grayed
        // out by the sensitivity dance below, but we may race with a
        // second click that was queued before the sensitivity update
        // reached the compositor.
        if (this._activeTranscriber) {
            log('Speakeasy: recovery already in progress, ignoring request');
            return;
        }

        const audioDir = GLib.build_filenamev([
            GLib.get_user_data_dir(), 'speakeasy', 'audio',
        ]);
        // Make sure the dir exists so the picker opens there even
        // if the user has never retained any audio.
        try { GLib.mkdir_with_parents(audioDir, 0o755); } catch (_e) { /* ignore */ }

        // Gray out the menu item for the duration of the flow so the
        // user can't spawn a second FileTranscriber on top of this
        // one. Re-enabled in the picker's cancel path, and in
        // _startRecovery's onDone/onError/onCancel hooks.
        this._panelIcon?.setRecoverFromFileSensitive(false);

        this._pickAudioFile(audioDir, (path) => {
            if (path) {
                this._startRecovery(path);
            } else {
                // User cancelled the picker — re-enable the menu item.
                this._panelIcon?.setRecoverFromFileSensitive(true);
            }
        });
    }

    /**
     * File picker fallback chain.  Tries each picker in order;
     * the first one whose binary is on PATH is used. The very
     * last fallback is an in-Shell prompt that asks the user to
     * paste a path. Calls the callback with the chosen absolute
     * path, or null if the user cancelled / no path was provided.
     *
     * @param {string} initialDir
     * @param {function(string|null)} callback
     */
    _pickAudioFile(initialDir, callback) {
        const audioExts = ['opus', 'wav', 'mp3', 'flac', 'ogg', 'm4a'];

        // Try zenity first.
        if (GLib.find_program_in_path('zenity')) {
            this._spawnPickerProcess([
                'zenity', '--file-selection',
                `--filename=${initialDir}/`,
                '--title=Choose audio file to transcribe',
                `--file-filter=Audio files | ${audioExts.map(e => `*.${e}`).join(' ')}`,
                '--file-filter=All files | *',
            ], callback);
            return;
        }

        // Then kdialog.
        if (GLib.find_program_in_path('kdialog')) {
            const filter = `${audioExts.map(e => `*.${e}`).join(' ')}|Audio files\n*|All files`;
            this._spawnPickerProcess([
                'kdialog', '--getopenfilename',
                `${initialDir}/`,
                filter,
                '--title', 'Choose audio file to transcribe',
            ], callback);
            return;
        }

        // No external picker available — prompt for a path inline.
        log('Speakeasy: no zenity/kdialog found, prompting for path manually');
        this._promptForPathInline(initialDir, callback);
    }

    /**
     * Spawn a child picker process, parse its stdout as a single
     * absolute path, and call the callback with the result.
     */
    _spawnPickerProcess(argv, callback) {
        let proc;
        try {
            proc = new Gio.Subprocess({
                argv,
                flags: Gio.SubprocessFlags.STDOUT_PIPE |
                       Gio.SubprocessFlags.STDERR_SILENCE,
            });
            proc.init(null);
        } catch (e) {
            log(`Speakeasy: failed to launch ${argv[0]}: ${e.message}`);
            // Fall through to inline prompt
            this._promptForPathInline(null, callback);
            return;
        }

        proc.communicate_utf8_async(null, null, (p, result) => {
            let stdout, success;
            try {
                [success, stdout] = p.communicate_utf8_finish(result);
            } catch (e) {
                log(`Speakeasy: ${argv[0]} communicate failed: ${e.message}`);
                callback(null);
                return;
            }
            if (!success || p.get_exit_status() !== 0) {
                callback(null);
                return;
            }
            const path = (stdout || '').trim();
            callback(path || null);
        });
    }

    /**
     * Last-resort fallback: open the in-Shell PathPromptDialog
     * (an St-based modal with a single editable text entry). Used
     * when neither zenity nor kdialog is available so the recovery
     * flow can always be reached.
     */
    _promptForPathInline(initialDir, callback) {
        log('Speakeasy: no zenity/kdialog found; opening inline path prompt');
        const dialog = new PathPromptDialog({
            title: 'Recover from Audio File',
            message: 'Type or paste the absolute path of an audio ' +
                'file (.opus, .wav, .mp3, .flac, .ogg, .m4a) to ' +
                'transcribe. Install zenity or kdialog for a real ' +
                'file picker.',
            initialPath: initialDir ? `${initialDir}/` : '',
            onAccept: (path) => callback(path || null),
            onCancel: () => callback(null),
        });
        dialog.open();
    }

    /**
     * Open the recovery dialog and kick off transcription of the
     * given audio file. Pulled out of _recoverFromAudioFile so the
     * GTK test app can call it directly with a path.
     */
    _startRecovery(audioPath) {
        log(`Speakeasy: starting recovery for ${audioPath}`);

        // Pre-flight the path before spawning a FileTranscriber.
        // FileTranscriber.start() also checks this, but surfacing the
        // error here means the user sees a notification instead of a
        // half-opened dialog that flashes "Loading STT model..." and
        // then errors out.
        const {ok, error} = validateAudioPath(audioPath);
        if (!ok) {
            log(`Speakeasy: recovery pre-flight failed: ${error}`);
            this._notify(`Cannot recover: ${error}`);
            this._panelIcon?.setRecoverFromFileSensitive(true);
            return;
        }

        // Guarantee we always re-enable the menu item, regardless of
        // which exit path (save, cancel, error, dialog-closed) fires.
        let reenabled = false;
        const reenable = () => {
            if (reenabled)
                return;
            reenabled = true;
            this._panelIcon?.setRecoverFromFileSensitive(true);
        };

        const dialog = new RecoveryDialog({
            audioPath,
            onSave: (rawText, doneInfo) => {
                this._saveRecoveredTranscript(audioPath, rawText, doneInfo);
                reenable();
            },
            onCancel: () => {
                if (this._activeTranscriber) {
                    this._activeTranscriber.cancel();
                    this._activeTranscriber = null;
                }
                reenable();
            },
        });

        const transcriber = new FileTranscriber({
            extensionDir: this.path,
            // Reuse the live recorder's resolved model path so the
            // subprocess doesn't re-run auto-detection. The recorder
            // has already resolved this from settings or from
            // ~/.cache/vosk discovery, and that path is the
            // authoritative one for this user's environment.
            modelPath: this._recorder?.getModelPath?.() ?? null,
            onLoading: () => dialog.onLoading(),
            onReady: () => dialog.onReady(),
            onProgress: (info) => dialog.onProgress(info),
            onPartial: (text) => dialog.onPartial(text),
            onFinal: (text) => dialog.onFinal(text),
            onDone: (info) => {
                dialog.onDone(info);
                this._activeTranscriber = null;
                // The subprocess is done — the menu item is safe to
                // re-enable even though the dialog may still be open
                // waiting for the user to click Save. A second
                // recovery can safely start while the user is still
                // reading the result.
                reenable();
            },
            onError: (msg) => {
                dialog.onError(msg);
                this._activeTranscriber = null;
                // Error state — re-enable now so the user can retry
                // without waiting to dismiss the dialog.
                reenable();
            },
        });

        this._activeTranscriber = transcriber;
        dialog.open();

        if (!transcriber.start(audioPath, null)) {
            log('Speakeasy: failed to start FileTranscriber');
            this._activeTranscriber = null;
            reenable();
        }
    }

    /**
     * Save a recovered transcript: write the JSON, add to in-memory
     * list, and (if AI is enabled) kick off a background cleanup
     * pass that updates the entry when it completes.
     */
    _saveRecoveredTranscript(audioPath, rawText, _doneInfo) {
        // Use the controller's saveTranscript so the JSON shape
        // matches everywhere. We pass cleaned_text=rawText for now;
        // the AI cleanup pass below will replace it.
        const entry = this._controller?.saveTranscript(
            rawText, rawText, audioPath, false);

        if (!entry) {
            log('Speakeasy: recovery save failed');
            this._notify('Failed to save recovered transcript.');
            return;
        }

        // Mark this entry as recovered for the UI
        entry.recovered = true;

        if (this._transcripts) {
            this._transcripts.push(entry);
            this._trimTranscripts();
        }

        log(`Speakeasy: recovered transcript saved at ${entry.filePath}`);
        this._notify(`Recovered transcript saved (${rawText.length} chars).`);

        // Optional AI cleanup pass — runs in the background, updates
        // the transcript JSON and the in-memory entry when done.
        if (this._ai && this._ai.isAvailable()) {
            this._runRecoveryAiCleanup(entry, audioPath, rawText);
        }
    }

    /**
     * Build a fresh AI backend instance configured the same way as
     * the live one. Used by the recovery cleanup so it can never
     * collide with an in-flight normal dictation session — both
     * AICleanup and OllamaCleanup keep per-instance session state
     * (active session UUID, chunk buffer, conversation history),
     * and feeding a recovered transcript through the live instance
     * would clobber the live state.
     *
     * Returns null if no AI backend is configured or if init fails.
     * Caller is responsible for calling .destroy() when done.
     */
    _createIsolatedAi() {
        if (!this._settings)
            return null;
        const backend = this._settings.get_string('ai-backend');
        let ai;
        try {
            ai = backend === 'ollama' ? new OllamaCleanup() : new AICleanup();
            ai.setExtensionDir(this.path);
            ai.setSettings(this._settings);
            if (!ai.init())
                return null;
        } catch (e) {
            log(`Speakeasy: failed to create isolated AI: ${e.message}`);
            return null;
        }
        if (!ai.isAvailable()) {
            ai.destroy();
            return null;
        }
        return ai;
    }

    /**
     * Run a one-shot AI cleanup pass on a recovered transcript.
     * This is a "synthetic session" — we begin a fresh AI session
     * on a *separate, isolated* AI instance, feed the entire raw
     * text in one chunk, finalize, then rewrite the saved
     * transcript JSON with the cleaned text. Using an isolated
     * instance means a normal recording can be in progress at the
     * same time without interference.
     */
    _runRecoveryAiCleanup(entry, audioPath, rawText) {
        const isolatedAi = this._createIsolatedAi();
        if (!isolatedAi) {
            log('Speakeasy: skipping recovery AI cleanup (no isolated AI available)');
            return;
        }
        log(`Speakeasy: running AI cleanup on recovered transcript (${rawText.length} chars) on isolated instance`);

        // Ensure the entry carries the fields rerunAiCleanup needs.
        // controller.saveTranscript() doesn't set audioPath on the
        // returned entry, but rerunAiCleanup preserves it in the
        // rewritten JSON under the audio_path field.
        entry.audioPath = audioPath;
        entry.recovered = true;

        runRecoveryCleanupWithFeedback(entry, isolatedAi, {
            onStart: () => {
                this._notify('Cleaning up recovered transcript via AI...');
            },
            onDone: (e) => {
                log(`Speakeasy: recovery AI cleanup complete (${e.cleanedText?.length ?? 0} chars)`);
                this._notify('Recovered transcript cleanup complete.');
            },
            onError: (err) => {
                if (err)
                    log(`Speakeasy: recovery AI cleanup failed: ${err.message}`);
                else
                    log('Speakeasy: recovery AI cleanup returned empty');
                this._notify('AI cleanup failed for recovered transcript — raw text kept.');
            },
        }).finally(() => {
            // Always release the isolated AI's HTTP session.
            try { isolatedAi.destroy(); } catch (_e) { /* ignore */ }
        });
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

    // _saveTranscript was removed in the controller refactor —
    // the DictationController.saveTranscript() method is now the
    // single implementation, used by both the Shell extension and
    // the standalone GTK test app.
}
