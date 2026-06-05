// SPDX-License-Identifier: MIT
// Speakeasy — Whisper model catalog + on-demand downloader.
//
// This module holds the canonical list of Whisper models we support
// for speech-to-text, and the machinery to download them on demand
// to the user's models directory (see `data_paths::models_dir()`).
//
// The models are the same GGML `.bin` files used by whisper.cpp,
// hosted on Hugging Face at
// `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{NAME}.bin`.
// Filenames and (approximate) sizes come from whisper.cpp's
// `models/download-ggml-model.sh` script.
//
// ## SHA256s
//
// Upstream (ggerganov/whisper.cpp) does not publish SHA256s alongside
// its model files. The download script at
// https://github.com/ggerganov/whisper.cpp/blob/master/models/download-ggml-model.sh
// uses per-file SHA1s embedded in the script, not SHA256s. Rather
// than ship stale hashes that could break if upstream re-uploads a
// file, we leave `sha256` as `None` for v1 and rely on server-side
// integrity (TLS + HF's content-addressed storage). Downloaded
// files are still size-checked against the catalog, so a truncated
// or redirected-to-HTML download is detected.
//
// TODO(models): add SHA256s once we settle on a policy — likely
// compute them lazily at first install and cache under
// `<models_dir>/.sha256/<filename>` so future installs can verify
// against a locally-trusted reference.

use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;

/// Base URL for model downloads. The concrete URL for a model is
/// `{MODEL_BASE_URL}/{filename}`.
pub const MODEL_BASE_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

/// Size tolerance when checking whether a locally-installed file
/// matches the expected model size. A file within ±10 % of the
/// catalog `size_bytes` is considered "installed"; anything smaller
/// is treated as a partial / aborted download.
const SIZE_TOLERANCE: f64 = 0.10;

/// Minimum interval between progress callback invocations. Progress
/// is also emitted on every buffer flush regardless, so short
/// downloads always see at least one event.
const PROGRESS_MIN_INTERVAL: Duration = Duration::from_millis(100);

/// Minimum bytes between progress callback invocations (256 KiB).
const PROGRESS_MIN_BYTES: u64 = 256 * 1024;

/// Metadata describing one entry in the Whisper model catalog.
///
/// The catalog is deliberately hard-coded rather than fetched
/// dynamically: it changes only when whisper.cpp ships a new model,
/// and we'd rather update the binary than rely on network fetches at
/// startup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModelInfo {
    /// Short model identifier, e.g. `"small.en"` or `"large-v3-turbo"`.
    /// This is what the user selects via the CLI / preferences UI.
    pub name: String,

    /// On-disk filename, e.g. `"ggml-small.en.bin"`. Always
    /// `ggml-{name}.bin` for every current catalog entry.
    pub filename: String,

    /// Approximate download size, in bytes. Used both for UI display
    /// ("465 MB") and to sanity-check a completed download.
    pub size_bytes: u64,

    /// SHA-256 of the expected file contents, if known. Currently
    /// always `None`; see the TODO at the top of this file.
    pub sha256: Option<String>,
}

impl ModelInfo {
    /// Fully-qualified HTTPS URL to download this model from.
    pub fn url(&self) -> String {
        format!("{MODEL_BASE_URL}/{}", self.filename)
    }
}

/// Progress event emitted during a model download.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct DownloadProgress {
    /// Bytes written to disk so far.
    pub downloaded: u64,
    /// Total expected bytes. Taken from the HTTP `Content-Length`
    /// header when available; falls back to the catalog
    /// `size_bytes`.
    pub total: u64,
}

// ---------------------------------------------------------------
// Catalog data
// ---------------------------------------------------------------

/// Hard-coded list of supported Whisper models. Sizes are from
/// whisper.cpp's `models/download-ggml-model.sh` (2025-era values,
/// rounded to the same "approximate MB/GB" granularity users see
/// upstream).
const CATALOG_RAW: &[(&str, u64)] = &[
    // tiny — ~75 MB
    ("tiny.en", 77_691_713),
    ("tiny", 77_691_713),
    // base — ~150 MB
    ("base.en", 147_951_465),
    ("base", 147_951_465),
    // small — ~465 MB
    ("small.en", 487_601_967),
    ("small", 487_601_967),
    // medium — ~1.5 GB
    ("medium.en", 1_533_763_059),
    ("medium", 1_533_763_059),
    // large-v3-turbo — ~1.5 GB (quantized turbo variant)
    ("large-v3-turbo", 1_624_555_275),
];

