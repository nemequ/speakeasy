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
 * Each row shows a timestamp (plus optional [AI] and [recovered]
 * badges), a toggle between cleaned and raw text (when AI cleanup
 * exists), copy-to-clipboard, re-run-cleanup, and delete buttons.
 */
export const TranscriptDialog = GObject.registerClass(
class SpeakeasyTranscriptDialog extends ModalDialog.ModalDialog {
    /**
     * @param {Array} transcripts - Array of transcript entries
     * @param {object} [options]
     * @param {function} [options.onClear] - Called when "Clear History" is clicked
     * @param {function} [options.onDelete] - Called with (entry) to delete one transcript
     * @param {function} [options.onRerunCleanup] - Async, called with (entry); must resolve true/false
     */
    _init(transcripts, options = {}) {
        super._init({styleClass: 'speakeasy-transcript-dialog'});

        this._onClear = options.onClear ?? null;
        this._onDelete = options.onDelete ?? null;
        this._onRerunCleanup = options.onRerunCleanup ?? null;
        this._rows = [];          // {entry, textLabel, toggleButton, headerLabel, rowBox, showRaw}
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

        this._listBox = new St.BoxLayout({
            vertical: true,
            style_class: 'speakeasy-transcript-list',
        });

        if (transcripts.length === 0) {
            const emptyLabel = new St.Label({
                text: 'No transcripts yet. Record something first!',
                style_class: 'speakeasy-transcript-empty',
            });
            this._listBox.add_child(emptyLabel);
        } else {
            // Show newest first
            for (let i = transcripts.length - 1; i >= 0; i--) {
                const entry = transcripts[i];
                const row = this._createRow(entry);
                this._listBox.add_child(row);
            }
        }

        scrollView.set_child(this._listBox);
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
     */
    _toggleRow(row) {
        row.showRaw = !row.showRaw;
        row.textLabel.text = row.showRaw ? row.entry.rawText : row.entry.cleanedText;
        row.toggleButton.child.text = row.showRaw ? 'Show Cleaned' : 'Show Raw';
    }

    /**
     * Build the header text (timestamp + badges) for a row.
     */
    _headerText(entry) {
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
        let badges = '';
        if (entry.aiEnabled)
            badges += '  [AI]';
        if (entry.recovered)
            badges += '  [recovered]';
        return `${dateStr} ${timeStr}${badges}`;
    }

    /**
     * Create a single transcript row widget.
     */
    _createRow(entry) {
        const row = new St.BoxLayout({
            vertical: true,
            style_class: 'speakeasy-transcript-row',
        });

        // ── Header row: timestamp + action buttons ──
        const headerBox = new St.BoxLayout({
            x_expand: true,
        });

        const header = new St.Label({
            text: this._headerText(entry),
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

        // Re-run AI cleanup button
        let rerunButton = null;
        if (this._onRerunCleanup) {
            rerunButton = new St.Button({
                style_class: 'speakeasy-transcript-rerun-button',
                child: new St.Label({text: 'Re-run AI'}),
                y_align: Clutter.ActorAlign.CENTER,
            });
            headerBox.add_child(rerunButton);
        }

        // Copy button
        const copyButton = new St.Button({
            style_class: 'speakeasy-transcript-copy-button',
            child: new St.Icon({
                icon_name: 'edit-copy-symbolic',
                icon_size: 14,
            }),
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerBox.add_child(copyButton);

        // Delete button (with two-stage confirmation)
        let deleteButton = null;
        if (this._onDelete) {
            deleteButton = new St.Button({
                style_class: 'speakeasy-transcript-delete-button',
                child: new St.Icon({
                    icon_name: 'user-trash-symbolic',
                    icon_size: 14,
                }),
                y_align: Clutter.ActorAlign.CENTER,
            });
            headerBox.add_child(deleteButton);
        }

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

        const rowData = {
            entry, textLabel, toggleButton, headerLabel: header,
            rowBox: row, showRaw: false, deleteConfirming: false,
            deleteButton, rerunButton,
        };
        this._rows.push(rowData);

        if (toggleButton)
            toggleButton.connect('clicked', () => this._toggleRow(rowData));

        copyButton.connect('clicked', () => {
            const text = rowData.showRaw ? entry.rawText : entry.cleanedText;
            St.Clipboard.get_default().set_text(
                St.ClipboardType.CLIPBOARD, text);
            copyButton.child.icon_name = 'object-select-symbolic';
            const timerId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, 1500, () => {
                    const idx = this._feedbackTimerIds.indexOf(timerId);
                    if (idx !== -1)
                        this._feedbackTimerIds.splice(idx, 1);
                    try {
                        copyButton.child.icon_name = 'edit-copy-symbolic';
                    } catch (_e) { /* already destroyed */ }
                    return GLib.SOURCE_REMOVE;
                });
            this._feedbackTimerIds.push(timerId);
        });

        if (rerunButton) {
            rerunButton.connect('clicked', () => {
                this._handleRerun(rowData);
            });
        }

        if (deleteButton) {
            deleteButton.connect('clicked', () => {
                this._handleDelete(rowData);
            });
        }

        return row;
    }

    /**
     * Two-stage delete: first click arms the button (icon changes to
     * a warning glyph); second click within 3s actually deletes.
     */
    _handleDelete(rowData) {
        if (!this._onDelete)
            return;

        if (!rowData.deleteConfirming) {
            rowData.deleteConfirming = true;
            try {
                rowData.deleteButton.child.icon_name = 'dialog-warning-symbolic';
                rowData.deleteButton.add_style_pseudo_class('active');
            } catch (_e) { /* ignore */ }

            const timerId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, 3000, () => {
                    const idx = this._feedbackTimerIds.indexOf(timerId);
                    if (idx !== -1)
                        this._feedbackTimerIds.splice(idx, 1);
                    try {
                        rowData.deleteConfirming = false;
                        rowData.deleteButton.child.icon_name = 'user-trash-symbolic';
                        rowData.deleteButton.remove_style_pseudo_class('active');
                    } catch (_e) { /* ignore */ }
                    return GLib.SOURCE_REMOVE;
                });
            this._feedbackTimerIds.push(timerId);
            return;
        }

        // Second click — actually delete
        try {
            this._onDelete(rowData.entry);
        } catch (e) {
            log(`Speakeasy: onDelete failed: ${e.message}`);
            return;
        }
        // Remove the row from the dialog
        try {
            rowData.rowBox.destroy();
        } catch (_e) { /* ignore */ }
        const idx = this._rows.indexOf(rowData);
        if (idx !== -1)
            this._rows.splice(idx, 1);
    }

    /**
     * Kick off async AI re-run; update the button label to reflect
     * progress, and refresh the row once it completes.
     */
    _handleRerun(rowData) {
        if (!this._onRerunCleanup || !rowData.rerunButton)
            return;
        const btn = rowData.rerunButton;
        btn.reactive = false;
        btn.child.text = 'Running...';

        (async () => {
            let ok = false;
            try {
                ok = await this._onRerunCleanup(rowData.entry);
            } catch (e) {
                log(`Speakeasy: onRerunCleanup threw: ${e.message}`);
                ok = false;
            }

            try {
                if (ok) {
                    // Refresh this row's view: header gains [AI]
                    // badge, text label shows the new cleaned text.
                    rowData.headerLabel.text = this._headerText(rowData.entry);
                    rowData.showRaw = false;
                    rowData.textLabel.text = rowData.entry.cleanedText;
                    btn.child.text = 'Done';
                } else {
                    btn.child.text = 'Failed';
                }
            } catch (_e) { /* widget may be gone */ }

            const timerId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, 2000, () => {
                    const idx = this._feedbackTimerIds.indexOf(timerId);
                    if (idx !== -1)
                        this._feedbackTimerIds.splice(idx, 1);
                    try {
                        btn.child.text = 'Re-run AI';
                        btn.reactive = true;
                    } catch (_e) { /* ignore */ }
                    return GLib.SOURCE_REMOVE;
                });
            this._feedbackTimerIds.push(timerId);
        })();
    }

    destroy() {
        for (const id of this._feedbackTimerIds)
            GLib.source_remove(id);
        this._feedbackTimerIds = [];
        this._rows = [];

        super.destroy();
    }
});
