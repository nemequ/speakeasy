#!/usr/bin/env -S gjs -m
// Standalone test harness for OllamaCleanup.
// Exercises the same code path as the extension without GNOME Shell.
//
// Usage:
//   gjs -m test-ollama.js                    # uses most recent transcript
//   gjs -m test-ollama.js path/to/transcript.json
//   gjs -m test-ollama.js --text "some raw stt text here"

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { OllamaCleanup } from '../ollama.js';

const EXTENSION_DIR = GLib.path_get_dirname(
    GLib.filename_from_uri(import.meta.url)[0]
);
const TRANSCRIPTS_DIR = GLib.build_filenamev([
    GLib.get_user_data_dir(), 'speakeasy', 'transcripts',
]);

// ── Parse arguments ─────────────────────────────────────────────────

let rawText = null;

if (ARGV.length >= 2 && ARGV[0] === '--text') {
    rawText = ARGV.slice(1).join(' ');
} else if (ARGV.length >= 1 && ARGV[0] !== '--text') {
    // Load from a specific transcript file
    const path = ARGV[0];
    try {
        const file = Gio.File.new_for_path(path);
        const [ok, contents] = file.load_contents(null);
        if (ok) {
            const data = JSON.parse(new TextDecoder().decode(contents));
            rawText = data.raw_text;
            print(`Loaded transcript: ${path}`);
            print(`  timestamp: ${data.timestamp}`);
            print(`  ai_enabled: ${data.ai_enabled}`);
        }
    } catch (e) {
        printerr(`Failed to load transcript: ${e.message}`);
        imports.system.exit(1);
    }
} else if (ARGV.length === 0) {
    // Find the most recent transcript with substantial text
    try {
        const dir = Gio.File.new_for_path(TRANSCRIPTS_DIR);
        const enumerator = dir.enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);

        let files = [];
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (name.endsWith('.json'))
                files.push(name);
        }
        enumerator.close(null);

        // Sort descending (newest first)
        files.sort().reverse();

        for (const name of files) {
            const path = GLib.build_filenamev([TRANSCRIPTS_DIR, name]);
            const file = Gio.File.new_for_path(path);
            const [ok, contents] = file.load_contents(null);
            if (!ok) continue;

            const data = JSON.parse(new TextDecoder().decode(contents));
            if (data.raw_text && data.raw_text.length > 20) {
                rawText = data.raw_text;
                print(`Using transcript: ${name}`);
                print(`  timestamp: ${data.timestamp}`);
                print(`  raw_text length: ${rawText.length}`);
                break;
            }
        }

        if (!rawText) {
            printerr('No transcript with substantial text found');
            imports.system.exit(1);
        }
    } catch (e) {
        printerr(`Failed to scan transcripts: ${e.message}`);
        imports.system.exit(1);
    }
}

// ── Run the test ────────────────────────────────────────────────────

print('');
print('─── Input (raw STT) ───');
print(rawText);
print('');

const ai = new OllamaCleanup();
ai.setExtensionDir(EXTENSION_DIR);

// Skip GSettings — configure directly
ai._enabled = true;
ai._url = 'http://localhost:11434';
ai._model = 'qwen2.5:3b';

ai.init();

if (!ai.isAvailable()) {
    printerr('ERROR: OllamaCleanup reports not available');
    imports.system.exit(1);
}

print('Starting session...');
ai.beginSession();

print('Feeding text...');
ai.feedText(rawText);

print('Finalizing (sending to Ollama)...');
const startTime = GLib.get_monotonic_time();

// We need a main loop for the async operations
const loop = GLib.MainLoop.new(null, false);
let exitCode = 0;

ai.finalize(null).then(cleaned => {
    const elapsed = (GLib.get_monotonic_time() - startTime) / 1e6;
    print('');
    print('─── Output (cleaned) ───');
    print(cleaned ?? '(null — cleanup failed)');
    print('');
    print(`─── Stats ───`);
    print(`  Time: ${elapsed.toFixed(2)}s`);
    print(`  Input: ${rawText.length} chars`);
    print(`  Output: ${cleaned?.length ?? 0} chars`);

    ai.destroy();
    loop.quit();
}).catch(e => {
    printerr(`ERROR: ${e.message}`);
    exitCode = 1;
    ai.destroy();
    loop.quit();
});

loop.run();
imports.system.exit(exitCode);
