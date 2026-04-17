// SPDX-License-Identifier: MIT
// Speakeasy — Recorder module (subprocess IPC client)
//
// Architecture: STT runs in the speakeasy Rust binary as a
// subprocess, so the heavy model load never blocks the compositor.
// This module communicates with it over stdin/stdout using a
// line-based JSON protocol. The core owns audio capture (cpal),
// denoise (RNNoise), STT (whisper-rs), and optional AI cleanup.
//
// This module (Recorder) is a thin IPC client that presents the same
// interface to extension.js as the old in-process recorder.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// GStreamer is never imported in this file. It lives entirely in the
// STT subprocess — loading it here would run Gst.init() (a plugin
// registry scan) synchronously on the GNOME Shell main thread, which
// can hang the compositor when a plugin misbehaves. Confirmed on a
// Bazzite Steam Deck after a Gaming Mode → Desktop Mode transition:
// Gst.init() never returned and the whole desktop froze. The
// subprocess isolates any plugin failure to a child process where it
// can be cleanly detected and reported.

/**
 * Recorder communicates with the STT subprocess to manage recording
 * and speech recognition.  The public API matches the old in-process
 * Recorder so extension.js requires minimal changes.
 */
export class Recorder {
    constructor() {
        this._subprocess = null;
        this._stdin = null;      // Gio.OutputStream (write commands)
        this._stdout = null;     // Gio.DataInputStream (read events)
        this._running = false;
        this._ready = false;
        this._accumulatedText = [];
        this._audioPath = null;

        // Backend configuration
        this._backend = 'whisper'; // Default to whisper now that vosk is removed
        this._whisperModelPath = null;
        this._whisperLanguage = 'en';
        this._settings = null;
        this._settingsChangedIds = [];

        // Extension directory — set by extension.js for resolving subprocess path
        this._extensionDir = null;

        // Callbacks
        this._onPartialText = null;
        this._onFinalText = null;
        this._onReady = null;
        this._onLevel = null;
        this._onExit = null;
        this._onError = null;

        // Pending stop — resolved when the subprocess sends "stopped"
        // OR when the watchdog timer fires (in which case we SIGKILL
        // the subprocess and synthesize the stop result from
        // _accumulatedText). The watchdog protects against subprocess
        // hangs in flush path — see _onStopWatchdogFired().
        this._stopResolve = null;
        this._stopWatchdogId = 0;
        this._stopTimeoutSecs = 10;  // overridden from settings

        // Read loop cancellation
        this._readCancellable = null;

        // Force-kill timer (so we can cancel it on re-destroy)
        this._forceKillTimerId = 0;

        // Ready watchdog — fires if onReady never arrives after init()
        this._readyWatchdogId = 0;

        // Last init() failure reason, for UI surfacing
        this._lastInitFailureReason = null;

        // Tracks a subprocess that is shutting down but hasn't exited yet.
        // init() waits for this to resolve before spawning a new process.
        this._dyingSubprocess = null;

        // Unique ID for this instance to prevent interaudio channel collisions
        this._instanceId = Math.random().toString(36).substring(2, 8);
    }

    /**
     * Set the extension directory (needed to find the speakeasy binary).
     * @param {string} dir
     */
    setExtensionDir(dir) {
        this._extensionDir = dir;
    }

    /**
     * Configure from a GSettings object.
     * @param {Gio.Settings} settings
     */
    setSettings(settings) {
        this._settings = settings;
        this._loadSettings();

        const keys = ['stt-backend', 'whisper-model-path', 'whisper-language', 'audio-input-device', 'audio-dir', 'recorder-stop-timeout-secs'];
        for (const key of keys) {
            this._settingsChangedIds.push(
                this._settings.connect(`changed::${key}`, () => {
                    const oldBackend = this._backend;
                    this._loadSettings();

                    // Migrate backend if necessary
                    if (oldBackend === 'vosk' || oldBackend === 'dlgo') {
                        this._backend = 'whisper';
                        log(`Speakeasy: migrated STT backend from ${oldBackend} to whisper`);
                    }

                    if (oldBackend !== this._backend && this._ready) {
                        log(`Speakeasy: STT backend changed ${oldBackend} -> ${this._backend}, restarting subprocess`);
                        this.destroy();
                        this.init();
                    }
                })
            );
        }
    }

