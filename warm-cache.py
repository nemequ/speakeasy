#!/usr/bin/env python3
"""Warm the GStreamer plugin registry and VOSK model page cache.

Spawned by the Speakeasy extension at startup so the heavy I/O happens
in a separate process without blocking the compositor.  When this
exits, the extension runs Gst.init() + recorder.init() on the main
thread — both complete quickly because the registry cache is fresh
and model files are already in the kernel page cache.

Usage:  warm-cache.py [vosk-model-dir]

Exit codes:
  0  — success (registry + model warmed)
  1  — GStreamer init failed
  2  — model directory not found / not readable
"""

import os
import sys


def warm_gstreamer():
    """Initialize GStreamer to rebuild/validate the plugin registry cache."""
    try:
        import gi

        gi.require_version("Gst", "1.0")
        from gi.repository import Gst

        Gst.init(None)
    except Exception as e:
        print(f"warm-cache: Gst.init failed: {e}", file=sys.stderr)
        return False
    return True


def warm_model(model_dir):
    """Read all files in the model directory to populate the page cache."""
    if not model_dir or not os.path.isdir(model_dir):
        print(f"warm-cache: model dir not found: {model_dir}", file=sys.stderr)
        return False

    buf = bytearray(1024 * 1024)  # 1 MiB read buffer
    for dirpath, _dirnames, filenames in os.walk(model_dir):
        for name in filenames:
            path = os.path.join(dirpath, name)
            try:
                with open(path, "rb") as f:
                    while f.readinto(buf):
                        pass
            except OSError:
                pass  # skip unreadable files
    return True


def main():
    model_dir = sys.argv[1] if len(sys.argv) > 1 else None

    if not warm_gstreamer():
        sys.exit(1)

    if model_dir and not warm_model(model_dir):
        sys.exit(2)


if __name__ == "__main__":
    main()
