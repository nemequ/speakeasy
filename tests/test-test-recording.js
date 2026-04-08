#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: MIT
// Unit tests for testRecording.js (the "Test Recording" helper used
// by the GTK debug app to run an automated short recording through
// the whole dictation pipeline).
//
// Run: gjs -m tests/test-test-recording.js

import {runTestRecording} from '../testRecording.js';

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

// ─── Fake controller ────────────────────────────────────────────────
//
// Mimics the tiny slice of DictationController that runTestRecording
// depends on: getState(), start(), commit(), stop(). Records the
// sequence of calls so tests can assert on ordering.

const ControllerState = {
    IDLE: 'idle',
    RECORDING: 'recording',
    PROCESSING: 'processing',
};

class FakeController {
    constructor({state = ControllerState.IDLE, startOk = true} = {}) {
        this._state = state;
        this._startOk = startOk;
        this.calls = [];
        this.stopResult = {filePath: '/tmp/fake-transcript.json'};
    }
    getState() { return this._state; }
    start() {
        this.calls.push('start');
        if (this._startOk)
            this._state = ControllerState.RECORDING;
        return this._startOk;
    }
    commit() {
        this.calls.push('commit');
    }
    async stop() {
        this.calls.push('stop');
        this._state = ControllerState.IDLE;
        return this.stopResult;
    }
}

// A fake scheduler: runTestRecording() should call scheduler(cb, ms)
// instead of GLib.timeout_add_seconds so the test can trigger the
// stop synchronously. The scheduler records its invocations.
function makeFakeScheduler() {
    const scheduler = (cb, secs) => {
        scheduler.lastCb = cb;
        scheduler.lastSecs = secs;
        scheduler.calls++;
    };
    scheduler.calls = 0;
    scheduler.lastCb = null;
    scheduler.lastSecs = null;
    return scheduler;
}

// ─── Tests ──────────────────────────────────────────────────────────

print('\ntestRecording.runTestRecording');
print('────────────────────────────────────────────────────────────');

await test('happy path: start, commit, schedule, then stop', async () => {
    const ctrl = new FakeController();
    const sched = makeFakeScheduler();
    const result = await runTestRecording(ctrl, 3, {scheduler: sched});

    assertEqual(result.started, true, 'started flag');
    assertEqual(sched.calls, 1, 'scheduler called once');
    assertEqual(sched.lastSecs, 3, 'scheduler got duration');
    assertEqual(ctrl.calls[0], 'start', 'start first');
    assertEqual(ctrl.calls[1], 'commit', 'commit second');
    // stop not called yet — scheduled
    assert(!ctrl.calls.includes('stop'), 'stop not called before timer fires');

    // Fire the timer
    await sched.lastCb();
    assert(ctrl.calls.includes('stop'), 'stop called after timer fires');
});

await test('bails if controller is not idle', async () => {
    const ctrl = new FakeController({state: ControllerState.RECORDING});
    const sched = makeFakeScheduler();
    const result = await runTestRecording(ctrl, 3, {scheduler: sched});

    assertEqual(result.started, false, 'not started');
    assert(result.reason && result.reason.length > 0, 'has reason');
    assertEqual(ctrl.calls.length, 0, 'controller untouched');
    assertEqual(sched.calls, 0, 'scheduler not called');
});

await test('bails if start() returns false without scheduling stop', async () => {
    const ctrl = new FakeController({startOk: false});
    const sched = makeFakeScheduler();
    const result = await runTestRecording(ctrl, 3, {scheduler: sched});

    assertEqual(result.started, false, 'not started');
    assertEqual(ctrl.calls[0], 'start', 'start was attempted');
    assert(!ctrl.calls.includes('commit'), 'commit not called');
    assert(!ctrl.calls.includes('stop'), 'stop not called');
    assertEqual(sched.calls, 0, 'scheduler not called');
});

await test('uses default duration of 3 seconds when not specified', async () => {
    const ctrl = new FakeController();
    const sched = makeFakeScheduler();
    await runTestRecording(ctrl, undefined, {scheduler: sched});
    assertEqual(sched.lastSecs, 3, 'default duration is 3');
});

await test('rejects non-positive durations', async () => {
    const ctrl = new FakeController();
    const sched = makeFakeScheduler();
    const result = await runTestRecording(ctrl, 0, {scheduler: sched});
    assertEqual(result.started, false, 'not started with zero duration');
    assertEqual(ctrl.calls.length, 0, 'controller untouched');
});

// ─── Summary ────────────────────────────────────────────────────────

print('\n════════════════════════════════════════════════════════════');
print(`Results: ${_passed} passed, ${_failed} failed, ${_passed + _failed} total`);

if (_failed > 0) {
    print('\nFailures:');
    for (const {name, error} of _errors)
        print(`  ${name}: ${error}`);
    imports.system.exit(1);
}
