// SPDX-License-Identifier: MIT
// Speakeasy — Recovery AI cleanup with feedback callbacks
//
// Thin wrapper around transcriptStore.rerunAiCleanup that surfaces
// start/done/error events via callbacks so both UIs (Shell
// notifications + GTK text-view) can show progress while the
// background cleanup pass runs.
//
// Extracted into its own module so it can be unit-tested without a
// running gnome-shell or Gtk.Application — the helper is pure orchestration.

import {rerunAiCleanup} from './transcriptStore.js';

/**
 * Run an AI cleanup pass on a just-recovered transcript and invoke
 * user-provided callbacks before/after so the UI can show progress.
 *
 * The helper is callback-based rather than returning a promise so
 * callers that want fire-and-forget semantics (GNOME Shell notification
 * flow) don't have to build their own async wrapper.
 *
 * @param {object} entry - in-memory transcript entry, mutated on success
 *   (cleanedText, aiEnabled updated). Must have rawText + filePath.
 * @param {object} ai - AI cleanup instance (beginSession/feedText/finalize).
 * @param {object} [callbacks]
 * @param {function} [callbacks.onStart] - Fired synchronously before
 *   the AI call begins. Use to show "cleaning up..." UI state.
 * @param {function(object)} [callbacks.onDone] - Fired with the mutated
 *   entry after a successful cleanup that rewrote the JSON.
 * @param {function(Error|null)} [callbacks.onError] - Fired if the AI
 *   call throws, returns empty text, or the JSON rewrite fails. The
 *   argument is the raw error (may be null if rerunAiCleanup simply
 *   returned false without throwing).
 * @returns {Promise<boolean>} true if cleanup succeeded, false otherwise.
 */
export async function runRecoveryCleanupWithFeedback(entry, ai, callbacks = {}) {
    const {onStart, onDone, onError} = callbacks;

    if (!entry || !ai) {
        if (onError) {
            try { onError(new Error('missing entry or ai')); } catch (_e) { /* ignore */ }
        }
        return false;
    }

    if (onStart) {
        try { onStart(); } catch (_e) { /* ignore */ }
    }

    let ok = false;
    let caught = null;
    try {
        ok = await rerunAiCleanup(entry, ai);
    } catch (e) {
        caught = e;
        ok = false;
    }

    if (ok) {
        if (onDone) {
            try { onDone(entry); } catch (_e) { /* ignore */ }
        }
        return true;
    }

    if (onError) {
        try { onError(caught); } catch (_e) { /* ignore */ }
    }
    return false;
}