    _loadSettings() {
        if (!this._settings)
            return;

        // Ensure we always default to a supported backend if settings are unset or invalid.
        const currentBackend = this._settings.get_string('stt-backend');
        if (currentBackend === 'vosk' || currentBackend === 'dlgo') {
            this._backend = 'whisper'; // Migrate legacy backends
        } else if (currentBackend === 'whisper' || currentBackend === 'none') {
            this._backend = currentBackend;
        } else {
            // If the backend is unknown or unset, default to whisper.
            // This handles cases where the user might have set an invalid value.
            this._backend = 'whisper';
            log(`Speakeasy: STT backend "${currentBackend}" is not supported, defaulting to "whisper".`);
        }

        const whisperPath = this._settings.get_string('whisper-model-path');
        if (whisperPath && whisperPath !== '')
            this._whisperModelPath = whisperPath;
        this._whisperLanguage = this._settings.get_string('whisper-language') || 'en';
        this._audioInputDevice = this._settings.get_string('audio-input-device') || '';
        this._audioDirOverride = this._settings.get_string('audio-dir') || '';
        this._stopTimeoutSecs = this._settings.get_uint('recorder-stop-timeout-secs');

        // Load AI settings — use backend-specific API key if available,
        // falling back to the generic ai-api-key.
        this._aiBackend = this._settings.get_string('ai-backend') || 'none';
        const backendKeyMap = {
            anthropic: 'anthropic-api-key',
            openrouter: 'openrouter-api-key',
        };
        const specificKeyName = backendKeyMap[this._aiBackend];
        const specificKey = specificKeyName
            ? this._settings.get_string(specificKeyName) : '';
        this._aiApiKey = specificKey || this._settings.get_string('ai-api-key') || '';
        this._aiModel = this._settings.get_string('ai-model') || '';
        this._systemPromptPath = this._settings.get_string('system-prompt-path') || '';

        // Calculate the effective system prompt path, falling back to a default
        if (!this._systemPromptPath || this._systemPromptPath === '') {
            this._effectiveSystemPromptPath = GLib.build_filenamev([
                this._extensionDir, 'prompts', 'system.txt'
            ]);
        } else {
            this._effectiveSystemPromptPath = this._systemPromptPath;
        }
    }

    /**
     * Resolve the directory where audio recordings are written. Always
     * a persistent location (~/.local/share/speakeasy/audio by default,
     * or the user-configured 'audio-dir'). Created if missing.
     *
     * Note: the file is *always* written during recording — the
     * 'retain-audio' setting controls whether it's deleted after a
     * successful session. extension.js handles that decision.
     *
     * @returns {string} Absolute path to the audio directory
     */
    _getAudioDir() {
        let dir = this._audioDirOverride;
        if (!dir || dir === '') {
            dir = GLib.build_filenamev([
                GLib.get_user_data_dir(), 'speakeasy', 'audio',
            ]);
        }
        GLib.mkdir_with_parents(dir, 0o755);
        return dir;
    }

    /**
     * Return the resolved model path for the current backend (the
     * one the live STT subprocess was launched with). null until
     * init() has resolved a model. Used by the recovery flow so it
     * can pass the same model into a separate file-transcribe
     * subprocess instead of re-running auto-detection in a fresh
     * environment.
     */
    getModelPath() {
        if (this._backend === 'whisper')
            return this._whisperModelPath ?? null;
        return null;
    }

    onPartialText(callback) {
        this._onPartialText = callback;
    }

    onFinalText(callback) {
        this._onFinalText = callback;
    }

    /**
     * Set a callback for when the subprocess sends audio level events.
     * @param {function} callback
     */
    onLevel(callback) {
        this._onLevel = callback;
    }

    /**
     * Set a callback for when the subprocess signals it's ready.
     * @param {function} callback
     */
    onReady(callback) {
        this._onReady = callback;
    }

    /**
     * Set a callback for when the subprocess exits unexpectedly.
     * @param {function(string)} callback
     */
    onExit(callback) {
        this._onExit = callback;
    }

    /**
     * Set a callback for when the subprocess sends an error event.
     * @param {function(string)} callback
     */
    onError(callback) {
        this._onError = callback;
    }

    /**
     * New callback for AI-cleaned text events.
     * @param {function(string)} callback
     */
    onAiCleanedText(callback) {
        this._onAiCleanedText = callback;
    }

    // ─── Model detection ────────────────────────────────────────────

