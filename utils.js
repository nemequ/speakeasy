// SPDX-License-Identifier: MIT
// Speakeasy — Shared utilities

import GLib from 'gi://GLib';

/**
 * Async sleep helper. Returns a promise that resolves after the
 * specified number of milliseconds via GLib's main loop.
 *
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
export function sleep(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}
