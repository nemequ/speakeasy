// SPDX-License-Identifier: MIT
// Speakeasy — transcript history store (Rust port of transcriptStore.js).
//
// On-disk layout:
//   $DATA_DIR/transcripts/
//     transcript-${ISO_TS_WITH_DASHES}.json
//     transcript-${ISO_TS_WITH_DASHES}-recovered.json
//
// On-disk JSON schema (snake_case — the GNOME JS frontend reads the
// same files during the overlap, so this is load-bearing):
//
//   {
//     "timestamp": "2026-04-20T12:34:56.789Z",
//     "raw_text": "...",
//     "cleaned_text": "..." | null,
//     "audio_path": "..." | null,
//     "ai_enabled": true,
//     "recovered": true,                // optional
//     "recovered_from": "...",          // optional, recovery only
//     "recovered_complete": true        // optional, recovery only
//   }
//
// In-memory `TranscriptEntry` uses camelCase names that the Swift/JS
// frontends consume; `ai_used` from older callers is normalized to
// `ai_enabled` on read to match transcriptStore.js' `entryFromJson()`.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

/// One transcript entry, both the save and load shape. Matches the
/// in-memory record the JS frontend consumes (camelCase field names).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TranscriptEntry {
    /// Filename without the `.json` extension. Used as a stable handle
    /// for `read_transcript_by_id` / `delete_transcript`.
    pub id: String,
    /// ISO-8601 timestamp string from the time of capture.
    pub timestamp: String,
    pub raw_text: String,
    #[serde(default)]
    pub cleaned_text: Option<String>,
    #[serde(default)]
    pub audio_path: Option<PathBuf>,
    pub ai_enabled: bool,
    #[serde(default)]
    pub recovered: bool,
    #[serde(default)]
    pub recovered_from: Option<String>,
    #[serde(default)]
    pub recovered_complete: Option<bool>,
}

fn strip_json_ext(name: &str) -> Option<&str> {
    name.strip_suffix(".json")
}

/// Parse an on-disk JSON blob into a `TranscriptEntry`, tolerating
/// missing optional fields and performing the `ai_used` → `ai_enabled`
/// translation the JS side also does.
fn entry_from_json(value: &Value, id: String) -> Result<TranscriptEntry> {
    let timestamp = value
        .get("timestamp")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .unwrap_or_default();
    let raw_text = value
        .get("raw_text")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .unwrap_or_default();
    let cleaned_text = value
        .get("cleaned_text")
        .and_then(|v| match v {
            Value::Null => None,
            Value::String(s) if s.is_empty() => None,
            Value::String(s) => Some(s.clone()),
            _ => None,
        });
    let audio_path = value
        .get("audio_path")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);

    // Accept either `ai_enabled` (new canonical) or legacy `ai_used`.
    // The JS `entryFromJson()` reads `ai_enabled`; older files written
    // by the session_log's stop record use `ai_used`. Prefer the
    // explicit transcript field.
    let ai_enabled = value
        .get("ai_enabled")
        .and_then(|v| v.as_bool())
        .or_else(|| value.get("ai_used").and_then(|v| v.as_bool()))
        .unwrap_or(false);

    let recovered = value
        .get("recovered")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let recovered_from = value
        .get("recovered_from")
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let recovered_complete = value.get("recovered_complete").and_then(|v| v.as_bool());

    Ok(TranscriptEntry {
        id,
        timestamp,
        raw_text,
        cleaned_text,
        audio_path,
        ai_enabled,
        recovered,
        recovered_from,
        recovered_complete,
    })
}

