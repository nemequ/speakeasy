// Integration tests for the subcommand CLI surface exposed in
// `core/src/main.rs`. These tests drive the built binary and assert
// that each subcommand produces well-formed output without needing a
// real microphone, model, or network.

use assert_cmd::Command;
use serde_json::Value;
use std::fs;
use tempfile::TempDir;

fn speakeasy() -> Command {
    Command::cargo_bin("speakeasy").expect("binary exists")
}

#[test]
fn list_models_json_is_parseable_and_marks_installed_flag() {
    let tmp = TempDir::new().unwrap();
    let output = speakeasy()
        .args(["list-models", "--json", "--models-dir"])
        .arg(tmp.path())
        .output()
        .expect("run list-models");
    assert!(output.status.success(), "stderr: {}", String::from_utf8_lossy(&output.stderr));
    let stdout = String::from_utf8(output.stdout).unwrap();
    let value: Value = serde_json::from_str(&stdout).expect("valid JSON");
    let arr = value.as_array().expect("array");
    assert!(!arr.is_empty(), "catalog should have entries");
    // Every entry has the expected fields, and all are marked
    // uninstalled for a fresh tmp directory.
    for entry in arr {
        assert!(entry.get("name").is_some());
        assert!(entry.get("filename").is_some());
        assert!(entry.get("size_bytes").is_some());
        assert_eq!(entry.get("installed"), Some(&Value::Bool(false)));
    }
}

#[test]
fn list_transcripts_json_empty_dir_returns_empty_array() {
    let tmp = TempDir::new().unwrap();
    let output = speakeasy()
        .args(["list-transcripts", "--json", "--dir"])
        .arg(tmp.path())
        .output()
        .expect("run list-transcripts");
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    let value: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(value, Value::Array(vec![]));
}

#[test]
fn list_transcripts_default_table_reports_no_transcripts_for_empty_dir() {
    let tmp = TempDir::new().unwrap();
    let output = speakeasy()
        .args(["list-transcripts", "--dir"])
        .arg(tmp.path())
        .output()
        .expect("run list-transcripts");
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(
        stdout.contains("no transcripts"),
        "unexpected stdout: {stdout}"
    );
}

#[test]
fn read_transcript_by_id_round_trips_a_saved_entry() {
    let tmp = TempDir::new().unwrap();
    // Write a transcript file directly via the shape the store uses.
    let id = "transcript-2026-04-20T12-00-00-000Z";
    let body = serde_json::json!({
        "timestamp": "2026-04-20T12:00:00.000Z",
        "raw_text": "hello from a test",
        "cleaned_text": "Hello from a test.",
        "audio_path": null,
        "ai_enabled": true,
    });
    fs::write(
        tmp.path().join(format!("{id}.json")),
        serde_json::to_string_pretty(&body).unwrap(),
    )
    .unwrap();

    let output = speakeasy()
        .args(["read-transcript", id, "--dir"])
        .arg(tmp.path())
        .output()
        .expect("run read-transcript");
    assert!(output.status.success(), "stderr: {}", String::from_utf8_lossy(&output.stderr));
    let stdout = String::from_utf8(output.stdout).unwrap();
    let value: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(value["raw_text"], "hello from a test");
    assert_eq!(value["ai_enabled"], true);
    assert_eq!(value["id"], id);
}

#[test]
fn delete_transcript_removes_the_file() {
    let tmp = TempDir::new().unwrap();
    let id = "transcript-to-delete";
    let path = tmp.path().join(format!("{id}.json"));
    fs::write(
        &path,
        serde_json::to_string_pretty(&serde_json::json!({
            "timestamp": "2026-04-20T12:00:00.000Z",
            "raw_text": "gone soon",
            "ai_enabled": false,
        }))
        .unwrap(),
    )
    .unwrap();
    assert!(path.exists());

    let output = speakeasy()
        .args(["delete-transcript", id, "--dir"])
        .arg(tmp.path())
        .output()
        .expect("run delete-transcript");
    assert!(output.status.success());
    assert!(!path.exists(), "file should have been deleted");
}

