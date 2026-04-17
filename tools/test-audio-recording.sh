#!/bin/bash
# Phase 1 test: record audio, save to WAV, play back.
#
# Proves the mic → cpal → WAV path works end-to-end without any
# STT or AI involvement. If this works, the audio capture half of
# speakeasy is healthy.
#
# Usage:
#   ./tools/test-audio-recording.sh
#
# You'll be prompted to press Enter to start, then Enter again to
# stop. The recording is saved to .tmp/test-recording.wav and
# played back immediately using aplay or paplay.

set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORE="${ROOT}/core/target/release/speakeasy"
WAV="${ROOT}/.tmp/test-recording.wav"

mkdir -p "${ROOT}/.tmp"
rm -f "${WAV}"

if [ ! -x "${CORE}" ]; then
    echo "Error: speakeasy not built. Run: cd core && cargo build --release" >&2
    exit 1
fi

# Find a playback command
PLAYER=""
for cmd in paplay aplay play; do
    if command -v "${cmd}" >/dev/null 2>&1; then
        PLAYER="${cmd}"
        break
    fi
done
if [ -z "${PLAYER}" ]; then
    echo "Warning: no playback tool found (tried paplay, aplay, play). WAV will be saved but not played."
fi

echo "=== Speakeasy audio recording test ==="
echo "Binary: ${CORE}"
echo "Output: ${WAV}"
echo

# Spawn the core in the background, keeping stdin open on a FIFO so
# we can write JSON commands into it interactively.
CMD_FIFO="${ROOT}/.tmp/core-cmd.fifo"
rm -f "${CMD_FIFO}"
mkfifo "${CMD_FIFO}"

# No model = no transcription thread, but mic + WAV save still work.
# --ai-backend none so we don't need an API key.
#
# Order matters: open the FIFO read-write on fd 3 BEFORE spawning the
# core. Opening rw (<>) never blocks. Then the core opens the FIFO
# for read via shell redirection, and we write commands to fd 3.
exec 3<>"${CMD_FIFO}"

"${CORE}" \
    --debug-save-wav "${WAV}" \
    --ai-backend none \
    --backend whisper-rs \
    < "${CMD_FIFO}" \
    2>"${ROOT}/.tmp/core-stderr.log" \
    &
CORE_PID=$!

# Cleanup on exit: close fd 3, kill core if still alive, remove FIFO
cleanup() {
    exec 3>&-
    kill "${CORE_PID}" 2>/dev/null || true
    wait "${CORE_PID}" 2>/dev/null || true
    rm -f "${CMD_FIFO}"
}
trap cleanup EXIT

# Give the core a moment to initialize audio
sleep 1

echo "Press Enter to START recording..."
read -r _

echo '{"cmd":"start"}' >&3
echo ">>> Recording. Press Enter to STOP."
read -r _

echo '{"cmd":"stop"}' >&3
# Give it a moment to flush the WAV. The core doesn't always exit
# cleanly on "quit" (blocking stdin read prevents runtime shutdown),
# so we just TERM it once the WAV is flushed — the file is already
# on disk by then.
sleep 1
kill -TERM "${CORE_PID}" 2>/dev/null || true
wait "${CORE_PID}" 2>/dev/null || true

echo
if [ -f "${WAV}" ]; then
    SIZE=$(stat -c '%s' "${WAV}")
    echo "WAV saved: ${WAV} (${SIZE} bytes)"
    if [ "${SIZE}" -lt 100 ]; then
        echo "Warning: file is very small — recording may have failed."
        echo "stderr log: ${ROOT}/.tmp/core-stderr.log"
        tail -20 "${ROOT}/.tmp/core-stderr.log"
        exit 1
    fi
    if [ -n "${PLAYER}" ]; then
        echo "Playing back with ${PLAYER}..."
        "${PLAYER}" "${WAV}"
        echo "Done."
    fi
else
    echo "Error: no WAV file produced. See ${ROOT}/.tmp/core-stderr.log" >&2
    tail -30 "${ROOT}/.tmp/core-stderr.log" >&2
    exit 1
fi