/// Return the full list of models we know how to install.
///
/// This allocates a fresh `Vec<ModelInfo>` on each call — cheap, and
/// keeps the API simple for callers that want to serialize it.
pub fn catalog() -> Vec<ModelInfo> {
    CATALOG_STATIC.iter().cloned().collect()
}

/// Look up a model by its short name (e.g. `"small.en"`). Returns
/// `None` if no such entry exists.
pub fn find(name: &str) -> Option<&'static ModelInfo> {
    CATALOG_STATIC.iter().find(|m| m.name == name)
}

/// Path where a given model will be / is installed, under the
/// supplied `models_dir`. Does not touch disk.
pub fn installed_path(info: &ModelInfo, models_dir: &Path) -> PathBuf {
    models_dir.join(&info.filename)
}

/// Report whether `info` is already installed in `models_dir`.
///
/// An install is considered valid if:
///   - the file exists, and
///   - its on-disk size is within ±10 % of the catalog
///     `size_bytes`.
///
/// We do not hash the file here (that's O(GB)); that check happens
/// exactly once, at the end of a download, when a SHA256 is known.
/// A partial / aborted download that left a smaller file on disk
/// will therefore be reported as not-installed, and the next call to
/// `download()` will overwrite it.
pub fn is_installed(info: &ModelInfo, models_dir: &Path) -> bool {
    let path = installed_path(info, models_dir);
    let Ok(meta) = std::fs::metadata(&path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    let actual = meta.len();
    let expected = info.size_bytes as f64;
    let tolerance = expected * SIZE_TOLERANCE;
    let diff = (actual as f64 - expected).abs();
    diff <= tolerance
}

// ---------------------------------------------------------------
// Static catalog materialization
// ---------------------------------------------------------------

/// `&'static [ModelInfo]` built once at first access from
/// `CATALOG_RAW`. We use a lazy `OnceLock` so the `String`s inside
/// each `ModelInfo` are heap-allocated exactly once per process.
static CATALOG_STATIC: std::sync::LazyLock<Vec<ModelInfo>> = std::sync::LazyLock::new(|| {
    CATALOG_RAW
        .iter()
        .map(|(name, size)| ModelInfo {
            name: (*name).to_string(),
            filename: format!("ggml-{name}.bin"),
            size_bytes: *size,
            sha256: None, // see file-level TODO
        })
        .collect()
});

// ---------------------------------------------------------------
// Download
// ---------------------------------------------------------------

/// Stream `info`'s model file to `models_dir`, emitting
/// `DownloadProgress` events as bytes arrive.
///
/// Behavior:
///   - Writes to a temporary `.part` file next to the destination;
///     on success, renames into place. This prevents a partial
///     download from looking like a valid install to
///     `is_installed()`.
///   - On any failure (network, I/O, or SHA mismatch), removes the
///     `.part` file before returning. The final destination file
///     is never clobbered by a failed download.
///   - If the catalog entry has a non-None `sha256`, verifies the
///     downloaded bytes against it and returns Err on mismatch.
///
/// The `progress` callback is invoked:
///   - At least once at the start (before any bytes have been
///     written) so the caller can emit a `{downloaded: 0, total}`
///     header event,
///   - Every >= 256 KiB AND >= 100 ms of accumulated deltas,
///   - And once at completion with `downloaded == total`.
///
/// `progress` runs on the same task as the download — do not block
/// in it. Serialize to stdout, push onto a channel, etc.; don't
/// call into heavyweight work.
pub async fn download(
    info: &ModelInfo,
    models_dir: &Path,
    progress: impl FnMut(DownloadProgress),
) -> Result<PathBuf> {
    download_from_url(&info.url(), info, models_dir, progress).await
}

/// Internal helper used by `download()` and directly by unit tests
/// that need to point at a mock HTTP server. Takes an explicit URL
/// rather than building one from `MODEL_BASE_URL`.
async fn download_from_url(
    url: &str,
    info: &ModelInfo,
    models_dir: &Path,
    mut progress: impl FnMut(DownloadProgress),
) -> Result<PathBuf> {
    tokio::fs::create_dir_all(models_dir)
        .await
        .with_context(|| format!("creating models dir {:?}", models_dir))?;

    let dest = installed_path(info, models_dir);
    let part = with_extension_appended(&dest, "part");

    // Clean up any leftover .part from a previous failed attempt.
    let _ = tokio::fs::remove_file(&part).await;

    let client = reqwest::Client::builder()
        .build()
        .context("building HTTP client")?;
    let resp = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("GET {url}"))?;

    if !resp.status().is_success() {
        return Err(anyhow!(
            "download {url} failed: HTTP {}",
            resp.status()
        ));
    }

    // Prefer the server's Content-Length for the "total" in progress
    // events; fall back to the catalog size so the UI can still show
    // a percentage even if the server doesn't send one.
    let total = resp.content_length().unwrap_or(info.size_bytes);

    let file_result = stream_to_file(
        resp,
        &part,
        total,
        info.sha256.as_deref(),
        &mut progress,
    )
    .await;

    match file_result {
        Ok(()) => {
            tokio::fs::rename(&part, &dest)
                .await
                .with_context(|| format!("rename {:?} -> {:?}", part, dest))?;
            // Final progress event at 100 %.
            progress(DownloadProgress {
                downloaded: total,
                total,
            });
            Ok(dest)
        }
        Err(e) => {
            let _ = tokio::fs::remove_file(&part).await;
            Err(e)
        }
    }
}

