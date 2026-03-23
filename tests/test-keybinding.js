#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: MIT
// Speakeasy — Unit tests for the keybinding state machine
//
// Run with:  gjs -m tests/test-keybinding.js
//
// These tests exercise the pure state-machine logic extracted from
// keybinding.js.  The real KeybindingManager depends on gi://Meta,
// gi://Shell, and GNOME Shell internals that are unavailable outside
// the compositor, so we inline the logic here with real GLib timers.

import GLib from 'gi://GLib';

// ─── State enum (copied from keybinding.js) ──────────────────────────
const State = Object.freeze({
    IDLE: 'idle',
    RECORDING: 'recording',
    LOCKED: 'locked',
    PROCESSING: 'processing',
});

// ─── TestableStateMachine ────────────────────────────────────────────
// Captures the state-transition, timeout, and callback-firing logic of
// KeybindingManager without Mutter/Shell dependencies.  Uses GLib
// timers that work in standalone GJS.

class TestableStateMachine {
    /**
     * @param {object} opts
     * @param {number} [opts.releaseGapMs=700]
     * @param {number} [opts.interTapGapMs=60]
     * @param {number} [opts.repeatDelayMs=400]
     * @param {number} [opts.doubleTapWindowMs=500]
     * @param {number} [opts.holdThreshold=5]
     * @param {function} [opts.onStartRecording]
     * @param {function} [opts.onStopRecording]
     * @param {function} [opts.onStateChanged]
     * @param {function} [opts.onDiscardRecording]
     * @param {function} [opts.onCommitRecording]
     */
    constructor(opts = {}) {
        this._releaseGapMs = opts.releaseGapMs ?? 700;
        this._interTapGapMs = opts.interTapGapMs ?? 60;
        this._repeatDelayMs = opts.repeatDelayMs ?? 400;
        this._doubleTapWindowMs = opts.doubleTapWindowMs ?? 500;
        this._holdThreshold = opts.holdThreshold ?? 5;

        this._onStartRecording = opts.onStartRecording ?? (() => {});
        this._onStopRecording = opts.onStopRecording ?? (() => {});
        this._onStateChanged = opts.onStateChanged ?? (() => {});
        this._onDiscardRecording = opts.onDiscardRecording ?? null;
        this._onCommitRecording = opts.onCommitRecording ?? null;

        this._state = State.IDLE;

        // Gap detection
        this._gapTimeoutId = 0;
        this._keyHeld = false;
        this._repeatCount = 0;
        this._lastEventTime = 0;

        // Double-tap window timeout
        this._doubleTapTimeoutId = 0;

        // Commit guard
        this._commitFired = false;
    }

    getState() {
        return this._state;
    }

    // ── public API matching KeybindingManager ──

    processingDone() {
        if (this._state === State.PROCESSING)
            this._setState(State.IDLE);
    }

    forceState(newState) {
        this._setState(newState);
    }

    onDiscardRecording(callback) {
        this._onDiscardRecording = callback;
    }

    onCommitRecording(callback) {
        this._onCommitRecording = callback;
    }

    // ── internal state-machine methods (mirrored from keybinding.js) ──

    _fireCommit() {
        if (this._commitFired)
            return;
        this._commitFired = true;
        if (this._onCommitRecording)
            this._onCommitRecording();
    }

    _onKeyEvent() {
        const now = GLib.get_monotonic_time() / 1000;
        const sinceLast = now - this._lastEventTime;
        this._lastEventTime = now;

        // Detect re-press via inter-tap gap
        if (this._keyHeld && sinceLast > this._interTapGapMs && sinceLast < this._repeatDelayMs) {
            this._keyHeld = false;
            this._onRelease();
            this._repeatCount = 0;
        }

        const wasHeld = this._keyHeld;
        this._keyHeld = true;
        this._repeatCount++;

        this._resetGapTimeout();

        // Fire commit when hold crosses the threshold
        if (this._repeatCount === this._holdThreshold && this._state === State.RECORDING)
            this._fireCommit();

        // Only act on first event of a key-hold
        if (wasHeld)
            return;

        this._onPress();
    }

