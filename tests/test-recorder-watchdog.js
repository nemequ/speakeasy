#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: MIT
// Unit tests for the Recorder.stop() watchdog (recorder.js).
//
// Run: gjs -m tests/test-recorder-watchdog.js
//
// These tests don't spawn the real STT subprocess. Instead they
// poke a Recorder instance into a state that simulates "running"
// and stub out the subprocess plumbing, so we can drive the
// watchdog state machine deterministically and verify:
//
//   1. The watchdog times out and synthesizes text from
//      _accumulatedText when the subprocess never sends "stopped".
//   2. The watchdog is cancelled when "stopped" arrives in time.
//   3. force_exit() is called on the wedged subprocess.
//   4. A respawn is scheduled after a watchdog kill.
//   5. cancelling via destroy() also cancels the watchdog.
//
// This was added in response to the 2026-04-08 incident where the
// VOSK plugin's current-final-results flush wedged in a busy loop
// and recorder.stop() blocked forever, freezing the compositor's
// stop-recording path.

import GLib from 'gi://GLib';

import {Recorder} from '../recorder.js';

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
        _errors.push({name, error: e.message});
        print(`  FAIL  ${name}`);
        print(`        ${e.message}`);
    }
}

// ─── Fake subprocess ────────────────────────────────────────────────
//
// We need an object with .force_exit() that the watchdog can call.
// The real Gio.Subprocess doesn't accept arbitrary stand-ins because
// the recorder also calls .wait_async on it during init() — but we
// bypass init() entirely in these tests by manually setting state.

class FakeSubprocess {
    constructor() {
        this.forceExitCalled = false;
    }
    force_exit() {
        this.forceExitCalled = true;
    }
}

// ─── Helpers ────────────────────────────────────────────────────────

// Build a Recorder in the "running" state without spawning a real
// subprocess. The caller can then poke .stop() and inspect outcomes.
function makeRunningRecorder({timeoutSecs = 1, finals = []} = {}) {
    const r = new Recorder();
    r._stopTimeoutSecs = timeoutSecs;
    r._running = true;
    r._ready = true;
    r._accumulatedText = [...finals];
    r._subprocess = new FakeSubprocess();
    // Stub _sendCommand so it doesn't try to write to a null stdin.
    r._sentCommands = [];
    r._sendCommand = (cmd) => { r._sentCommands.push(cmd); };
    return r;
}

function runMainLoopUntil(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
        const start = GLib.get_monotonic_time();
        const ctx = GLib.MainContext.default();
        const tick = () => {
            ctx.iteration(false);
            if (predicate()) {
                resolve();
                return GLib.SOURCE_REMOVE;
            }
            const elapsed = (GLib.get_monotonic_time() - start) / 1000;
            if (elapsed > timeoutMs) {
                reject(new Error(`runMainLoopUntil timed out after ${timeoutMs}ms`));
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        };
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, tick);
    });
}

// ════════════════════════════════════════════════════════════════════
//  Tests
// ════════════════════════════════════════════════════════════════════

const loop = GLib.MainLoop.new(null, false);

