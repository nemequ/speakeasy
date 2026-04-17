#!/bin/bash
# Phase 3 test: end-to-end WAV -> STT -> AI cleanup.
#
# Runs speakeasy with --file (one-shot) and an AI backend. The
# binary prints:
#   Transcription: <raw STT output>
#   AI Cleaned: <cleaned output>
#
# Backends:
#   llama      (default) — local GGUF via candle (pure Rust), fully offline.
#   openrouter            — cloud; needs OPENROUTER_API_KEY env var.
#
# Usage:
#   ./tools/test-ai-cleanup.sh                 # local llama
#   ./tools/test-ai-cleanup.sh openrouter      # needs OPENROUTER_API_KEY
#   ./tools/test-ai-cleanup.sh llama path/to/sample.wav
#
# Reads the WAV from .tmp/test-recording.wav by default (produced by
# test-audio-recording.sh).

set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORE="${ROOT}/core/target/release/speakeasy"
BACKEND="${1:-llama}"
WAV="${2:-${ROOT}/.tmp/test-recording.wav}"

# Whisper model
WHISPER_MODEL=""
if [ -n "${WHISPER_MODEL_PATH:-}" ]; then
    WHISPER_MODEL="${WHISPER_MODEL_PATH}"
else
    for candidate in "${HOME}/.cache/whisper"/ggml-*.bin; do
        if [ -f "${candidate}" ]; then
            WHISPER_MODEL="${candidate}"
            break
        fi
    done
fi

if [ ! -x "${CORE}" ]; then
    echo "Error: speakeasy not built." >&2
    exit 1
fi
if [ ! -f "${WAV}" ]; then
    echo "Error: WAV not found: ${WAV}" >&2
    exit 1
fi
if [ -z "${WHISPER_MODEL}" ]; then
    echo "Error: no Whisper model in ~/.cache/whisper." >&2
    exit 1
fi

# Build per-backend argv
case "${BACKEND}" in
    llama)
        # Local GGUF model
        LLAMA_MODEL=""
        if [ -n "${LLAMA_MODEL_PATH:-}" ]; then
            LLAMA_MODEL="${LLAMA_MODEL_PATH}"
        else
            for candidate in \
                "${HOME}/.cache/speakeasy"/qwen*-instruct-*.gguf \
                "${HOME}/.cache/speakeasy"/*.gguf; do
                if [ -f "${candidate}" ]; then
                    LLAMA_MODEL="${candidate}"
                    break
                fi
            done
        fi
        if [ -z "${LLAMA_MODEL}" ]; then
            echo "Error: no GGUF chat model in ~/.cache/speakeasy." >&2
            echo "Download qwen2.5-0.5b-instruct-q4_k_m.gguf or similar." >&2
            exit 1
        fi
        AI_ARGS=(--ai-backend llama --ai-model "${LLAMA_MODEL}")
        echo "AI:     llama (local) -- ${LLAMA_MODEL}"
        ;;
    openrouter)
        if [ -z "${OPENROUTER_API_KEY:-}" ]; then
            echo "Error: set OPENROUTER_API_KEY env var." >&2
            exit 1
        fi
        MODEL="${OPENROUTER_MODEL:-anthropic/claude-haiku-4-5-20251001}"
        AI_ARGS=(--ai-backend openrouter --ai-api-key "${OPENROUTER_API_KEY}" --ai-model "${MODEL}")
        echo "AI:     openrouter -- ${MODEL}"
        ;;
    none)
        AI_ARGS=(--ai-backend none)
        echo "AI:     none (STT only)"
        ;;
    *)
        echo "Error: unknown backend '${BACKEND}'. Try: llama, openrouter, none." >&2
        exit 1
        ;;
esac

echo "=== Speakeasy AI cleanup test ==="
echo "Binary: ${CORE}"
echo "WAV:    ${WAV} ($(stat -c '%s' "${WAV}") bytes)"
echo "STT:    ${WHISPER_MODEL}"
echo

"${CORE}" \
    --backend whisper-rs \
    --model-path "${WHISPER_MODEL}" \
    --file "${WAV}" \
    "${AI_ARGS[@]}" \
    2>"${ROOT}/.tmp/core-ai-stderr.log"

echo
echo "--- timings (stderr) ---"
tail -20 "${ROOT}/.tmp/core-ai-stderr.log"