    _onPress() {
        const wasWaitingForDoubleTap = this._doubleTapTimeoutId !== 0;
        if (this._doubleTapTimeoutId) {
            GLib.source_remove(this._doubleTapTimeoutId);
            this._doubleTapTimeoutId = 0;
        }

        switch (this._state) {
            case State.IDLE:
                if (wasWaitingForDoubleTap) {
                    this._setState(State.LOCKED);
                    this._fireCommit();
                } else {
                    this._commitFired = false;
                    this._setState(State.RECORDING);
                    this._onStartRecording();
                }
                break;

            case State.RECORDING:
                break;

            case State.LOCKED:
                this._setState(State.PROCESSING);
                this._onStopRecording();
                break;

            case State.PROCESSING:
                break;
        }
    }

    _onRelease() {
        const wasHeld = this._repeatCount >= this._holdThreshold;

        switch (this._state) {
            case State.RECORDING:
                if (wasHeld) {
                    this._setState(State.PROCESSING);
                    this._onStopRecording();
                } else {
                    this._setState(State.IDLE);
                    this._doubleTapTimeoutId = GLib.timeout_add(
                        GLib.PRIORITY_DEFAULT, this._doubleTapWindowMs, () => {
                            this._doubleTapTimeoutId = 0;
                            if (this._onDiscardRecording)
                                this._onDiscardRecording();
                            return GLib.SOURCE_REMOVE;
                        });
                }
                break;

            case State.LOCKED:
                break;

            case State.IDLE:
            case State.PROCESSING:
                break;
        }
    }

    _resetGapTimeout() {
        if (this._gapTimeoutId) {
            GLib.source_remove(this._gapTimeoutId);
            this._gapTimeoutId = 0;
        }
        this._gapTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, this._releaseGapMs, () => {
                this._gapTimeoutId = 0;
                this._keyHeld = false;
                this._onRelease();
                this._repeatCount = 0;
                return GLib.SOURCE_REMOVE;
            });
    }

    _setState(newState) {
        const oldState = this._state;
        this._state = newState;
        if (this._onStateChanged)
            this._onStateChanged(newState);
    }

    _clearTimeouts() {
        if (this._gapTimeoutId) {
            GLib.source_remove(this._gapTimeoutId);
            this._gapTimeoutId = 0;
        }
        if (this._doubleTapTimeoutId) {
            GLib.source_remove(this._doubleTapTimeoutId);
            this._doubleTapTimeoutId = 0;
        }
    }

    destroy() {
        this._clearTimeouts();
    }
}

// ─── Test harness ────────────────────────────────────────────────────

let _testsPassed = 0;
let _testsFailed = 0;
let _testsRun = 0;
const _failures = [];

function assert(condition, message) {
    if (!condition)
        throw new Error(`Assertion failed: ${message}`);
}

