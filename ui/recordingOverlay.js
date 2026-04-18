// SPDX-License-Identifier: MIT
// Speakeasy — Recording overlay UI with waveform visualization and drag support
//
// Shows a floating box during recording/processing with:
//   - Microphone icon + real-time audio waveform visualization
//   - Auto-scrolling transcript (partial + finalized text)
//   - Spinner + status text during post-transcription cleanup
//   - Draggable via pointer (position persists in-memory only)

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import Cairo from 'gi://cairo';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Animation from 'resource:///org/gnome/shell/ui/animation.js';

// ── Waveform visualization ────────────────────────────────────────

const WaveformDisplay = GObject.registerClass(
class WaveformDisplay extends St.DrawingArea {
    _init() {
        super._init({
            style_class: 'speakeasy-overlay-waveform',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Rolling buffer of normalized audio levels (0.0 to 1.0)
        this._barCount = 40;
        this._levels = new Array(this._barCount).fill(0);
    }

    pushLevel(value) {
        this._levels.push(Math.max(0, Math.min(1, value)));
        if (this._levels.length > this._barCount)
            this._levels.shift();
        this.queue_repaint();
    }

    reset() {
        this._levels = new Array(this._barCount).fill(0);
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        if (!cr) return;

        const [width, height] = this.get_surface_size();

        // Clear
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        const barCount = this._levels.length;
        if (barCount === 0 || width <= 0 || height <= 0) {
            cr.$dispose();
            return;
        }

        const gap = 2;
        const totalGap = (barCount - 1) * gap;
        const barWidth = Math.max(1, (width - totalGap) / barCount);
        const maxBarHeight = height - 4;
        const centerY = height / 2;

        // Draw bars extending symmetrically from center (waveform style)
        for (let i = 0; i < barCount; i++) {
            const level = this._levels[i];
            const barHeight = Math.max(2, level * maxBarHeight);
            const x = i * (barWidth + gap);

            // Gradient from blue to cyan based on level
            const r = 0.2;
            const g = 0.5 + level * 0.3;
            const b = 0.9 + level * 0.1;
            cr.setSourceRGBA(r, g, b, 0.85);

            // Rounded rectangle via arc corners
            const radius = Math.min(barWidth / 2, barHeight / 4, 3);
            const top = centerY - barHeight / 2;
            const bottom = centerY + barHeight / 2;

            cr.newPath();
            cr.arc(x + barWidth - radius, top + radius, radius, -Math.PI / 2, 0);
            cr.arc(x + barWidth - radius, bottom - radius, radius, 0, Math.PI / 2);
            cr.arc(x + radius, bottom - radius, radius, Math.PI / 2, Math.PI);
            cr.arc(x + radius, top + radius, radius, Math.PI, 3 * Math.PI / 2);
            cr.closePath();
            cr.fill();
        }

        cr.$dispose();
    }

    vfunc_get_preferred_width(_forHeight) {
        const themeNode = this.get_theme_node();
        return themeNode.adjust_preferred_width(200, 200);
    }

    vfunc_get_preferred_height(_forWidth) {
        const themeNode = this.get_theme_node();
        return themeNode.adjust_preferred_height(48, 48);
    }
});

// ── Main overlay widget ───────────────────────────────────────────

export const RecordingOverlay = GObject.registerClass(
class RecordingOverlay extends St.BoxLayout {
    _init() {
        super._init({
            vertical: true,
            style_class: 'speakeasy-overlay',
            visible: false,
            reactive: true,
            can_focus: true,
            track_hover: true,
            clip_to_allocation: true,
        });

        // State
        this._mode = 'idle'; // 'idle', 'recording', 'processing'

        // Drag state
        this._isDragging = false;
        this._dragStartX = 0;
        this._dragStartY = 0;
        this._origX = 0;
        this._origY = 0;
        this._grab = null;

        // Partial text label reference (always last child in transcript box)
        this._partialLabel = null;

        // Streaming cleanup label — appended-to as Event::Delta chunks
        // arrive from the core, replaced wholesale by the terminal
        // Event::Final. Null until beginCleanup() is called.
        this._cleanedLabel = null;

        // Callbacks
        this._onCancel = null;

        this._buildUI();
    }

    _buildUI() {
        // ── Header row: mic icon + waveform ──
        this._headerBox = new St.BoxLayout({
            vertical: false,
            style_class: 'speakeasy-overlay-header',
        });

        this._micIcon = new St.Icon({
            icon_name: 'audio-input-microphone-symbolic',
            icon_size: 24,
            style_class: 'speakeasy-overlay-mic-icon speakeasy-overlay-mic-recording',
        });
        this._headerBox.add_child(this._micIcon);

        this._waveform = new WaveformDisplay();
        this._headerBox.add_child(this._waveform);

        this._cancelButton = new St.Button({
            style_class: 'speakeasy-overlay-cancel-button',
            child: new St.Icon({
                icon_name: 'window-close-symbolic',
                icon_size: 16,
            }),
            y_align: Clutter.ActorAlign.CENTER,
            can_focus: false,
        });
        this._cancelButton.connect('clicked', () => {
            if (this._onCancel)
                this._onCancel();
        });
        this._headerBox.add_child(this._cancelButton);

        this.add_child(this._headerBox);

        // ── Scrollable transcript area ──
        // The overlay itself has a fixed height + clip_to_allocation,
        // so the scroll view fills remaining space and scrolls.
        this._scrollView = new St.ScrollView({
            style_class: 'speakeasy-overlay-scroll',
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        this._scrollView.set_policy(
            St.PolicyType.NEVER,       // horizontal: never
            St.PolicyType.ALWAYS       // vertical: always show
        );

        this._transcriptBox = new St.BoxLayout({
            vertical: true,
            style_class: 'speakeasy-overlay-transcript',
        });

        this._scrollView.set_child(this._transcriptBox);
        this.add_child(this._scrollView);

        // Create the persistent partial-text label (always last in transcript)
        this._partialLabel = new St.Label({
            style_class: 'speakeasy-overlay-partial-text',
            x_expand: true,
            visible: false,
            reactive: true,
        });
        this._configureSelectableLabel(this._partialLabel);
        this._transcriptBox.add_child(this._partialLabel);

        // Auto-scroll: only follow new content if already at the bottom.
        // If the user scrolled up, leave the position alone.
        const vadjust = this._scrollView.vadjustment;
        this._autoScroll = true;

        vadjust.connect('notify::value', () => {
            // Consider "at bottom" if within 5px of the end
            this._autoScroll =
                vadjust.value >= vadjust.upper - vadjust.page_size - 5;
        });

        vadjust.connect('changed', () => {
            if (this._autoScroll)
                vadjust.value = vadjust.upper - vadjust.page_size;
        });

        // ── Status row (processing spinner) ──
        this._statusBox = new St.BoxLayout({
            vertical: false,
            style_class: 'speakeasy-overlay-status',
            visible: false,
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._spinner = new Animation.Spinner(16, {
            animate: true,
            hideOnStop: true,
        });
        this._statusBox.add_child(this._spinner);

        // Default caption. The controller overrides this via
        // setStatusText() as the stop-pipeline progresses through
        // finalize-transcription / AI-cleanup / paste.
        this._statusLabel = new St.Label({
            text: 'Finalizing transcription\u2026',
            style_class: 'speakeasy-overlay-status-text',
        });
        this._statusBox.add_child(this._statusLabel);

        this.add_child(this._statusBox);
    }

    /**
     * Set a callback for when the cancel button is clicked.
     * @param {function} callback
     */
    onCancel(callback) {
        this._onCancel = callback;
    }

    // ── Public API ──
    // Note: we use open/close instead of show/hide to avoid
    // shadowing Clutter.Actor.show() / hide().

    /**
     * Show the overlay in the given mode.
     * @param {'recording'|'processing'} mode
     */
    open(mode) {
        if (mode === 'recording')
            this._clearTranscript();

        this._mode = mode;
        this._applyMode();
        super.show();
    }

    /**
     * Hide the overlay and reset state.
     */
    close() {
        this._mode = 'idle';
        this._spinner.stop();
        super.hide();
    }

    /**
     * Switch the overlay to a new mode while already visible.
     * @param {'recording'|'processing'} mode
     */
    setMode(mode) {
        this._mode = mode;
        this._applyMode();
        if (!this.visible)
            super.show();
    }

    /**
     * Replace the processing-mode caption next to the spinner. Called
     * by the controller at each stop-pipeline step so the user can
     * see which hop is running (finalize, AI cleanup, paste).
     * @param {string} text
     */
    setStatusText(text) {
        if (this._statusLabel)
            this._statusLabel.text = text;
    }

    /**
     * Update the tentative/partial transcription text.
     * @param {string} text
     */
    setPartialText(text) {
        if (text) {
            this._partialLabel.text = text;
            this._partialLabel.show();
        } else {
            this._partialLabel.text = '';
            this._partialLabel.hide();
        }
    }

    /**
     * Append a finalized transcription segment.
     * @param {string} text
     */
    addFinalText(text) {
        if (!text) return;

        const label = new St.Label({
            text,
            style_class: 'speakeasy-overlay-final-text',
            x_expand: true,
            reactive: true,
        });
        this._configureSelectableLabel(label);

        // Insert before the partial label (which is always last)
        this._transcriptBox.insert_child_below(label, this._partialLabel);

        // Clear partial text since the final supersedes it
        this.setPartialText('');
    }

    /**
     * Start an AI-cleanup streaming pass. Replaces the raw STT
     * segments with a single fresh label that subsequent deltas
     * append into. Safe to call multiple times — each call wipes
     * prior cleaned text so a retry doesn't accumulate.
     */
    beginCleanup() {
        const children = this._transcriptBox.get_children();
        for (const child of children) {
            if (child !== this._partialLabel)
                child.destroy();
        }
        this.setPartialText('');

        this._cleanedLabel = new St.Label({
            text: '',
            style_class: 'speakeasy-overlay-final-text speakeasy-overlay-cleaned-text',
            x_expand: true,
            reactive: true,
        });
        this._configureSelectableLabel(this._cleanedLabel);
        this._transcriptBox.insert_child_below(
            this._cleanedLabel, this._partialLabel);
    }

    /**
     * Append a streamed cleanup chunk. Lazily initializes the
     * cleaned label if the core somehow emits a delta before we
     * called beginCleanup() — protects against race conditions in
     * the caller.
     * @param {string} text
     */
    appendCleanedDelta(text) {
        if (!text) return;
        if (!this._cleanedLabel)
            this.beginCleanup();
        this._cleanedLabel.text = (this._cleanedLabel.text || '') + text;
    }

    /**
     * Replace the cleanup buffer with the terminal full text from
     * Event::Final. Deltas + final should agree, but if anything
     * slipped (truncation, retry) the final wins.
     * @param {string} text
     */
    setCleanedText(text) {
        if (!this._cleanedLabel)
            this.beginCleanup();
        this._cleanedLabel.text = text || '';
    }

    /**
     * Configure a label's ClutterText so the user can click-drag to
     * select text, and Ctrl+C to copy it to the clipboard. Without
     * `selectable` + `reactive` on the ClutterText, St.Label is a
     * purely-display widget and any click on it bubbles up to the
     * overlay (where the old code used it to start a drag).
     *
     * Keep `cursor_visible` off so the text area doesn't blink as if
     * it were editable.
     */
    _configureSelectableLabel(label) {
        const ct = label.clutter_text;
        ct.set_line_wrap(true);
        ct.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        ct.set_ellipsize(Pango.EllipsizeMode.NONE);
        ct.set_selectable(true);
        ct.set_editable(false);
        ct.set_cursor_visible(false);
        ct.reactive = true;
    }

    /**
     * Feed an audio level reading for the waveform. Inputs are
     * linear amplitudes in roughly [0, 1] (the core emits raw
     * linear peak alongside a TUI-boosted rms). We convert peak to
     * dB here so the -60..0 dB mapping produces a natural-looking
     * VU meter for speech.
     *
     * @param {number} _rms - RMS amplitude (unused; peak drives display)
     * @param {number} peak - Peak amplitude, linear
     */
    setLevel(_rms, peak) {
        const minDb = -60;
        const maxDb = 0;
        const peakDb = peak > 0 ? 20 * Math.log10(peak) : minDb;
        const normalized = Math.max(0, Math.min(1,
            (peakDb - minDb) / (maxDb - minDb)));
        this._waveform.pushLevel(normalized);
    }

    destroy() {
        if (this._grab) {
            this._grab.dismiss();
            this._grab = null;
        }
        this._spinner?.stop();
        super.destroy();
    }

    // ── Private ──

    _applyMode() {
        switch (this._mode) {
            case 'recording':
                this._headerBox.show();
                this._scrollView.show();
                this._statusBox.hide();
                this._spinner.stop();
                break;

            case 'processing':
                this._headerBox.show();
                this._scrollView.show();
                this._statusBox.show();
                this._spinner.play();
                // Clear stale partial text — it's now included in the
                // final accumulated result from the STT subprocess.
                this.setPartialText('');
                break;
        }
    }

    _clearTranscript() {
        // Remove all children except the partial label
        const children = this._transcriptBox.get_children();
        for (const child of children) {
            if (child !== this._partialLabel)
                child.destroy();
        }
        this._partialLabel.text = '';
        this._partialLabel.hide();
        this._cleanedLabel = null;
        this._waveform.reset();
        this._autoScroll = true;
    }

    // ── Drag handling ──
    //
    // Drag is scoped to the header strip only (mic icon + waveform +
    // control buttons). Clicks in the transcript area propagate so
    // the ClutterText can start a text selection; clicks on a Button
    // or ScrollBar are consumed by that widget before our vfunc runs.

    _isHeaderPress(x, y) {
        if (!this._headerBox || !this._headerBox.visible)
            return false;
        const [hx, hy] = this._headerBox.get_transformed_position();
        const [hw, hh] = this._headerBox.get_transformed_size();
        return x >= hx && x < hx + hw && y >= hy && y < hy + hh;
    }

    vfunc_button_press_event(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();
        if (!this._isHeaderPress(x, y))
            return Clutter.EVENT_PROPAGATE;

        this._isDragging = true;
        [this._dragStartX, this._dragStartY] = [x, y];
        [this._origX, this._origY] = this.get_position();
        this._grab = global.stage.grab(this);

        return Clutter.EVENT_STOP;
    }

    vfunc_motion_event(event) {
        if (!this._isDragging)
            return Clutter.EVENT_PROPAGATE;

        const [stageX, stageY] = event.get_coords();
        let newX = this._origX + (stageX - this._dragStartX);
        let newY = this._origY + (stageY - this._dragStartY);

        // Constrain to monitor bounds
        const monitor = Main.layoutManager.currentMonitor;
        if (monitor) {
            newX = Math.max(monitor.x,
                    Math.min(newX, monitor.x + monitor.width - this.width));
            newY = Math.max(monitor.y,
                    Math.min(newY, monitor.y + monitor.height - this.height));
        }

        this.set_position(newX, newY);
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event(event) {
        if (!this._isDragging)
            return Clutter.EVENT_PROPAGATE;

        this._isDragging = false;
        if (this._grab) {
            this._grab.dismiss();
            this._grab = null;
        }

        return Clutter.EVENT_STOP;
    }
});
