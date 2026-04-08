// SPDX-License-Identifier: MIT
// Speakeasy — Recorder module (subprocess IPC client)
//
// Architecture: the GStreamer/VOSK pipeline runs in a separate Python
// subprocess (stt-subprocess.py) so the heavy model load (~1.5-3s)
// never blocks the compositor.  This module communicates with it over
// stdin/stdout using a line-based JSON protocol.
//
// The subprocess owns:
//   - STT pipeline: interaudiosrc → vosk/whisper → fakesink (permanent)
//   - Capture pipeline: pulsesrc → interaudiosink (per-recording)
//   - File recording pipeline: pulsesrc → opusenc → filesink (per-recording)
//
// This module (Recorder) is a thin IPC client that presents the same
// interface to extension.js as the old in-process recorder.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

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
        this._backend = 'vosk';
        this._voskModelPath = null;
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

        // Pending stop — resolved when the subprocess sends "stopped"
        // OR when the watchdog timer fires (in which case we SIGKILL
        // the subprocess and synthesize the stop result from
        // _accumulatedText). The watchdog protects against subprocess
        // hangs in VOSK's flush path — see _onStopWatchdogFired().
        this._stopResolve = null;
        this._stopWatchdogId = 0;
        this._stopTimeoutSecs = 10;  // overridden from settings

        // Read loop cancellation
        this._readCancellable = null;

        // Force-kill timer (so we can cancel it on re-destroy)
        this._forceKillTimerId = 0;

        // Tracks a subprocess that is shutting down but hasn't exited yet.
        // init() waits for this to resolve before spawning a new process.
        this._dyingSubprocess = null;
    }

    /**
     * Set the extension directory (needed to find stt-subprocess.py).
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

        const keys = ['stt-backend', 'vosk-model-path', 'whisper-model-path', 'whisper-language', 'audio-input-device', 'audio-dir', 'recorder-stop-timeout-secs'];
        for (const key of keys) {
            this._settingsChangedIds.push(
                this._settings.connect(`changed::${key}`, () => {
                    const oldBackend = this._backend;
                    this._loadSettings();

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

        this._backend = this._settings.get_string('stt-backend') || 'vosk';
        const voskPath = this._settings.get_string('vosk-model-path');
        if (voskPath && voskPath !== '')
            this._voskModelPath = voskPath;
        const whisperPath = this._settings.get_string('whisper-model-path');
        if (whisperPath && whisperPath !== '')
            this._whisperModelPath = whisperPath;
        this._whisperLanguage = this._settings.get_string('whisper-language') || 'en';
        this._audioInputDevice = this._settings.get_string('audio-input-device') || '';
        this._audioDirOverride = this._settings.get_string('audio-dir') || '';
        this._stopTimeoutSecs = this._settings.get_uint('recorder-stop-timeout-secs');
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

    // ─── Model detection ────────────────────────────────────────────

    static detectVoskModelPath() {
        const modelDirs = [
            GLib.get_home_dir() + '/.cache/vosk',
            '/usr/share/vosk',
        ];

        for (const dir of modelDirs) {
            const dirFile = Gio.File.new_for_path(dir);
            if (!dirFile.query_exists(null))
                continue;

            try {
                const enumerator = dirFile.enumerate_children(
                    'standard::name,standard::type',
                    Gio.FileQueryInfoFlags.NONE, null);

                let best = null;
                let info;
                while ((info = enumerator.next_file(null)) !== null) {
                    if (info.get_file_type() !== Gio.FileType.DIRECTORY)
                        continue;
                    const name = info.get_name();
                    if (name.startsWith('vosk-model')) {
                        if (best === null || (!name.includes('-small') && best.includes('-small')))
                            best = name;
                    }
                }
                enumerator.close(null);

                if (best)
                    return `${dir}/${best}`;
            } catch (e) {
                log(`Speakeasy: error scanning ${dir}: ${e.message}`);
            }
        }

        return null;
    }

    static detectWhisperModelPath() {
        const modelDirs = [
            GLib.get_home_dir() + '/.cache/whisper',
            GLib.get_home_dir() + '/.local/share/whisper',
            '/usr/share/whisper',
        ];

        const sizeOrder = ['large', 'medium', 'base', 'small', 'tiny'];

        for (const dir of modelDirs) {
            const dirFile = Gio.File.new_for_path(dir);
            if (!dirFile.query_exists(null))
                continue;

            try {
                const enumerator = dirFile.enumerate_children(
                    'standard::name,standard::type',
                    Gio.FileQueryInfoFlags.NONE, null);

                const models = [];
                let info;
                while ((info = enumerator.next_file(null)) !== null) {
                    if (info.get_file_type() !== Gio.FileType.REGULAR)
                        continue;
                    const name = info.get_name();
                    if (name.startsWith('ggml-') && name.endsWith('.bin'))
                        models.push(name);
                }
                enumerator.close(null);

                if (models.length === 0)
                    continue;

                models.sort((a, b) => {
                    const aIdx = sizeOrder.findIndex(s => a.includes(s));
                    const bIdx = sizeOrder.findIndex(s => b.includes(s));
                    return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
                });

                return `${dir}/${models[0]}`;
            } catch (e) {
                log(`Speakeasy: error scanning ${dir}: ${e.message}`);
            }
        }

        return null;
    }

    // ─── Init / lifecycle ───────────────────────────────────────────

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
        // process (each holding ~1.5 GB for the VOSK model).
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

        // Resolve model path
        let modelPath;
        if (this._backend === 'vosk') {
            modelPath = this._voskModelPath || Recorder.detectVoskModelPath();
            if (!modelPath) {
                log('Speakeasy: no VOSK model found');
                return false;
            }
            this._voskModelPath = modelPath;
        } else if (this._backend === 'whisper') {
            modelPath = this._whisperModelPath || Recorder.detectWhisperModelPath();
            if (!modelPath) {
                log('Speakeasy: no Whisper model found');
                return false;
            }
            this._whisperModelPath = modelPath;
        } else {
            log(`Speakeasy: unknown STT backend "${this._backend}"`);
            return false;
        }

        const scriptPath = GLib.build_filenamev([
            this._extensionDir, 'stt-subprocess.js',
        ]);

        const argv = [
            'gjs', '-m', scriptPath,
            '--backend', this._backend,
            '--model-path', modelPath,
        ];
        if (this._backend === 'whisper' && this._whisperLanguage)
            argv.push('--whisper-language', this._whisperLanguage);
        if (this._audioInputDevice)
            argv.push('--audio-device', this._audioInputDevice);

        log(`Speakeasy: spawning STT subprocess: ${argv.join(' ')}`);
        log(`Speakeasy:   model path resolved (+${((GLib.get_monotonic_time() - t0) / 1000).toFixed(1)}ms)`);

        try {
            this._subprocess = new Gio.Subprocess({
                argv,
                flags: Gio.SubprocessFlags.STDIN_PIPE |
                       Gio.SubprocessFlags.STDOUT_PIPE |
                       Gio.SubprocessFlags.STDERR_PIPE,
            });
            this._subprocess.init(null);
        } catch (e) {
            log(`Speakeasy: failed to spawn STT subprocess: ${e.message}`);
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

        // Monitor for unexpected exit
        this._subprocess.wait_async(null, (proc, result) => {
            try {
                proc.wait_finish(result);
            } catch (_e) {
                // Ignore
            }
            const exitCode = proc.get_exit_status();
            if (this._subprocess === proc) {
                log(`Speakeasy: STT subprocess exited (status=${exitCode})`);
                this._ready = false;
                this._subprocess = null;
                this._stdin = null;
                this._stdout = null;

                // The subprocess died unexpectedly. Cancel the
                // watchdog (if armed) and resolve any pending stop
                // from accumulated finals — this is the same
                // recovery the watchdog does, just triggered by a
                // crash instead of a timeout.
                this._cancelStopWatchdog();
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
     * recording. This is the safety net for VOSK flush hangs — the
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
     *      (preserving everything VOSK already committed).
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
            log(`Speakeasy: failed to send command: ${e.message}`);
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
                        log(`Speakeasy: error reading from subprocess: ${e.message}`);
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
     * Handle a JSON message from the subprocess.
     * @param {string} line
     */
    _handleMessage(line) {
        let msg;
        try {
            msg = JSON.parse(line);
        } catch (e) {
            log(`Speakeasy: invalid JSON from subprocess: ${e.message}`);
            return;
        }

        switch (msg.event) {
            case 'ready':
                log('Speakeasy: STT subprocess ready');
                this._ready = true;
                if (this._onReady)
                    this._onReady();
                break;

            case 'partial':
                if (msg.text && this._onPartialText)
                    this._onPartialText(msg.text);
                break;

            case 'final':
                if (msg.text) {
                    log(`Speakeasy: final text segment: "${msg.text}"`);
                    this._accumulatedText.push(msg.text);
                    if (this._onFinalText)
                        this._onFinalText(msg.text);
                }
                break;

            case 'level':
                if (this._onLevel)
                    this._onLevel(msg.rms, msg.peak);
                break;

            case 'stopped': {
                const text = msg.text || this._accumulatedText.join(' ').trim();
                log(`Speakeasy: recording stopped, text: "${text}"`);
                this._cancelStopWatchdog();
                if (this._stopResolve) {
                    this._stopResolve(text);
                    this._stopResolve = null;
                }
                break;
            }

            case 'error':
                log(`Speakeasy: subprocess error: ${msg.message}`);
                break;

            default:
                log(`Speakeasy: unknown event from subprocess: ${msg.event}`);
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

        if (this._subprocess) {
            this._sendCommand({cmd: 'quit'});

            // Track the dying subprocess so init() can wait for it to
            // fully exit before spawning a replacement.  This prevents
            // accumulating duplicate STT processes (each holding the
            // full VOSK model in memory).
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