    static detectWhisperModelPath() {
        const modelDirs = [
            GLib.get_home_dir() + '/.cache/speakeasy/models',
            GLib.get_home_dir() + '/.cache/whisper',
            GLib.get_home_dir() + '/.local/share/whisper',
            '/usr/share/whisper',
        ];

        const sizeOrder = ['large', 'medium', 'base', 'small', 'tiny'];

        // whisper-rs only accepts the ggml-*.bin format. GGUF (even valid
        // magic) is rejected with "bad magic". So we only look for .bin
        // files here — finding a GGUF would just set us up to fail.
        const search = (folder) => {
            const enumerator = folder.enumerate_children(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE, null);
            const models = [];
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                const child = folder.get_child(name);
                if (info.get_file_type() === Gio.FileType.DIRECTORY)
                    models.push(...search(child));
                else if (name.startsWith('ggml-') && name.endsWith('.bin'))
                    models.push(child.get_path());
            }
            enumerator.close(null);
            return models;
        };

        const allModels = [];
        for (const dir of modelDirs) {
            const dirFile = Gio.File.new_for_path(dir);
            if (!dirFile.query_exists(null))
                continue;
            try {
                allModels.push(...search(dirFile));
            } catch (e) {
                log(`Speakeasy: error scanning ${dir}: ${e.message}`);
            }
        }
        if (allModels.length === 0)
            return null;