/// Serialize an entry into the canonical on-disk JSON shape. The
/// `recovered_*` fields are only emitted when meaningful to avoid
/// polluting fresh transcripts with `"recovered": false`.
fn entry_to_value(entry: &TranscriptEntry) -> Value {
    let mut map = serde_json::Map::new();
    map.insert(
        "timestamp".to_string(),
        Value::String(entry.timestamp.clone()),
    );
    map.insert(
        "raw_text".to_string(),
        Value::String(entry.raw_text.clone()),
    );
    map.insert(
        "cleaned_text".to_string(),
        match &entry.cleaned_text {
            Some(s) => Value::String(s.clone()),
            None => Value::Null,
        },
    );
    map.insert(
        "audio_path".to_string(),
        match &entry.audio_path {
            Some(p) => Value::String(p.to_string_lossy().into_owned()),
            None => Value::Null,
        },
    );
    map.insert("ai_enabled".to_string(), Value::Bool(entry.ai_enabled));
    if entry.recovered {
        map.insert("recovered".to_string(), Value::Bool(true));
        if let Some(src) = &entry.recovered_from {
            map.insert("recovered_from".to_string(), Value::String(src.clone()));
        }
        if let Some(c) = entry.recovered_complete {
            map.insert("recovered_complete".to_string(), Value::Bool(c));
        }
    }
    Value::Object(map)
}

/// Save a transcript to disk. Returns the absolute path of the written
/// file. The filename is derived from `entry.id` (e.g.
/// `transcript-2026-04-20T12-34-56-789Z`). Creates `transcripts_dir`
/// if it doesn't exist yet.
pub fn save_transcript(
    transcripts_dir: &Path,
    entry: &TranscriptEntry,
) -> Result<PathBuf> {
    if entry.id.is_empty() {
        return Err(anyhow!("transcript entry has empty id"));
    }
    fs::create_dir_all(transcripts_dir).with_context(|| {
        format!("creating transcripts dir {}", transcripts_dir.display())
    })?;

    let path = transcripts_dir.join(format!("{}.json", entry.id));
    let body = serde_json::to_string_pretty(&entry_to_value(entry))
        .context("serialize transcript")?;
    fs::write(&path, body)
        .with_context(|| format!("writing {}", path.display()))?;
    Ok(path)
}

/// Load a transcript from an explicit file path.
pub fn load_transcript(path: &Path) -> Result<TranscriptEntry> {
    let contents = fs::read_to_string(path)
        .with_context(|| format!("reading {}", path.display()))?;
    let value: Value = serde_json::from_str(&contents)
        .with_context(|| format!("parsing {}", path.display()))?;
    let id = path
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(strip_json_ext)
        .ok_or_else(|| anyhow!("path {} has no .json filename", path.display()))?
        .to_string();
    entry_from_json(&value, id)
}

/// List every transcript in `transcripts_dir`. Returned newest-first
/// by `timestamp` (falling back to `id` when timestamps match, so the
/// order is deterministic even for old files missing timestamps).
///
/// Unparseable / malformed files are silently skipped so one bad file
/// doesn't break the history UI.
pub fn list_transcripts(transcripts_dir: &Path) -> Result<Vec<TranscriptEntry>> {
    let iter = match fs::read_dir(transcripts_dir) {
        Ok(i) => i,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(e).with_context(|| {
                format!("enumerating {}", transcripts_dir.display())
            });
        }
    };

    let mut entries = Vec::new();
    for dirent in iter.flatten() {
        let path = dirent.path();
        let file_type = match dirent.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if !file_type.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if !name.ends_with(".json") {
            continue;
        }
        if let Ok(entry) = load_transcript(&path) {
            entries.push(entry);
        }
        // Silently skip malformed files — same as the JS loader.
    }

    // Newest first: descending by timestamp, id as tiebreaker.
    entries.sort_by(|a, b| {
        b.timestamp
            .cmp(&a.timestamp)
            .then_with(|| b.id.cmp(&a.id))
    });
    Ok(entries)
}

/// Load one transcript by id (filename without extension).
pub fn read_transcript_by_id(
    transcripts_dir: &Path,
    id: &str,
) -> Result<TranscriptEntry> {
    let path = transcripts_dir.join(format!("{}.json", id));
    load_transcript(&path)
}

