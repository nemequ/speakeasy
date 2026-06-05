// SPDX-License-Identifier: MIT
// Speakeasy — Crash-safe incremental session log (Rust port of sessionLog.js)
//
// See `sessionLog.js` in the repo root for the full design rationale.
// In short: a dictation session appends a JSON Lines file as each STT
// segment finalizes, flushing after every line so a SIGKILL loses at
// most the final partial line. A `stop` record is written at the end
// with the raw + AI-cleaned text. `mark_completed()` moves the file
// into `sessions/completed/` once the transcript JSON has been saved.
//
// On startup, `recover_orphans()` scans the top-level `sessions/`
// directory and turns any leftover JSONL files into
// `transcript-${ts}-recovered.json` files in the transcripts dir so
// the user's words aren't lost.
//
// On-disk schema (one JSON object per line):
//   {"type":"start", "timestamp":"...", "audio_path":"...", "uuid":"..."}
//   {"type":"final", "timestamp":"...", "text":"..."}
//   {"type":"stop",  "timestamp":"...", "raw_text":"...",
//                    "cleaned_text":"...", "ai_used": bool}
//
// The recovered transcript JSON shape matches what the JS frontend's
// `extension.js _saveTranscript()` produces so the GNOME frontend
// keeps reading the same files post-migration.

use anyhow::{Context, Result};
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

/// Current ISO-8601 timestamp, matching JavaScript's
/// `new Date().toISOString()` format: `YYYY-MM-DDTHH:MM:SS.sssZ`.
fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Derive the `completed/` subdirectory beneath `sessions_dir`, creating
/// it if necessary.
fn completed_dir(sessions_dir: &Path) -> Result<PathBuf> {
    let completed = sessions_dir.join("completed");
    fs::create_dir_all(&completed).with_context(|| {
        format!("creating completed dir {}", completed.display())
    })?;
    Ok(completed)
}

/// Append-only, crash-safe log of one dictation session.
///
/// Lifecycle:
///
/// ```ignore
/// let mut log = SessionLog::start(sessions_dir, Some(&audio_path), Some("uuid"))?;
/// log.append_final("hello world")?;
/// log.append_final("this is a test")?;
/// log.stop("hello world this is a test", Some("Hello world. This is a test."), true)?;
/// log.mark_completed()?;  // moves the file into `completed/`
/// ```
///
/// Each call writes one JSON line and flushes the kernel buffers before
/// returning. A SIGKILL between calls preserves every already-flushed
/// line; the next process startup's `recover_orphans()` pass converts
/// the leftover file into a transcript JSON.
pub struct SessionLog {
    sessions_dir: PathBuf,
    path: PathBuf,
    writer: Option<BufWriter<File>>,
}

impl SessionLog {
    /// Open a new log file and write the `start` record.
    ///
    /// The filename is `session-${ISO_TIMESTAMP_WITH_DASHES}.jsonl`
    /// inside `sessions_dir` (which is created if missing).
    pub fn start(
        sessions_dir: &Path,
        audio_path: Option<&Path>,
        uuid: Option<&str>,
    ) -> Result<Self> {
        fs::create_dir_all(sessions_dir).with_context(|| {
            format!("creating sessions dir {}", sessions_dir.display())
        })?;

        let ts_for_file = now_iso().replace([':', '.'], "-");
        let filename = format!("session-{}.jsonl", ts_for_file);
        let path = sessions_dir.join(filename);

        // REPLACE_DESTINATION semantics — fresh file every time.
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&path)
            .with_context(|| format!("creating session log {}", path.display()))?;
        // Small buffer so each `flush()` hits the kernel immediately
        // but we still avoid a syscall per byte. JSON lines are
        // short, so 4 KiB is comfortable.
        let writer = BufWriter::with_capacity(4096, file);

        let mut log = Self {
            sessions_dir: sessions_dir.to_path_buf(),
            path,
            writer: Some(writer),
        };

