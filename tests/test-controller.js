#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: MIT
// Unit tests for DictationController (controller.js)
//
// Run: gjs -m tests/test-controller.js
//
// These tests use fake recorder/AI/output objects so the orchestration
// logic can be exercised without GStreamer, HTTP, or any compositor.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {DictationController, ControllerState} from '../controller.js';

// ─── Test harness ───────────────────────────────────────────────────

let _passed = 0;
let _failed = 0;
const _errors = [];

function assert(condition, message) {
    if (!condition)
        throw new Error(`Assertion failed: ${message}`);
}

function assertEqual(actual, expected, message) {
    if (actual !== expected)
        throw new Error(
            `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function test(name, fn) {
    try {
        await fn();
        _passed++;
        print(`  PASS  ${name}`);
    } catch (e) {
        _failed++;
        _errors.push({name, error: e.message, stack: e.stack});
        print(`  FAIL  ${name}`);
        print(`        ${e.message}`);
    }
}

// ─── Fakes ───────────────────────────────────────────────────────────

class FakeRecorder {
    constructor() {
        this._partialCb = null;
        this._finalCb = null;
        this._levelCb = null;
        this._ready = true;
        this._running = false;
        this._audioPath = null;
        this._stopText = '';
        this._deleteCalled = false;
    }
    isReady() { return this._ready; }
    onPartialText(cb) { this._partialCb = cb; }
    onFinalText(cb) { this._finalCb = cb; }
    onLevel(cb) { this._levelCb = cb; }
    getAudioPath() { return this._audioPath; }
    start() {
        this._running = true;
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        this._audioPath = `/tmp/fake-audio-${ts}.opus`;
        return true;
    }
    stop() {
        this._running = false;
        return Promise.resolve(this._stopText);
    }
    deleteAudio() {
        this._deleteCalled = true;
        this._audioPath = null;
    }
    // Test helpers — simulate STT events from outside the class
    fireFinal(text) { this._finalCb?.(text); }
    firePartial(text) { this._partialCb?.(text); }
    setStopText(t) { this._stopText = t; }
}

class FakeAi {
    constructor() {
        this._available = true;
        this._sessionStarted = false;
        this._sessionCancelled = false;
        this._buffer = '';
        this._finalizeResult = null;  // null = use buffer
        this._finalizeShouldThrow = false;
        this._finalizeCalled = false;
    }
    isAvailable() { return this._available; }
    beginSession() { this._sessionStarted = true; }
    cancelSession() { this._sessionCancelled = true; }
    feedText(text) { this._buffer += (this._buffer ? ' ' : '') + text; }
    async finalize(_onDelta) {
        this._finalizeCalled = true;
        if (this._finalizeShouldThrow)
            throw new Error('simulated AI hang/timeout');
        return this._finalizeResult ?? `[clean] ${this._buffer}`;
    }
}

class FakeOutput {
    constructor() {
        this._typed = [];
        this._typeShouldFail = false;
        this._typeShouldThrow = false;
    }
    async typeText(text) {
        if (this._typeShouldThrow)
            throw new Error('simulated paste failure');
        this._typed.push(text);
        return !this._typeShouldFail;
    }
}

class FakeSettings {
    constructor(retainAudio = false) {
        this._retainAudio = retainAudio;
    }
    get_boolean(key) {
        if (key === 'retain-audio') return this._retainAudio;
        return false;
    }
    get_string(_key) { return ''; }
}

// Helper: build a controller wired to a tmp transcript dir AND a
// tmp sessions dir, so tests don't pollute the user's real
// ~/.local/share/speakeasy/.
function makeController({
    retainAudio = false,
    aiAvailable = true,
} = {}) {
    const tmpDir = GLib.dir_make_tmp('speakeasy-controller-test-XXXXXX');
    const transcriptDir = GLib.build_filenamev([tmpDir, 'transcripts']);
    const sessionsDir = GLib.build_filenamev([tmpDir, 'sessions']);
    GLib.mkdir_with_parents(transcriptDir, 0o755);
    GLib.mkdir_with_parents(sessionsDir, 0o755);

    const recorder = new FakeRecorder();
    const ai = new FakeAi();
    ai._available = aiAvailable;
    const output = new FakeOutput();
    const settings = new FakeSettings(retainAudio);

    const events = {
        states: [],
        partials: [],
        finals: [],
        transcripts: [],
        errors: [],
    };

    const controller = new DictationController({
        recorder,
        ai,
        output,
        settings,
        transcriptDirOverride: transcriptDir,
        sessionsDirOverride: sessionsDir,
        onStateChanged: (s) => events.states.push(s),
        onPartialText: (t) => events.partials.push(t),
        onFinalText: (t) => events.finals.push(t),
        onTranscript: (e) => events.transcripts.push(e),
        onError: (m) => events.errors.push(m),
        onLog: () => {},  // silence test output
    });

    return {controller, recorder, ai, output, settings, events, tmpDir, sessionsDir};
}

function rmrf(path) {
    try {
        const file = Gio.File.new_for_path(path);
        const enumerator = file.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const child = GLib.build_filenamev([path, info.get_name()]);
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                rmrf(child);
            else
                Gio.File.new_for_path(child).delete(null);
        }
        enumerator.close(null);
        file.delete(null);
    } catch (_e) { /* ignore */ }
}

// ════════════════════════════════════════════════════════════════════
//  Tests
// ════════════════════════════════════════════════════════════════════

const loop = GLib.MainLoop.new(null, false);

(async () => {
    print('');
    print('DictationController');
    print('─'.repeat(60));

    await test('starts in IDLE state', async () => {
        const t = makeController();
        try {
            assertEqual(t.controller.getState(), ControllerState.IDLE, 'initial state');
        } finally {
            rmrf(t.tmpDir);
        }
    });

    await test('start() transitions to RECORDING and fires state callback', async () => {
        const t = makeController();
        try {
            const ok = t.controller.start();
            assertEqual(ok, true, 'start returns true');
            assertEqual(t.controller.getState(), ControllerState.RECORDING, 'state');
            assert(t.events.states.includes(ControllerState.RECORDING), 'state event fired');
        } finally {
            rmrf(t.tmpDir);
        }
    });

    await test('start() returns false when recorder is not ready', async () => {
        const t = makeController();
        try {
            t.recorder._ready = false;
            const ok = t.controller.start();
            assertEqual(ok, false, 'start returns false');
            assertEqual(t.controller.getState(), ControllerState.IDLE, 'still idle');
            assert(t.events.errors.length > 0, 'error fired');
        } finally {
            rmrf(t.tmpDir);
        }
    });

    await test('commit() fires ai.beginSession exactly once', async () => {
        const t = makeController();
        try {
            t.controller.start();
            t.controller.commit();
            assertEqual(t.ai._sessionStarted, true, 'session started');

            // Second commit is a no-op
            t.ai._sessionStarted = false;
            t.controller.commit();
            assertEqual(t.ai._sessionStarted, false, 'second commit ignored');
        } finally {
            rmrf(t.tmpDir);
        }
    });

    await test('commit() outside RECORDING is ignored', async () => {
        const t = makeController();
        try {
            t.controller.commit();  // IDLE
            assertEqual(t.ai._sessionStarted, false, 'no session in IDLE');
        } finally {
            rmrf(t.tmpDir);
        }
    });

    await test('partial/final/level events forward to callbacks', async () => {
        const t = makeController();
        try {
            t.controller.start();
            t.recorder.firePartial('hello there');
            t.recorder.fireFinal('hello there');
            assertEqual(t.events.partials.length, 1, 'partial event count');
            assertEqual(t.events.partials[0], 'hello there', 'partial text');
            assertEqual(t.events.finals.length, 1, 'final event count');
            assertEqual(t.events.finals[0], 'hello there', 'final text');
            // Final should also have been fed into ai
            assertEqual(t.ai._buffer, 'hello there', 'fed to ai');
        } finally {
            rmrf(t.tmpDir);
        }
    });

    await test('full session: start → commit → finals → stop produces cleaned transcript', async () => {
        const t = makeController();
        try {
            t.controller.start();
            t.controller.commit();
            t.recorder.fireFinal('hello world');
            t.recorder.fireFinal('this is a test');
            t.recorder.setStopText('hello world this is a test');

            const entry = await t.controller.stop();
            assert(entry !== null, 'transcript entry returned');
            assertEqual(entry.rawText, 'hello world this is a test', 'rawText');
            assertEqual(entry.cleanedText, '[clean] hello world this is a test', 'cleanedText');
            assertEqual(entry.aiEnabled, true, 'aiEnabled');
            assertEqual(t.output._typed.length, 1, 'output called');
            assertEqual(t.output._typed[0], '[clean] hello world this is a test', 'output content');
            assertEqual(t.controller.getState(), ControllerState.IDLE, 'back to idle');
            assertEqual(t.events.transcripts.length, 1, 'transcript callback fired');
        } finally {
            rmrf(t.tmpDir);
        }
    });

    await test('stop without commit() skips AI and outputs raw text', async () => {
        const t = makeController();
        try {
            t.controller.start();
            t.recorder.fireFinal('uncommitted speech');
            t.recorder.setStopText('uncommitted speech');

            const entry = await t.controller.stop();
            assert(entry !== null, 'transcript saved');
            assertEqual(entry.rawText, 'uncommitted speech', 'raw');
            assertEqual(entry.cleanedText, 'uncommitted speech', 'cleaned == raw');
            assertEqual(entry.aiEnabled, false, 'aiEnabled false');
            assertEqual(t.ai._finalizeCalled, false, 'finalize NOT called');
            assertEqual(t.output._typed[0], 'uncommitted speech', 'raw text typed');
        } finally {
            rmrf(t.tmpDir);
        }
    });

    await test('AI hang/timeout: finalize() throws → raw text saved + transcript still saves', async () => {
        // This is the regression test for the bug that lost the
        // user's long dictation session. Without the catch in
        // _stopInner, a finalize() that throws would unwind past
        // the transcript save and lose everything.
        const t = makeController();
        try {
            t.ai._finalizeShouldThrow = true;
            t.controller.start();
            t.controller.commit();
            t.recorder.fireFinal('important content');
            t.recorder.setStopText('important content');

            const entry = await t.controller.stop();
            assert(entry !== null, 'transcript was still saved despite AI hang');
            assertEqual(entry.rawText, 'important content', 'raw text preserved');
            assertEqual(entry.cleanedText, 'important content', 'falls back to raw');
            assertEqual(entry.aiEnabled, false, 'aiEnabled false on failure');
            assertEqual(t.output._typed[0], 'important content', 'output got raw text');
        } finally {
            rmrf(t.tmpDir);
        }
    });

    await test('output failure (typeText returns false) still saves transcript', async () => {
        const t = makeController();
        try {
            t.output._typeShouldFail = true;
            t.controller.start();
            t.controller.commit();
            t.recorder.setStopText('something');

            const entry = await t.controller.stop();
            assert(entry !== null, 'transcript saved');
            assert(t.events.errors.length > 0, 'error was surfaced');
        } finally {
            rmrf(t.tmpDir);
        }
    });

    await test('output throwing still saves transcript', async () => {
        const t = makeController();
        try {
            t.output._typeShouldThrow = true;
            t.controller.start();
            t.controller.commit();
            t.recorder.setStopText('something');

            const entry = await t.controller.stop();
            assert(entry !== null, 'transcript saved despite output throw');
        } finally {
            rmrf(t.tmpDir);
        }
    });

    await test('empty stop text → no transcript, recorder.deleteAudio() called', async () => {
        const t = makeController();
        try {
            t.controller.start();
            t.controller.commit();
            t.recorder.setStopText('');

            const entry = await t.controller.stop();
            assertEqual(entry, null, 'no transcript saved');
            assertEqual(t.recorder._deleteCalled, true, 'audio deleted');
            assert(t.events.errors.length > 0, '"no speech" error fired');
            assertEqual(t.controller.getState(), ControllerState.IDLE, 'back to idle');
        } finally {
            rmrf(t.tmpDir);
        }
    });

    await test('discard() resets without saving anything', async () => {
        const t = makeController();
        try {
            t.controller.start();
            t.recorder.fireFinal('discarded content');
            t.controller.discard();

            assertEqual(t.controller.getState(), ControllerState.IDLE, 'idle');
            assertEqual(t.recorder._deleteCalled, true, 'audio deleted');
            assertEqual(t.ai._sessionCancelled, true, 'ai cancelled');
        } finally {
            rmrf(t.tmpDir);
        }
    });

    await test('retainAudio=true skips deleteAudio and populates audio_path', async () => {
        const t = makeController({retainAudio: true});
        try {
            t.controller.start();
            t.controller.commit();
            const audioBefore = t.recorder.getAudioPath();
            t.recorder.setStopText('keep this');

            const entry = await t.controller.stop();
            assertEqual(t.recorder._deleteCalled, false, 'audio NOT deleted');
            // Read transcript JSON to confirm audio_path is set
            const file = Gio.File.new_for_path(entry.filePath);
            const [ok, bytes] = file.load_contents(null);
            assert(ok, 'transcript readable');
            const data = JSON.parse(new TextDecoder().decode(bytes));
            assertEqual(data.audio_path, audioBefore, 'audio_path persisted');
        } finally {
            rmrf(t.tmpDir);
        }
    });

    await test('retainAudio=false (default) deletes audio after success', async () => {
        const t = makeController({retainAudio: false});
        try {
            t.controller.start();
            t.controller.commit();
            t.recorder.setStopText('discardable');
            await t.controller.stop();
            assertEqual(t.recorder._deleteCalled, true, 'audio deleted');
        } finally {
            rmrf(t.tmpDir);
        }
    });

    await test('session log is written and marked completed on success', async () => {
        const t = makeController();
        try {
            t.controller.start();
            t.controller.commit();
            t.recorder.fireFinal('first');
            t.recorder.fireFinal('second');
            t.recorder.setStopText('first second');
            await t.controller.stop();

            // Session log should be in the tmp sessions dir's
            // completed/ subfolder.
            const completedDir = GLib.build_filenamev([t.sessionsDir, 'completed']);
            const dir = Gio.File.new_for_path(completedDir);
            assert(dir.query_exists(null), 'completed dir exists');

            // And there should be at least one .jsonl file in it.
            const enumerator = dir.enumerate_children(
                'standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let count = 0;
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                if (info.get_name().endsWith('.jsonl'))
                    count++;
            }
            enumerator.close(null);
            assert(count >= 1, 'completed jsonl present');
        } finally {
            rmrf(t.tmpDir);
        }
    });

    await test('AI unavailable → uses raw text and transcript still saves', async () => {
        const t = makeController({aiAvailable: false});
        try {
            t.controller.start();
            t.controller.commit();
            t.recorder.setStopText('raw and uncleaned');
            const entry = await t.controller.stop();
            assert(entry !== null, 'transcript saved');
            assertEqual(entry.cleanedText, 'raw and uncleaned', 'raw used as cleaned');
            assertEqual(entry.aiEnabled, false, 'aiEnabled false');
            assertEqual(t.ai._finalizeCalled, false, 'finalize NOT called');
        } finally {
            rmrf(t.tmpDir);
        }
    });

    print('');
    print('═'.repeat(60));
    print(`Results: ${_passed} passed, ${_failed} failed, ${_passed + _failed} total`);

    if (_errors.length > 0) {
        print('');
        print('Failures:');
        for (const {name, error} of _errors)
            print(`  - ${name}: ${error}`);
    }

    print('');
    loop.quit();
})();

loop.run();

imports.system.exit(_failed > 0 ? 1 : 0);