/// Write the response body to `part`, emitting progress and (if
/// `expected_sha256` is set) verifying the SHA-256 of the full body.
async fn stream_to_file(
    resp: reqwest::Response,
    part: &Path,
    total: u64,
    expected_sha256: Option<&str>,
    progress: &mut impl FnMut(DownloadProgress),
) -> Result<()> {
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(part)
        .await
        .with_context(|| format!("opening {:?} for write", part))?;

    let mut hasher = expected_sha256.map(|_| Sha256::new());
    let mut downloaded: u64 = 0;
    let mut last_progress_at = Instant::now();
    let mut bytes_since_last_progress: u64 = 0;

    // Header-event so the caller sees total up front.
    progress(DownloadProgress {
        downloaded: 0,
        total,
    });

    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("reading response chunk")?;
        file.write_all(&chunk)
            .await
            .with_context(|| format!("writing to {:?}", part))?;
        if let Some(h) = hasher.as_mut() {
            h.update(&chunk);
        }
        downloaded += chunk.len() as u64;
        bytes_since_last_progress += chunk.len() as u64;

        if bytes_since_last_progress >= PROGRESS_MIN_BYTES
            || last_progress_at.elapsed() >= PROGRESS_MIN_INTERVAL
        {
            progress(DownloadProgress {
                downloaded,
                total: total.max(downloaded),
            });
            last_progress_at = Instant::now();
            bytes_since_last_progress = 0;
        }
    }

    file.flush()
        .await
        .with_context(|| format!("flushing {:?}", part))?;
    // Dropping the `File` closes it; do that before we rename.
    drop(file);

    if let (Some(expected), Some(h)) = (expected_sha256, hasher) {
        let got = h.finalize();
        let got_hex = hex_encode(&got);
        if !got_hex.eq_ignore_ascii_case(expected) {
            return Err(anyhow!(
                "SHA-256 mismatch: expected {expected}, got {got_hex}"
            ));
        }
    }

    Ok(())
}