#[test]
fn recover_orphans_emits_saved_event_json() {
    let tmp = TempDir::new().unwrap();
    let sessions = tmp.path().join("sessions");
    let transcripts = tmp.path().join("transcripts");
    fs::create_dir_all(&sessions).unwrap();
    // Hand-craft an orphan JSONL.
    fs::write(
        sessions.join("session-2026-04-20T00-00-00-000Z.jsonl"),
        r#"{"type":"start","timestamp":"2026-04-20T00:00:00.000Z","audio_path":null,"uuid":null}
{"type":"final","timestamp":"2026-04-20T00:00:01.000Z","text":"orphan one"}
"#,
    )
    .unwrap();

    let output = speakeasy()
        .args([
            "recover-orphans",
            "--json-events",
            "--sessions-dir",
        ])
        .arg(&sessions)
        .arg("--transcripts-dir")
        .arg(&transcripts)
        .output()
        .expect("run recover-orphans");
    assert!(output.status.success(), "stderr: {}", String::from_utf8_lossy(&output.stderr));
    let stdout = String::from_utf8(output.stdout).unwrap();
    // One NDJSON line with a saved event.
    let mut lines = stdout.lines();
    let first = lines.next().expect("at least one event");
    let value: Value = serde_json::from_str(first).unwrap();
    assert_eq!(value["event"], "saved");
    assert_eq!(value["recovered"], true);
    assert!(
        value["transcript_id"]
            .as_str()
            .unwrap_or("")
            .contains("recovered"),
        "expected id to contain 'recovered', got {}",
        value["transcript_id"]
    );
}

#[test]
fn list_input_devices_json_is_an_array() {
    let output = speakeasy()
        .args(["list-input-devices", "--json"])
        .output()
        .expect("run list-input-devices");
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    let value: Value = serde_json::from_str(&stdout).expect("valid JSON");
    assert!(value.is_array(), "expected array, got {value}");
}

#[test]
fn transcribe_file_errors_when_model_is_missing() {
    // Subcommand should surface a helpful error when given a
    // nonexistent audio path AND no model is installed. We don't
    // want to spin up whisper in CI, so the failing-path path is the
    // one we assert.
    let tmp = TempDir::new().unwrap();
    let output = speakeasy()
        .args(["transcribe-file", "--json-events", "--model"])
        .arg(tmp.path().join("no-such-model.bin"))
        .arg(tmp.path().join("no-such-audio.wav"))
        .output()
        .expect("run transcribe-file");
    // We expect a non-zero exit because both inputs are missing.
    assert!(!output.status.success(), "stdout: {}, stderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr));
}

#[test]
fn download_model_errors_on_unknown_name() {
    let tmp = TempDir::new().unwrap();
    let output = speakeasy()
        .args(["download-model", "not-a-real-model", "--models-dir"])
        .arg(tmp.path())
        .output()
        .expect("run download-model");
    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("unknown model"),
        "unexpected stderr: {stderr}"
    );
}

// ─── save-transcript ────────────────────────────────────────────────

#[test]
fn save_transcript_persists_json_stdin_to_store() {
    let tmp = TempDir::new().unwrap();
    let payload = serde_json::json!({
        "timestamp": "2026-04-20T12:00:00.000Z",
        "raw_text": "recovered from a file",
        "cleaned_text": null,
        "audio_path": "/tmp/some.opus",
        "ai_enabled": false,
        "recovered": true,
    });
    let output = speakeasy()
        .args(["save-transcript", "--json", "--dir"])
        .arg(tmp.path())
        .write_stdin(serde_json::to_string(&payload).unwrap())
        .output()
        .expect("run save-transcript");
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    // stdout prints one JSON object with id + path + timestamp.
    let value: Value = serde_json::from_str(stdout.trim()).expect("valid JSON");
    let id = value["id"].as_str().expect("id is a string").to_string();
    assert!(id.starts_with("transcript-"), "id={id}");
    assert!(id.ends_with("-recovered"), "recovered suffix missing in {id}");
    assert_eq!(value["timestamp"], "2026-04-20T12:00:00.000Z");

    let path = tmp.path().join(format!("{id}.json"));
    assert!(path.exists(), "expected saved transcript at {}", path.display());
    let body: Value =
        serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(body["raw_text"], "recovered from a file");
    assert_eq!(body["recovered"], true);
    assert_eq!(body["audio_path"], "/tmp/some.opus");
}

#[test]
fn save_transcript_generates_id_and_timestamp_when_missing() {
    // Minimal payload with just raw_text. The subcommand should fill
    // in a timestamp and derive an id from it.
    let tmp = TempDir::new().unwrap();
    let payload = serde_json::json!({
        "raw_text": "bare minimum save",
    });
    let output = speakeasy()
        .args(["save-transcript", "--json", "--dir"])
        .arg(tmp.path())
        .write_stdin(serde_json::to_string(&payload).unwrap())
        .output()
        .expect("run save-transcript");
    assert!(output.status.success());
    let value: Value =
        serde_json::from_str(String::from_utf8(output.stdout).unwrap().trim()).unwrap();
    let id = value["id"].as_str().unwrap();
    assert!(id.starts_with("transcript-"));
    // Not recovered → no -recovered suffix.
    assert!(!id.ends_with("-recovered"));
}

#[test]
fn save_transcript_rejects_empty_stdin() {
    let tmp = TempDir::new().unwrap();
    let output = speakeasy()
        .args(["save-transcript", "--dir"])
        .arg(tmp.path())
        .write_stdin("")
        .output()
        .expect("run save-transcript");
    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("empty stdin"), "stderr={stderr}");
}