/// Delete a transcript by id. Idempotent: a second delete on the same
/// id returns `Ok(())` rather than erroring.
pub fn delete_transcript(transcripts_dir: &Path, id: &str) -> Result<()> {
    let path = transcripts_dir.join(format!("{}.json", id));
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => {
            Err(e).with_context(|| format!("deleting {}", path.display()))
        }
    }
}

// ─── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn sample_entry(id: &str, timestamp: &str) -> TranscriptEntry {
        TranscriptEntry {
            id: id.to_string(),
            timestamp: timestamp.to_string(),
            raw_text: "hello world".to_string(),
            cleaned_text: Some("Hello, world.".to_string()),
            audio_path: Some(PathBuf::from("/tmp/audio.opus")),
            ai_enabled: true,
            recovered: false,
            recovered_from: None,
            recovered_complete: None,
        }
    }

    #[test]
    fn round_trip_save_and_load() {
        let tmp = TempDir::new().unwrap();
        let entry = sample_entry(
            "transcript-2026-04-20T12-00-00-000Z",
            "2026-04-20T12:00:00.000Z",
        );
        let path = save_transcript(tmp.path(), &entry).unwrap();
        let loaded = load_transcript(&path).unwrap();
        assert_eq!(loaded, entry);
    }

    #[test]
    fn read_by_id_matches_load() {
        let tmp = TempDir::new().unwrap();
        let entry = sample_entry(
            "transcript-2026-04-20T12-00-00-000Z",
            "2026-04-20T12:00:00.000Z",
        );
        save_transcript(tmp.path(), &entry).unwrap();
        let loaded = read_transcript_by_id(tmp.path(), &entry.id).unwrap();
        assert_eq!(loaded, entry);
    }

    #[test]
    fn ai_used_field_translates_to_ai_enabled_on_read() {
        // Older session-log-produced JSON may use `ai_used`; JS
        // `entryFromJson()` normalizes that to `ai_enabled` on read.
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("transcript-legacy.json");
        let body = serde_json::to_string_pretty(&json!({
            "timestamp": "2026-04-20T12:00:00.000Z",
            "raw_text": "legacy raw",
            "cleaned_text": null,
            "audio_path": null,
            "ai_used": true,
        }))
        .unwrap();
        fs::write(&path, body).unwrap();

        let loaded = load_transcript(&path).unwrap();
        assert!(loaded.ai_enabled, "ai_used maps to ai_enabled");
        assert_eq!(loaded.raw_text, "legacy raw");
    }

    #[test]
    fn list_order_is_newest_first() {
        let tmp = TempDir::new().unwrap();
        let old = sample_entry(
            "transcript-2026-04-18T00-00-00-000Z",
            "2026-04-18T00:00:00.000Z",
        );
        let mid = sample_entry(
            "transcript-2026-04-19T00-00-00-000Z",
            "2026-04-19T00:00:00.000Z",
        );
        let new = sample_entry(
            "transcript-2026-04-20T00-00-00-000Z",
            "2026-04-20T00:00:00.000Z",
        );
        // Intentionally save in a non-monotonic order.
        save_transcript(tmp.path(), &mid).unwrap();
        save_transcript(tmp.path(), &old).unwrap();
        save_transcript(tmp.path(), &new).unwrap();

        let list = list_transcripts(tmp.path()).unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].id, new.id);
        assert_eq!(list[1].id, mid.id);
        assert_eq!(list[2].id, old.id);
    }

    #[test]
    fn list_skips_non_json_and_malformed_files() {
        let tmp = TempDir::new().unwrap();
        let good = sample_entry(
            "transcript-2026-04-20T12-00-00-000Z",
            "2026-04-20T12:00:00.000Z",
        );
        save_transcript(tmp.path(), &good).unwrap();
        fs::write(tmp.path().join("not-a-transcript.txt"), "nope").unwrap();
        fs::write(tmp.path().join("transcript-broken.json"), "{not json").unwrap();

        let list = list_transcripts(tmp.path()).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, good.id);
    }

    #[test]
    fn list_empty_for_missing_dir() {
        let tmp = TempDir::new().unwrap();
        let list =
            list_transcripts(&tmp.path().join("does-not-exist")).unwrap();
        assert!(list.is_empty());
    }

    #[test]
    fn load_tolerates_missing_optional_fields() {
        // Mirrors "JS loader handles sparse JSON" behavior.
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("transcript-sparse.json");
        let body = serde_json::to_string_pretty(&json!({
            "timestamp": "2026-04-20T12:00:00.000Z",
            "raw_text": "bare",
            "ai_enabled": false,
        }))
        .unwrap();
        fs::write(&path, body).unwrap();

        let loaded = load_transcript(&path).unwrap();
        assert_eq!(loaded.raw_text, "bare");
        assert_eq!(loaded.cleaned_text, None);
        assert_eq!(loaded.audio_path, None);
        assert!(!loaded.recovered);
        assert_eq!(loaded.recovered_from, None);
        assert_eq!(loaded.recovered_complete, None);
    }

    #[test]
    fn recovered_flags_round_trip_through_save_and_load() {
        let tmp = TempDir::new().unwrap();
        let mut entry = sample_entry(
            "transcript-2026-04-20T12-00-00-000Z-recovered",
            "2026-04-20T12:00:00.000Z",
        );
        entry.recovered = true;
        entry.recovered_from = Some("session-2026-04-20T12-00-00-000Z.jsonl".to_string());
        entry.recovered_complete = Some(false);

        let path = save_transcript(tmp.path(), &entry).unwrap();
        // Sanity: the on-disk JSON has the `recovered*` fields.
        let raw: Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["recovered"], true);
        assert_eq!(raw["recovered_from"], "session-2026-04-20T12-00-00-000Z.jsonl");
        assert_eq!(raw["recovered_complete"], false);

        let loaded = load_transcript(&path).unwrap();
        assert_eq!(loaded, entry);
    }

    #[test]
    fn non_recovered_entry_omits_recovered_fields_on_disk() {
        let tmp = TempDir::new().unwrap();
        let entry = sample_entry(
            "transcript-2026-04-20T12-00-00-000Z",
            "2026-04-20T12:00:00.000Z",
        );
        let path = save_transcript(tmp.path(), &entry).unwrap();
        let raw: Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(raw.get("recovered").is_none());
        assert!(raw.get("recovered_from").is_none());
        assert!(raw.get("recovered_complete").is_none());
    }

    #[test]
    fn delete_removes_file_and_is_idempotent() {
        let tmp = TempDir::new().unwrap();
        let entry = sample_entry(
            "transcript-2026-04-20T12-00-00-000Z",
            "2026-04-20T12:00:00.000Z",
        );
        let path = save_transcript(tmp.path(), &entry).unwrap();
        assert!(path.exists());

        delete_transcript(tmp.path(), &entry.id).unwrap();
        assert!(!path.exists());

        // Second delete is a no-op, not an error.
        delete_transcript(tmp.path(), &entry.id).unwrap();
    }

    #[test]
    fn save_rejects_empty_id() {
        let tmp = TempDir::new().unwrap();
        let mut entry = sample_entry("", "2026-04-20T12:00:00.000Z");
        entry.id = String::new();
        let err = save_transcript(tmp.path(), &entry).unwrap_err();
        assert!(err.to_string().contains("empty id"));
    }

    #[test]
    fn existing_transcripts_without_optional_fields_still_decode() {
        // Older transcript JSON files lack many optional fields. With
        // #[serde(default)] they should still decode cleanly.
        let tmp = TempDir::new().unwrap();
        let id = "transcript-t2";
        let json = r#"{"timestamp":"2026-04-21T00:00:00Z","raw_text":"hello","cleaned_text":"Hello!","ai_enabled":false}"#;
        std::fs::write(tmp.path().join(format!("{}.json", id)), json).unwrap();
        let entry = read_transcript_by_id(tmp.path(), id).unwrap();
        assert_eq!(entry.raw_text, "hello");
        assert!(!entry.ai_enabled);
    }
}
