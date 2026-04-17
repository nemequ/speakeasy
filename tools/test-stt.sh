#!/bin/bash
# Phase 2 test: run STT on the saved WAV from Phase 1.
#
# Proves the WAV -> whisper-rs path works end-to-end with no mic
# involvement. If Phase 1's recording is intelligible and this prints
# a sensible transcription, the speakeasy Rust STT is healthy.
#
# Usage:
#   ./tools/test-stt.sh [path/to/file.wav]
#
# Defaults to .tmp/test-recording.wav (produced by test-audio-recording.sh).

set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORE="${ROOT}/core/target/release/speakeasy"
WAV="${1:-${ROOT}/.tmp/test-recording.wav}"

# Locate a Whisper model. Prefer ggml-*.bin (whisper-rs requires this
# format; GGUF v3 is rejected with "bad magic"). Match recorder.js's
# detection: look in ~/.cache/whisper.
MODEL=""
if [ -n "${WHISPER_MODEL:-}" ]; then
    MODEL="${WHISPER_MODEL}"
else
    for candidate in "${HOME}/.cache/whisper"/ggml-*.bin; do
        if [ -f "${candidate}" ]; then
            MODEL="${candidate}"
            break
        fi
    done
fi

if [ ! -x "${CORE}" ]; then
    echo "Error: speakeasy not built. Run: cd core && cargo build --release" >&2
    exit 1
fi
if [ ! -f "${WAV}" ]; then
    echo "Error: WAV not found: ${WAV}" >&2
    echo "Run ./tools/test-audio-recording.sh first." >&2
    exit 1
fi
if [ -z "${MODEL}" ] || [ ! -f "${MODEL}" ]; then
    echo "Error: no Whisper model found in ~/.cache/whisper." >&2
    echo "Drop a ggml-*.bin there, or set WHISPER_MODEL=/path/to/ggml-*.bin." >&2
    exit 1
fi

echo "=== Speakeasy STT test ==="
echo "Binary: ${CORE}"
echo "WAV:    ${WAV} ($(stat -c '%s' "${WAV}") bytes)"
echo "Model:  ${MODEL}"
echo

# --file mode is one-shot: load model, transcribe, print, exit.
# Output format (stdout):
#   Transcription: <text>
# stderr has load/transcribe timings.
"${CORE}" \
    --backend whisper-rs \
    --model-path "${MODEL}" \
    --file "${WAV}" \
    --ai-backend none \
    2>"${ROOT}/.tmp/core-stt-stderr.log"

echo
echo "--- timings (stderr) ---"
cat "${ROOT}/.tmp/core-stt-stderr.log"