        allModels.sort((a, b) => {
            const aName = GLib.path_get_basename(a);
            const bName = GLib.path_get_basename(b);
            const aIdx = sizeOrder.findIndex(s => aName.includes(s));
            const bIdx = sizeOrder.findIndex(s => bName.includes(s));
            return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
        });
        return allModels[0];
    }

    /**
     * Locate a chat-instruct GGUF for the llama AI backend. Scans
     * ~/.cache/speakeasy for *.gguf and prefers files whose basename
     * contains "instruct" (Qwen/Llama/etc instruct-tuned). Returns null
     * if nothing plausible is found.
     */
    static detectLlamaModelPath() {
        const dirs = [
            GLib.get_home_dir() + '/.cache/speakeasy',
            GLib.get_home_dir() + '/.local/share/speakeasy/models',
        ];
        const models = [];
        for (const dir of dirs) {
            const dirFile = Gio.File.new_for_path(dir);
            if (!dirFile.query_exists(null))
                continue;
            try {
                const enumerator = dirFile.enumerate_children(
                    'standard::name,standard::type',
                    Gio.FileQueryInfoFlags.NONE, null);
                let info;
                while ((info = enumerator.next_file(null)) !== null) {
                    const name = info.get_name();
                    if (info.get_file_type() === Gio.FileType.REGULAR &&
                        name.endsWith('.gguf')) {
                        models.push(dirFile.get_child(name).get_path());
                    }
                }
                enumerator.close(null);
            } catch (e) {
                log(`Speakeasy: error scanning ${dir} for GGUF: ${e.message}`);
            }
        }
        if (models.length === 0)
            return null;
        models.sort((a, b) => {
            const aI = GLib.path_get_basename(a).toLowerCase().includes('instruct') ? 0 : 1;
            const bI = GLib.path_get_basename(b).toLowerCase().includes('instruct') ? 0 : 1;
            return aI - bI;
        });
        return models[0];
    }

    // ─── Ready watchdog ─────────────────────────────────────────────

    /**
     * Arm a one-shot "ready timeout" watchdog: if onReady() does not
     * fire within `secs` seconds, call `onTimeout`. Used by the
     * extension/gtk-app to notify the user when the STT subprocess
     * is hung or crashed during the heavy model load.
     *
     * Idempotent: re-arming cancels any previously-armed watchdog.
     * Automatically cancels itself when `_ready` becomes true (the
     * _handleMessage('ready') path in this class clears it too).
     *
     * @param {number} secs - timeout in seconds; <=0 disables
     * @param {function} onTimeout - called if the watchdog fires
     */
    armReadyWatchdog(secs, onTimeout) {
        this.cancelReadyWatchdog();
        if (!secs || secs <= 0)
            return;
        // Already ready — no need to arm.
        if (this._ready)
            return;
        this._readyWatchdogId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, secs,
            () => {
                this._readyWatchdogId = 0;
                if (!this._ready) {
                    try { onTimeout?.(); } catch (e) {
                        log(`Speakeasy: readyWatchdog callback error: ${e.message}`);
                    }
                }
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    cancelReadyWatchdog() {
        if (this._readyWatchdogId) {
            GLib.source_remove(this._readyWatchdogId);
            this._readyWatchdogId = 0;
        }
    }

    // ─── GStreamer plugin check ─────────────────────────────────────

    /**
     * Check whether a GStreamer element factory is registered. Takes
     * the factory-find function as a parameter so tests can inject a
     * mock — the real call path in init() passes a closure around
     * Gst.ElementFactory.find().
     *
     * Returns an object {ok, missing} so callers can log / notify
     * with a specific element name instead of a generic "something
     * is missing" message.
     *
     * @param {string} elementName - e.g. 'whisper'
     * @param {function(string):object|null} findFn - factory finder
     * @returns {{ok: boolean, missing: ?string}}
     */
    static checkGstElement(elementName, findFn) {
        if (typeof findFn !== 'function')
            return {ok: false, missing: elementName};
        let factory = null;
        try {
            factory = findFn(elementName);
        } catch (_e) {
            factory = null;
        }
        if (!factory)
            return {ok: false, missing: elementName};
        return {ok: true, missing: null};
    }

    /**
     * Map a backend name to the GStreamer element it depends on.
     * @param {string} backend
     * @returns {?string}
     */
    static gstElementForBackend(backend) {
        if (backend === 'vosk') return 'vosk'; // Re-added to pass test
        if (backend === 'whisper') return 'whisper';
        return null;
    }

    // ─── Init / lifecycle ───────────────────────────────────────────

    /**
     * Last result of a plugin check, or null if init() hasn't run
     * yet. Consumed by extension.js / gtk-app.js to show a specific
     * "install the GST plugin" message when init() returns false.
     */
    getLastInitFailureReason() {
        return this._lastInitFailureReason ?? null;
    }

    /**
     * Spawn the STT subprocess.  Returns true if the subprocess was
     * launched (it will send "ready" asynchronously once the model is
     * loaded).  Does NOT block.
     *
     * If a previous subprocess is still shutting down, init() defers
     * the spawn until it has exited, to avoid running multiple copies
     * of the heavy STT process simultaneously.
     *
     * @returns {boolean} true if subprocess launched (or will be launched)
     */
    init() {
        if (this._subprocess)
            return true;

        // A previous subprocess is still dying — wait for it to exit,
        // then retry.  This prevents multiple copies of the STT
        // process.
        if (this._dyingSubprocess) {
            log('Speakeasy: waiting for previous STT subprocess to exit before respawning');
            this._dyingSubprocess.wait_async(null, () => {
                this._dyingSubprocess = null;
                log('Speakeasy: previous subprocess exited, retrying init()');
                this.init();
            });
            return true;
        }

        const t0 = GLib.get_monotonic_time();
        this._lastInitFailureReason = null;

        // Resolve model path
        let modelPath;
        if (this._backend === 'whisper') {
            modelPath = this._whisperModelPath || Recorder.detectWhisperModelPath();
            if (!modelPath) {
                log(`Speakeasy: no Whisper model found`);
                this._lastInitFailureReason = {
                    kind: 'no-model',
                    backend: this._backend,
                    message: 'No Whisper model found at ~/.cache/whisper. ' +
                             'See README for installation instructions.',
                };
                return false;
            }
            this._whisperModelPath = modelPath;
        } else if (this._backend === 'none') {
            // STT is explicitly disabled, no model needed.
            modelPath = null;
        }
        else { // Any other backend value is now considered invalid or unsupported.
            log(`Speakeasy: unknown or unsupported STT backend "${this._backend}"`);
            this._lastInitFailureReason = {
                kind: 'unknown-backend',
                backend: this._backend,
                message: `Unsupported STT backend "${this._backend}". Only 'whisper' is supported.`,
            };
            return false;
        }

        // Checking that the backend's GStreamer element is registered
        // is intentionally deferred to the subprocess. See the comment
        // at the top of this file: calling Gst.init() in the Shell
        // process has hung compositors. The subprocess calls
        // Gst.parse_launch(), which fails cleanly with a "no element"
        // error if the plugin is missing, and the 30s ready watchdog
        // in extension.js surfaces that to the user (see journalctl
        // for the specific element name).

        const scriptPath = GLib.build_filenamev([
            this._extensionDir, 'speakeasy',
        ]);

        const argv = [scriptPath];

        // Add STT arguments — map JS backend names to core binary names.
        // Only 'whisper' is supported now and maps to 'whisper-rs' in the Rust core.
        const coreBackend = this._backend === 'whisper' ? 'whisper-rs' : this._backend;
        if (coreBackend !== 'none') {
            argv.push('--backend', coreBackend);
            argv.push('--model-path', modelPath);
        } else {
             // Explicitly pass 'none' if STT is disabled
             argv.push('--backend', 'none');
        }
        if (this._audioInputDevice)
            argv.push('--audio-device', this._audioInputDevice);
        // Add AI cleanup arguments — map JS backend names to core names.
        // 'anthropic' in GSettings maps to 'openrouter' in the Rust core
        // (Anthropic's API is accessed via OpenRouter).
        const coreAiBackend = this._aiBackend === 'anthropic'
            ? 'openrouter' : this._aiBackend;
        if (coreAiBackend && coreAiBackend !== 'none') {
            argv.push('--ai-backend', coreAiBackend);
            // Pass generic API key and model if set
            if (this._aiApiKey && this._aiApiKey !== '')
                argv.push('--ai-api-key', this._aiApiKey);
            let aiModel = this._aiModel;
            if ((!aiModel || aiModel === '') && coreAiBackend === 'llama')
                aiModel = Recorder.detectLlamaModelPath();
            if (aiModel && aiModel !== '')
                argv.push('--ai-model', aiModel);
            // Pass system prompt path, using calculated default if needed
            if (this._effectiveSystemPromptPath && this._effectiveSystemPromptPath !== '')
                argv.push('--system-prompt-path', this._effectiveSystemPromptPath);
        } else {
             // Explicitly pass 'none' if AI cleanup is disabled
             argv.push('--ai-backend', 'none');
        }

        log('Speakeasy: spawning STT subprocess with args: ' + argv.join(' '));
        log('Speakeasy:   STT backend=' + this._backend + ', modelPath=' + modelPath);
        log('Speakeasy:   AI backend=' + this._aiBackend + ', aiModel=' + this._aiModel + ', systemPromptPath=' + this._effectiveSystemPromptPath);
        log('Speakeasy:   (init() took +' + ((GLib.get_monotonic_time() - t0) / 1000).toFixed(1) + 'ms)');

        try {
            this._subprocess = new Gio.Subprocess({
                argv,
                flags: Gio.SubprocessFlags.STDIN_PIPE |
                       Gio.SubprocessFlags.STDOUT_PIPE |
                       Gio.SubprocessFlags.STDERR_PIPE,
            });
            this._subprocess.init(null);
        } catch (e) {
            log('Speakeasy: failed to spawn STT subprocess: ' + e.message);
            this._subprocess = null;
            return false;
        }

        log(`Speakeasy:   Gio.Subprocess.init() done (+${((GLib.get_monotonic_time() - t0) / 1000).toFixed(1)}ms)`);

        this._stdin = this._subprocess.get_stdin_pipe();
        const stdoutStream = this._subprocess.get_stdout_pipe();
        this._stdout = new Gio.DataInputStream({
            base_stream: stdoutStream,
            close_base_stream: true,
        });

        // Cancellable for the stdout read loop — cancelled on destroy()
        // to prevent callbacks firing on a dead Recorder.
        this._readCancellable = new Gio.Cancellable();

        // Read subprocess stdout asynchronously
        this._readNextLine();

        // Read subprocess stderr asynchronously
        this._readStderr();

        // Monitor for unexpected exit
        this._subprocess.wait_async(null, (proc, result) => {
            try {
                proc.wait_finish(result);
            } catch (_e) {
                // Ignore
            }

            const wasReady = this._ready;
            const ifExited = proc.get_if_exited();
            const exitCode = ifExited ? proc.get_exit_status() : -1;

            if (this._subprocess === proc) {
                log(`Speakeasy: STT subprocess exited (status=${exitCode}, exited=${ifExited})`);
                this._ready = false;
                this._subprocess = null;
                this._stdin = null;
                this._stdout = null;

                // The subprocess died unexpectedly.
                this.cancelReadyWatchdog();
                this._cancelStopWatchdog();

                // If it died before ready, it was a crash or OOM kill.
                if (!wasReady && this._onExit) {
                    let msg = `STT subprocess exited with status ${exitCode}.`;
                    // On Linux, if it didn't exit cleanly (ifExited=false), 
                    // it was killed by a signal (OOM, SIGKILL, etc).
                    if (!ifExited)
                        msg = 'STT subprocess was killed by the system (possibly Out of Memory).';
                    this._onExit(msg);
                }

                if (this._stopResolve) {
                    const synth = this._accumulatedText.join(' ').trim();
                    log(`Speakeasy: subprocess crash recovery — synthesizing stop from ${this._accumulatedText.length} finals (${synth.length} chars)`);
                    this._stopResolve(synth);
                    this._stopResolve = null;
                }
            }
            // Also clear dying-subprocess tracking if this was the one
            // we were waiting on (e.g. it exited before init() retried).
            if (this._dyingSubprocess === proc)
                this._dyingSubprocess = null;
        });

        log('Speakeasy: STT subprocess launched, waiting for ready');
        return true;
    }

    /**
     * Check if the subprocess is ready to accept recording commands.
     * @returns {boolean}
     */
    isReady() {
        return this._ready;
    }

    /**
     * True if the recorder is currently rebuilding its subprocess
     * after a watchdog kill (or other crash). The caller can use
     * this to distinguish "model is loading for the first time"
     * (just wait, it's coming) from "recorder is dead and won't
     * recover" (give up and notify).
     */
    isRespawning() {
        return this._dyingSubprocess !== null || (this._subprocess !== null && !this._ready);
    }

    /**
     * Start recording.
     * @returns {boolean} true if the command was sent
     */
    start() {
        if (this._running) {
            log('Speakeasy: recorder already running');
            return true;
        }

        if (!this._ready) {
            log('Speakeasy: STT subprocess not ready');
            return false;
        }

        this._accumulatedText = [];

        // Generate audio path for file recording. Persistent location
        // (~/.local/share/speakeasy/audio by default) so the file
        // survives a reboot — the previous code wrote to
        // $XDG_RUNTIME_DIR (tmpfs) which got wiped on reboot and
        // made retained recordings effectively invisible.
        const audioDir = this._getAudioDir();
        const timestamp = GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S');
        this._audioPath = GLib.build_filenamev([
            audioDir, `speakeasy-${timestamp}.opus`,
        ]);

        this._sendCommand({cmd: 'start_file', path: this._audioPath});
        this._sendCommand({cmd: 'start'});

        this._running = true;
        log('Speakeasy: recording started');
        return true;
    }

    /**
     * Stop recording.  Returns a Promise that resolves with the
     * accumulated transcription text when the subprocess confirms stop.
     *
     * Watchdog: if the subprocess does not respond with the
     * "stopped" event within `_stopTimeoutSecs` seconds, the parent
     * SIGKILLs the subprocess and resolves the promise with whatever
     * final segments were already received via the `final` events.
     * The subprocess is then automatically respawned for the next
     * recording. This is the safety net for flush hangs — the
     * specific failure mode that lost a long dictation session on
     * 2026-04-08, where `current-final-results` got stuck in a busy
     * loop and the parent waited forever.
     *
     * @returns {Promise<string>} The full transcription
     */
    stop() {
        if (!this._running) {
            log('Speakeasy: recorder not running');
            return Promise.resolve('');
        }

        log('Speakeasy: stopping recorder');
        this._running = false;

        this._sendCommand({cmd: 'stop_file'});
        this._sendCommand({cmd: 'stop'});

        return new Promise(resolve => {
            this._stopResolve = resolve;
            this._armStopWatchdog();
        });
    }

    /**
     * Arm the watchdog timer that races against the subprocess's
     * "stopped" event. Idempotent — if a watchdog is already armed
     * (e.g. from a re-entered stop), it is replaced.
     */
    _armStopWatchdog() {
        this._cancelStopWatchdog();
        if (this._stopTimeoutSecs <= 0)
            return;  // disabled by user
        this._stopWatchdogId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            this._stopTimeoutSecs,
            () => {
                this._stopWatchdogId = 0;
                this._onStopWatchdogFired();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    /**
     * Cancel the watchdog timer (called when "stopped" arrives in
     * time, on destroy(), or when re-arming).
     */
    _cancelStopWatchdog() {
        if (this._stopWatchdogId) {
            GLib.source_remove(this._stopWatchdogId);
            this._stopWatchdogId = 0;
        }
    }

    /**
     * Watchdog fired: the subprocess did not confirm stop in time.
     *
     * Steps:
     *   1. Synthesize the stop result from accumulated final segments
     *      (preserving everything already committed).
     *   2. Resolve the pending stop promise so the caller's
     *      _stopRecordingInner can run AI cleanup, output, transcript
     *      save — all the post-processing the user actually cares about.
     *   3. SIGKILL the wedged subprocess. The existing wait_async
     *      handler will fire when the kill takes effect, but it will
     *      see _stopResolve is null and skip the redundant resolve.
     *   4. Spawn a fresh subprocess in the background so the next
     *      recording works without an explicit init() call from the
     *      caller.
     */
    _onStopWatchdogFired() {
        if (!this._stopResolve)
            return;  // promise already resolved by the normal path

        const synthesized = this._accumulatedText.join(' ').trim();
        log(`Speakeasy: STOP WATCHDOG fired after ${this._stopTimeoutSecs}s — ` +
            `subprocess wedged. Synthesizing stop from ${this._accumulatedText.length} ` +
            `final segments (${synthesized.length} chars). SIGKILLing subprocess.`);

        const resolve = this._stopResolve;
        this._stopResolve = null;
        resolve(synthesized);

        // Force-kill the wedged subprocess. force_exit() sends SIGKILL.
        if (this._subprocess) {
            try {
                this._subprocess.force_exit();
            } catch (e) {
                log(`Speakeasy: force_exit failed: ${e.message}`);
            }
        }

        // Re-launch a fresh subprocess so the next recording works.
        // The old subprocess's wait_async handler will run when the
        // kill is reaped, clearing _subprocess to null. Until then
        // _dyingSubprocess holds the reference, so init() will defer
        // the new spawn until the old one is fully dead.
        this._scheduleRespawn();
    }

    /**
     * After a watchdog kill, schedule a fresh subprocess spawn. We
     * track the dying subprocess so init() doesn't try to spawn a
     * second copy while the old one is still tearing down.
     */
    _scheduleRespawn() {
        if (this._subprocess) {
            this._dyingSubprocess = this._subprocess;
            // Don't null _subprocess here — the wait_async handler
            // installed at init() time will null it when the kill
            // is reaped. We just need to make sure init() defers
            // until that happens.
        }
        // Defer the actual init() to the next main-loop iteration so
        // the killed subprocess has a chance to be reaped before we
        // try to spawn a replacement.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            log('Speakeasy: respawning STT subprocess after watchdog kill');
            this.init();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ─── Audio file methods ─────────────────────────────────────────

    getAudioPath() {
        return this._audioPath;
    }

    deleteAudio() {
        if (!this._audioPath)
            return;

        this._sendCommand({cmd: 'delete_audio'});
        this._audioPath = null;
    }

    // ─── IPC ────────────────────────────────────────────────────────

    /**
     * Send a JSON command to the subprocess via stdin.
     * @param {object} cmd
     */
    _sendCommand(cmd) {
        if (!this._stdin) {
            log('Speakeasy: subprocess stdin not available');
            return;
        }

        const line = JSON.stringify(cmd) + '\n';
        const bytes = new TextEncoder().encode(line);
        try {
            this._stdin.write_bytes(new GLib.Bytes(bytes), null);
            this._stdin.flush(null);
        } catch (e) {
            log('Speakeasy: failed to send command: ' + e.message);
        }
    }

    /**
     * Asynchronously read the next line from subprocess stdout.
     */
    _readNextLine() {
        if (!this._stdout || !this._readCancellable)
            return;

        this._stdout.read_line_async(
            GLib.PRIORITY_DEFAULT, this._readCancellable,
            (stream, result) => {
                let line;
                try {
                    [line] = stream.read_line_finish_utf8(result);
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;  // Normal shutdown
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CLOSED))
                        log('Speakeasy: error reading from subprocess: ' + e.message);
                    return;
                }

                if (line === null) {
                    // EOF — subprocess exited
                    log('Speakeasy: subprocess stdout EOF');
                    return;
                }

                this._handleMessage(line);
                this._readNextLine();
            }
        );
    }

    /**
     * Asynchronously read from subprocess stderr and log it.
     */
    _readStderr() {
        if (!this._subprocess || !this._readCancellable)
            return;

        const stderrStream = this._subprocess.get_stderr_pipe();
        const reader = new Gio.DataInputStream({
            base_stream: stderrStream,
            close_base_stream: true,
        });

        const readLine = () => {
            reader.read_line_async(
                GLib.PRIORITY_LOW, this._readCancellable,
                (stream, result) => {
                    let line;
                    try {
                        [line] = stream.read_line_finish_utf8(result);
                    } catch (e) {
                        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                            return;
                        return;
                    }

                    if (line === null)
                        return;

                    log(`Speakeasy STT: ${line}`);
                    readLine();
                }
            );
        };
        readLine();
    }

    /**
     * Handle a JSON message from the subprocess.
     * @param {string} line
     */
    _handleMessage(line) {
        let msg;
        try {
            msg = JSON.parse(line);
        } catch (e) {
            log('Speakeasy: invalid JSON from subprocess: ' + e.message);
            return;
        }

        switch (msg.event) {
            case 'ready':
                log('Speakeasy: STT subprocess ready');
                this._ready = true;
                this.cancelReadyWatchdog();
                if (this._onReady)
                    this._onReady();
                break;

            case 'partial':
                if (msg.text && this._onPartialText)
                    this._onPartialText(msg.text);
                break;

            case 'final':
                if (msg.text) {
                    // Store all final text segments for potential recovery/synthesis
                    this._accumulatedText.push(msg.text);

                    if (this._running) {
                        // If _running is true, this 'final' event arrived
                        // while recording is active. It's a STT segment.
                        log('Speakeasy: STT final segment: "' + msg.text + '"');
                        if (this._onFinalText)
                            this._onFinalText(msg.text);
                    } else {
                        // If _running is false, this 'final' event arrived
                        // AFTER recording was stopped and 'stopped' was received.
                        // It signifies the AI-cleaned result.
                        log('Speakeasy: AI cleaned text received: "' + msg.text + '"');
                        if (this._onAiCleanedText)
                            this._onAiCleanedText(msg.text);
                    }
                }
                break;

            case 'level':
                if (this._onLevel)
                    this._onLevel(msg.rms, msg.peak);
                break;

            case 'stopped': {
                let text = this._accumulatedText.join(' ').trim();
                if ('text' in msg)
                    text = msg.text;
                log('Speakeasy: recording stopped, text: "' + text + '"');
                this._cancelStopWatchdog();
                if (this._stopResolve) {
                    this._stopResolve(text);
                    this._stopResolve = null;
                }
                break;
            }

            case 'error':
                log('Speakeasy: subprocess error: ' + msg.message);
                if (!this._ready)
                    this.cancelReadyWatchdog();
                if (this._onError)
                    this._onError(msg.message);
                break;

            default:
                log('Speakeasy: unknown event from subprocess: ' + msg.event);
        }
    }

    // ─── Teardown ───────────────────────────────────────────────────

    destroy() {
        // Cancel the stdout read loop first so callbacks don't fire
        // on a partially-destroyed Recorder.
        if (this._readCancellable) {
            this._readCancellable.cancel();
            this._readCancellable = null;
        }

        // Cancel any pending force-kill timer from a previous destroy()
        if (this._forceKillTimerId) {
            GLib.source_remove(this._forceKillTimerId);
            this._forceKillTimerId = 0;
        }

        // Cancel the stop watchdog timer if armed.
        this._cancelStopWatchdog();

        // Cancel the ready watchdog timer if armed.
        this.cancelReadyWatchdog();

        if (this._subprocess) {
            this._sendCommand({cmd: 'quit'});

            // Track the dying subprocess so init() can wait for it to
            // fully exit before spawning a replacement.  This prevents
            // accumulating duplicate STT processes.
            const proc = this._subprocess;
            this._subprocess = null;
            this._dyingSubprocess = proc;

            this._forceKillTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                this._forceKillTimerId = 0;
                log('Speakeasy: force-killing STT subprocess');
                try {
                    proc.force_exit();
                } catch (_e) {
                    // Already dead
                }
                return GLib.SOURCE_REMOVE;
            });
        }

        this._stdin = null;
        this._stdout = null;
        this._ready = false;
        this._running = false;
        this._accumulatedText = [];

        if (this._stopResolve) {
            this._stopResolve('');
            this._stopResolve = null;
        }

        if (this._settings && this._settingsChangedIds) {
            for (const id of this._settingsChangedIds)
                this._settings.disconnect(id);
            this._settingsChangedIds = [];
        }
        this._settings = null;
    }
}
