#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: MIT
// Unit tests for Recorder static helpers used by init() to detect
// misconfiguration early (missing GStreamer plugin, missing model)
// and surface a specific error to the user instead of failing
// silently deep inside the subprocess.
//
// Run: gjs -m tests/test-recorder-init.js

import GLib from 'gi://GLib';

import {Recorder} from '../recorder.js';

let _passed = 0;
let _failed = 0;
const _errors = [];

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

async function asyncTest(name, fn) {
    try {
        await fn();
        _passed++;
        print(`  PASS  ${name}`);
    } catch (e) {
        _failed++;
        _errors.push({name, error: e.message});
        print(`  FAIL  ${name}`);
        print(`        ${e.message}`);
    }
}

function sleepMs(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

print('');
print('Recorder init helpers');
print('─'.repeat(60));

// ─── checkGstElement ─────────────────────────────────────────────────

test('checkGstElement returns ok=true when the finder returns a factory', () => {
    const fakeFactory = {name: 'vosk'};
    const res = Recorder.checkGstElement('vosk', () => fakeFactory);
    assertEqual(res.ok, true, 'ok');
    assertEqual(res.missing, null, 'missing');
});

test('checkGstElement returns ok=false when the finder returns null', () => {
    const res = Recorder.checkGstElement('vosk', () => null);
    assertEqual(res.ok, false, 'ok');
    assertEqual(res.missing, 'vosk', 'missing element name');
});

test('checkGstElement returns ok=false when the finder throws', () => {
    const res = Recorder.checkGstElement('vosk', () => {
        throw new Error('gstreamer not initialized');
    });
    assertEqual(res.ok, false, 'ok');
    assertEqual(res.missing, 'vosk', 'missing element name');
});

test('checkGstElement returns ok=false when no finder function is provided', () => {
    const res = Recorder.checkGstElement('vosk', null);
    assertEqual(res.ok, false, 'ok');
    assertEqual(res.missing, 'vosk', 'missing element name');
});

test('checkGstElement works for a whisper element', () => {
    const res = Recorder.checkGstElement('whisper', () => null);
    assertEqual(res.ok, false, 'ok');
    assertEqual(res.missing, 'whisper', 'missing element name');
});

// ─── gstElementForBackend ────────────────────────────────────────────

test('gstElementForBackend maps vosk -> "vosk"', () => {
    assertEqual(Recorder.gstElementForBackend('vosk'), 'vosk', 'vosk');
});

test('gstElementForBackend maps whisper -> "whisper"', () => {
    assertEqual(Recorder.gstElementForBackend('whisper'), 'whisper', 'whisper');
});

test('gstElementForBackend returns null for unknown backends', () => {
    assertEqual(Recorder.gstElementForBackend('magic'), null, 'unknown');
});

// ─── getLastInitFailureReason ────────────────────────────────────────

test('getLastInitFailureReason is null on a fresh instance', () => {
    const r = new Recorder();
    assertEqual(r.getLastInitFailureReason(), null, 'null');
});

// ─── armReadyWatchdog ────────────────────────────────────────────────

const loop = GLib.MainLoop.new(null, false);

(async () => {
    await asyncTest('armReadyWatchdog fires onTimeout when ready never arrives', async () => {
        const r = new Recorder();
        let fired = false;
        // The watchdog uses timeout_add_seconds, which has 1s
        // granularity and may align to the next second boundary —
        // wait up to ~2.5s for it to fire to avoid flakiness.
        r.armReadyWatchdog(1, () => { fired = true; });
        const deadline = GLib.get_monotonic_time() + 2500000;  // +2.5s
        while (!fired && GLib.get_monotonic_time() < deadline)
            await sleepMs(100);
        if (!fired) throw new Error('onTimeout was not invoked within 2.5s');
        assertEqual(r._readyWatchdogId, 0, 'id cleared after firing');
    });

    await asyncTest('armReadyWatchdog does NOT fire if cancelReadyWatchdog is called in time', async () => {
        const r = new Recorder();
        let fired = false;
        r.armReadyWatchdog(1, () => { fired = true; });
        await sleepMs(200);
        r.cancelReadyWatchdog();
        await sleepMs(2200);
        if (fired) throw new Error('onTimeout fired after cancel');
        assertEqual(r._readyWatchdogId, 0, 'id cleared');
    });

    await asyncTest('armReadyWatchdog does NOT fire if _ready becomes true before expiry', async () => {
        const r = new Recorder();
        let fired = false;
        r.armReadyWatchdog(1, () => { fired = true; });
        // Simulate the 'ready' message arriving: the real path sets
        // _ready=true then calls cancelReadyWatchdog().
        await sleepMs(200);
        r._ready = true;
        r.cancelReadyWatchdog();
        await sleepMs(2200);
        if (fired) throw new Error('onTimeout fired after ready');
    });

    await asyncTest('armReadyWatchdog with secs=0 is a no-op', async () => {
        const r = new Recorder();
        let fired = false;
        r.armReadyWatchdog(0, () => { fired = true; });
        assertEqual(r._readyWatchdogId, 0, 'no timer armed');
        await sleepMs(100);
        if (fired) throw new Error('onTimeout fired for disabled watchdog');
    });

    await asyncTest('armReadyWatchdog is idempotent (re-arming cancels the old timer)', async () => {
        const r = new Recorder();
        let first = 0;
        let second = 0;
        r.armReadyWatchdog(1, () => { first++; });
        await sleepMs(100);
        r.armReadyWatchdog(1, () => { second++; });
        const deadline = GLib.get_monotonic_time() + 2500000;
        while (second === 0 && GLib.get_monotonic_time() < deadline)
            await sleepMs(100);
        assertEqual(first, 0, 'first timeout NOT fired');
        assertEqual(second, 1, 'second timeout fired');
    });

    await asyncTest('_handleMessage("ready") cancels an armed watchdog', async () => {
        const r = new Recorder();
        let fired = false;
        r.armReadyWatchdog(2, () => { fired = true; });
        // Fire the ready event through the normal handler path.
        r._handleMessage('{"event":"ready"}');
        assertEqual(r._readyWatchdogId, 0, 'watchdog cancelled');
        assertEqual(r._ready, true, 'ready flag set');
        await sleepMs(2500);
        if (fired) throw new Error('onTimeout fired after ready event');
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
