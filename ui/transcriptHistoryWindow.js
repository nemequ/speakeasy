// SPDX-License-Identifier: MIT
// Speakeasy — GTK transcript history window
//
// The GTK counterpart of ui/transcriptDialog.js. Used by the
// standalone GTK test app (gtk-app.js) to view, delete, and re-run
// AI cleanup on transcript history, outside the Shell compositor.
//
// Loads transcripts from disk via transcriptStore.js on open, so
// the view always reflects what's actually on disk.

import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

import {
    loadTranscriptsSync,
    deleteTranscript,
    rerunAiCleanup,
} from '../transcriptStore.js';

/**
 * Open the transcript history window.
 *
 * @param {object} options
 * @param {Gtk.Window} options.parent      - Parent window for transient-for
 * @param {string}    options.transcriptDir - Directory to load transcripts from
 * @param {function}  options.getAi         - () => AI instance for re-run (may be null)
 * @returns {Gtk.Window}
 */
export function openTranscriptHistoryWindow({parent, transcriptDir, getAi}) {
    const window = new Gtk.Window({
        title: 'Transcript History',
        default_width: 720,
        default_height: 600,
        transient_for: parent ?? null,
        modal: false,
    });

    const root = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        margin_top: 12,
        margin_bottom: 12,
        margin_start: 12,
        margin_end: 12,
        spacing: 8,
    });
    window.set_child(root);

    const header = new Gtk.Label({
        label: '<b>Transcript History</b>',
        use_markup: true,
        xalign: 0,
    });
    root.append(header);

    const scrolled = new Gtk.ScrolledWindow({
        hexpand: true,
        vexpand: true,
    });
    root.append(scrolled);

    const listBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
    });
    scrolled.set_child(listBox);

    const footer = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
        halign: Gtk.Align.END,
    });
    const reloadBtn = new Gtk.Button({label: 'Reload'});
    const closeBtn = new Gtk.Button({label: 'Close'});
    footer.append(reloadBtn);
    footer.append(closeBtn);
    root.append(footer);

    closeBtn.connect('clicked', () => window.close());

    function clearList() {
        let child = listBox.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            listBox.remove(child);
            child = next;
        }
    }

    function populate() {
        clearList();
        const entries = loadTranscriptsSync(transcriptDir);
        if (entries.length === 0) {
            const empty = new Gtk.Label({
                label: 'No transcripts yet.',
                xalign: 0,
                css_classes: ['dim-label'],
                margin_top: 12,
            });
            listBox.append(empty);
            return;
        }
        // Newest first
        for (let i = entries.length - 1; i >= 0; i--) {
            const row = buildRow(entries[i]);
            listBox.append(row);
        }
    }

    function headerText(entry) {
        const time = new Date(entry.timestamp);
        const str = time.toLocaleString();
        let badges = '';
        if (entry.aiEnabled)
            badges += '  [AI]';
        if (entry.recovered)
            badges += '  [recovered]';
        return `${str}${badges}`;
    }

    function buildRow(entry) {
        const frame = new Gtk.Frame({margin_top: 2, margin_bottom: 2});
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: 6,
            spacing: 4,
        });
        frame.set_child(box);

        // Header: timestamp + badges + action buttons
        const headerBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
        });
        const ts = new Gtk.Label({
            label: headerText(entry),
            xalign: 0,
            hexpand: true,
            css_classes: ['heading'],
        });
        headerBox.append(ts);

        // Toggle cleaned/raw — only when AI cleanup exists and differs
        const hasAI = entry.aiEnabled && entry.rawText !== entry.cleanedText;
        let toggleBtn = null;
        if (hasAI) {
            toggleBtn = new Gtk.Button({label: 'Show Raw'});
            headerBox.append(toggleBtn);
        }

        const rerunBtn = new Gtk.Button({label: 'Re-run AI'});
        headerBox.append(rerunBtn);

        const copyBtn = new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            tooltip_text: 'Copy to clipboard',
        });
        headerBox.append(copyBtn);

        const deleteBtn = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            tooltip_text: 'Delete this transcript',
            css_classes: ['destructive-action'],
        });
        headerBox.append(deleteBtn);

        box.append(headerBox);

        // Text
        const textView = new Gtk.TextView({
            editable: false,
            cursor_visible: false,
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
            top_margin: 4,
            bottom_margin: 4,
            left_margin: 4,
            right_margin: 4,
        });
        let showRaw = false;
        textView.buffer.set_text(entry.cleanedText ?? '', -1);
        box.append(textView);

        // Wire up toggle
        if (toggleBtn) {
            toggleBtn.connect('clicked', () => {
                showRaw = !showRaw;
                const t = showRaw ? entry.rawText : entry.cleanedText;
                textView.buffer.set_text(t ?? '', -1);
                toggleBtn.label = showRaw ? 'Show Cleaned' : 'Show Raw';
            });
        }

        // Copy
        copyBtn.connect('clicked', () => {
            const text = showRaw ? entry.rawText : entry.cleanedText;
            try {
                const display = Gdk.Display.get_default();
                if (display) {
                    const clipboard = display.get_clipboard();
                    clipboard.set(text ?? '');
                }
            } catch (e) {
                print(`[transcriptHistoryWindow] copy failed: ${e.message}`);
            }
            const prevIcon = copyBtn.icon_name;
            copyBtn.icon_name = 'object-select-symbolic';
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                try { copyBtn.icon_name = prevIcon; } catch (_e) { /* ignore */ }
                return GLib.SOURCE_REMOVE;
            });
        });

        // Delete with two-stage confirmation
        let deleteConfirming = false;
        deleteBtn.connect('clicked', () => {
            if (!deleteConfirming) {
                deleteConfirming = true;
                deleteBtn.icon_name = 'dialog-warning-symbolic';
                deleteBtn.tooltip_text = 'Click again within 3s to confirm delete';
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
                    if (deleteConfirming) {
                        deleteConfirming = false;
                        try {
                            deleteBtn.icon_name = 'user-trash-symbolic';
                            deleteBtn.tooltip_text = 'Delete this transcript';
                        } catch (_e) { /* widget destroyed */ }
                    }
                    return GLib.SOURCE_REMOVE;
                });
                return;
            }
            deleteTranscript(entry);
            try { listBox.remove(frame); } catch (_e) { /* ignore */ }
        });

        // Re-run
        rerunBtn.connect('clicked', () => {
            const ai = getAi?.();
            if (!ai || !ai.isAvailable || !ai.isAvailable()) {
                rerunBtn.label = 'No AI';
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                    try { rerunBtn.label = 'Re-run AI'; } catch (_e) { /* ignore */ }
                    return GLib.SOURCE_REMOVE;
                });
                return;
            }
            rerunBtn.sensitive = false;
            rerunBtn.label = 'Running...';
            (async () => {
                let ok = false;
                try {
                    ok = await rerunAiCleanup(entry, ai);
                } catch (e) {
                    print(`[transcriptHistoryWindow] rerun failed: ${e.message}`);
                }
                try {
                    if (ok) {
                        rerunBtn.label = 'Done';
                        ts.label = headerText(entry);
                        showRaw = false;
                        textView.buffer.set_text(entry.cleanedText ?? '', -1);
                    } else {
                        rerunBtn.label = 'Failed';
                    }
                } catch (_e) { /* ignore */ }
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                    try {
                        rerunBtn.label = 'Re-run AI';
                        rerunBtn.sensitive = true;
                    } catch (_e) { /* ignore */ }
                    return GLib.SOURCE_REMOVE;
                });
            })();
        });

        return frame;
    }

    reloadBtn.connect('clicked', () => populate());
    populate();

    window.present();
    return window;
}
