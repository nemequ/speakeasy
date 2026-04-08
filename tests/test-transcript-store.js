#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: MIT
// Unit tests for transcriptStore.js — the shared helper module used
// by the Shell extension and the GTK test app to load, delete, and
// re-run AI cleanup on transcript history entries.
//
// Run: gjs -m tests/test-transcript-store.js

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {
    entryFromJson,
    loadTranscriptsSync,
    deleteTranscript,
    rerunAiCleanup,
} from '../transcriptStore.js';

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

// ── Helpers ──

function mktmp() {
    return GLib.dir_make_tmp('speakeasy-store-test-XXXXXX');
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

function writeJson(dir, name, obj) {
    const path = GLib.build_filenamev([dir, name]);
    const file = Gio.File.new_for_path(path);
    file.replace_contents(
        new TextEncoder().encode(JSON.stringify(obj, null, 2)),
        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    return path;
}

function readJson(path) {
    const file = Gio.File.new_for_path(path);
    const [ok, contents] = file.load_contents(null);
    if (!ok) throw new Error(`failed to read ${path}`);
    return JSON.parse(new TextDecoder().decode(contents));
}

// ── Fake AI ──
class FakeAi {
    constructor(cleaned = '[clean] result') {
        this._cleaned = cleaned;
        this._sessionStarted = false;
        this._buffer = '';
        this._destroyed = false;
        this._shouldThrow = false;
    }
    isAvailable() { return true; }
    beginSession() { this._sessionStarted = true; return Promise.resolve(); }
    feedText(text) { this._buffer += text; }
    async finalize(_onDelta) {
        if (this._shouldThrow) throw new Error('simulated failure');
        return this._cleaned;
    }
    destroy() { this._destroyed = true; }
}

const loop = GLib.MainLoop.new(null, false);

(async () => {
    print('');
    print('transcriptStore');
    print('─'.repeat(60));

    await test('entryFromJson reads basic fields', async () => {
        const entry = entryFromJson({
            timestamp: '2026-04-08T12:00:00.000Z',
            raw_text: 'hello',
            cleaned_text: 'Hello.',
            ai_enabled: true,
        }, '/tmp/x.json');
        assertEqual(entry.timestamp, '2026-04-08T12:00:00.000Z', 'timestamp');
        assertEqual(entry.rawText, 'hello', 'rawText');
        assertEqual(entry.cleanedText, 'Hello.', 'cleanedText');
        assertEqual(entry.aiEnabled, true, 'aiEnabled');
        assertEqual(entry.recovered, false, 'recovered default false');
        assertEqual(entry.filePath, '/tmp/x.json', 'filePath');
    });

    await test('entryFromJson picks up recovered:true flag', async () => {
        const entry = entryFromJson({
            timestamp: '2026-04-08T12:00:00.000Z',
            raw_text: 'hi',
            cleaned_text: 'hi',
            ai_enabled: false,
            recovered: true,
        }, '/tmp/x.json');
        assertEqual(entry.recovered, true, 'recovered true');
    });

    await test('loadTranscriptsSync loads a recovered transcript with recovered=true', async () => {
        const dir = mktmp();
        try {
            writeJson(dir, 'transcript-2026-04-08T11-00-00-000Z.json', {
                timestamp: '2026-04-08T11:00:00.000Z',
                raw_text: 'some text',
                cleaned_text: 'some text',
                ai_enabled: false,
                recovered: true,
            });
            writeJson(dir, 'transcript-2026-04-08T12-00-00-000Z.json', {
                timestamp: '2026-04-08T12:00:00.000Z',
                raw_text: 'normal',
                cleaned_text: 'Normal.',
                ai_enabled: true,
            });
            const entries = loadTranscriptsSync(dir);
            assertEqual(entries.length, 2, 'two entries');
            // Sorted ascending by timestamp
            assertEqual(entries[0].recovered, true, 'recovered flag on first');
            assertEqual(entries[1].recovered, false, 'non-recovered on second');
            assertEqual(entries[1].aiEnabled, true, 'aiEnabled true on second');
        } finally {
            rmrf(dir);
        }
    });

    await test('loadTranscriptsSync skips non-json files and returns empty on missing dir', async () => {
        const dir = mktmp();
        try {
            writeJson(dir, 'transcript-x.json', {
                timestamp: '2026-01-01T00:00:00.000Z',
                raw_text: 'a', cleaned_text: 'a', ai_enabled: false,
            });
            const stray = GLib.build_filenamev([dir, 'not-a-transcript.txt']);
            Gio.File.new_for_path(stray).replace_contents(
                new TextEncoder().encode('nope'), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            const entries = loadTranscriptsSync(dir);
            assertEqual(entries.length, 1, 'only json counted');

            const missing = loadTranscriptsSync('/tmp/does-not-exist-speakeasy-xyz');
            assertEqual(missing.length, 0, 'missing dir → empty');
        } finally {
            rmrf(dir);
        }
    });

    await test('deleteTranscript removes the file from disk', async () => {
        const dir = mktmp();
        try {
            const path = writeJson(dir, 'transcript-del.json', {
                timestamp: '2026-04-08T12:00:00.000Z',
                raw_text: 'gone', cleaned_text: 'gone', ai_enabled: false,
            });
            const entry = {filePath: path};
            assert(Gio.File.new_for_path(path).query_exists(null), 'file exists before');
            const ok = deleteTranscript(entry);
            assertEqual(ok, true, 'delete returns true');
            assert(!Gio.File.new_for_path(path).query_exists(null), 'file gone after');
        } finally {
            rmrf(dir);
        }
    });

    await test('deleteTranscript returns false when file already gone', async () => {
        const entry = {filePath: '/tmp/no-such-file-speakeasy-xyz.json'};
        const ok = deleteTranscript(entry);
        assertEqual(ok, false, 'delete returns false for missing file');
    });

    await test('rerunAiCleanup updates entry + JSON with cleaned text and ai_enabled', async () => {
        const dir = mktmp();
        try {
            const path = writeJson(dir, 'transcript-rerun.json', {
                timestamp: '2026-04-08T12:00:00.000Z',
                raw_text: 'hello world',
                cleaned_text: 'hello world',
                audio_path: null,
                ai_enabled: false,
            });
            const entry = {
                timestamp: '2026-04-08T12:00:00.000Z',
                rawText: 'hello world',
                cleanedText: 'hello world',
                aiEnabled: false,
                recovered: false,
                filePath: path,
            };
            const ai = new FakeAi('Hello, world!');
            const ok = await rerunAiCleanup(entry, ai);
            assertEqual(ok, true, 'returns true on success');
            assertEqual(entry.cleanedText, 'Hello, world!', 'in-memory cleanedText updated');
            assertEqual(entry.aiEnabled, true, 'in-memory aiEnabled true');

            const data = readJson(path);
            assertEqual(data.cleaned_text, 'Hello, world!', 'JSON cleaned_text updated');
            assertEqual(data.ai_enabled, true, 'JSON ai_enabled true');
            assertEqual(data.raw_text, 'hello world', 'raw text preserved');
        } finally {
            rmrf(dir);
        }
    });

    await test('rerunAiCleanup preserves recovered flag in JSON', async () => {
        const dir = mktmp();
        try {
            const path = writeJson(dir, 'transcript-rerun-rec.json', {
                timestamp: '2026-04-08T12:00:00.000Z',
                raw_text: 'recovered content',
                cleaned_text: 'recovered content',
                audio_path: '/tmp/foo.opus',
                ai_enabled: false,
                recovered: true,
            });
            const entry = {
                timestamp: '2026-04-08T12:00:00.000Z',
                rawText: 'recovered content',
                cleanedText: 'recovered content',
                aiEnabled: false,
                recovered: true,
                audioPath: '/tmp/foo.opus',
                filePath: path,
            };
            const ai = new FakeAi('Recovered content.');
            await rerunAiCleanup(entry, ai);
            const data = readJson(path);
            assertEqual(data.recovered, true, 'recovered flag preserved');
            assertEqual(data.audio_path, '/tmp/foo.opus', 'audio_path preserved');
            assertEqual(data.cleaned_text, 'Recovered content.', 'cleaned updated');
        } finally {
            rmrf(dir);
        }
    });

    await test('rerunAiCleanup returns false on AI failure and leaves entry unchanged', async () => {
        const dir = mktmp();
        try {
            const path = writeJson(dir, 'transcript-fail.json', {
                timestamp: '2026-04-08T12:00:00.000Z',
                raw_text: 'raw', cleaned_text: 'raw', ai_enabled: false,
            });
            const entry = {
                timestamp: '2026-04-08T12:00:00.000Z',
                rawText: 'raw',
                cleanedText: 'raw',
                aiEnabled: false,
                recovered: false,
                filePath: path,
            };
            const ai = new FakeAi();
            ai._shouldThrow = true;
            const ok = await rerunAiCleanup(entry, ai);
            assertEqual(ok, false, 'returns false');
            assertEqual(entry.cleanedText, 'raw', 'entry unchanged');
            assertEqual(entry.aiEnabled, false, 'entry unchanged');
        } finally {
            rmrf(dir);
        }
    });

    await test('rerunAiCleanup returns false when AI returns empty text', async () => {
        const dir = mktmp();
        try {
            const path = writeJson(dir, 'transcript-empty.json', {
                timestamp: '2026-04-08T12:00:00.000Z',
                raw_text: 'raw', cleaned_text: 'raw', ai_enabled: false,
            });
            const entry = {
                timestamp: '2026-04-08T12:00:00.000Z',
                rawText: 'raw',
                cleanedText: 'raw',
                aiEnabled: false,
                recovered: false,
                filePath: path,
            };
            const ai = new FakeAi('   ');
            const ok = await rerunAiCleanup(entry, ai);
            assertEqual(ok, false, 'returns false on empty');
            assertEqual(entry.cleanedText, 'raw', 'unchanged');
        } finally {
            rmrf(dir);
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
