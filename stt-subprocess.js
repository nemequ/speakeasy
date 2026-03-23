#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: MIT
// Speakeasy — STT subprocess (GJS rewrite)
//
// Owns the GStreamer/VOSK pipeline in a separate process so the heavy
// model load (~1.5-3s) doesn't block the compositor.
//
// IPC protocol (JSON lines over stdin/stdout):
//
//   Extension → Subprocess (stdin):
//     {"cmd": "start"}                         — begin recording
//     {"cmd": "stop"}                          — stop recording, flush
//     {"cmd": "start_file", "path": "..."}     — start audio file recording
//     {"cmd": "stop_file"}                     — stop audio file recording
//     {"cmd": "delete_audio"}                  — delete the recorded audio file
//     {"cmd": "quit"}                          — clean shutdown
//
//   Subprocess → Extension (stdout):
//     {"event": "ready"}                       — model loaded, accepting commands
//     {"event": "partial", "text": "..."}      — partial STT result
//     {"event": "final", "text": "..."}        — finalized STT segment
//     {"event": "stopped", "text": "..."}      — recording stopped + final text
//     {"event": "level", "rms": -12.3, "peak": -5.1} — audio level (dB)
//     {"event": "error", "message": "..."}     — error

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import Gst from 'gi://Gst?version=1.0';
import System from 'system';

// --- Configuration ---
const MEMORY_STATS_INTERVAL_S = 60; // 0 = disabled

// --- I/O Setup ---
const loop = new GLib.MainLoop(null, false);

const stdinRaw = new GioUnix.InputStream({ fd: 0 });
const stdinReader = new Gio.DataInputStream({
    base_stream: stdinRaw,
    close_base_stream: true,
});
const stderrStream = new GioUnix.OutputStream({ fd: 2 });

function send(obj) {
    print(JSON.stringify(obj));           // stdout, for IPC
}

function debug(msg) {
    stderrStream.write_bytes(             // stderr, for logging
        new GLib.Bytes(`[stt-subprocess] ${msg}\n`), null);
}

// --- GStreamer Setup ---
Gst.init(null);

const CAPS_STR = 'audio/x-raw,format=S16LE,rate=16000,channels=1';
const INTERAUDIO_CHANNEL = 'speakeasy-stt';

class SttSubprocess {
    constructor(backend, modelPath, whisperLanguage = 'en') {
        this.backend = backend;
        this.modelPath = modelPath;
        this.whisperLanguage = whisperLanguage;

        this.loop = null;
        this.sttPipeline = null;
        this.sttElement = null;
        this.capturePipeline = null;
        this.filePipeline = null;
        this.audioPath = null;
        this.running = false;
        this.accumulatedText = [];
        this._lastPartial = '';   // last partial text seen (for stop-time fallback)
        this._recordingCount = 0;
        this._memoryTimerId = 0;
    }

    init() {
        // Build STT pipeline
        let pipelineDef;
        if (this.backend === 'vosk') {
            pipelineDef = (
                `interaudiosrc channel=${INTERAUDIO_CHANNEL} ! ${CAPS_STR} ! ` +
                'vosk name=SpeakeasyStt enable-denoise=true ! ' +
                'fakesink'
            );
        } else if (this.backend === 'whisper') {
            pipelineDef = (
                `interaudiosrc channel=${INTERAUDIO_CHANNEL} ! ${CAPS_STR} ! ` +
                'whisper name=SpeakeasyStt ! ' +
                'fakesink'
            );
        } else {
            send({event: 'error', message: `Unknown backend: ${this.backend}`});
            return false;
        }

        try {
            this.sttPipeline = Gst.parse_launch(pipelineDef);
        } catch (e) {
            send({event: 'error', message: `Failed to create STT pipeline: ${e.message}`});
            return false;
        }

        this.sttElement = this.sttPipeline.get_by_name('SpeakeasyStt');
        if (!this.sttElement) {
            send({event: 'error', message: 'Could not find SpeakeasyStt element'});
            return false;
        }

        // Configure backend
        if (this.backend === 'vosk') {
            this.sttElement.set_property('speech-model', this.modelPath);
            debug(`Using VOSK model at ${this.modelPath}`);
        } else if (this.backend === 'whisper') {
            try {
                this.sttElement.set_property('model', this.modelPath);
            } catch (e) {
                try {
                    this.sttElement.set_property('model-path', this.modelPath);
                } catch (e2) {
                    debug(`Failed to set whisper model: ${e2.message}`);
                }
            }
            if (this.whisperLanguage) {
                try {
                    this.sttElement.set_property('language', this.whisperLanguage);
                } catch (e) {
                    // Ignore if property not available
                }
            }
        }

        // Bus watch for STT results
        const bus = this.sttPipeline.get_bus();
        bus.add_signal_watch();
        bus.connect('message::element', (bus, message) => this._onBusMessage(message));
        bus.connect('message::error', (bus, message) => this._onBusError(message));

        // Start STT pipeline (model loads here — the heavy part)
        const ret = this.sttPipeline.set_state(Gst.State.PLAYING);
        if (ret === Gst.StateChangeReturn.FAILURE) {
            send({event: 'error', message: 'Failed to set STT pipeline to PLAYING'});
            return false;
        }

        debug('STT pipeline running, model loaded');
        this._logMemory('after init');

        // Periodic memory stats
        if (MEMORY_STATS_INTERVAL_S > 0) {
            this._memoryTimerId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, MEMORY_STATS_INTERVAL_S,
                () => {
                    this._logMemory('periodic');
                    return GLib.SOURCE_CONTINUE;
                });
        }

