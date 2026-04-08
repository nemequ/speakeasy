// SPDX-License-Identifier: MIT
// Speakeasy — AI error classifier
//
// When ai.finalize() throws, the controller's catch block needs to
// tell the user *why* the AI cleanup failed so they can react
// appropriately (wait and retry, check their network, etc.) instead
// of getting a generic "cleanup error" message.
//
// Soup surfaces network failures as Gio.IOError subtypes. This
// helper maps those (and the HTTP-status errors that ai.js throws
// after retries exhausted) into one of four categories the UI can
// render a sensible message for.

import Gio from 'gi://Gio';

/**
 * Categories returned by classifyAiError().
 *
 *   'timeout' — the request exceeded the configured ai-request-timeout-secs
 *               or otherwise hit a Gio.IOErrorEnum.TIMED_OUT.
 *   'network' — the request couldn't reach the server (DNS, proxy,
 *               connection refused, host unreachable, TLS failure, etc.).
 *   'http'    — the request reached the server but the server returned
 *               an HTTP 4xx/5xx after all retries were exhausted. ai.js
 *               wraps these as `new Error('HTTP <status>')`.
 *   'unknown' — anything else. The caller should fall back to the
 *               generic error message.
 */
export const AiErrorCategory = Object.freeze({
    TIMEOUT: 'timeout',
    NETWORK: 'network',
    HTTP: 'http',
    UNKNOWN: 'unknown',
});

// Gio.IOError codes we treat as "network unreachable" rather than
// a true timeout. Listed explicitly (rather than "everything that
// isn't TIMED_OUT") so unknown/new error codes fall through to
// 'unknown' where the user sees the raw message.
const NETWORK_CODES = [
    Gio.IOErrorEnum.NETWORK_UNREACHABLE,
    Gio.IOErrorEnum.HOST_UNREACHABLE,
    Gio.IOErrorEnum.HOST_NOT_FOUND,
    Gio.IOErrorEnum.CONNECTION_REFUSED,
    Gio.IOErrorEnum.CONNECTION_CLOSED,
    Gio.IOErrorEnum.PROXY_FAILED,
    Gio.IOErrorEnum.PROXY_AUTH_FAILED,
    Gio.IOErrorEnum.PROXY_NEED_AUTH,
    Gio.IOErrorEnum.PROXY_NOT_ALLOWED,
    Gio.IOErrorEnum.TLS_CERTIFICATE_UNAVAILABLE,
    // Note: BROKEN_PIPE / PARTIAL_INPUT also map to network here —
    // the server hung up mid-response.
    Gio.IOErrorEnum.BROKEN_PIPE,
    Gio.IOErrorEnum.PARTIAL_INPUT,
].filter(c => c !== undefined);

/**
 * Classify an error thrown from ai.finalize() into one of the
 * AiErrorCategory values. Accepts:
 *   - a GLib.Error with a .matches(domain, code) method (the real
 *     case when Soup fails);
 *   - a plain Error whose .message starts with "HTTP " (the case
 *     when ai.js exhausted retries on a non-2xx response);
 *   - anything else → 'unknown'.
 *
 * @param {Error|GLib.Error|null|undefined} err
 * @returns {'timeout'|'network'|'http'|'unknown'}
 */
export function classifyAiError(err) {
    if (!err)
        return AiErrorCategory.UNKNOWN;

    // Gio/GLib errors expose a .matches(domain, code) method. Soup
    // raises these for socket/DNS/TLS/timeout failures.
    if (typeof err.matches === 'function') {
        try {
            if (err.matches(Gio.io_error_quark(), Gio.IOErrorEnum.TIMED_OUT))
                return AiErrorCategory.TIMEOUT;
            for (const code of NETWORK_CODES) {
                if (err.matches(Gio.io_error_quark(), code))
                    return AiErrorCategory.NETWORK;
            }
        } catch (_e) {
            // Fall through to message-based classification.
        }
    }

    // HTTP-status errors thrown by ai.js after retries.
    const msg = typeof err.message === 'string' ? err.message : '';
    if (/^HTTP\s+\d{3}/.test(msg))
        return AiErrorCategory.HTTP;

    // Fallback: look for "timed out" / "timeout" text in the message
    // (handles Error instances whose underlying cause was a Gio
    // TIMED_OUT but got rewrapped somewhere).
    if (/timed out|timeout/i.test(msg))
        return AiErrorCategory.TIMEOUT;

    return AiErrorCategory.UNKNOWN;
}

/**
 * Turn a classified category into a short user-facing message. The
 * controller uses this so both the Shell extension and gtk-app see
 * the same wording.
 *
 * @param {string} category - one of AiErrorCategory
 * @param {Error} [err] - optional original error (used for the
 *   fallback message in the 'unknown' case)
 * @returns {string}
 */
export function aiErrorUserMessage(category, err) {
    switch (category) {
        case AiErrorCategory.TIMEOUT:
            return 'AI request timed out — used raw text. Re-run cleanup later from history.';
        case AiErrorCategory.NETWORK:
            return 'AI cleanup unreachable — used raw text. Check your network/proxy.';
        case AiErrorCategory.HTTP:
            return 'AI cleanup failed (HTTP error) — used raw text.';
        default: {
            const detail = err?.message ? `: ${err.message}` : '';
            return `AI cleanup error — used raw text${detail}`;
        }
    }
}