        let start_record = json!({
            "type": "start",
            "timestamp": now_iso(),
            "audio_path": audio_path.map(|p| p.to_string_lossy().into_owned()),
            "uuid": uuid,
        });
        log.write_line(&start_record)?;
        Ok(log)
    }

    /// Append one finalized STT segment. Empty strings are silently
    /// ignored (matching the JS semantics).
    ///
    /// Each call is independently durable: the line is written and
    /// flushed to the kernel page cache before returning.
    pub fn append_final(&mut self, text: &str) -> Result<()> {
        if text.is_empty() {
            return Ok(());
        }
        let record = json!({
            "type": "final",
            "timestamp": now_iso(),
            "text": text,
        });
        self.write_line(&record)
    }

    /// Write the `stop` record. The log is "complete from the writer's
    /// perspective" at this point but still lives in the top-level
    /// `sessions/` directory — call `mark_completed()` once the
    /// transcript JSON has been saved to move it into `completed/`.
    pub fn stop(
        &mut self,
        raw_text: &str,
        cleaned_text: Option<&str>,
        ai_used: bool,
    ) -> Result<()> {
        let record = json!({
            "type": "stop",
            "timestamp": now_iso(),
            "raw_text": raw_text,
            "cleaned_text": cleaned_text,
            "ai_used": ai_used,
        });
        self.write_line(&record)
    }

    /// Close the stream and move the log file into `completed/`.
    /// Consumes the log — no further writes are possible.
    pub fn mark_completed(mut self) -> Result<()> {
        // Drop the writer to release the handle on Windows-style
        // filesystems and flush any residual buffer.
        if let Some(mut w) = self.writer.take() {
            w.flush().ok();
        }

        let completed = completed_dir(&self.sessions_dir)?;
        let filename = self
            .path
            .file_name()
            .context("session log has no filename")?;
        let dest = completed.join(filename);
        fs::rename(&self.path, &dest).with_context(|| {
            format!(
                "moving {} to {}",
                self.path.display(),
                dest.display()
            )
        })?;
        Ok(())
    }

    /// Close the stream without moving the file. Use this to abandon
    /// a session — the file stays in the top-level directory and
    /// will be picked up by the next `recover_orphans()` pass.
    pub fn close(mut self) {
        if let Some(mut w) = self.writer.take() {
            let _ = w.flush();
        }
    }

    /// Path of the currently open log file.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Serialize one record as a single JSON line, write it, flush so
    /// the bytes are in the kernel page cache.
    fn write_line(&mut self, value: &Value) -> Result<()> {
        let writer = self
            .writer
            .as_mut()
            .context("session log is closed")?;
        let line = serde_json::to_string(value).context("serialize session record")?;
        writer.write_all(line.as_bytes())?;
        writer.write_all(b"\n")?;
        // `BufWriter::flush()` does NOT fsync(2) — it just pushes the
        // buffered bytes through write(2) into the kernel page cache.
        // That's exactly what we want (see note in sessionLog.js).
        writer.flush()?;
        Ok(())
    }
}

impl Drop for SessionLog {
    fn drop(&mut self) {
        if let Some(mut w) = self.writer.take() {
            let _ = w.flush();
        }
    }
}

/// Parsed session log — the in-memory view of a `.jsonl` file, produced
/// by `parse_session_log()` and used both for recovery and for tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSession {
    pub raw_text: String,
    pub cleaned_text: Option<String>,
    pub ai_used: bool,
    pub finals: Vec<String>,
    pub audio_path: Option<PathBuf>,
    pub start_timestamp: Option<String>,
    pub stop_timestamp: Option<String>,
    pub complete: bool,
}

/// One recovery result, matching the JS `recoverOrphans()` result shape.
#[derive(Debug, Clone)]
pub struct RecoveryResult {
    /// Path to the original orphan `.jsonl` file (post-move, this
    /// points at the file's *former* location in `sessions/`).
    pub source: PathBuf,
    /// Path to the newly-written `transcript-*-recovered.json`.
    pub transcript: PathBuf,
    pub raw_text: String,
    pub complete: bool,
}