        return true;
    }

    _logMemory(label = '') {
        try {
            const [ok, data] = GLib.file_get_contents('/proc/self/statm');
            if (!ok) return;
            const fields = new TextDecoder('utf-8').decode(data).trim().split(/\s+/);
            const rssPages = parseInt(fields[1]);
            const pageSize = GLib.get_page_size?.() ?? 4096;
            const rssMiB = (rssPages * pageSize) / (1024 * 1024);
            const tag = label ? ` (${label})` : '';
            debug(`memory: RSS=${rssMiB.toFixed(1)} MiB, recordings=${this._recordingCount}${tag}`);
        } catch (e) {
            debug(`memory read error: ${e.message}`);
        }
    }

    start() {
        if (this.running) return;

        this.accumulatedText = [];
        this._lastPartial = '';

        // Flush stale results
        if (this.backend === 'vosk' && this.sttElement) {
            try {
                void this.sttElement.get_property('current-final-results');
            } catch (e) {
                // Ignore
            }
        }

        // Create capture pipeline with level element for audio visualization
        const captureDef = (
            `pulsesrc blocksize=3200 ! ${CAPS_STR} ! ` +
            `level name=SpeakeasyLevel interval=50000000 post-messages=true ! ` +
            `interaudiosink channel=${INTERAUDIO_CHANNEL} sync=false`
        );
        try {
            this.capturePipeline = Gst.parse_launch(captureDef);
        } catch (e) {
            send({event: 'error', message: `Failed to create capture pipeline: ${e.message}`});
            return;
        }

        const capBus = this.capturePipeline.get_bus();
        capBus.add_signal_watch();
        capBus.connect('message::error', (_bus, msg) => this._onCaptureError(msg));
        capBus.connect('message::element', (_bus, msg) => {
            const structure = msg.get_structure();
            if (structure && structure.get_name() === 'level') {
                this._onLevelMessage(msg);
            }
        });

        const ret = this.capturePipeline.set_state(Gst.State.PLAYING);
        if (ret === Gst.StateChangeReturn.FAILURE) {
            send({event: 'error', message: 'Failed to start capture pipeline'});
            this.capturePipeline.set_state(Gst.State.NULL);
            this.capturePipeline = null;
            return;
        }

        this.running = true;
        this._recordingCount++;
        debug('Recording started');
        this._logMemory('recording start');
    }

    stop() {
        if (!this.running) {
            send({event: 'stopped', text: ''});
            return;
        }

        debug('Stopping recording');
        this.running = false;

        // Destroy capture pipeline immediately (releases mic).
        if (this.capturePipeline) {
            this.capturePipeline.set_state(Gst.State.NULL);
            const bus = this.capturePipeline.get_bus();
            bus.remove_signal_watch();
            this.capturePipeline = null;
            debug('Capture pipeline destroyed (mic released)');
        }

        this._finishStop();
    }

    /**
     * Flush VOSK and emit the stopped event.
     * Called after capture pipeline teardown.
     *
     * current-final-results forces VOSK to finalize its internal
     * buffer, but depending on timing it may return:
     *   - {"text": "..."} — a proper final (already handled by _parseVoskJson)
     *   - {"partial": "..."} — VOSK hadn't committed yet; we promote it to final
     *   - empty/null — nothing pending
     *
     * As a last resort, if neither current-final-results nor any prior
     * bus message produced a final for the in-progress utterance, we
     * fall back to _lastPartial (the most recent partial text we saw
     * during recording).
     */
    _finishStop() {
        const countBefore = this.accumulatedText.length;

        if (this.backend === 'vosk' && this.sttElement) {
            try {
                const finalJson = this.sttElement.get_property('current-final-results');
                debug(`Final flush result: ${finalJson}`);
                if (finalJson) {
                    // Parse the flush result.  If it's a proper final
                    // ("text" key), _parseVoskJson accumulates it normally.
                    // If it's a partial ("partial" key), we need to
                    // promote it to final ourselves since _parseVoskJson
                    // would just update _lastPartial and return.
                    let data;
                    try {
                        data = JSON.parse(finalJson);
                    } catch (e) {
                        debug(`Failed to parse final flush JSON: ${e}`);
                        data = null;
                    }

                    if (data && 'partial' in data && data.partial) {
                        // Promote partial to final — VOSK hadn't
                        // committed this text before we asked.
                        debug(`Promoting flush partial to final: "${data.partial}"`);
                        this.accumulatedText.push(data.partial);
                        send({event: 'final', text: data.partial});
                    } else {
                        // Normal path: final text, alternatives, or empty
                        this._parseVoskJson(finalJson);
                    }
                }
            } catch (e) {
                debug(`Error getting final results: ${e}`);
            }
        }

        // Fallback: if current-final-results didn't produce any new
        // text and we have a last-seen partial, use it.  This covers
        // the edge case where the capture pipeline was torn down and
        // VOSK processed silence before we could read its buffer.
        if (this.accumulatedText.length === countBefore && this._lastPartial) {
            debug(`Using last partial as fallback final: "${this._lastPartial}"`);
            this.accumulatedText.push(this._lastPartial);
            send({event: 'final', text: this._lastPartial});
        }

        this._lastPartial = '';

        const result = this.accumulatedText.join(' ').trim();
        this.accumulatedText = [];
        debug(`Recording stopped, text: "${result}"`);
        send({event: 'stopped', text: result});
        this._logMemory('recording stop');
    }

    startFile(path) {
        this.stopFile();
        this.audioPath = path;
        debug(`Recording audio to ${path}`);

        const fileDef = (
            `pulsesrc blocksize=3200 ! ${CAPS_STR} ! ` +
            `queue leaky=downstream max-size-time=3000000000 ! ` +
            `opusenc bitrate=24000 ! oggmux ! ` +
            `filesink location=${path}`
        );
        try {
            this.filePipeline = Gst.parse_launch(fileDef);
        } catch (e) {
            send({event: 'error', message: `Failed to create file pipeline: ${e.message}`});
            this.audioPath = null;
            return;
        }

        const fileBus = this.filePipeline.get_bus();
        fileBus.add_signal_watch();
        fileBus.connect(
            'message::error',
            (_bus, msg) => {
                debug(`File pipeline error: ${msg.parse_error()[0].message}`);
                this.stopFile();
            },
        );

        const ret = this.filePipeline.set_state(Gst.State.PLAYING);
        if (ret === Gst.StateChangeReturn.FAILURE) {
            debug('Failed to start file recording pipeline');
            this.filePipeline.set_state(Gst.State.NULL);
            this.filePipeline = null;
            this.audioPath = null;
        }
    }

    stopFile() {
        if (!this.filePipeline) return;
        this.filePipeline.send_event(Gst.Event.new_eos());
        this.filePipeline.set_state(Gst.State.NULL);
        const bus = this.filePipeline.get_bus();
        bus.remove_signal_watch();
        this.filePipeline = null;
        debug(`File recording stopped (${this.audioPath})`);
    }

    deleteAudio() {
        if (!this.audioPath) return;
        try {
            if (GLib.file_test(this.audioPath, GLib.FileTest.EXISTS)) {
                GLib.unlink(this.audioPath);
                debug(`Deleted audio file ${this.audioPath}`);
            }
        } catch (e) {
            debug(`Failed to delete audio: ${e}`);
        }
        this.audioPath = null;
    }

    destroy() {
        if (this._memoryTimerId) {
            GLib.source_remove(this._memoryTimerId);
            this._memoryTimerId = 0;
        }

        if (this.capturePipeline) {
            this.capturePipeline.set_state(Gst.State.NULL);
            this.capturePipeline.get_bus().remove_signal_watch();
            this.capturePipeline = null;
        }

        this.stopFile();

        if (this.sttPipeline) {
            const bus = this.sttPipeline.get_bus();
            bus.remove_signal_watch();
            this.sttPipeline.set_state(Gst.State.NULL);
            this.sttPipeline = null;
        }

        this.sttElement = null;
        this.accumulatedText = [];
        this._lastPartial = '';
        this._logMemory('destroy');
    }

    // ── Bus message handlers ──

    _onBusMessage(message) {
        if (!this.running) return;

        const structure = message.get_structure();
        if (!structure) return;

        const name = structure.get_name();

        if (this.backend === 'vosk' && name === 'vosk') {
            const jsonStr = structure.get_string('current-result');
            if (jsonStr) this._parseVoskJson(jsonStr);
        } else if (this.backend === 'whisper' && name === 'whisper') {
            this._parseWhisperMessage(structure);
        }
    }

    _onBusError(message) {
        const [error, debugStr] = message.parse_error();
        debug(`STT pipeline error: ${error.message} (${debugStr})`);
        send({event: 'error', message: `STT pipeline error: ${error.message}`});
    }

    _onCaptureError(message) {
        const [error, debugStr] = message.parse_error();
        debug(`Capture pipeline error: ${error.message} (${debugStr})`);
    }

    _onLevelMessage(message) {
        if (!this.running) return;
        const structure = message.get_structure();
        if (!structure || structure.get_name() !== 'level') return;

        try {
            // Extract RMS value for channel 0
            const rmsValue = structure.get_value('rms');
            const peakValue = structure.get_value('peak');

            // GValueArray handling - try direct access first
            let rmsDb = rmsValue;
            let peakDb = peakValue;

            // If they're GValueArrays, get channel 0
            if (rmsValue.get_nth) {
                rmsDb = rmsValue.get_nth(0);
                peakDb = peakValue.get_nth(0);
            }

            send({event: 'level', rms: rmsDb, peak: peakDb});
        } catch (e) {
            debug(`Failed to parse level message: ${e.message}`);
        }
    }

    _parseVoskJson(jsonStr) {
        if (!jsonStr) return;

        let data;
        try {
            data = JSON.parse(jsonStr);
        } catch (e) {
            debug(`Failed to parse VOSK JSON: ${e}`);
            return;
        }

        if ('partial' in data) {
            if (data.partial) {
                this._lastPartial = data.partial;
                send({event: 'partial', text: data.partial});
            }
            return;
        }

        if ('text' in data && data.text) {
            debug(`Final text segment: "${data.text}"`);
            this.accumulatedText.push(data.text);
            this._lastPartial = '';   // final supersedes any partial
            send({event: 'final', text: data.text});
            return;
        }

        if ('alternatives' in data && data.alternatives.length > 0) {
            const text = data.alternatives[0].text;
            if (text && text.trim() !== '') {
                this.accumulatedText.push(text);
                send({event: 'final', text: text});
            }
        }
    }

    _parseWhisperMessage(structure) {
        const text = structure.get_string('text');
        if (text && text.trim() !== '') {
            const [hasPartial, isPartial] = structure.get_boolean('is-partial');
            if (hasPartial && isPartial) {
                this._lastPartial = text;
                send({event: 'partial', text: text});
            } else {
                debug(`Whisper final text: "${text}"`);
                this.accumulatedText.push(text.trim());
                this._lastPartial = '';
                send({event: 'final', text: text.trim()});
            }
            return;
        }

        const jsonStr = structure.get_string('result');
        if (jsonStr) {
            try {
                const data = JSON.parse(jsonStr);
                const text = (data.text || '').trim();
                if (text) {
                    this.accumulatedText.push(text);
                    send({event: 'final', text: text});
                }
            } catch (e) {
                debug(`Failed to parse whisper JSON: ${e}`);
            }
        }
    }
}