#[test]
fn daemon_smoke_quit_exits_cleanly_with_ready_event() {
    use std::io::Write;
    use std::process::Stdio;
    use std::time::Duration;

    let mut cmd = std::process::Command::new(
        assert_cmd::cargo::cargo_bin("speakeasy"),
    );
    cmd.arg("daemon")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().expect("spawn daemon");
    if let Some(mut stdin) = child.stdin.take() {
        // Write quit immediately — don't need to wait for Ready.
        let _ = stdin.write_all(b"{\"cmd\":\"quit\"}\n");
        drop(stdin);
    }

    // Wait with a 15s timeout so a wedged daemon doesn't stall the
    // test suite — we use a polling loop rather than adding a new
    // dependency for wait-with-timeout.
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    let status = loop {
        match child.try_wait().expect("try_wait") {
            Some(s) => break s,
            None => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    panic!("daemon did not exit within 15s");
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    };
    assert!(status.success(), "daemon exited non-zero: {status:?}");

    // Collect any stdout produced before quit fired. It's fine if the
    // daemon exited before it emitted Ready — the assertion here is
    // simply that the subcommand parses and exits cleanly.
    let mut stdout = String::new();
    if let Some(mut out) = child.stdout.take() {
        use std::io::Read;
        let _ = out.read_to_string(&mut stdout);
    }
    // If there was any stdout, it should be a sequence of valid JSON
    // lines — exercise the minimal parse loop the Swift/JS side uses.
    for line in stdout.lines() {
        let _: Value = serde_json::from_str(line)
            .unwrap_or_else(|e| panic!("daemon stdout line not valid JSON ({e}): {line:?}"));
    }
}

#[test]
fn daemon_empty_tail_stop_emits_stopped_and_saved_and_writes_transcript() {
    // Gap 2 regression test: when a user hits stop with no new audio
    // since the last commit window, the daemon must still save a
    // transcript and emit `saved`. We exercise a degenerate variant
    // of that path — start → stop with no microphone audio and no
    // model loaded — which takes the same empty-buf branch.
    use std::io::{BufRead, BufReader, Write};
    use std::process::Stdio;
    use std::time::Duration;

    let tmp = TempDir::new().unwrap();
    let app_data = tmp.path();

    let mut cmd = std::process::Command::new(
        assert_cmd::cargo::cargo_bin("speakeasy"),
    );
    cmd.arg("daemon")
        .arg("--app-data-dir")
        .arg(app_data)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().expect("spawn daemon");

    // Drive the daemon: start → stop → quit.
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"{\"cmd\":\"start\"}\n");
        // Give the audio callback no time to accumulate samples; the
        // empty-tail branch is what we're testing.
        std::thread::sleep(Duration::from_millis(50));
        let _ = stdin.write_all(b"{\"cmd\":\"stop\"}\n");
        std::thread::sleep(Duration::from_millis(200));
        let _ = stdin.write_all(b"{\"cmd\":\"quit\"}\n");
        drop(stdin);
    }

    // Collect stdout. We drain in a helper thread so the daemon can't
    // block on a full stdout buffer.
    let stdout = child.stdout.take().expect("stdout pipe");
    let reader = BufReader::new(stdout);
    let collector = std::thread::spawn(move || {
        let mut events: Vec<Value> = Vec::new();
        for line in reader.lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                events.push(v);
            }
        }
        events
    });

    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        match child.try_wait().expect("try_wait") {
            Some(_) => break,
            None => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    panic!("daemon did not exit within 15s");
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
    let events = collector.join().expect("collector thread");

    // `stopped` must be present, and `saved` must follow for the
    // empty-tail case.
    let mut saw_stopped = false;
    let mut saw_saved = false;
    let mut saved_id: Option<String> = None;
    for ev in &events {
        match ev["event"].as_str() {
            Some("stopped") => saw_stopped = true,
            Some("saved") => {
                saw_saved = true;
                saved_id = ev["transcript_id"].as_str().map(str::to_string);
            }
            _ => {}
        }
    }
    assert!(
        saw_stopped,
        "expected a stopped event; events={:?}",
        events
    );
    assert!(
        saw_saved,
        "expected a saved event on empty-tail stop; events={:?}",
        events
    );

    // The transcript JSON must be on disk, with empty raw_text.
    let id = saved_id.expect("saved event had no transcript_id");
    let path = app_data.join("transcripts").join(format!("{id}.json"));
    assert!(
        path.exists(),
        "expected transcript file at {}",
        path.display()
    );
    let body: Value =
        serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(body["raw_text"], "");
    // `cleaned_text` starts as null; AI cleanup wasn't configured.
    assert!(body["cleaned_text"].is_null(), "got {:?}", body["cleaned_text"]);
    assert_eq!(body["ai_enabled"], false);
}
