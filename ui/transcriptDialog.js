// SPDX-License-Identifier: MIT
// Speakeasy — Transcript history dialog

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

/**
 * Modal dialog that displays transcript history entries.
 *
 * Each entry shows a timestamp and either the AI-cleaned text or
 * the raw STT text, toggled via a button in the title bar.
 */
export const TranscriptDialog = GObject.registerClass(
class SpeakeasyTranscriptDialog extends ModalDialog.ModalDialog {
    /**
     * @param {Array} transcripts - Array of transcript entries
     * @param {object} [options]
     * @param {function} [options.onClear] - Called when "Clear History" is clicked
     */
    _init(transcripts, options = {}) {
        super._init({styleClass: 'speakeasy-transcript-dialog'});

        this._onClear = options.onClear ?? null;
        this._rows = [];          // {entry, textLabel, toggleButton, showRaw}
        this._feedbackTimerIds = [];

        // ── Title ──
        const title = new St.Label({
            text: 'Transcript History',
            style_class: 'speakeasy-transcript-title',
            x_expand: true,
        });
        this.contentLayout.add_child(title);

        // ── Scrollable content area ──
        const scrollView = new St.ScrollView({
            style_class: 'speakeasy-transcript-scroll',
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });

        const listBox = new St.BoxLayout({
            vertical: true,
            style_class: 'speakeasy-transcript-list',
        });

        if (transcripts.length === 0) {
            const emptyLabel = new St.Label({
                text: 'No transcripts yet. Record something first!',
                style_class: 'speakeasy-transcript-empty',
            });
            listBox.add_child(emptyLabel);
        } else {
            // Show newest first
            for (let i = transcripts.length - 1; i >= 0; i--) {
                const entry = transcripts[i];
                const row = this._createRow(entry);
                listBox.add_child(row);
            }
        }

        scrollView.set_child(listBox);
        this.contentLayout.add_child(scrollView);

        // ── Buttons ──
        if (this._onClear && transcripts.length > 0) {
            this.addButton({
                label: 'Clear History',
                action: () => {
                    if (this._onClear)
                        this._onClear();
                },
            });
        }

        this.addButton({
            label: 'Close',
            action: () => this.close(),
            default: true,
        });
    }

    /**
     * Toggle a single row between cleaned and raw text.
     * @param {object} row - {entry, textLabel, toggleButton, showRaw}
     */
    _toggleRow(row) {
        row.showRaw = !row.showRaw;
        row.textLabel.text = row.showRaw ? row.entry.rawText : row.entry.cleanedText;
        row.toggleButton.child.text = row.showRaw ? 'Show Cleaned' : 'Show Raw';
    }

    /**
     * Create a single transcript row widget.
     * @param {object} entry - {timestamp, rawText, cleanedText, aiEnabled}
     * @returns {St.BoxLayout}
     */
    _createRow(entry) {
        const row = new St.BoxLayout({
            vertical: true,
            style_class: 'speakeasy-transcript-row',
        });

        // ── Header row: timestamp + copy button ──
        const headerBox = new St.BoxLayout({
            x_expand: true,
        });

        // Timestamp
        const time = new Date(entry.timestamp);
        const timeStr = time.toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
        const dateStr = time.toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
        });

        const header = new St.Label({
            text: `${dateStr} ${timeStr}${entry.aiEnabled ? '  [AI]' : ''}`,
            style_class: 'speakeasy-transcript-time',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerBox.add_child(header);

        // Per-row toggle button — only for entries with AI cleanup
        const hasAI = entry.aiEnabled && entry.rawText !== entry.cleanedText;
        let toggleButton = null;
        if (hasAI) {
            toggleButton = new St.Button({
                style_class: 'speakeasy-transcript-toggle-button',
                child: new St.Label({text: 'Show Raw'}),
                y_align: Clutter.ActorAlign.CENTER,
            });
            headerBox.add_child(toggleButton);
        }

        // Copy button — copies whichever version is currently displayed
        const copyButton = new St.Button({
            style_class: 'speakeasy-transcript-copy-button',
            child: new St.Icon({
                icon_name: 'edit-copy-symbolic',
                icon_size: 14,
            }),
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerBox.add_child(copyButton);

        row.add_child(headerBox);

        // ── Text label (selectable) ──
        const textLabel = new St.Label({
            text: entry.cleanedText,
            style_class: 'speakeasy-transcript-text',
            reactive: true,
        });
        textLabel.clutter_text.set_selectable(true);
        textLabel.clutter_text.set_line_wrap(true);
        textLabel.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        textLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        row.add_child(textLabel);

        // Track for toggle
        const rowData = {entry, textLabel, toggleButton, showRaw: false};
        this._rows.push(rowData);

        // Wire up toggle button
        if (toggleButton) {
            toggleButton.connect('clicked', () => this._toggleRow(rowData));
        }

        // Wire up copy button
        copyButton.connect('clicked', () => {
            const text = rowData.showRaw ? entry.rawText : entry.cleanedText;
            St.Clipboard.get_default().set_text(
                St.ClipboardType.CLIPBOARD, text);
            // Brief visual feedback: swap icon to a checkmark
            copyButton.child.icon_name = 'object-select-symbolic';
            const timerId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, 1500, () => {
                    const idx = this._feedbackTimerIds.indexOf(timerId);
                    if (idx !== -1)
                        this._feedbackTimerIds.splice(idx, 1);
                    try {
                        copyButton.child.icon_name = 'edit-copy-symbolic';
                    } catch (_e) {
                        // Widget may already be destroyed
                    }
                    return GLib.SOURCE_REMOVE;
                });
            this._feedbackTimerIds.push(timerId);
        });

        return row;
    }

    destroy() {
        for (const id of this._feedbackTimerIds)
            GLib.source_remove(id);
        this._feedbackTimerIds = [];
        this._rows = [];

        super.destroy();
    }
});