/// Parse a session log file. Returns `Ok(None)` when the file is empty
/// or contains no usable content (e.g. only a torn line). A trailing
/// torn/incomplete JSON line is tolerated — it simply gets skipped.
pub fn parse_session_log(path: &Path) -> Result<Option<ParsedSession>> {
    let contents = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };

    let mut finals: Vec<String> = Vec::new();
    let mut start_timestamp: Option<String> = None;
    let mut stop_timestamp: Option<String> = None;
    let mut audio_path: Option<PathBuf> = None;
    let mut raw_text: Option<String> = None;
    let mut cleaned_text: Option<String> = None;
    let mut ai_used = false;
    let mut complete = false;

    for line in contents.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        let obj: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            // A trailing torn line is expected after a crash. Skip.
            Err(_) => continue,
        };
        let kind = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match kind {
            "start" => {
                start_timestamp = obj
                    .get("timestamp")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned);
                audio_path = obj
                    .get("audio_path")
                    .and_then(|v| v.as_str())
                    .map(PathBuf::from);
            }
            "final" => {
                if let Some(text) = obj.get("text").and_then(|v| v.as_str()) {
                    if !text.is_empty() {
                        finals.push(text.to_owned());
                    }
                }
            }
            "stop" => {
                stop_timestamp = obj
                    .get("timestamp")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned);
                raw_text = obj
                    .get("raw_text")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned);
                cleaned_text = obj
                    .get("cleaned_text")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned);
                ai_used = obj
                    .get("ai_used")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                complete = true;
            }
            _ => {}
        }
    }

    if finals.is_empty() && raw_text.is_none() {
        return Ok(None);
    }

    // If the stop record is missing, synthesize raw_text from finals.
    let raw_text = raw_text.unwrap_or_else(|| finals.join(" ").trim().to_string());

    Ok(Some(ParsedSession {
        raw_text,
        cleaned_text,
        ai_used,
        finals,
        audio_path,
        start_timestamp,
        stop_timestamp,
        complete,
    }))
}

/// Scan the top-level `sessions_dir` for orphaned `.jsonl` files (the
/// ones that never made it into `completed/`) and convert each into a
/// `transcript-${ts}-recovered.json` in `transcripts_dir`. After a
/// successful recovery the orphan is moved into `sessions/completed/`
/// so it isn't reprocessed next startup — making this function
/// idempotent.
///
/// Enumeration is **not** recursive. Files already under `completed/`
/// are ignored.
pub fn recover_orphans(
    sessions_dir: &Path,
    transcripts_dir: &Path,
) -> Result<Vec<RecoveryResult>> {
    fs::create_dir_all(sessions_dir).with_context(|| {
        format!("creating sessions dir {}", sessions_dir.display())
    })?;
    let completed = completed_dir(sessions_dir)?;
    fs::create_dir_all(transcripts_dir).with_context(|| {
        format!("creating transcripts dir {}", transcripts_dir.display())
    })?;

    let mut results = Vec::new();
    let iter = match fs::read_dir(sessions_dir) {
        Ok(i) => i,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(results),
        Err(e) => {
            return Err(e).with_context(|| {
                format!("enumerating {}", sessions_dir.display())
            });
        }
    };

    for entry in iter {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if !file_type.is_file() {
            continue;
        }
        let name = entry.file_name();
        let name_str = match name.to_str() {
            Some(s) => s,
            None => continue,
        };
        if !name_str.ends_with(".jsonl") {
            continue;
        }

        let path = entry.path();
        let parsed = match parse_session_log(&path) {
            Ok(Some(p)) => p,
            Ok(None) => {
                // Empty / no usable content. Leave the file in place;
                // it's harmless and the next run will re-skip it.
                continue;
            }
            Err(_) => continue,
        };

        let timestamp = parsed
            .stop_timestamp
            .clone()
            .or_else(|| parsed.start_timestamp.clone())
            .unwrap_or_else(now_iso);

        // Build the transcript JSON in the same shape as
        // extension.js `_saveTranscript()` plus the `recovered` marker
        // trio. Field order follows the JS output for stability.
        let transcript = json!({
            "timestamp": timestamp,
            "raw_text": parsed.raw_text,
            "cleaned_text": parsed.cleaned_text,
            "audio_path": parsed.audio_path
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
            "ai_enabled": parsed.ai_used,
            "recovered": true,
            "recovered_from": name_str,
            "recovered_complete": parsed.complete,
        });

        let ts_for_file = timestamp.replace([':', '.'], "-");
        let transcript_filename =
            format!("transcript-{}-recovered.json", ts_for_file);
        let transcript_path = transcripts_dir.join(&transcript_filename);

        let body = serde_json::to_string_pretty(&transcript)
            .context("serialize recovery transcript")?;
        fs::write(&transcript_path, body).with_context(|| {
            format!("writing {}", transcript_path.display())
        })?;

        // Move the orphan into completed/ so we don't reprocess it.
        let dest = completed.join(name_str);
        fs::rename(&path, &dest).with_context(|| {
            format!("moving {} to {}", path.display(), dest.display())
        })?;

        results.push(RecoveryResult {
            source: path,
            transcript: transcript_path,
            raw_text: parsed.raw_text,
            complete: parsed.complete,
        });
    }

    Ok(results)
}

