#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: MIT
// Speakeasy — Standalone offline transcription tool
//
// Runs an existing audio file (anything decodebin can handle —
// Opus/Ogg, WAV, FLAC, MP3, etc.) through the same VOSK STT
// pipeline that the live recorder uses, and prints the resulting
// transcript to stdout.
//
// This was originally written to recover a long dictation session
// whose live extension hung before saving the transcript JSON. The
// audio file was sitting on disk but the user had no way to feed
// it back through STT without restarting GNOME Shell.
//
// Usage:
//   gjs -m tools/transcribe-file.js INPUT_FILE [--model PATH] [--json OUT.json] [--json-events]
//
//   INPUT_FILE     Path to the audio file to transcribe.
//   --model        Override the VOSK model directory. Default: auto-detect
//                  from ~/.cache/vosk (first subdirectory found).
//   --json         Also write a transcript JSON next to STDOUT, in the same
//                  shape extension.js produces. Useful for re-importing into
//                  the transcript history.
//   --json-events  Emit machine-readable NDJSON events on STDOUT instead
//                  of the human-readable text. Used by the in-extension
//                  recovery UI to drive a progress dialog. Each line is
//                  one JSON object. Event types:
//                    {"type":"loading"}
//                    {"type":"ready"}
//                    {"type":"progress","pos_secs":N,"dur_secs":N,"finals":N}
//                    {"type":"partial","text":"..."}
//                    {"type":"final","text":"..."}
//                    {"type":"done","raw_text":"...","finals_count":N}
//                    {"type":"error","message":"..."}
//                  In this mode no transcript text is printed to stdout
//                  outside the JSON events; the .json file (if --json
//                  was given) is still written.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gst from 'gi://Gst?version=1.0';
import System from 'system';

// ─── Argument parsing ───────────────────────────────────────────────

function parseArgs(argv) {
    const args = {input: null, model: null, jsonOut: null, jsonEvents: false};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--model') {
            args.model = argv[++i];
        } else if (a === '--json') {
            args.jsonOut = argv[++i];
        } else if (a === '--json-events') {
            args.jsonEvents = true;
        } else if (a === '-h' || a === '--help') {
            print('Usage: gjs -m tools/transcribe-file.js INPUT [--model PATH] [--json OUT.json] [--json-events]');
            System.exit(0);
        } else if (!args.input) {
            args.input = a;
        }
    }
    if (!args.input) {
        printerr('error: missing INPUT_FILE');
        System.exit(2);
    }
    return args;
}

// Emit a machine-readable event on stdout (when --json-events is set)
// or fall back to a human-readable line on stderr.
function emit(args, type, payload = {}) {
    if (args.jsonEvents) {
        const obj = {type, ...payload};
        print(JSON.stringify(obj));
    } else {
        // Human-readable formatting for command-line use
        switch (type) {
            case 'loading':
                printerr(`[transcribe] loading VOSK (this can take a few seconds)...`);
                break;
            case 'ready':
                printerr(`[transcribe] VOSK ready`);
                break;
            case 'progress': {
                const fmt = (s) => {
                    const m = Math.floor(s / 60);
                    const sec = (s % 60).toString().padStart(2, '0');
                    return `${m}:${sec}`;
                };
                if (payload.dur_secs > 0)
                    printerr(`[progress] ${fmt(payload.pos_secs)} / ${fmt(payload.dur_secs)}  (${payload.finals} finals so far)`);
                else
                    printerr(`[progress] ${fmt(payload.pos_secs)}  (${payload.finals} finals so far)`);
                break;
            }
            case 'partial':
                printerr(`[partial] ${payload.text}`);
                break;
            case 'final':
                printerr(`[final] ${payload.text}`);
                break;
            case 'done':
                printerr('');
                printerr(`[transcribe] DONE — ${payload.finals_count} finals, ${payload.raw_text.length} chars`);
                break;
            case 'error':
                printerr(`error: ${payload.message}`);
                break;
        }
    }
}

function autodetectModel() {
    const vosk = GLib.build_filenamev([GLib.get_home_dir(), '.cache', 'vosk']);
    const dir = Gio.File.new_for_path(vosk);
    if (!dir.query_exists(null))
        return null;
    try {
        const enumerator = dir.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                return GLib.build_filenamev([vosk, info.get_name()]);
        }
    } catch (_e) { /* ignore */ }
    return null;
}

// ─── Main ───────────────────────────────────────────────────────────

const args = parseArgs(System.programArgs ?? []);
const modelPath = args.model ?? autodetectModel();
if (!modelPath) {
    printerr('error: no VOSK model found in ~/.cache/vosk and --model not given');
    System.exit(2);
}

const inputFile = Gio.File.new_for_path(args.input);
if (!inputFile.query_exists(null)) {
    printerr(`error: input file does not exist: ${args.input}`);
    System.exit(2);
}

if (!args.jsonEvents) {
    printerr(`[transcribe] input: ${args.input}`);
    printerr(`[transcribe] model: ${modelPath}`);
}
emit(args, 'loading');

Gst.init(null);