function assertEqual(actual, expected, message) {
    if (actual !== expected)
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/**
 * Helper: pump the main loop for a given number of milliseconds.
 * This allows GLib timers to fire.
 */
function pumpMs(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

/**
 * Helper: send N key events spaced ~intervalMs apart.
 * Returns a promise that resolves after all events are sent.
 */
function sendKeyEvents(sm, count, intervalMs) {
    return new Promise(resolve => {
        let sent = 0;
        function tick() {
            if (sent >= count) {
                resolve();
                return GLib.SOURCE_REMOVE;
            }
            sm._onKeyEvent();
            sent++;
            if (sent < count) {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, tick);
            } else {
                resolve();
            }
            return GLib.SOURCE_REMOVE;
        }
        tick();
    });
}

/**
 * Run an async test function, catch any assertion errors, print result.
 */
async function runTest(name, fn) {
    _testsRun++;
    try {
        await fn();
        _testsPassed++;
        print(`  PASS  ${name}`);
    } catch (e) {
        _testsFailed++;
        _failures.push({name, error: e.message});
        print(`  FAIL  ${name}`);
        print(`        ${e.message}`);
    }
}

// ─── Tests ───────────────────────────────────────────────────────────

async function testHoldToTalk() {
    // Use short timings so the test finishes quickly
    const stateLog = [];
    let startCalled = false;
    let stopCalled = false;
    let commitCalled = false;

    const sm = new TestableStateMachine({
        releaseGapMs: 80,
        interTapGapMs: 20,
        repeatDelayMs: 100,
        doubleTapWindowMs: 150,
        holdThreshold: 5,
        onStartRecording: () => { startCalled = true; },
        onStopRecording: () => { stopCalled = true; },
        onStateChanged: (s) => { stateLog.push(s); },
    });
    sm.onCommitRecording(() => { commitCalled = true; });

    assertEqual(sm.getState(), State.IDLE, 'initial state');

    // Send 8 key events (~30ms apart = ~240ms total), simulating a hold
    await sendKeyEvents(sm, 8, 10);

    assertEqual(sm.getState(), State.RECORDING, 'state after hold events');
    assert(startCalled, 'onStartRecording should have been called');
    assert(commitCalled, 'commit should have fired after crossing hold threshold');

    // Wait for gap timeout to fire (release detection)
    await pumpMs(sm._releaseGapMs + 50);

    assertEqual(sm.getState(), State.PROCESSING, 'state after gap timeout');
    assert(stopCalled, 'onStopRecording should have been called');
    assert(stateLog.includes(State.RECORDING), 'should have transitioned through RECORDING');
    assert(stateLog.includes(State.PROCESSING), 'should have transitioned to PROCESSING');

    sm.destroy();
}

async function testDoubleTapToLock() {
    const stateLog = [];
    let startCalled = false;
    let commitCount = 0;

    const sm = new TestableStateMachine({
        releaseGapMs: 60,
        interTapGapMs: 20,
        repeatDelayMs: 100,
        doubleTapWindowMs: 300,
        holdThreshold: 5,
        onStartRecording: () => { startCalled = true; },
        onStopRecording: () => {},
        onStateChanged: (s) => { stateLog.push(s); },
    });
    sm.onCommitRecording(() => { commitCount++; });

    // First tap: 2 events (below hold threshold)
    await sendKeyEvents(sm, 2, 10);
    assertEqual(sm.getState(), State.RECORDING, 'after first tap events');

    // Wait for gap timeout → release with low repeat count → IDLE + double-tap timer
    await pumpMs(sm._releaseGapMs + 50);
    assertEqual(sm.getState(), State.IDLE, 'after first tap release');
    assert(startCalled, 'onStartRecording called on first tap');

    // Second tap (within double-tap window) → LOCKED
    await sendKeyEvents(sm, 2, 10);
    assertEqual(sm.getState(), State.LOCKED, 'after second tap');
    assertEqual(commitCount, 1, 'commit fires once on lock');

    sm.destroy();
}

async function testDoubleTapThenStop() {
    let stopCalled = false;
    const stateLog = [];

    const sm = new TestableStateMachine({
        releaseGapMs: 60,
        interTapGapMs: 20,
        repeatDelayMs: 100,
        doubleTapWindowMs: 300,
        holdThreshold: 5,
        onStartRecording: () => {},
        onStopRecording: () => { stopCalled = true; },
        onStateChanged: (s) => { stateLog.push(s); },
    });

    // First tap
    await sendKeyEvents(sm, 2, 10);
    await pumpMs(sm._releaseGapMs + 50);
    assertEqual(sm.getState(), State.IDLE, 'after first tap release');

    // Second tap → LOCKED
    await sendKeyEvents(sm, 2, 10);
    assertEqual(sm.getState(), State.LOCKED, 'locked after second tap');

    // Wait for gap timeout in LOCKED (release in LOCKED is a no-op, stays LOCKED)
    await pumpMs(sm._releaseGapMs + 50);
    assertEqual(sm.getState(), State.LOCKED, 'stays locked after release');

    // Third tap while LOCKED → PROCESSING + onStopRecording
    await sendKeyEvents(sm, 1, 10);
    assertEqual(sm.getState(), State.PROCESSING, 'processing after third tap');
    assert(stopCalled, 'onStopRecording called');

    sm.destroy();
}

async function testAccidentalSingleTap() {
    let discardCalled = false;
    let stopCalled = false;

    const sm = new TestableStateMachine({
        releaseGapMs: 50,
        interTapGapMs: 20,
        repeatDelayMs: 100,
        doubleTapWindowMs: 100,
        holdThreshold: 5,
        onStartRecording: () => {},
        onStopRecording: () => { stopCalled = true; },
        onStateChanged: () => {},
    });
    sm.onDiscardRecording(() => { discardCalled = true; });

    // Single quick tap (below threshold)
    await sendKeyEvents(sm, 2, 10);
    assertEqual(sm.getState(), State.RECORDING, 'recording after tap');

    // Gap timeout fires → IDLE + double-tap timer starts
    await pumpMs(sm._releaseGapMs + 50);
    assertEqual(sm.getState(), State.IDLE, 'idle after release');

    // Double-tap window expires without second tap → discard
    await pumpMs(sm._doubleTapWindowMs + 50);
    assert(discardCalled, 'onDiscardRecording should be called');
    assert(!stopCalled, 'onStopRecording should NOT be called for accidental tap');

    sm.destroy();
}

async function testInterTapGapDetection() {
    // When events arrive with a gap between interTapGapMs and repeatDelayMs,
    // the state machine should detect a release-and-repress.
    const stateLog = [];
    let startCount = 0;

    const sm = new TestableStateMachine({
        releaseGapMs: 200,
        interTapGapMs: 40,
        repeatDelayMs: 150,
        doubleTapWindowMs: 400,
        holdThreshold: 5,
        onStartRecording: () => { startCount++; },
        onStopRecording: () => {},
        onStateChanged: (s) => { stateLog.push(s); },
    });

    // First tap: 2 events
    await sendKeyEvents(sm, 2, 10);
    assertEqual(sm.getState(), State.RECORDING, 'recording after first tap');

    // Wait a gap that is between interTapGapMs and repeatDelayMs
    // This should trigger inter-tap gap detection on next event
    await pumpMs(80);  // 80ms > 40ms (interTapGap) and < 150ms (repeatDelay)

    // Second tap: the _onKeyEvent will detect the inter-tap gap
    await sendKeyEvents(sm, 2, 10);

    // After inter-tap gap detection:
    // - First, _onRelease fires (repeatCount was 2 < 5 threshold → IDLE + double-tap timer)
    // - Then _onPress fires (double-tap timer active → LOCKED)
    assertEqual(sm.getState(), State.LOCKED, 'locked after inter-tap gap double-tap');

    sm.destroy();
}

async function testProcessingDone() {
    const stateLog = [];

    const sm = new TestableStateMachine({
        releaseGapMs: 50,
        holdThreshold: 5,
        onStartRecording: () => {},
        onStopRecording: () => {},
        onStateChanged: (s) => { stateLog.push(s); },
    });

    // Get into PROCESSING state via hold
    await sendKeyEvents(sm, 8, 10);
    await pumpMs(sm._releaseGapMs + 50);
    assertEqual(sm.getState(), State.PROCESSING, 'in processing');

    // processingDone → IDLE
    sm.processingDone();
    assertEqual(sm.getState(), State.IDLE, 'idle after processingDone');

    // processingDone when not in PROCESSING should be no-op
    sm.forceState(State.RECORDING);
    sm.processingDone();
    assertEqual(sm.getState(), State.RECORDING, 'processingDone is no-op outside PROCESSING');

    sm.destroy();
}

async function testForceState() {
    const stateLog = [];

    const sm = new TestableStateMachine({
        onStateChanged: (s) => { stateLog.push(s); },
        onStartRecording: () => {},
        onStopRecording: () => {},
    });

    sm.forceState(State.RECORDING);
    assertEqual(sm.getState(), State.RECORDING, 'forced to RECORDING');
    assertEqual(stateLog[stateLog.length - 1], State.RECORDING, 'callback fired for RECORDING');

    sm.forceState(State.LOCKED);
    assertEqual(sm.getState(), State.LOCKED, 'forced to LOCKED');
    assertEqual(stateLog[stateLog.length - 1], State.LOCKED, 'callback fired for LOCKED');

    sm.forceState(State.PROCESSING);
    assertEqual(sm.getState(), State.PROCESSING, 'forced to PROCESSING');

    sm.forceState(State.IDLE);
    assertEqual(sm.getState(), State.IDLE, 'forced to IDLE');

    assertEqual(stateLog.length, 4, 'callback fired for each forceState');

    sm.destroy();
}

async function testCommitFiresOnlyOnce() {
    let commitCount = 0;

    const sm = new TestableStateMachine({
        releaseGapMs: 80,
        interTapGapMs: 20,
        repeatDelayMs: 100,
        holdThreshold: 3,
        onStartRecording: () => {},
        onStopRecording: () => {},
        onStateChanged: () => {},
    });
    sm.onCommitRecording(() => { commitCount++; });

    // Send many events, crossing the threshold multiple times over
    await sendKeyEvents(sm, 12, 10);
    assertEqual(commitCount, 1, 'commit fires exactly once during sustained hold');

    // Wait for release
    await pumpMs(sm._releaseGapMs + 50);
    assertEqual(sm.getState(), State.PROCESSING, 'in processing after hold');
    assertEqual(commitCount, 1, 'commit still exactly once after release');

    sm.destroy();
}

async function testCommitResetsOnNewSession() {
    let commitCount = 0;
    let startCount = 0;

    const sm = new TestableStateMachine({
        releaseGapMs: 60,
        interTapGapMs: 20,
        repeatDelayMs: 100,
        holdThreshold: 3,
        doubleTapWindowMs: 100,
        onStartRecording: () => { startCount++; },
        onStopRecording: () => {},
        onStateChanged: () => {},
    });
    sm.onCommitRecording(() => { commitCount++; });

    // First recording session: hold
    await sendKeyEvents(sm, 6, 10);
    await pumpMs(sm._releaseGapMs + 50);
    assertEqual(commitCount, 1, 'first session commit');
    assertEqual(sm.getState(), State.PROCESSING, 'first session processing');

    // Transition back to IDLE
    sm.processingDone();
    assertEqual(sm.getState(), State.IDLE, 'back to idle');

    // Second recording session: hold
    await sendKeyEvents(sm, 6, 10);
    await pumpMs(sm._releaseGapMs + 50);
    assertEqual(commitCount, 2, 'second session gets its own commit');
    assertEqual(startCount, 2, 'onStartRecording called for each session');

    sm.destroy();
}

async function testLockedStateStaysOnRelease() {
    const sm = new TestableStateMachine({
        releaseGapMs: 50,
        interTapGapMs: 20,
        repeatDelayMs: 100,
        doubleTapWindowMs: 300,
        holdThreshold: 5,
        onStartRecording: () => {},
        onStopRecording: () => {},
        onStateChanged: () => {},
    });

    // Get to LOCKED via double-tap
    // First tap
    await sendKeyEvents(sm, 2, 10);
    await pumpMs(sm._releaseGapMs + 40);
    assertEqual(sm.getState(), State.IDLE, 'idle after first tap release');

    // Second tap → LOCKED
    await sendKeyEvents(sm, 2, 10);
    assertEqual(sm.getState(), State.LOCKED, 'locked');

    // Release in LOCKED state (gap timeout fires)
    await pumpMs(sm._releaseGapMs + 50);
    assertEqual(sm.getState(), State.LOCKED, 'still locked after release');

    sm.destroy();
}

async function testInitialStateIsIdle() {
    const sm = new TestableStateMachine();
    assertEqual(sm.getState(), State.IDLE, 'initial state is IDLE');
    sm.destroy();
}

async function testHoldBelowThresholdNoCommit() {
    let commitCount = 0;

    const sm = new TestableStateMachine({
        releaseGapMs: 50,
        holdThreshold: 10,
        doubleTapWindowMs: 100,
        onStartRecording: () => {},
        onStopRecording: () => {},
        onStateChanged: () => {},
    });
    sm.onCommitRecording(() => { commitCount++; });

    // Send fewer events than hold threshold
    await sendKeyEvents(sm, 4, 10);
    assertEqual(commitCount, 0, 'no commit below threshold');

    // Wait for gap timeout → IDLE (quick tap path)
    await pumpMs(sm._releaseGapMs + 50);
    assertEqual(sm.getState(), State.IDLE, 'idle after sub-threshold tap');
    assertEqual(commitCount, 0, 'still no commit after release');

    sm.destroy();
}

async function testProcessingIgnoresPress() {
    let startCount = 0;
    let stopCount = 0;

    const sm = new TestableStateMachine({
        releaseGapMs: 50,
        holdThreshold: 3,
        onStartRecording: () => { startCount++; },
        onStopRecording: () => { stopCount++; },
        onStateChanged: () => {},
    });

    // Get to PROCESSING
    await sendKeyEvents(sm, 6, 10);
    await pumpMs(sm._releaseGapMs + 50);
    assertEqual(sm.getState(), State.PROCESSING, 'in processing');
    assertEqual(startCount, 1, 'one start');
    assertEqual(stopCount, 1, 'one stop');

    // Press while PROCESSING should be ignored
    sm._clearTimeouts();
    sm._keyHeld = false;
    sm._repeatCount = 0;
    sm._lastEventTime = 0;
    sm._onPress();
    assertEqual(sm.getState(), State.PROCESSING, 'still processing');
    assertEqual(startCount, 1, 'start not called again');
    assertEqual(stopCount, 1, 'stop not called again');

    sm.destroy();
}

// ─── Main test runner ────────────────────────────────────────────────

const loop = GLib.MainLoop.new(null, false);

async function main() {
    print('');
    print('Speakeasy keybinding state-machine tests');
    print('─────────────────────────────────────────');

    await runTest('initial state is IDLE', testInitialStateIsIdle);
    await runTest('hold-to-talk', testHoldToTalk);
    await runTest('double-tap-to-lock', testDoubleTapToLock);
    await runTest('double-tap then stop', testDoubleTapThenStop);
    await runTest('accidental single tap → discard', testAccidentalSingleTap);
    await runTest('inter-tap gap detection', testInterTapGapDetection);
    await runTest('processingDone()', testProcessingDone);
    await runTest('forceState()', testForceState);
    await runTest('commit fires only once per session', testCommitFiresOnlyOnce);
    await runTest('commit resets on new recording session', testCommitResetsOnNewSession);
    await runTest('LOCKED stays on release', testLockedStateStaysOnRelease);
    await runTest('hold below threshold → no commit', testHoldBelowThresholdNoCommit);
    await runTest('PROCESSING ignores press', testProcessingIgnoresPress);

    print('─────────────────────────────────────────');
    print(`  ${_testsRun} tests: ${_testsPassed} passed, ${_testsFailed} failed`);

    if (_failures.length > 0) {
        print('');
        print('Failures:');
        for (const f of _failures)
            print(`  - ${f.name}: ${f.error}`);
    }

    print('');
    loop.quit();
}

// Kick off the async test suite from within the main loop so that
// GLib timers can fire.
GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
    main().catch(e => {
        printerr(`Fatal error: ${e.message}\n${e.stack}`);
        _testsFailed++;
        loop.quit();
    });
    return GLib.SOURCE_REMOVE;
});

loop.run();

// Exit with appropriate code
if (_testsFailed > 0)
    imports.system.exit(1);