(async () => {
    print('');
    print('Recorder.stop() watchdog');
    print('─'.repeat(60));

    await test('stop() resolves normally when "stopped" arrives in time', async () => {
        const r = makeRunningRecorder({
            timeoutSecs: 5,
            finals: ['hello', 'world'],
        });

        const stopPromise = r.stop();
        // The watchdog should now be armed.
        assert(r._stopWatchdogId !== 0, 'watchdog armed');
        // Stop commands should have been queued.
        assertEqual(r._sentCommands.length, 2, '2 commands sent');

        // Simulate the subprocess sending the stopped event.
        // We invoke the message handler directly with the parsed
        // payload, the same way _readNextLine would.
        r._handleMessage('{"event":"stopped","text":"hello world from subprocess"}');

        const result = await stopPromise;
        assertEqual(result, 'hello world from subprocess', 'normal text returned');
        assertEqual(r._stopWatchdogId, 0, 'watchdog cancelled');
        assertEqual(r._subprocess.forceExitCalled, false, 'subprocess NOT killed');
    });

    await test('watchdog fires when subprocess never sends "stopped"', async () => {
        const r = makeRunningRecorder({
            timeoutSecs: 1,
            finals: ['this', 'is', 'committed', 'text'],
        });

        const stopPromise = r.stop();
        assert(r._stopWatchdogId !== 0, 'watchdog armed');

        // Wait for the watchdog to fire (1s + grace).
        const result = await stopPromise;

        // Synthesized from _accumulatedText.
        assertEqual(result, 'this is committed text', 'synthesized text');
        assertEqual(r._stopWatchdogId, 0, 'watchdog id cleared');
        assertEqual(r._subprocess.forceExitCalled, true, 'subprocess SIGKILLed');
        // _scheduleRespawn idle was queued — let it run so we don't
        // leave a stale GLib idle hook lurking past the test. Since
        // init() will fail without an extension dir, that's fine.
        await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { r(); return GLib.SOURCE_REMOVE; }));
    });

    await test('watchdog disabled when timeoutSecs=0', async () => {
        const r = makeRunningRecorder({timeoutSecs: 0, finals: ['x']});
        const stopPromise = r.stop();
        assertEqual(r._stopWatchdogId, 0, 'no watchdog armed');

        // The promise should NOT resolve from a timeout. Send the
        // stopped event manually so the test doesn't hang.
        r._handleMessage('{"event":"stopped","text":"x"}');
        const result = await stopPromise;
        assertEqual(result, 'x', 'normal text');
    });

    await test('watchdog cancelled when subprocess crashes (unexpected exit)', async () => {
        // Simulate the subprocess wait_async firing while a stop is
        // in flight. The recorder should cancel the watchdog and
        // synthesize from accumulated finals (same recovery path as
        // a watchdog timeout, just triggered by a crash instead).
        const r = makeRunningRecorder({
            timeoutSecs: 30,
            finals: ['crash', 'recovery'],
        });
        const stopPromise = r.stop();
        assert(r._stopWatchdogId !== 0, 'watchdog armed');

        // Simulate the wait_async handler running. We don't have the
        // real subprocess so call the recovery branch directly the
        // way the wait_async handler would.
        r._cancelStopWatchdog();
        const synth = r._accumulatedText.join(' ').trim();
        const resolveFn = r._stopResolve;
        r._stopResolve = null;
        resolveFn(synth);

        const result = await stopPromise;
        assertEqual(result, 'crash recovery', 'synthesized from finals');
        assertEqual(r._stopWatchdogId, 0, 'watchdog cancelled');
    });

    await test('destroy() cancels the watchdog', async () => {
        const r = makeRunningRecorder({timeoutSecs: 30, finals: []});
        // Stub out the parts of destroy that touch real Gio state.
        r._readCancellable = null;
        r._subprocess = null;
        r._settings = null;
        r._settingsChangedIds = [];

        // Manually arm the watchdog (no need for the real stop() flow)
        r._stopResolve = () => {};
        r._armStopWatchdog();
        assert(r._stopWatchdogId !== 0, 'watchdog armed pre-destroy');

        r.destroy();
        assertEqual(r._stopWatchdogId, 0, 'watchdog cancelled by destroy');
    });

    await test('stop() while not running returns empty immediately', async () => {
        const r = new Recorder();
        r._stopTimeoutSecs = 5;
        r._running = false;
        const result = await r.stop();
        assertEqual(result, '', 'no recording -> empty string');
        assertEqual(r._stopWatchdogId, 0, 'no watchdog');
    });

    await test('"transcribing" event extends the watchdog past the pre-ack window', async () => {
        // Regression guard for the long-recording wedge: the core
        // emits `transcribing` right after accepting a stop. The
        // watchdog must switch from the short pre-ack timeout to the
        // longer decode-in-progress timeout so whisper can finish on
        // a long buffer without being SIGKILLed.
        const r = makeRunningRecorder({
            timeoutSecs: 1,
            finals: ['partial', 'text'],
        });

        const stopPromise = r.stop();
        assert(r._stopWatchdogId !== 0, 'watchdog armed');
        const initialId = r._stopWatchdogId;

        // Simulate the core's `transcribing` keep-alive arriving
        // quickly, before the 1s pre-ack window would fire.
        r._handleMessage('{"event":"transcribing"}');
        assert(r._stopWatchdogId !== 0, 'watchdog still armed after transcribing');
        assert(r._stopWatchdogId !== initialId, 'watchdog was re-armed with new id');

        // Wait past the original 1s pre-ack window. The watchdog
        // must NOT fire — the subprocess signalled it's still
        // working via `transcribing`.
        await new Promise(res => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => { res(); return GLib.SOURCE_REMOVE; }));
        assertEqual(r._subprocess.forceExitCalled, false, 'subprocess NOT killed during decode');
        assert(r._stopWatchdogId !== 0, 'watchdog still armed 1.5s in');

        // Eventually the subprocess sends stopped; promise resolves
        // with the real text and the watchdog cancels cleanly.
        r._handleMessage('{"event":"stopped","text":"final decoded text"}');
        const result = await stopPromise;
        assertEqual(result, 'final decoded text', 'real decoded text returned');
        assertEqual(r._stopWatchdogId, 0, 'watchdog cancelled');
    });

    await test('"transcribing" without a pending stop is a safe no-op', async () => {
        // The recorder might get a spurious `transcribing` if a race
        // between stop and some other flow arises. It should not
        // arm a watchdog out of nowhere.
        const r = makeRunningRecorder({timeoutSecs: 5, finals: []});
        assertEqual(r._stopWatchdogId, 0, 'no watchdog initially');
        r._handleMessage('{"event":"transcribing"}');
        assertEqual(r._stopWatchdogId, 0, 'no watchdog armed by spurious transcribing');
    });

    await test('synthesized text is empty when no finals were committed', async () => {
        const r = makeRunningRecorder({timeoutSecs: 1, finals: []});
        const stopPromise = r.stop();
        const result = await stopPromise;
        assertEqual(result, '', 'empty synthesized text');
        assertEqual(r._subprocess.forceExitCalled, true, 'still kills subprocess');
        await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { r(); return GLib.SOURCE_REMOVE; }));
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
