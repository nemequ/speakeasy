// SPDX-License-Identifier: MIT
// Speakeasy — Run an audio file through the STT pipeline as a subprocess
//
// Why a subprocess? Loading VOSK in-process means a 6+ GB RSS spike,
// blocks the main loop while it processes audio (multiple minutes for
// long recordings), and on OOM would take down the entire compositor
// with it. Running it as a separate gjs process insulates gnome-shell
// from all of that.
//
// This module wraps `tools/transcribe-file.js --json-events` and
// parses the NDJSON it emits on stdout, dispatching events to the
// caller's callbacks. The same module is used by:
//
//   - The Shell extension's "Recover from audio file..." menu entry
//     (via the recoveryDialog UI)
//   - The standalone GTK test app (via a similar dialog/button)
//
// Both use the controller's saveTranscript() to install the result
// into the live transcript history.
//
// Lifecycle:
//
//   const transcriber = new FileTranscriber({
//     extensionDir: '/path/to/speakeasy',
//     modelPath: '/path/to/vosk-model',  // optional, auto-detect if null
//     onLoading: () => ...,
//     onReady: () => ...,
//     onProgress: ({pos_secs, dur_secs, finals}) => ...,
//     onPartial: (text) => ...,
//     onFinal: (text) => ...,
//     onDone: ({raw_text, finals_count}) => ...,
//     onError: (message) => ...,
//   });
//   transcriber.start(audioPath, jsonOutPath);
//   // ... time passes ...
//   transcriber.cancel();   // SIGTERM the subprocess if needed

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export class FileTranscriber {
    /**
     * @param {object} opts
     * @param {string} opts.extensionDir - Absolute path to the
     *   speakeasy extension directory (used to locate the
     *   tools/transcribe-file.js script).
     * @param {string} [opts.modelPath] - VOSK model directory.
     *   If null, the subprocess auto-detects from ~/.cache/vosk.
     * @param {function} [opts.onLoading]
     * @param {function} [opts.onReady]
     * @param {function} [opts.onProgress]
     * @param {function} [opts.onPartial]
     * @param {function} [opts.onFinal]
     * @param {function} [opts.onDone]
     * @param {function} [opts.onError]
     */
    constructor({
        extensionDir, modelPath = null,
        onLoading, onReady, onProgress, onPartial, onFinal, onDone, onError,
    }) {
        this._extensionDir = extensionDir;
        this._modelPath = modelPath;
        this._onLoading = onLoading;
        this._onReady = onReady;
        this._onProgress = onProgress;
        this._onPartial = onPartial;
        this._onFinal = onFinal;
        this._onDone = onDone;
        this._onError = onError;

        this._subprocess = null;
        this._stdout = null;
        this._readCancellable = null;
        this._cancelled = false;
        // Buffer the last 'done' event payload so callers can read
        // it after the process exits without having to capture in a
        // closure.
        this._lastDone = null;
        this._lastError = null;
    }

    /**
     * Start a transcription. Returns immediately; the dispatch
     * happens asynchronously through the callbacks.
     *
     * @param {string} audioPath - Absolute path to the input file.
     * @param {string|null} jsonOutPath - Where to write the
     *   transcript JSON. If null, no JSON is saved (caller can
     *   build one from the onDone payload instead).
     * @returns {boolean} true if the subprocess was launched.
     */
    start(audioPath, jsonOutPath = null) {
        if (this._subprocess) {
            this._fireError('FileTranscriber.start() called while already running');
            return false;
        }

        const scriptPath = GLib.build_filenamev([
            this._extensionDir, 'tools', 'transcribe-file.js',
        ]);
        if (!Gio.File.new_for_path(scriptPath).query_exists(null)) {
            this._fireError(`transcribe-file.js not found at ${scriptPath}`);
            return false;
        }
        if (!Gio.File.new_for_path(audioPath).query_exists(null)) {
            this._fireError(`audio file not found: ${audioPath}`);
            return false;
        }

        const argv = ['gjs', '-m', scriptPath, audioPath, '--json-events'];
        if (this._modelPath) {
            argv.push('--model', this._modelPath);
        }
        if (jsonOutPath) {
            argv.push('--json', jsonOutPath);
        }

        log(`Speakeasy FileTranscriber: spawning ${argv.join(' ')}`);

        try {
            this._subprocess = new Gio.Subprocess({
                argv,
                flags: Gio.SubprocessFlags.STDOUT_PIPE |
                       Gio.SubprocessFlags.STDERR_SILENCE,
            });
            this._subprocess.init(null);
        } catch (e) {
            this._fireError(`failed to spawn transcribe subprocess: ${e.message}`);
            this._subprocess = null;
            return false;
        }

        const stdoutStream = this._subprocess.get_stdout_pipe();
        this._stdout = new Gio.DataInputStream({
            base_stream: stdoutStream,
            close_base_stream: true,
        });
        this._readCancellable = new Gio.Cancellable();

        // Read the NDJSON event stream
        this._readNextLine();

        // Watch for exit
        this._subprocess.wait_async(null, (proc, result) => {
            try {
                proc.wait_finish(result);
            } catch (_e) { /* ignore */ }
            const status = proc.get_exit_status();
            log(`Speakeasy FileTranscriber: subprocess exited (status=${status})`);
            this._subprocess = null;
            // If we never got a "done" event, treat any remaining
            // not-yet-fired error as the failure.
            if (!this._lastDone && !this._lastError && !this._cancelled) {
                this._fireError(`transcribe subprocess exited with status ${status}`);
            }
        });

        return true;
    }

    /**
     * Cancel the transcription. Sends SIGTERM, then SIGKILL if it
     * doesn't exit promptly. Idempotent — safe to call from a
     * Cancel button even after the subprocess has already exited.
     */
    cancel() {
        if (this._cancelled || !this._subprocess)
            return;
        this._cancelled = true;
        log('Speakeasy FileTranscriber: cancelling subprocess');
        try {
            this._subprocess.send_signal(15);  // SIGTERM
        } catch (e) {
            log(`Speakeasy FileTranscriber: SIGTERM failed: ${e.message}`);
        }
        // Force-kill backstop after 2s
        const proc = this._subprocess;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            try {
                proc.force_exit();
            } catch (_e) { /* already dead */ }
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * True if the subprocess is still running.
     */
    isRunning() {
        return this._subprocess !== null;
    }

    // ─── Internal ────────────────────────────────────────────────────

    _readNextLine() {
        if (!this._stdout)
            return;
        this._stdout.read_line_async(
            GLib.PRIORITY_DEFAULT, this._readCancellable,
            (stream, result) => {
                let line, length;
                try {
                    [line, length] = stream.read_line_finish_utf8(result);
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        log(`Speakeasy FileTranscriber: read error: ${e.message}`);
                    return;
                }
                if (line === null) {
                    // EOF — close the stream
                    try { stream.close(null); } catch (_e) { /* ignore */ }
                    this._stdout = null;
                    return;
                }
                if (line !== '') {
                    this._handleLine(line);
                }
                this._readNextLine();
            }
        );
    }

    _handleLine(line) {
        let obj;
        try {
            obj = JSON.parse(line);
        } catch (_e) {
            log(`Speakeasy FileTranscriber: unparseable line: ${line}`);
            return;
        }
        switch (obj.type) {
            case 'loading':
                this._fireSafe(this._onLoading);
                break;
            case 'ready':
                this._fireSafe(this._onReady);
                break;
            case 'progress':
                this._fireSafe(this._onProgress, obj);
                break;
            case 'partial':
                this._fireSafe(this._onPartial, obj.text);
                break;
            case 'final':
                this._fireSafe(this._onFinal, obj.text);
                break;
            case 'done':
                this._lastDone = obj;
                this._fireSafe(this._onDone, obj);
                break;
            case 'error':
                this._lastError = obj.message;
                this._fireError(obj.message);
                break;
            default:
                log(`Speakeasy FileTranscriber: unknown event type "${obj.type}"`);
        }
    }

    _fireSafe(cb, ...args) {
        if (!cb)
            return;
        try {
            cb(...args);
        } catch (e) {
            log(`Speakeasy FileTranscriber: callback error: ${e.message}`);
        }
    }

    _fireError(message) {
        this._lastError = message;
        log(`Speakeasy FileTranscriber: error: ${message}`);
        this._fireSafe(this._onError, message);
    }
}
