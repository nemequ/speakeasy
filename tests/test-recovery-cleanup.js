#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: MIT
// Unit tests for recoveryCleanup.js — the callback-driven wrapper
// around transcriptStore.rerunAiCleanup used by the Shell and GTK
// recovery flows to surface AI cleanup progress in the UI.
//
// Run: gjs -m tests/test-recovery-cleanup.js

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {runRecoveryCleanupWithFeedback} from '../recoveryCleanup.js';

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

function mktmp() {
    return GLib.dir_make_tmp('speakeasy-reccleanup-test-XXXXXX');
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

// Build a transcript JSON on disk and return a matching in-memory
// entry (the same shape rerunAiCleanup expects).
function makeEntry(dir, rawText) {
    const filePath = GLib.build_filenamev([dir, 'transcript-test.json']);
    const json = JSON.stringify({
        timestamp: '2026-04-08T12:00:00.000Z',
        raw_text: rawText,
        cleaned_text: rawText,
        audio_path: '/tmp/fake.opus',
        ai_enabled: false,
        recovered: true,
    }, null, 2);
    Gio.File.new_for_path(filePath).replace_contents(
        new TextEncoder().encode(json),
        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    return {
        timestamp: '2026-04-08T12:00:00.000Z',
        rawText,
        cleanedText: rawText,
        audioPath: '/tmp/fake.opus',
        aiEnabled: false,
        recovered: true,
        filePath,
    };
}

// Fake AI backends for each scenario.
function fakeAiSuccess(cleaned) {
    return {
        isAvailable: () => true,
        async beginSession() {},
        feedText(_text) {},
        async finalize(_signal) { return cleaned; },
        destroy() {},
    };
}

function fakeAiEmpty() {
    return {
        isAvailable: () => true,
        async beginSession() {},
        feedText(_text) {},
        async finalize(_signal) { return ''; },
        destroy() {},
    };
}

function fakeAiThrow() {
    return {
        isAvailable: () => true,
        async beginSession() { throw new Error('boom'); },
        feedText(_text) {},
        async finalize(_signal) { return null; },
        destroy() {},
    };
}

// ─── Tests ──────────────────────────────────────────────────────────

print('');
print('recoveryCleanup.runRecoveryCleanupWithFeedback');
print('─'.repeat(60));

await test('calls onStart then onDone on success, returns true', async () => {
    const dir = mktmp();
    try {
        const entry = makeEntry(dir, 'raw speech text');
        const events = [];
        const ok = await runRecoveryCleanupWithFeedback(
            entry, fakeAiSuccess('cleaned speech text.'),
            {
                onStart: () => events.push('start'),
                onDone: (e) => events.push(`done:${e.cleanedText}`),
                onError: (_e) => events.push('error'),
            });
        assertEqual(ok, true, 'return value');
        assertEqual(events.length, 2, 'two events');
        assertEqual(events[0], 'start', 'first event is start');
        assertEqual(events[1], 'done:cleaned speech text.', 'second event is done with cleaned text');
        assertEqual(entry.cleanedText, 'cleaned speech text.', 'entry mutated');
        assertEqual(entry.aiEnabled, true, 'entry ai enabled');
    } finally {
        rmrf(dir);
    }
});

await test('calls onError when AI throws, returns false', async () => {
    const dir = mktmp();
    try {
        const entry = makeEntry(dir, 'raw text');
        const events = [];
        const ok = await runRecoveryCleanupWithFeedback(
            entry, fakeAiThrow(),
            {
                onStart: () => events.push('start'),
                onDone: () => events.push('done'),
                onError: () => events.push('error'),
            });
        assertEqual(ok, false, 'return value');
        assertEqual(events[0], 'start', 'start fired');
        assertEqual(events[events.length - 1], 'error', 'ended with error');
        assert(!events.includes('done'), 'done NOT fired');
        assertEqual(entry.cleanedText, 'raw text', 'entry cleanedText unchanged');
        assertEqual(entry.aiEnabled, false, 'entry aiEnabled unchanged');
    } finally {
        rmrf(dir);
    }
});

await test('calls onError when AI returns empty text, returns false', async () => {
    const dir = mktmp();
    try {
        const entry = makeEntry(dir, 'raw text');
        let errored = false;
        const ok = await runRecoveryCleanupWithFeedback(
            entry, fakeAiEmpty(),
            {onError: () => { errored = true; }});
        assertEqual(ok, false, 'return value');
        assertEqual(errored, true, 'onError fired');
    } finally {
        rmrf(dir);
    }
});

await test('missing entry returns false and fires onError', async () => {
    let errored = false;
    const ok = await runRecoveryCleanupWithFeedback(
        null, fakeAiSuccess('x'),
        {onError: () => { errored = true; }});
    assertEqual(ok, false, 'return value');
    assertEqual(errored, true, 'onError fired');
});

await test('missing ai returns false and fires onError', async () => {
    const dir = mktmp();
    try {
        const entry = makeEntry(dir, 'raw text');
        let errored = false;
        const ok = await runRecoveryCleanupWithFeedback(
            entry, null,
            {onError: () => { errored = true; }});
        assertEqual(ok, false, 'return value');
        assertEqual(errored, true, 'onError fired');
    } finally {
        rmrf(dir);
    }
});

await test('callbacks are optional — no throw when omitted', async () => {
    const dir = mktmp();
    try {
        const entry = makeEntry(dir, 'raw text');
        const ok = await runRecoveryCleanupWithFeedback(
            entry, fakeAiSuccess('cleaned.'));
        assertEqual(ok, true, 'success without callbacks');
    } finally {
        rmrf(dir);
    }
});

await test('throwing onStart is swallowed and does not break cleanup', async () => {
    const dir = mktmp();
    try {
        const entry = makeEntry(dir, 'raw text');
        let doneFired = false;
        const ok = await runRecoveryCleanupWithFeedback(
            entry, fakeAiSuccess('cleaned.'),
            {
                onStart: () => { throw new Error('start blew up'); },
                onDone: () => { doneFired = true; },
            });
        assertEqual(ok, true, 'return value');
        assertEqual(doneFired, true, 'onDone still fired');
    } finally {
        rmrf(dir);
    }
});

// ─── Results ────────────────────────────────────────────────────────
print('');
print('═'.repeat(60));
print(`Results: ${_passed} passed, ${_failed} failed, ${_passed + _failed} total`);
if (_failed > 0) {
    for (const e of _errors)
        print(`  ${e.name}: ${e.error}`);
    imports.system.exit(1);
}