// ─── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::fs;
    use tempfile::TempDir;

    fn read_lines(path: &Path) -> Vec<String> {
        fs::read_to_string(path)
            .unwrap()
            .split('\n')
            .filter(|l| !l.is_empty())
            .map(str::to_owned)
            .collect()
    }

    // ─── SessionLog ───────────────────────────────────────────────

    #[test]
    fn start_opens_a_new_file_with_a_start_record() {
        let tmp = TempDir::new().unwrap();
        let log = SessionLog::start(
            tmp.path(),
            Some(Path::new("/tmp/audio.opus")),
            Some("u1"),
        )
        .unwrap();
        let path = log.path().to_path_buf();
        assert!(path.starts_with(tmp.path()));
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("jsonl"));
        log.close();

        let lines = read_lines(&path);
        assert_eq!(lines.len(), 1);
        let obj: Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(obj["type"], "start");
        assert_eq!(obj["audio_path"], "/tmp/audio.opus");
        assert_eq!(obj["uuid"], "u1");
        assert!(obj["timestamp"].is_string());
    }

    #[test]
    fn append_final_writes_one_line_per_call_and_flushes_immediately() {
        let tmp = TempDir::new().unwrap();
        let mut log = SessionLog::start(tmp.path(), None, None).unwrap();
        let path = log.path().to_path_buf();

        log.append_final("hello").unwrap();
        // The flush-on-append contract: a separate read should see
        // the line *while the log is still open*.
        let mid = read_lines(&path);
        assert_eq!(mid.len(), 2, "start + 1 final visible mid-stream");
        let final0: Value = serde_json::from_str(&mid[1]).unwrap();
        assert_eq!(final0["type"], "final");
        assert_eq!(final0["text"], "hello");

        log.append_final("world").unwrap();
        log.append_final("how are you").unwrap();
        log.close();

        let lines = read_lines(&path);
        assert_eq!(lines.len(), 4);
        let second: Value = serde_json::from_str(&lines[2]).unwrap();
        let third: Value = serde_json::from_str(&lines[3]).unwrap();
        assert_eq!(second["text"], "world");
        assert_eq!(third["text"], "how are you");
    }

    #[test]
    fn append_final_ignores_empty_text() {
        let tmp = TempDir::new().unwrap();
        let mut log = SessionLog::start(tmp.path(), None, None).unwrap();
        let path = log.path().to_path_buf();
        log.append_final("").unwrap();
        log.close();
        let lines = read_lines(&path);
        assert_eq!(lines.len(), 1, "only the start record should be present");
    }

    #[test]
    fn stop_writes_a_stop_record_with_all_fields() {
        let tmp = TempDir::new().unwrap();
        let mut log = SessionLog::start(tmp.path(), None, None).unwrap();
        let path = log.path().to_path_buf();
        log.append_final("hello world").unwrap();
        log.stop("hello world", Some("Hello, world."), true).unwrap();
        log.close();

        let lines = read_lines(&path);
        assert_eq!(lines.len(), 3);
        let stop: Value = serde_json::from_str(&lines[2]).unwrap();
        assert_eq!(stop["type"], "stop");
        assert_eq!(stop["raw_text"], "hello world");
        assert_eq!(stop["cleaned_text"], "Hello, world.");
        assert_eq!(stop["ai_used"], true);
    }

    #[test]
    fn mark_completed_moves_the_file_into_completed() {
        let tmp = TempDir::new().unwrap();
        let mut log = SessionLog::start(tmp.path(), None, None).unwrap();
        let path = log.path().to_path_buf();
        log.append_final("foo").unwrap();
        log.stop("foo", None, false).unwrap();
        log.mark_completed().unwrap();

        assert!(!path.exists(), "original moved");
        let filename = path.file_name().unwrap();
        let moved = tmp.path().join("completed").join(filename);
        assert!(moved.exists(), "file is in completed/");
    }

    // ─── parse_session_log ────────────────────────────────────────

    #[test]
    fn parses_a_fully_written_log() {
        let tmp = TempDir::new().unwrap();
        let mut log = SessionLog::start(
            tmp.path(),
            Some(Path::new("/aud.opus")),
            Some("abc"),
        )
        .unwrap();
        let path = log.path().to_path_buf();
        log.append_final("one").unwrap();
        log.append_final("two").unwrap();
        log.append_final("three").unwrap();
        log.stop("one two three", Some("One. Two. Three."), true)
            .unwrap();
        log.close();

        let parsed = parse_session_log(&path).unwrap().unwrap();
        assert!(parsed.complete);
        assert_eq!(parsed.raw_text, "one two three");
        assert_eq!(parsed.cleaned_text.as_deref(), Some("One. Two. Three."));
        assert!(parsed.ai_used);
        assert_eq!(parsed.finals.len(), 3);
        assert_eq!(parsed.audio_path.as_deref(), Some(Path::new("/aud.opus")));
    }

    #[test]
    fn parses_a_log_with_no_stop_record_orphan() {
        let tmp = TempDir::new().unwrap();
        let mut log = SessionLog::start(tmp.path(), None, None).unwrap();
        let path = log.path().to_path_buf();
        log.append_final("crash victim 1").unwrap();
        log.append_final("crash victim 2").unwrap();
        // Simulate a crash: no stop(), just drop the writer.
        log.close();

        let parsed = parse_session_log(&path).unwrap().unwrap();
        assert!(!parsed.complete);
        assert_eq!(parsed.raw_text, "crash victim 1 crash victim 2");
        assert_eq!(parsed.cleaned_text, None);
        assert_eq!(parsed.finals.len(), 2);
    }

    #[test]
    fn parses_a_log_with_a_torn_trailing_line() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("torn.jsonl");
        let good_start = serde_json::to_string(&json!({
            "type": "start", "timestamp": "2026-04-08T00:00:00Z", "audio_path": null,
        }))
        .unwrap();
        let good_final = serde_json::to_string(&json!({
            "type": "final", "timestamp": "2026-04-08T00:00:01Z", "text": "recoverable",
        }))
        .unwrap();
        let torn = r#"{"type":"final","timestamp":"2026-04-08T00:00:02Z","tex"#;
        fs::write(&path, format!("{good_start}\n{good_final}\n{torn}")).unwrap();

        let parsed = parse_session_log(&path).unwrap().unwrap();
        assert!(!parsed.complete);
        assert_eq!(parsed.finals.len(), 1);
        assert_eq!(parsed.finals[0], "recoverable");
    }

    #[test]
    fn returns_none_for_an_empty_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("empty.jsonl");
        fs::write(&path, "").unwrap();
        let parsed = parse_session_log(&path).unwrap();
        assert!(parsed.is_none());
    }

    // ─── recover_orphans ──────────────────────────────────────────

    #[test]
    fn recovers_an_orphan_session_into_a_transcript_json() {
        let tmp = TempDir::new().unwrap();
        let transcripts = tmp.path().join("transcripts");

        // Create an orphan.
        let mut log = SessionLog::start(
            tmp.path(),
            None,
            Some("orphan-uuid"),
        )
        .unwrap();
        let source = log.path().to_path_buf();
        log.append_final("this never made it").unwrap();
        log.append_final("to a transcript").unwrap();
        // No stop(), no mark_completed() — pure orphan.
        log.close();

        let results = recover_orphans(tmp.path(), &transcripts).unwrap();
        assert_eq!(results.len(), 1);
        let r = &results[0];
        assert!(!r.complete);
        assert_eq!(r.raw_text, "this never made it to a transcript");

        let body = fs::read_to_string(&r.transcript).unwrap();
        let t: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(t["recovered"], true);
        assert_eq!(t["recovered_complete"], false);
        assert_eq!(t["raw_text"], "this never made it to a transcript");
        // `recovered_from` should be the original basename.
        assert_eq!(
            t["recovered_from"].as_str(),
            source.file_name().and_then(|n| n.to_str())
        );

        // Source file should have moved to completed/.
        assert!(!source.exists());
        let completed = tmp
            .path()
            .join("completed")
            .join(source.file_name().unwrap());
        assert!(completed.exists());
    }

    #[test]
    fn does_not_recover_already_completed_sessions() {
        let tmp = TempDir::new().unwrap();
        let transcripts = tmp.path().join("transcripts");
        let mut log = SessionLog::start(tmp.path(), None, None).unwrap();
        log.append_final("done").unwrap();
        log.stop("done", None, false).unwrap();
        log.mark_completed().unwrap();

        let results = recover_orphans(tmp.path(), &transcripts).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn recover_orphans_is_idempotent() {
        let tmp = TempDir::new().unwrap();
        let transcripts = tmp.path().join("transcripts");
        let mut log = SessionLog::start(tmp.path(), None, None).unwrap();
        log.append_final("hello").unwrap();
        log.close();

        let first = recover_orphans(tmp.path(), &transcripts).unwrap();
        assert_eq!(first.len(), 1);
        // Second pass: orphan has been moved, nothing to do.
        let second = recover_orphans(tmp.path(), &transcripts).unwrap();
        assert!(second.is_empty());
    }

    #[test]
    fn recovers_multiple_orphans_in_one_pass() {
        let tmp = TempDir::new().unwrap();
        let transcripts = tmp.path().join("transcripts");

        // Two orphans, each with a hand-written unique filename so we
        // don't have to sleep waiting for the ISO-timestamp resolution
        // to tick over.
        let jsonl_a = tmp.path().join("session-2026-04-20T00-00-00-000Z.jsonl");
        fs::write(
            &jsonl_a,
            r#"{"type":"start","timestamp":"2026-04-20T00:00:00.000Z","audio_path":null,"uuid":null}
{"type":"final","timestamp":"2026-04-20T00:00:01.000Z","text":"alpha"}
"#,
        )
        .unwrap();

        let jsonl_b = tmp.path().join("session-2026-04-20T00-00-05-000Z.jsonl");
        fs::write(
            &jsonl_b,
            r#"{"type":"start","timestamp":"2026-04-20T00:00:05.000Z","audio_path":null,"uuid":null}
{"type":"final","timestamp":"2026-04-20T00:00:06.000Z","text":"bravo"}
{"type":"final","timestamp":"2026-04-20T00:00:07.000Z","text":"charlie"}
"#,
        )
        .unwrap();

        let results = recover_orphans(tmp.path(), &transcripts).unwrap();
        assert_eq!(results.len(), 2);
        let mut texts: Vec<String> = results.iter().map(|r| r.raw_text.clone()).collect();
        texts.sort();
        assert_eq!(texts[0], "alpha");
        assert_eq!(texts[1], "bravo charlie");
    }

    #[test]
    fn skips_empty_orphan_files_cleanly() {
        let tmp = TempDir::new().unwrap();
        let transcripts = tmp.path().join("transcripts");
        let path = tmp.path().join("session-empty.jsonl");
        fs::write(&path, "").unwrap();
        let results = recover_orphans(tmp.path(), &transcripts).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn recovered_transcript_shape_matches_extension_js() {
        // Check that the recovered transcript JSON has exactly the
        // fields the JS frontend consumes: timestamp, raw_text,
        // cleaned_text, audio_path, ai_enabled, plus the three
        // recovered_* markers.
        let tmp = TempDir::new().unwrap();
        let transcripts = tmp.path().join("transcripts");

        let jsonl = tmp.path().join("session-2026-04-20T10-00-00-000Z.jsonl");
        fs::write(
            &jsonl,
            r#"{"type":"start","timestamp":"2026-04-20T10:00:00.000Z","audio_path":"/tmp/a.opus","uuid":"u"}
{"type":"final","timestamp":"2026-04-20T10:00:01.000Z","text":"one"}
{"type":"final","timestamp":"2026-04-20T10:00:02.000Z","text":"two"}
{"type":"stop","timestamp":"2026-04-20T10:00:03.000Z","raw_text":"one two","cleaned_text":"One. Two.","ai_used":true}
"#,
        )
        .unwrap();

        let results = recover_orphans(tmp.path(), &transcripts).unwrap();
        assert_eq!(results.len(), 1);
        let body = fs::read_to_string(&results[0].transcript).unwrap();
        let t: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(t["timestamp"], "2026-04-20T10:00:03.000Z");
        assert_eq!(t["raw_text"], "one two");
        assert_eq!(t["cleaned_text"], "One. Two.");
        assert_eq!(t["audio_path"], "/tmp/a.opus");
        assert_eq!(t["ai_enabled"], true);
        assert_eq!(t["recovered"], true);
        assert_eq!(
            t["recovered_from"],
            "session-2026-04-20T10-00-00-000Z.jsonl"
        );
        assert_eq!(t["recovered_complete"], true);

        // Filename format: transcript-<ts-with-dashes>-recovered.json
        let name = results[0]
            .transcript
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap();
        assert!(name.starts_with("transcript-"));
        assert!(name.ends_with("-recovered.json"));
    }
}
