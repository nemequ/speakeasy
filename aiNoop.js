// SPDX-License-Identifier: MIT
// Speakeasy — No-op AI cleanup interface.
//
// With cloud AI backends removed, the Rust speakeasy core performs all
// cleanup in-process and streams the result back as a post-`stopped`
// `final` event (wired via recorder.onAiCleanedText). The controller
// still expects an AI-shaped object to call beginSession/feedText/
// finalize on, so this module provides a passthrough stub whose
// `isAvailable()` returns false. The controller sees "AI unavailable"
// and outputs the raw STT text, which is fine because the recorder's
// onAiCleanedText handler has already delivered the cleaned text to
// the real output sink.
//
// If recovery-cleanup-via-Rust is plumbed later, this file is where
// the Rust-core-backed implementation can slot in.

export function makeNoopAi() {
    return {
        setExtensionDir() {},
        setSettings() {},
        init() { return true; },
        destroy() {},
        isAvailable() { return false; },
        needsCleanup() { return false; },
        beginSession() {},
        cancelSession() {},
        feedText() {},
        feedContext() {},
        async finalize() { return null; },
    };
}
