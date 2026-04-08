// SPDX-License-Identifier: MIT
// Speakeasy — Test Recording helper
//
// A tiny helper that runs an automated short recording through the
// whole dictation pipeline (mic -> STT -> AI cleanup -> output).
// Used by the GTK debug app's "Test Recording" button so a new user
// can verify the pipeline works end-to-end without committing to a
// real dictation session.
//
// The helper is intentionally UI-agnostic: it only talks to the
// DictationController (start/commit/stop) and to a scheduler. The
// caller is responsible for updating button labels, disabling
// unrelated buttons, and displaying the result — all of that flows
// through the controller's existing onTranscript / onError callbacks
// that the GTK app already wires up.
//
// The default scheduler is GLib.timeout_add_seconds, but tests inject
// a synchronous fake so the timer can be fired immediately.

import GLib from 'gi://GLib';

/**
 * Default scheduler: arm a GLib timeout that fires `cb` after
 * `secs` seconds. `cb` may return a Promise; we intentionally don't
 * await it (GLib timeouts are fire-and-forget).
 */
function defaultScheduler(cb, secs) {
    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secs, () => {
        try {
            const ret = cb();
            if (ret && typeof ret.catch === 'function')
                ret.catch(() => { /* swallowed — caller's onError handles it */ });
        } catch (_e) { /* swallowed */ }
        return GLib.SOURCE_REMOVE;
    });
}

/**
 * Run a short automated recording for `durationSecs` seconds.
 *
 * Flow:
 *   1. Verify the controller is IDLE. Bail if not.
 *   2. Call controller.start(). If it returns false, bail without
 *      scheduling a stop.
 *   3. Call controller.commit() — this is an intentional test, so
 *      we commit immediately (no hold-to-talk gating).
 *   4. Schedule controller.stop() to fire after `durationSecs`.
 *
 * @param {object} controller - DictationController instance
 * @param {number} [durationSecs=3] - recording length in seconds
 * @param {object} [opts]
 * @param {function(function,number):void} [opts.scheduler] - injection
 *   point for tests. Signature: (cb, secs) => void.
 * @returns {Promise<{started: boolean, reason?: string}>}
 */
export async function runTestRecording(controller, durationSecs, opts = {}) {
    const secs = durationSecs ?? 3;
    const scheduler = opts.scheduler ?? defaultScheduler;

    if (typeof secs !== 'number' || secs <= 0) {
        return {started: false, reason: `invalid duration: ${secs}`};
    }

    const state = controller.getState();
    if (state !== 'idle') {
        return {
            started: false,
            reason: `controller not idle (state: ${state})`,
        };
    }

    const ok = controller.start();
    if (!ok) {
        return {started: false, reason: 'controller.start() returned false'};
    }

    controller.commit();

    scheduler(() => controller.stop(), secs);

    return {started: true};
}