// Build the pipeline. We use a non-live source (filesrc + decodebin)
// so VOSK can chew through the audio as fast as CPU allows.
//
// CRITICAL: a bounded queue between decodebin and vosk. Without it,
// decodebin will push the entire decoded PCM buffer downstream as
// fast as possible, and the vosk element accumulates all of it in
// its internal queue. On a long file (e.g. 54 minutes) this caused
// the gjs process to balloon to 6+ GB and get OOM-killed.
//
// max-size-buffers=200 keeps roughly a few seconds of audio in
// flight at any time, so memory stays bounded regardless of file
// length.
const pipelineDef = (
    `filesrc location="${args.input}" ! ` +
    `decodebin ! audioconvert ! audioresample ! ` +
    `audio/x-raw,format=S16LE,rate=16000,channels=1 ! ` +
    `queue name=PreVoskQueue max-size-buffers=50 max-size-bytes=0 max-size-time=0 ! ` +
    `vosk name=Stt ! ` +
    `fakesink sync=false`
);

let pipeline;
try {
    pipeline = Gst.parse_launch(pipelineDef);
} catch (e) {
    printerr(`error: failed to build pipeline: ${e.message}`);
    System.exit(1);
}

const stt = pipeline.get_by_name('Stt');
if (!stt) {
    printerr('error: could not find vosk element in pipeline');
    System.exit(1);
}
stt.set_property('speech-model', modelPath);

const finals = [];
let lastPartial = '';
let pipelineError = null;

const loop = GLib.MainLoop.new(null, false);
const bus = pipeline.get_bus();
bus.add_signal_watch();

bus.connect('message::element', (_bus, msg) => {
    const structure = msg.get_structure();
    if (!structure || structure.get_name() !== 'vosk')
        return;
    const jsonStr = structure.get_string('current-result');
    if (!jsonStr)
        return;
    let data;
    try {
        data = JSON.parse(jsonStr);
    } catch (_e) {
        return;
    }
    if ('partial' in data) {
        if (data.partial && data.partial !== lastPartial) {
            lastPartial = data.partial;
            emit(args, 'partial', {text: data.partial});
        }
        return;
    }
    if ('text' in data && data.text) {
        finals.push(data.text);
        lastPartial = '';
        emit(args, 'final', {text: data.text});
        return;
    }
    if ('alternatives' in data && data.alternatives.length > 0) {
        const t = data.alternatives[0].text;
        if (t && t.trim() !== '') {
            finals.push(t);
            emit(args, 'final', {text: t});
        }
    }
});

bus.connect('message::error', (_bus, msg) => {
    const [err, dbg] = msg.parse_error();
    emit(args, 'error', {message: `${err.message} (${dbg})`});
    pipelineError = err.message;
    loop.quit();
});

bus.connect('message::eos', () => {
    // Flush VOSK's internal buffer before quitting — anything still
    // pending in the recognizer becomes a final segment.
    try {
        const finalJson = stt.get_property('current-final-results');
        if (finalJson) {
            const data = JSON.parse(finalJson);
            if ('text' in data && data.text) {
                finals.push(data.text);
                emit(args, 'final', {text: data.text});
            } else if ('partial' in data && data.partial) {
                finals.push(data.partial);
                emit(args, 'final', {text: data.partial});
            }
        }
    } catch (e) {
        if (!args.jsonEvents)
            printerr(`flush warning: ${e.message}`);
    }
    loop.quit();
});

// Switch from "loading" to "ready" once the pipeline is actually
// playing. The bus async-done message indicates that.
bus.connect('message::async-done', () => {
    emit(args, 'ready');
});

// Periodic progress: every 5s in events mode (so the UI feels
// responsive) and every 10s in text mode.
const progressIntervalSecs = args.jsonEvents ? 5 : 10;
let progressTimer = GLib.timeout_add_seconds(
    GLib.PRIORITY_DEFAULT, progressIntervalSecs, () => {
    let pos = 0, dur = 0;
    try {
        [, pos] = pipeline.query_position(Gst.Format.TIME);
        [, dur] = pipeline.query_duration(Gst.Format.TIME);
    } catch (_e) { /* ignore */ }
    emit(args, 'progress', {
        pos_secs: Math.floor(pos / 1e9),
        dur_secs: Math.floor(dur / 1e9),
        finals: finals.length,
    });
    return GLib.SOURCE_CONTINUE;
});

const ret = pipeline.set_state(Gst.State.PLAYING);
if (ret === Gst.StateChangeReturn.FAILURE) {
    printerr('error: failed to start pipeline');
    System.exit(1);
}

loop.run();

GLib.source_remove(progressTimer);
pipeline.set_state(Gst.State.NULL);

if (pipelineError) {
    printerr(`pipeline failed: ${pipelineError}`);
    if (finals.length === 0)
        System.exit(1);
    if (!args.jsonEvents)
        printerr(`(continuing with ${finals.length} finals already collected)`);
}

const rawText = finals.join(' ').trim();
if (!args.jsonEvents) {
    // Human-readable mode: print transcript text on stdout
    print(rawText);
}
emit(args, 'done', {raw_text: rawText, finals_count: finals.length});

if (args.jsonOut) {
    const transcript = {
        timestamp: new Date().toISOString(),
        raw_text: rawText,
        cleaned_text: null,
        audio_path: args.input,
        ai_enabled: false,
        recovered: true,
        recovered_from: args.input,
        recovered_complete: false,
    };
    try {
        const file = Gio.File.new_for_path(args.jsonOut);
        file.replace_contents(
            new TextEncoder().encode(JSON.stringify(transcript, null, 2)),
            null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null
        );
        if (!args.jsonEvents)
            printerr(`[transcribe] wrote ${args.jsonOut}`);
    } catch (e) {
        if (!args.jsonEvents)
            printerr(`[transcribe] failed to write JSON: ${e.message}`);
    }
}

System.exit(0);