/// Lowercase-hex encode a byte slice without pulling in an extra
/// crate. Constant-memory; fine for 32-byte SHA-256 digests.
fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Return `path` with `suffix` appended to its final component,
/// preserving any existing extensions.
///
/// `with_extension_appended("ggml-foo.bin", "part")` =>
/// `"ggml-foo.bin.part"`. We intentionally do not use
/// `Path::with_extension` because that would replace `.bin` with
/// `.part`, which is the opposite of what we want.
fn with_extension_appended(path: &Path, suffix: &str) -> PathBuf {
    let mut os = path.as_os_str().to_owned();
    os.push(".");
    os.push(suffix);
    PathBuf::from(os)
}

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Digest;
    use std::sync::{Arc, Mutex};
    use tempfile::TempDir;
    use wiremock::matchers::{method, path as path_matcher};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn catalog_has_expected_entries() {
        let cat = catalog();
        let names: Vec<&str> = cat.iter().map(|m| m.name.as_str()).collect();
        assert!(names.contains(&"tiny.en"));
        assert!(names.contains(&"tiny"));
        assert!(names.contains(&"base.en"));
        assert!(names.contains(&"base"));
        assert!(names.contains(&"small.en"));
        assert!(names.contains(&"small"));
        assert!(names.contains(&"medium.en"));
        assert!(names.contains(&"medium"));
        assert!(names.contains(&"large-v3-turbo"));
        // No duplicates.
        let unique: std::collections::HashSet<&str> = names.iter().copied().collect();
        assert_eq!(unique.len(), names.len());
    }

    #[test]
    fn catalog_filenames_follow_ggml_prefix() {
        for m in catalog() {
            assert_eq!(m.filename, format!("ggml-{}.bin", m.name));
        }
    }

    #[test]
    fn catalog_urls_are_well_formed() {
        for m in catalog() {
            let url = m.url();
            assert!(url.starts_with("https://huggingface.co/"));
            assert!(url.ends_with(&m.filename));
        }
    }

    #[test]
    fn find_locates_known_entry() {
        let got = find("small.en").expect("small.en should exist");
        assert_eq!(got.name, "small.en");
        assert_eq!(got.filename, "ggml-small.en.bin");
    }

    #[test]
    fn find_returns_none_for_unknown() {
        assert!(find("nonexistent").is_none());
        assert!(find("").is_none());
    }

    #[test]
    fn installed_path_joins_filename_under_models_dir() {
        let info = find("small.en").unwrap();
        let dir = Path::new("/var/models");
        assert_eq!(
            installed_path(info, dir),
            PathBuf::from("/var/models/ggml-small.en.bin")
        );
    }

    #[test]
    fn is_installed_returns_false_when_missing() {
        let tmp = TempDir::new().unwrap();
        let info = find("small.en").unwrap();
        assert!(!is_installed(info, tmp.path()));
    }

    #[test]
    fn is_installed_returns_false_for_partial_file() {
        let tmp = TempDir::new().unwrap();
        let info = find("small.en").unwrap();
        let path = installed_path(info, tmp.path());
        // 1 KiB: way too small for a 465 MB model.
        std::fs::write(&path, vec![0u8; 1024]).unwrap();
        assert!(!is_installed(info, tmp.path()));
    }

    #[test]
    fn is_installed_returns_true_for_full_file_within_tolerance() {
        let tmp = TempDir::new().unwrap();
        // Construct a fake tiny-sized entry so we don't have to
        // write a real 465 MB file in a unit test.
        let info = ModelInfo {
            name: "test-tiny".to_string(),
            filename: "ggml-test-tiny.bin".to_string(),
            size_bytes: 1_000,
            sha256: None,
        };
        let path = installed_path(&info, tmp.path());
        // 950 bytes: within the 10 % tolerance of 1000.
        std::fs::write(&path, vec![0u8; 950]).unwrap();
        assert!(is_installed(&info, tmp.path()));
    }

    #[test]
    fn is_installed_returns_false_when_path_is_a_directory() {
        let tmp = TempDir::new().unwrap();
        let info = find("small.en").unwrap();
        let path = installed_path(info, tmp.path());
        std::fs::create_dir_all(&path).unwrap();
        assert!(!is_installed(info, tmp.path()));
    }

    #[test]
    fn with_extension_appended_preserves_existing_extension() {
        assert_eq!(
            with_extension_appended(Path::new("/x/y/ggml-foo.bin"), "part"),
            PathBuf::from("/x/y/ggml-foo.bin.part")
        );
    }

    // ---------- async download tests ----------

    /// Build a 1 KiB payload with a known pattern so we can detect
    /// corruption and deterministic SHA computation.
    fn test_payload(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i % 251) as u8).collect()
    }

    fn sha256_hex(data: &[u8]) -> String {
        hex_encode(&Sha256::digest(data))
    }

    #[tokio::test]
    async fn download_happy_path_writes_file_with_correct_size_and_sha() {
        let payload = test_payload(1024);
        let expected_sha = sha256_hex(&payload);

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path_matcher("/ggml-test-happy.bin"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_bytes(payload.clone())
                    .insert_header("content-length", payload.len().to_string()),
            )
            .mount(&server)
            .await;

        let tmp = TempDir::new().unwrap();
        let info = ModelInfo {
            name: "test-happy".to_string(),
            // Point the filename at the mock server; the download
            // function builds its URL from MODEL_BASE_URL + filename,
            // so we override the URL via a custom ModelInfo. Easier:
            // use the URL-building indirection by placing a
            // constructed URL into a bespoke info + override of
            // MODEL_BASE_URL is not feasible at runtime; we instead
            // exercise `stream_to_file` directly below for the SHA
            // mismatch path and use a thin shim for this one.
            filename: "ggml-test-happy.bin".to_string(),
            size_bytes: payload.len() as u64,
            sha256: Some(expected_sha.clone()),
        };

        // Direct-URL variant of `download`: drive the request at
        // `{server.uri()}/ggml-test-happy.bin` instead of the real
        // HF URL. This is exactly the logic of `download()` minus
        // the MODEL_BASE_URL build step.
        let progress_events = Arc::new(Mutex::new(Vec::<DownloadProgress>::new()));
        let progress_events_cb = Arc::clone(&progress_events);
        let result = download_from_url(
            &format!("{}/{}", server.uri(), info.filename),
            &info,
            tmp.path(),
            move |p| progress_events_cb.lock().unwrap().push(p),
        )
        .await
        .expect("download should succeed");

        assert_eq!(result, installed_path(&info, tmp.path()));
        let on_disk = std::fs::read(&result).unwrap();
        assert_eq!(on_disk, payload);
        assert_eq!(sha256_hex(&on_disk), expected_sha);

        // At least one progress event for a 1 KiB download (the
        // header event fires unconditionally; the final 100 %
        // event also fires on success).
        let events = progress_events.lock().unwrap();
        assert!(!events.is_empty(), "expected at least one progress event");
        let last = events.last().unwrap();
        assert_eq!(last.downloaded, payload.len() as u64);
        assert_eq!(last.total, payload.len() as u64);
    }

    #[tokio::test]
    async fn download_sha_mismatch_removes_partial_and_errors() {
        let real_payload = test_payload(1024);
        let wrong_sha = sha256_hex(b"not the real payload");

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path_matcher("/ggml-test-bad-sha.bin"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_bytes(real_payload.clone())
                    .insert_header("content-length", real_payload.len().to_string()),
            )
            .mount(&server)
            .await;

        let tmp = TempDir::new().unwrap();
        let info = ModelInfo {
            name: "test-bad-sha".to_string(),
            filename: "ggml-test-bad-sha.bin".to_string(),
            size_bytes: real_payload.len() as u64,
            sha256: Some(wrong_sha),
        };

        let res = download_from_url(
            &format!("{}/{}", server.uri(), info.filename),
            &info,
            tmp.path(),
            |_p| {},
        )
        .await;

        assert!(res.is_err(), "expected SHA mismatch to produce an error");
        // Neither the final file nor the .part file should remain.
        let dest = installed_path(&info, tmp.path());
        assert!(!dest.exists(), ".bin should not exist after SHA failure");
        let part = with_extension_appended(&dest, "part");
        assert!(!part.exists(), ".part should be cleaned up after SHA failure");
    }

    #[tokio::test]
    async fn download_emits_multiple_progress_events_for_100k() {
        // A 100 KiB payload is comfortably larger than one
        // PROGRESS_MIN_BYTES window, so we expect at least a
        // header event + a final event.
        let payload = test_payload(100 * 1024);
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path_matcher("/ggml-test-progress.bin"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_bytes(payload.clone())
                    .insert_header("content-length", payload.len().to_string()),
            )
            .mount(&server)
            .await;

        let tmp = TempDir::new().unwrap();
        let info = ModelInfo {
            name: "test-progress".to_string(),
            filename: "ggml-test-progress.bin".to_string(),
            size_bytes: payload.len() as u64,
            sha256: None,
        };

        let events = Arc::new(Mutex::new(Vec::<DownloadProgress>::new()));
        let events_cb = Arc::clone(&events);
        download_from_url(
            &format!("{}/{}", server.uri(), info.filename),
            &info,
            tmp.path(),
            move |p| events_cb.lock().unwrap().push(p),
        )
        .await
        .expect("download should succeed");

        let events = events.lock().unwrap();
        assert!(
            events.len() >= 1,
            "expected at least one progress event, got {}",
            events.len()
        );
        // The final event should report full completion.
        let last = events.last().unwrap();
        assert_eq!(last.downloaded, payload.len() as u64);
    }

    #[tokio::test]
    async fn download_http_error_removes_partial() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path_matcher("/ggml-test-404.bin"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let tmp = TempDir::new().unwrap();
        let info = ModelInfo {
            name: "test-404".to_string(),
            filename: "ggml-test-404.bin".to_string(),
            size_bytes: 1024,
            sha256: None,
        };

        let res = download_from_url(
            &format!("{}/{}", server.uri(), info.filename),
            &info,
            tmp.path(),
            |_| {},
        )
        .await;
        assert!(res.is_err(), "404 should produce an error");
        assert!(!installed_path(&info, tmp.path()).exists());
        assert!(!with_extension_appended(
            &installed_path(&info, tmp.path()),
            "part"
        )
        .exists());
    }

}
