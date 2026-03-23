#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: MIT
// Unit tests for Recorder (recorder.js) — VOSK/Whisper parsing and helpers
//
// Run: gjs -m tests/test-recorder.js
//
// Tests parsing logic and model detection without creating real
// GStreamer pipelines (which require vosk/whisper plugins).

import GLib from 'gi://GLib';
import Gst from 'gi://Gst?version=1.0';

import {Recorder} from '../recorder.js';

// Initialize GStreamer (required before any Gst API usage)
Gst.init(null);

// ─── Test harness ───────────────────────────────────────────────────

let _passed = 0;
let _failed = 0;
let _errors = [];

function assert(condition, message) {
    if (!condition)
        throw new Error(`Assertion failed: ${message}`);
}

function assertEqual(actual, expected, message) {
    if (actual !== expected)
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
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

// ════════════════════════════════════════════════════════════════════
//  Helper: create a Recorder with _running=true for parse testing
// ════════════════════════════════════════════════════════════════════

function makeTestRecorder() {
    const r = new Recorder();
    // Set _running so _onBusMessage won't bail out early,
    // and initialize accumulators as start() would.
    r._running = true;
    r._accumulatedText = [];
    r._partialText = '';
    return r;
}

// ════════════════════════════════════════════════════════════════════
//  VOSK JSON parsing (_parseVoskJson)
// ════════════════════════════════════════════════════════════════════

print('');
print('Recorder — VOSK JSON parsing');
print('─'.repeat(60));

test('_parseVoskJson: partial result sets _partialText', () => {
    const r = makeTestRecorder();
    r._parseVoskJson('{"partial": "hello wor"}');
    assertEqual(r._partialText, 'hello wor', 'partial text');
    assertDeepEqual(r._accumulatedText, [], 'no accumulated text for partials');
});

test('_parseVoskJson: partial result fires onPartialText callback', () => {
    const r = makeTestRecorder();
    let cbText = null;
    r._onPartialText = text => { cbText = text; };

    r._parseVoskJson('{"partial": "testing"}');
    assertEqual(cbText, 'testing', 'callback text');
});

test('_parseVoskJson: empty partial does not fire callback', () => {
    const r = makeTestRecorder();
    let called = false;
    r._onPartialText = () => { called = true; };

    r._parseVoskJson('{"partial": ""}');
    assertEqual(called, false, 'callback should not fire for empty partial');
    assertEqual(r._partialText, '', 'partial text is empty string');
});

test('_parseVoskJson: final result accumulates text', () => {
    const r = makeTestRecorder();
    r._parseVoskJson('{"text": "hello world"}');
    assertDeepEqual(r._accumulatedText, ['hello world'], 'accumulated text');
    assertEqual(r._partialText, '', 'partial cleared on final');
});

test('_parseVoskJson: final result fires onFinalText callback', () => {
    const r = makeTestRecorder();
    let cbText = null;
    r._onFinalText = text => { cbText = text; };

    r._parseVoskJson('{"text": "done talking"}');
    assertEqual(cbText, 'done talking', 'callback text');
});

test('_parseVoskJson: empty text is ignored', () => {
    const r = makeTestRecorder();
    r._parseVoskJson('{"text": ""}');
    assertDeepEqual(r._accumulatedText, [], 'empty text not accumulated');
});

test('_parseVoskJson: alternatives result', () => {
    const r = makeTestRecorder();
    const json = JSON.stringify({
        alternatives: [
            {text: 'first alternative', confidence: 0.9},
            {text: 'second alternative', confidence: 0.7},
        ],
    });
    r._parseVoskJson(json);
    assertDeepEqual(r._accumulatedText, ['first alternative'], 'picks first alternative');
});

test('_parseVoskJson: alternatives with empty text ignored', () => {
    const r = makeTestRecorder();
    r._parseVoskJson('{"alternatives": [{"text": "   "}]}');
    assertDeepEqual(r._accumulatedText, [], 'whitespace-only alternative ignored');
});

test('_parseVoskJson: alternatives with no text field ignored', () => {
    const r = makeTestRecorder();
    r._parseVoskJson('{"alternatives": [{"confidence": 0.5}]}');
    assertDeepEqual(r._accumulatedText, [], 'alternative without text ignored');
});

test('_parseVoskJson: empty string input does nothing', () => {
    const r = makeTestRecorder();
    r._parseVoskJson('');
    assertDeepEqual(r._accumulatedText, [], 'empty string');
});

test('_parseVoskJson: null input does nothing', () => {
    const r = makeTestRecorder();
    r._parseVoskJson(null);
    assertDeepEqual(r._accumulatedText, [], 'null input');
});

test('_parseVoskJson: malformed JSON does not crash', () => {
    const r = makeTestRecorder();
    r._parseVoskJson('{not valid json');
    assertDeepEqual(r._accumulatedText, [], 'malformed json');
});

test('_parseVoskJson: multiple final results accumulate', () => {
    const r = makeTestRecorder();
    r._parseVoskJson('{"text": "hello"}');
    r._parseVoskJson('{"text": "world"}');
    r._parseVoskJson('{"text": "foo bar"}');
    assertDeepEqual(r._accumulatedText, ['hello', 'world', 'foo bar'], 'multiple segments');
});

test('_parseVoskJson: partial then final clears partial', () => {
    const r = makeTestRecorder();
    r._parseVoskJson('{"partial": "hel"}');
    assertEqual(r._partialText, 'hel', 'partial set');
    r._parseVoskJson('{"text": "hello"}');
    assertEqual(r._partialText, '', 'partial cleared after final');
    assertDeepEqual(r._accumulatedText, ['hello'], 'text accumulated');
});

// ════════════════════════════════════════════════════════════════════
//  Whisper message parsing (_parseWhisperMessage)
// ════════════════════════════════════════════════════════════════════

print('');
print('Recorder — Whisper message parsing');
print('─'.repeat(60));

test('_parseWhisperMessage: final text from GstStructure', () => {
    const r = makeTestRecorder();

    // Build a real GstStructure with text and is-partial=false
    const structure = Gst.Structure.new_from_string(
        'whisper, text=(string)"hello world", is-partial=(boolean)false;');

    if (structure) {
        r._parseWhisperMessage(structure);
        assertDeepEqual(r._accumulatedText, ['hello world'], 'final text accumulated');
        assertEqual(r._partialText, '', 'partial should be empty');
    } else {
        // If GstStructure parsing doesn't work, skip gracefully
        throw new Error('Could not create GstStructure — skipping');
    }
});

test('_parseWhisperMessage: partial text from GstStructure', () => {
    const r = makeTestRecorder();

    const structure = Gst.Structure.new_from_string(
        'whisper, text=(string)"partial words", is-partial=(boolean)true;');

    if (structure) {
        r._parseWhisperMessage(structure);
        assertDeepEqual(r._accumulatedText, [], 'partial not accumulated');
        assertEqual(r._partialText, 'partial words', 'partial text set');
    } else {
        throw new Error('Could not create GstStructure — skipping');
    }
});

test('_parseWhisperMessage: partial text fires onPartialText callback', () => {
    const r = makeTestRecorder();
    let cbText = null;
    r._onPartialText = text => { cbText = text; };

    const structure = Gst.Structure.new_from_string(
        'whisper, text=(string)"incoming", is-partial=(boolean)true;');

    if (structure) {
        r._parseWhisperMessage(structure);
        assertEqual(cbText, 'incoming', 'callback fired');
    } else {
        throw new Error('Could not create GstStructure — skipping');
    }
});

test('_parseWhisperMessage: final text fires onFinalText callback', () => {
    const r = makeTestRecorder();
    let cbText = null;
    r._onFinalText = text => { cbText = text; };

    const structure = Gst.Structure.new_from_string(
        'whisper, text=(string)"done here", is-partial=(boolean)false;');

    if (structure) {
        r._parseWhisperMessage(structure);
        assertEqual(cbText, 'done here', 'callback fired');
    } else {
        throw new Error('Could not create GstStructure — skipping');
    }
});

test('_parseWhisperMessage: text without is-partial treats as final', () => {
    const r = makeTestRecorder();

    // No is-partial field — get_boolean returns [false, undefined],
    // so the else branch runs (treated as final).
    const structure = Gst.Structure.new_from_string(
        'whisper, text=(string)"no partial flag";');

    if (structure) {
        r._parseWhisperMessage(structure);
        assertDeepEqual(r._accumulatedText, ['no partial flag'], 'treated as final');
    } else {
        throw new Error('Could not create GstStructure — skipping');
    }
});

test('_parseWhisperMessage: empty text falls through to result field', () => {
    const r = makeTestRecorder();

    const structure = Gst.Structure.new_from_string(
        'whisper, result=(string)"{\\"text\\": \\"from result\\"}";');

    if (structure) {
        r._parseWhisperMessage(structure);
        assertDeepEqual(r._accumulatedText, ['from result'], 'result field used');
    } else {
        throw new Error('Could not create GstStructure — skipping');
    }
});

test('_parseWhisperMessage: empty text and no result does nothing', () => {
    const r = makeTestRecorder();

    const structure = Gst.Structure.new_from_string('whisper;');
    if (structure) {
        r._parseWhisperMessage(structure);
        assertDeepEqual(r._accumulatedText, [], 'nothing accumulated');
    } else {
        throw new Error('Could not create GstStructure — skipping');
    }
});

// ════════════════════════════════════════════════════════════════════
//  Text accumulation: stop() returns joined text
// ════════════════════════════════════════════════════════════════════

print('');
print('Recorder — Text accumulation');
print('─'.repeat(60));

test('accumulated text joins with spaces', () => {
    const r = makeTestRecorder();
    r._parseVoskJson('{"text": "hello"}');
    r._parseVoskJson('{"text": "world"}');
    r._parseVoskJson('{"text": "this is a test"}');

    const result = r._accumulatedText.join(' ').trim();
    assertEqual(result, 'hello world this is a test', 'joined text');
});

test('empty accumulation returns empty string', () => {
    const r = makeTestRecorder();
    const result = r._accumulatedText.join(' ').trim();
    assertEqual(result, '', 'empty');
});

test('single segment accumulation', () => {
    const r = makeTestRecorder();
    r._parseVoskJson('{"text": "only one segment"}');
    const result = r._accumulatedText.join(' ').trim();
    assertEqual(result, 'only one segment', 'single segment');
});

// ════════════════════════════════════════════════════════════════════
//  Model detection (static methods)
// ════════════════════════════════════════════════════════════════════

print('');
print('Recorder — Model detection');
print('─'.repeat(60));

test('detectVoskModelPath() returns string or null without crashing', () => {
    const result = Recorder.detectVoskModelPath();
    assert(result === null || typeof result === 'string',
        `expected null or string, got ${typeof result}`);
    if (result !== null)
        assert(result.length > 0, 'path should not be empty');
    // Log for informational purposes
    print(`        (vosk model: ${result ?? 'not found'})`);
});

test('detectWhisperModelPath() returns string or null without crashing', () => {
    const result = Recorder.detectWhisperModelPath();
    assert(result === null || typeof result === 'string',
        `expected null or string, got ${typeof result}`);
    if (result !== null)
        assert(result.length > 0, 'path should not be empty');
    print(`        (whisper model: ${result ?? 'not found'})`);
});

// ════════════════════════════════════════════════════════════════════
//  Callback wiring
// ════════════════════════════════════════════════════════════════════

print('');
print('Recorder — Callback wiring');
print('─'.repeat(60));

test('onPartialText() sets callback', () => {
    const r = new Recorder();
    const cb = () => {};
    r.onPartialText(cb);
    assertEqual(r._onPartialText, cb, 'callback stored');
});

test('onFinalText() sets callback', () => {
    const r = new Recorder();
    const cb = () => {};
    r.onFinalText(cb);
    assertEqual(r._onFinalText, cb, 'callback stored');
});

test('onPartialText fires during VOSK partial parse', () => {
    const r = makeTestRecorder();
    const partials = [];
    r._onPartialText = text => partials.push(text);

    r._parseVoskJson('{"partial": "hel"}');
    r._parseVoskJson('{"partial": "hello"}');
    r._parseVoskJson('{"partial": "hello wor"}');

    assertDeepEqual(partials, ['hel', 'hello', 'hello wor'], 'all partials received');
});

test('onFinalText fires during VOSK final parse', () => {
    const r = makeTestRecorder();
    const finals = [];
    r._onFinalText = text => finals.push(text);

    r._parseVoskJson('{"text": "hello world"}');
    r._parseVoskJson('{"text": "second sentence"}');

    assertDeepEqual(finals, ['hello world', 'second sentence'], 'all finals received');
});

test('partial callback not fired for empty partial', () => {
    const r = makeTestRecorder();
    let callCount = 0;
    r._onPartialText = () => { callCount++; };

    r._parseVoskJson('{"partial": ""}');
    assertEqual(callCount, 0, 'no call for empty partial');
});

test('final callback not fired for empty text', () => {
    const r = makeTestRecorder();
    let callCount = 0;
    r._onFinalText = () => { callCount++; };

    r._parseVoskJson('{"text": ""}');
    assertEqual(callCount, 0, 'no call for empty text');
});

test('mixed partial and final callbacks in sequence', () => {
    const r = makeTestRecorder();
    const events = [];
    r._onPartialText = text => events.push({type: 'partial', text});
    r._onFinalText = text => events.push({type: 'final', text});

    r._parseVoskJson('{"partial": "hel"}');
    r._parseVoskJson('{"partial": "hello"}');
    r._parseVoskJson('{"text": "hello"}');
    r._parseVoskJson('{"partial": "good"}');
    r._parseVoskJson('{"text": "goodbye"}');

    assertDeepEqual(events, [
        {type: 'partial', text: 'hel'},
        {type: 'partial', text: 'hello'},
        {type: 'final', text: 'hello'},
        {type: 'partial', text: 'good'},
        {type: 'final', text: 'goodbye'},
    ], 'events in order');
});

// ════════════════════════════════════════════════════════════════════
//  Constructor defaults
// ════════════════════════════════════════════════════════════════════

print('');
print('Recorder — Constructor');
print('─'.repeat(60));

test('constructor defaults', () => {
    const r = new Recorder();
    assertEqual(r._sttPipeline, null, '_sttPipeline');
    assertEqual(r._sttElement, null, '_sttElement');
    assertEqual(r._busWatchId, 0, '_busWatchId');
    assertEqual(r._errorHandlerId, 0, '_errorHandlerId');
    assertDeepEqual(r._accumulatedText, [], '_accumulatedText');
    assertEqual(r._partialText, '', '_partialText');
    assertEqual(r._running, false, '_running');
    assertEqual(r._ready, false, '_ready');
    assertEqual(r._capturePipeline, null, '_capturePipeline');
    assertEqual(r._filePipeline, null, '_filePipeline');
    assertEqual(r._audioPath, null, '_audioPath');
    assertEqual(r._backend, 'vosk', '_backend');
    assertEqual(r._voskModelPath, null, '_voskModelPath');
    assertEqual(r._whisperModelPath, null, '_whisperModelPath');
    assertEqual(r._whisperLanguage, 'en', '_whisperLanguage');
    assertEqual(r._settings, null, '_settings');
    assertEqual(r._onPartialText, null, '_onPartialText');
    assertEqual(r._onFinalText, null, '_onFinalText');
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
