#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: MIT
// Unit tests for the FileTranscriber NDJSON event parser.
//
// Run: gjs -m tests/test-file-transcribe.js
//
// These tests bypass the actual subprocess and directly drive
// `_handleLine()` with JSON strings. That covers the parser/dispatch
// logic deterministically without needing a VOSK model on disk or
// the multi-minute wall time of a real transcription.

import GLib from 'gi://GLib';

import {FileTranscriber} from '../fileTranscribe.js';

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

function assertDeepEqual(actual, expected, message) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b)
        throw new Error(`${message}: expected ${b}, got ${a}`);
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

function makeTranscriber() {
    const events = {
        loading: 0,
        ready: 0,
        progress: [],
        partials: [],
        finals: [],
        done: null,
        errors: [],
    };

    const t = new FileTranscriber({
        extensionDir: '/tmp/fake-ext-dir',
        modelPath: null,
        onLoading: () => { events.loading++; },
        onReady: () => { events.ready++; },
        onProgress: (info) => { events.progress.push(info); },
        onPartial: (text) => { events.partials.push(text); },
        onFinal: (text) => { events.finals.push(text); },
        onDone: (info) => { events.done = info; },
        onError: (msg) => { events.errors.push(msg); },
    });

    return {transcriber: t, events};
}

// ════════════════════════════════════════════════════════════════════
//  Tests
// ════════════════════════════════════════════════════════════════════

print('');
print('FileTranscriber NDJSON parser');
print('─'.repeat(60));

test('loading event fires onLoading', () => {
    const {transcriber, events} = makeTranscriber();
    transcriber._handleLine('{"type":"loading"}');
    assertEqual(events.loading, 1, 'onLoading called once');
});

test('ready event fires onReady', () => {
    const {transcriber, events} = makeTranscriber();
    transcriber._handleLine('{"type":"ready"}');
    assertEqual(events.ready, 1, 'onReady called once');
});

test('progress event forwards full payload', () => {
    const {transcriber, events} = makeTranscriber();
    transcriber._handleLine('{"type":"progress","pos_secs":42,"dur_secs":3225,"finals":17}');
    assertEqual(events.progress.length, 1, '1 progress event');
    assertDeepEqual(events.progress[0], {
        type: 'progress',
        pos_secs: 42,
        dur_secs: 3225,
        finals: 17,
    }, 'progress payload');
});

test('partial event forwards text only', () => {
    const {transcriber, events} = makeTranscriber();
    transcriber._handleLine('{"type":"partial","text":"hello there my friend"}');
    assertEqual(events.partials.length, 1, '1 partial');
    assertEqual(events.partials[0], 'hello there my friend', 'partial text');
});

test('final event forwards text only', () => {
    const {transcriber, events} = makeTranscriber();
    transcriber._handleLine('{"type":"final","text":"this is a committed segment"}');
    assertEqual(events.finals.length, 1, '1 final');
    assertEqual(events.finals[0], 'this is a committed segment', 'final text');
});

test('done event forwards full payload and is buffered as _lastDone', () => {
    const {transcriber, events} = makeTranscriber();
    transcriber._handleLine('{"type":"done","raw_text":"hello world","finals_count":7}');
    assert(events.done !== null, 'onDone called');
    assertEqual(events.done.raw_text, 'hello world', 'raw_text');
    assertEqual(events.done.finals_count, 7, 'finals_count');
    // Internal buffering for the wait_async exit handler
    assertEqual(transcriber._lastDone.raw_text, 'hello world', '_lastDone cached');
});

test('error event fires onError and is buffered as _lastError', () => {
    const {transcriber, events} = makeTranscriber();
    transcriber._handleLine('{"type":"error","message":"pipeline failed: no model"}');
    assertEqual(events.errors.length, 1, '1 error');
    assertEqual(events.errors[0], 'pipeline failed: no model', 'error message');
    assertEqual(transcriber._lastError, 'pipeline failed: no model', '_lastError cached');
});

test('full event sequence — loading → ready → progress → finals → done', () => {
    const {transcriber, events} = makeTranscriber();
    transcriber._handleLine('{"type":"loading"}');
    transcriber._handleLine('{"type":"ready"}');
    transcriber._handleLine('{"type":"progress","pos_secs":0,"dur_secs":120,"finals":0}');
    transcriber._handleLine('{"type":"final","text":"first segment"}');
    transcriber._handleLine('{"type":"final","text":"second segment"}');
    transcriber._handleLine('{"type":"progress","pos_secs":60,"dur_secs":120,"finals":2}');
    transcriber._handleLine('{"type":"final","text":"third segment"}');
    transcriber._handleLine('{"type":"done","raw_text":"first segment second segment third segment","finals_count":3}');

    assertEqual(events.loading, 1, 'loading');
    assertEqual(events.ready, 1, 'ready');
    assertEqual(events.progress.length, 2, '2 progress events');
    assertEqual(events.finals.length, 3, '3 finals');
    assertEqual(events.finals[0], 'first segment', 'first');
    assertEqual(events.finals[2], 'third segment', 'third');
    assertEqual(events.done.finals_count, 3, 'done count');
});

test('unparseable lines are skipped without throwing', () => {
    const {transcriber, events} = makeTranscriber();
    transcriber._handleLine('this is not json');
    transcriber._handleLine('{"truncated json"');
    transcriber._handleLine('');
    // None of these should call any callback
    assertEqual(events.loading, 0, 'no loading');
    assertEqual(events.errors.length, 0, 'no error fires');
});

test('unknown event types are skipped without throwing', () => {
    const {transcriber, events} = makeTranscriber();
    transcriber._handleLine('{"type":"future_unknown_event","data":42}');
    assertEqual(events.errors.length, 0, 'unknown type does not fire onError');
});

test('cancel() is idempotent when subprocess is null', () => {
    const {transcriber} = makeTranscriber();
    // No subprocess running — cancel should be a no-op, not throw
    transcriber.cancel();
    transcriber.cancel();  // again
    assertEqual(transcriber.isRunning(), false, 'still not running');
});

test('start() with non-existent script reports error', () => {
    const {transcriber, events} = makeTranscriber();
    // extensionDir points to /tmp/fake-ext-dir which doesn't have
    // tools/transcribe-file.js
    const ok = transcriber.start('/tmp/some-fake-audio.opus');
    assertEqual(ok, false, 'start returns false');
    assertEqual(events.errors.length, 1, 'error fired');
    assert(events.errors[0].includes('not found'), 'error mentions missing script');
});

test('start() with non-existent audio reports error', () => {
    // Use the real extension dir so the script check passes
    const {transcriber, events} = makeTranscriber();
    transcriber._extensionDir = GLib.path_get_dirname(
        GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]));
    const ok = transcriber.start('/tmp/this-file-does-not-exist.opus');
    assertEqual(ok, false, 'start returns false');
    assertEqual(events.errors.length, 1, 'error fired');
    assert(events.errors[0].includes('audio file not found'), 'error mentions missing audio');
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