// --- stdin Command Loop ---
function readCommand() {
    stdinReader.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, result) => {
        try {
            const [line] = stream.read_line_finish_utf8(result);
            if (line === null) { loop.quit(); return; }

            const cmd = JSON.parse(line);
            handleCommand(cmd);
            readCommand();
        } catch (e) {
            debug(`invalid JSON from extension: ${e.message}`);
            loop.quit();
        }
    });
}

function handleCommand(cmd) {
    const cmdStr = cmd.cmd;
    if (cmdStr === 'start') {
        stt.start();
    } else if (cmdStr === 'stop') {
        stt.stop();
    } else if (cmdStr === 'start_file') {
        const path = cmd.path || '';
        stt.startFile(path);
    } else if (cmdStr === 'stop_file') {
        stt.stopFile();
    } else if (cmdStr === 'delete_audio') {
        stt.deleteAudio();
    } else if (cmdStr === 'quit') {
        loop.quit();
    } else {
        debug(`unknown command: ${cmdStr}`);
    }
}

// --- Argument parsing ---
// System.programArgs contains only the script's args, not 'gjs' or '-m'.
// Expected: --backend vosk --model-path /path [--whisper-language en]
function parseArgs(argv) {
    const result = {backend: 'vosk', modelPath: '', whisperLanguage: 'en'};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--backend' && i + 1 < argv.length)
            result.backend = argv[++i];
        else if (argv[i] === '--model-path' && i + 1 < argv.length)
            result.modelPath = argv[++i];
        else if (argv[i] === '--whisper-language' && i + 1 < argv.length)
            result.whisperLanguage = argv[++i];
    }
    return result;
}

// --- Main ---
const config = parseArgs(System.programArgs);
const {backend, modelPath, whisperLanguage} = config;

const stt = new SttSubprocess(backend, modelPath, whisperLanguage);

if (!stt.init()) {
    debug('Failed to initialize STT pipeline');
    System.exit(1);
}

send({event: 'ready'});
debug('STT subprocess ready');

readCommand();
loop.run();
debug('STT subprocess exiting');