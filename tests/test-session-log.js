#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: MIT
// Unit tests for sessionLog.js (crash-safe incremental session log)
//
// Run: gjs -m tests/test-session-log.js

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {SessionLog, parseSessionLog, recoverOrphans} from '../sessionLog.js';

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

function test(name, fn) {
    try {
        fn();
        _passed++;
        print(`  PASS  ${name}`);
    } catch (e) {
        _failed++;
        _errors.push({name, error: e.message});
        print(`  FAIL  ${name}`);
        print(`        ${e.message}`);
    }
}

// ─── Helpers ────────────────────────────────────────────────────────

function makeTmpDir() {
    return GLib.dir_make_tmp('speakeasy-session-test-XXXXXX');
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

function readFile(path) {
    const [ok, bytes] = Gio.File.new_for_path(path).load_contents(null);
    if (!ok)
        return null;
    return new TextDecoder().decode(bytes);
}

function writeFile(path, contents) {
    const file = Gio.File.new_for_path(path);
    // g_file_replace_contents() rejects zero-length contents in some
    // GLib versions, so use the stream API for empty files.
    if (contents === '') {
        const stream = file.replace(
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        stream.close(null);
        return;
    }
    file.replace_contents(
        new TextEncoder().encode(contents),
        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}

// ════════════════════════════════════════════════════════════════════
//  SessionLog tests
// ════════════════════════════════════════════════════════════════════

print('');
print('SessionLog');
print('─'.repeat(60));

test('start() opens a new file with a start record', () => {
    const tmp = makeTmpDir();
    try {
        const log = new SessionLog(tmp);
        const path = log.start({audioPath: '/tmp/audio.opus', uuid: 'u1'});
        assert(path.startsWith(tmp), 'path under tmp dir');
        assert(path.endsWith('.jsonl'), 'jsonl extension');
        log.close();

        const content = readFile(path);
        const lines = content.split('\n').filter(l => l !== '');
        assertEqual(lines.length, 1, 'one line written');
        const obj = JSON.parse(lines[0]);
        assertEqual(obj.type, 'start', 'first record type');
        assertEqual(obj.audio_path, '/tmp/audio.opus', 'audio path');
        assertEqual(obj.uuid, 'u1', 'uuid');
        assert(typeof obj.timestamp === 'string', 'timestamp present');
    } finally {
        rmrf(tmp);
    }
});

test('appendFinal() writes one line per call and flushes immediately', () => {
    // The whole point of this module: a process killed between
    // calls should still see all already-flushed lines on disk.
    const tmp = makeTmpDir();
    try {
        const log = new SessionLog(tmp);
        const path = log.start({audioPath: null, uuid: null});

        log.appendFinal('hello');
        // Read while the log is still open — flush should make
        // the line visible to a separate file read.
        const mid = readFile(path);
        const midLines = mid.split('\n').filter(l => l !== '');
        assertEqual(midLines.length, 2, 'start + 1 final visible mid-stream');
        const final0 = JSON.parse(midLines[1]);
        assertEqual(final0.type, 'final', 'final record type');
        assertEqual(final0.text, 'hello', 'final text');

        log.appendFinal('world');
        log.appendFinal('how are you');
        log.close();

        const content = readFile(path);
        const lines = content.split('\n').filter(l => l !== '');
        assertEqual(lines.length, 4, 'start + 3 finals');
        assertEqual(JSON.parse(lines[2]).text, 'world', 'second final');
        assertEqual(JSON.parse(lines[3]).text, 'how are you', 'third final');
    } finally {
        rmrf(tmp);
    }
});

test('appendFinal() ignores empty / non-string text', () => {
    const tmp = makeTmpDir();
    try {
        const log = new SessionLog(tmp);
        const path = log.start({});
        log.appendFinal('');
        log.appendFinal(null);
        log.appendFinal(undefined);
        log.appendFinal(42);
        log.close();
        const content = readFile(path);
        const lines = content.split('\n').filter(l => l !== '');
        // Only the start record should be present.
        assertEqual(lines.length, 1, 'no finals written');
    } finally {
        rmrf(tmp);
    }
});

test('stop() writes a stop record with all fields', () => {
    const tmp = makeTmpDir();
    try {
        const log = new SessionLog(tmp);
        const path = log.start({});
        log.appendFinal('hello world');
        log.stop({
            rawText: 'hello world',
            cleanedText: 'Hello, world.',
            aiUsed: true,
        });
        log.close();

        const content = readFile(path);
        const lines = content.split('\n').filter(l => l !== '');
        assertEqual(lines.length, 3, 'start + final + stop');
        const stop = JSON.parse(lines[2]);
        assertEqual(stop.type, 'stop', 'stop record type');
        assertEqual(stop.raw_text, 'hello world', 'raw_text');
        assertEqual(stop.cleaned_text, 'Hello, world.', 'cleaned_text');
        assertEqual(stop.ai_used, true, 'ai_used');
    } finally {
        rmrf(tmp);
    }
});

test('markCompleted() moves the file into completed/', () => {
    const tmp = makeTmpDir();
    try {
        const log = new SessionLog(tmp);
        const path = log.start({});
        log.appendFinal('foo');
        log.stop({rawText: 'foo'});
        log.markCompleted();

        // Original file should be gone
        const exists = Gio.File.new_for_path(path).query_exists(null);
        assertEqual(exists, false, 'original moved');

        // File should appear in completed/
        const filename = GLib.path_get_basename(path);
        const movedPath = GLib.build_filenamev([tmp, 'completed', filename]);
        const movedExists = Gio.File.new_for_path(movedPath).query_exists(null);
        assertEqual(movedExists, true, 'file in completed/');
    } finally {
        rmrf(tmp);
    }
});

// ════════════════════════════════════════════════════════════════════
//  parseSessionLog tests
// ════════════════════════════════════════════════════════════════════

print('');
print('parseSessionLog');
print('─'.repeat(60));

test('parses a fully-written log', () => {
    const tmp = makeTmpDir();
    try {
        const log = new SessionLog(tmp);
        const path = log.start({audioPath: '/aud.opus', uuid: 'abc'});
        log.appendFinal('one');
        log.appendFinal('two');
        log.appendFinal('three');
        log.stop({
            rawText: 'one two three',
            cleanedText: 'One. Two. Three.',
            aiUsed: true,
        });
        log.close();

        const parsed = parseSessionLog(path);
        assert(parsed !== null, 'returns a result');
        assertEqual(parsed.complete, true, 'complete flag');
        assertEqual(parsed.rawText, 'one two three', 'rawText');
        assertEqual(parsed.cleanedText, 'One. Two. Three.', 'cleanedText');
        assertEqual(parsed.aiUsed, true, 'aiUsed');
        assertEqual(parsed.finals.length, 3, 'finals count');
        assertEqual(parsed.audioPath, '/aud.opus', 'audioPath');
    } finally {
        rmrf(tmp);
    }
});

test('parses a log with no stop record (orphan)', () => {
    const tmp = makeTmpDir();
    try {
        const log = new SessionLog(tmp);
        const path = log.start({});
        log.appendFinal('crash victim 1');
        log.appendFinal('crash victim 2');
        // simulate a crash: don't call stop()
        log.close();

        const parsed = parseSessionLog(path);
        assert(parsed !== null, 'returns a result');
        assertEqual(parsed.complete, false, 'incomplete');
        // raw_text synthesized from finals
        assertEqual(parsed.rawText, 'crash victim 1 crash victim 2', 'rawText synthesized');
        assertEqual(parsed.cleanedText, null, 'no cleaned text');
        assertEqual(parsed.finals.length, 2, 'two finals');
    } finally {
        rmrf(tmp);
    }
});

test('parses a log with a torn trailing line', () => {
    // Simulates a process killed mid-write: the last line is incomplete.
    const tmp = makeTmpDir();
    try {
        const path = GLib.build_filenamev([tmp, 'torn.jsonl']);
        const goodLine = JSON.stringify({
            type: 'start', timestamp: '2026-04-08T00:00:00Z', audio_path: null,
        });
        const goodFinal = JSON.stringify({
            type: 'final', timestamp: '2026-04-08T00:00:01Z', text: 'recoverable',
        });
        // Half-written final at the end
        const torn = '{"type":"final","timestamp":"2026-04-08T00:00:02Z","tex';
        writeFile(path, `${goodLine}\n${goodFinal}\n${torn}`);

        const parsed = parseSessionLog(path);
        assert(parsed !== null, 'returns a result');
        assertEqual(parsed.complete, false, 'incomplete');
        assertEqual(parsed.finals.length, 1, 'only complete finals counted');
        assertEqual(parsed.finals[0], 'recoverable', 'survivor');
    } finally {
        rmrf(tmp);
    }
});

test('returns null for an empty file', () => {
    const tmp = makeTmpDir();
    try {
        const path = GLib.build_filenamev([tmp, 'empty.jsonl']);
        writeFile(path, '');
        const parsed = parseSessionLog(path);
        assertEqual(parsed, null, 'empty -> null');
    } finally {
        rmrf(tmp);
    }
});

// ════════════════════════════════════════════════════════════════════
//  recoverOrphans tests
// ════════════════════════════════════════════════════════════════════

print('');
print('recoverOrphans');
print('─'.repeat(60));

test('recovers an orphaned session into a transcript JSON', () => {
    const tmp = makeTmpDir();
    const transcriptDir = GLib.build_filenamev([tmp, 'transcripts']);
    try {
        // Create an orphan
        const log = new SessionLog(tmp);
        const path = log.start({audioPath: null, uuid: 'orphan-uuid'});
        log.appendFinal('this never made it');
        log.appendFinal('to a transcript');
        log.close();
        // Note: no markCompleted() — this is an orphan.

        const results = recoverOrphans(tmp, transcriptDir);
        assertEqual(results.length, 1, 'one orphan recovered');
        const r = results[0];
        assertEqual(r.complete, false, 'recovery marks incomplete');
        assertEqual(r.rawText, 'this never made it to a transcript', 'recovered text');

        // Transcript file should exist and be parseable JSON
        const tContent = readFile(r.transcript);
        const t = JSON.parse(tContent);
        assertEqual(t.recovered, true, 'recovered marker');
        assertEqual(t.recovered_complete, false, 'recovered_complete marker');
        assertEqual(t.raw_text, 'this never made it to a transcript', 'raw_text');

        // Source file should have moved to completed/
        const exists = Gio.File.new_for_path(path).query_exists(null);
        assertEqual(exists, false, 'orphan moved out of top-level dir');
    } finally {
        rmrf(tmp);
    }
});

test('does not recover already-completed sessions', () => {
    const tmp = makeTmpDir();
    const transcriptDir = GLib.build_filenamev([tmp, 'transcripts']);
    try {
        const log = new SessionLog(tmp);
        log.start({});
        log.appendFinal('done');
        log.stop({rawText: 'done'});
        log.markCompleted();

        const results = recoverOrphans(tmp, transcriptDir);
        assertEqual(results.length, 0, 'completed session not recovered');
    } finally {
        rmrf(tmp);
    }
});

test('recovers multiple orphans in one pass', () => {
    const tmp = makeTmpDir();
    const transcriptDir = GLib.build_filenamev([tmp, 'transcripts']);
    try {
        const a = new SessionLog(tmp);
        a.start({});
        a.appendFinal('alpha');
        a.close();

        // Sleep briefly to make sure the second log gets a different
        // timestamp in its filename, otherwise replace() would
        // overwrite the first.
        const ctx = GLib.MainContext.default();
        const t = Date.now() + 1100;
        while (Date.now() < t)
            ctx.iteration(false);

        const b = new SessionLog(tmp);
        b.start({});
        b.appendFinal('bravo');
        b.appendFinal('charlie');
        b.close();

        const results = recoverOrphans(tmp, transcriptDir);
        assertEqual(results.length, 2, 'both recovered');
        const texts = results.map(r => r.rawText).sort();
        assertEqual(texts[0], 'alpha', 'first');
        assertEqual(texts[1], 'bravo charlie', 'second');
    } finally {
        rmrf(tmp);
    }
});

test('skips empty orphan files cleanly', () => {
    const tmp = makeTmpDir();
    const transcriptDir = GLib.build_filenamev([tmp, 'transcripts']);
    try {
        // Create an empty .jsonl by hand
        const path = GLib.build_filenamev([tmp, 'session-empty.jsonl']);
        writeFile(path, '');
        const results = recoverOrphans(tmp, transcriptDir);
        assertEqual(results.length, 0, 'empty file not recovered');
    } finally {
        rmrf(tmp);
    }
});

// ─── Summary ────────────────────────────────────────────────────────

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

imports.system.exit(_failed > 0 ? 1 : 0);
