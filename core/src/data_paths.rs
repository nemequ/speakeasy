// SPDX-License-Identifier: MIT
// Speakeasy — Platform-aware data directory resolution.
//
// Single source of truth for where Speakeasy writes its sessions,
// transcripts, cached audio, and downloaded Whisper models.
//
// Conventions:
//   - macOS:   ~/Library/Application Support/Speakeasy/
//   - Linux:   $XDG_DATA_HOME/speakeasy/   (usually ~/.local/share/speakeasy)
//   - Windows: %APPDATA%/Speakeasy/        (for completeness; not a v1 target)
//
// The Linux layout intentionally matches the existing JS/GNOME
// frontend's convention (see sessionLog.js::getSessionsDir, which uses
// `GLib.get_user_data_dir()` + "speakeasy"), so that a Linux user
// running both frontends during the migration will see one shared
// data directory.
//
// The macOS layout follows Apple's Application Support convention,
// using the capitalized product name (matches the .app bundle name).
//
// Each subdirectory resolver auto-creates the directory if it does
// not already exist. Failure to create is logged but non-fatal — the
// caller will get a path that may not be writable, and downstream
// I/O will surface a more specific error there. This mirrors the JS
// `GLib.mkdir_with_parents(dir, 0o755)` behavior.
//
// ## Test injection
//
// Tests construct a `DataPaths` via `DataPaths::with_root(tmpdir)` to
// point at a scratch directory. The free functions
// (`app_data_dir()`, `sessions_dir()`, etc.) delegate to a
// process-global default `DataPaths` built from the platform
// resolver; do not use them in tests.

use directories::BaseDirs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Platform-specific product directory name. Capitalized on macOS /
/// Windows to match OS conventions; lowercase on Linux to match the
/// existing JS frontend's convention.
#[cfg(target_os = "macos")]
const APP_DIR_NAME: &str = "Speakeasy";
#[cfg(target_os = "windows")]
const APP_DIR_NAME: &str = "Speakeasy";
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const APP_DIR_NAME: &str = "speakeasy";

/// Subdirectories under the application data dir.
pub const SESSIONS_SUBDIR: &str = "sessions";
pub const TRANSCRIPTS_SUBDIR: &str = "transcripts";
pub const AUDIO_SUBDIR: &str = "audio";
pub const MODELS_SUBDIR: &str = "models";

/// Resolved application data directory tree.
///
/// Construct via `DataPaths::new()` for the real platform path, or
/// via `DataPaths::with_root(...)` for tests.
///
/// All directory accessors (`sessions()`, `transcripts()`, `audio()`,
/// `models()`) auto-create their subdirectory on each call; creation
/// is idempotent and cheap (`fs::create_dir_all`).
#[derive(Debug, Clone)]
pub struct DataPaths {
    root: PathBuf,
}

impl DataPaths {
    /// Build a `DataPaths` using the platform-native application data
    /// root.
    ///
    /// - macOS: `~/Library/Application Support/Speakeasy/`
    /// - Linux: `$XDG_DATA_HOME/speakeasy/` (defaults to
    ///   `~/.local/share/speakeasy/`)
    /// - Windows: `%APPDATA%/Speakeasy/`
    ///
    /// If the base directory cannot be resolved (e.g. no home dir on
    /// a weird container), falls back to `./speakeasy-data/`. This
    /// fallback is a last-resort; production installs should always
    /// have a home directory.
    pub fn new() -> Self {
        let root = Self::resolve_platform_root();
        // Best-effort create; ignore errors (caller will see them on
        // downstream writes with better context).
        let _ = std::fs::create_dir_all(&root);
        Self { root }
    }

    /// Build a `DataPaths` rooted at an arbitrary directory. Intended
    /// for tests; production code should use `DataPaths::new()`.
    pub fn with_root(root: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&root);
        Self { root }
    }

    /// Path to the root application data directory.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Path to `<root>/sessions/` (created if missing).
    pub fn sessions(&self) -> PathBuf {
        self.ensure_subdir(SESSIONS_SUBDIR)
    }

    /// Path to `<root>/transcripts/` (created if missing).
    pub fn transcripts(&self) -> PathBuf {
        self.ensure_subdir(TRANSCRIPTS_SUBDIR)
    }

    /// Path to `<root>/audio/` (created if missing). Used for Opus
    /// retention files for crash recovery.
    pub fn audio(&self) -> PathBuf {
        self.ensure_subdir(AUDIO_SUBDIR)
    }

    /// Path to `<root>/models/` (created if missing). Destination for
    /// downloaded Whisper `.bin` models.
    pub fn models(&self) -> PathBuf {
        self.ensure_subdir(MODELS_SUBDIR)
    }

    fn ensure_subdir(&self, name: &str) -> PathBuf {
        let path = self.root.join(name);
        let _ = std::fs::create_dir_all(&path);
        path
    }

    fn resolve_platform_root() -> PathBuf {
        if let Some(base) = BaseDirs::new() {
            // BaseDirs::data_dir() is platform-appropriate:
            //   macOS:   ~/Library/Application Support
            //   Linux:   $XDG_DATA_HOME (defaulting to ~/.local/share)
            //   Windows: %APPDATA%/Roaming
            return base.data_dir().join(APP_DIR_NAME);
        }
        // No home directory? Fall back to a CWD-relative dir so
        // nothing panics. Not pretty, but unlikely to ever be hit.
        PathBuf::from(format!("./{APP_DIR_NAME}-data"))
    }
}

impl Default for DataPaths {
    fn default() -> Self {
        Self::new()
    }
}

/// Process-global default `DataPaths` built from the platform
/// resolver. Populated on first access to any free function below.
fn default_paths() -> &'static DataPaths {
    static PATHS: OnceLock<DataPaths> = OnceLock::new();
    PATHS.get_or_init(DataPaths::new)
}

/// Convenience: root application data directory, using the default
/// platform resolver.
pub fn app_data_dir() -> PathBuf {
    default_paths().root().to_path_buf()
}

/// Convenience: sessions directory, using the default platform
/// resolver. Equivalent to `DataPaths::new().sessions()`.
pub fn sessions_dir() -> PathBuf {
    default_paths().sessions()
}

/// Convenience: transcripts directory, using the default platform
/// resolver. Equivalent to `DataPaths::new().transcripts()`.
pub fn transcripts_dir() -> PathBuf {
    default_paths().transcripts()
}

/// Convenience: audio retention directory, using the default
/// platform resolver. Equivalent to `DataPaths::new().audio()`.
pub fn audio_dir() -> PathBuf {
    default_paths().audio()
}

/// Convenience: models directory, using the default platform
/// resolver. Equivalent to `DataPaths::new().models()`.
pub fn models_dir() -> PathBuf {
    default_paths().models()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn with_root_uses_provided_root() {
        let tmp = TempDir::new().unwrap();
        let paths = DataPaths::with_root(tmp.path().to_path_buf());
        assert_eq!(paths.root(), tmp.path());
    }

    #[test]
    fn subdirs_are_created_under_the_root() {
        let tmp = TempDir::new().unwrap();
        let paths = DataPaths::with_root(tmp.path().to_path_buf());

        let sessions = paths.sessions();
        let transcripts = paths.transcripts();
        let audio = paths.audio();
        let models = paths.models();

        assert_eq!(sessions, tmp.path().join("sessions"));
        assert_eq!(transcripts, tmp.path().join("transcripts"));
        assert_eq!(audio, tmp.path().join("audio"));
        assert_eq!(models, tmp.path().join("models"));

        assert!(sessions.is_dir());
        assert!(transcripts.is_dir());
        assert!(audio.is_dir());
        assert!(models.is_dir());
    }

    #[test]
    fn subdir_creation_is_idempotent() {
        let tmp = TempDir::new().unwrap();
        let paths = DataPaths::with_root(tmp.path().to_path_buf());
        // Call twice; second call must not fail or touch anything
        // unexpected.
        let first = paths.sessions();
        let second = paths.sessions();
        assert_eq!(first, second);
        assert!(first.is_dir());
    }

    #[test]
    fn writes_to_subdir_are_visible_on_disk() {
        let tmp = TempDir::new().unwrap();
        let paths = DataPaths::with_root(tmp.path().to_path_buf());
        let file = paths.sessions().join("probe.txt");
        std::fs::write(&file, b"hello").unwrap();
        let read = std::fs::read_to_string(&file).unwrap();
        assert_eq!(read, "hello");
    }

    #[test]
    fn root_creation_is_idempotent() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("deep").join("nested").join("root");
        let paths = DataPaths::with_root(root.clone());
        assert!(root.is_dir());
        // Rebuilding on the same root must still succeed.
        let _ = DataPaths::with_root(root.clone());
        assert!(root.is_dir());
        assert_eq!(paths.root(), root);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn platform_root_is_application_support_speakeasy_on_macos() {
        // We can't easily mock $HOME from a unit test without leaking
        // state, but we can assert the suffix of the resolved path —
        // that's the contract we care about for downstream code.
        let root = DataPaths::resolve_platform_root();
        assert!(
            root.ends_with("Library/Application Support/Speakeasy"),
            "unexpected macOS root: {root:?}"
        );
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn platform_root_is_xdg_speakeasy_on_linux() {
        let root = DataPaths::resolve_platform_root();
        // Either $XDG_DATA_HOME/speakeasy or ~/.local/share/speakeasy.
        // Both paths end with "/speakeasy".
        assert!(
            root.ends_with("speakeasy"),
            "unexpected linux root: {root:?}"
        );
        // And the parent is either .local/share or $XDG_DATA_HOME —
        // in either case, not "Application Support".
        let parent_str = root.parent().unwrap().to_string_lossy().to_string();
        assert!(
            !parent_str.contains("Application Support"),
            "linux root should not nest under Application Support: {root:?}"
        );
    }

    #[test]
    fn default_free_functions_return_consistent_paths() {
        // The default free functions use a process-global cache; all
        // four subdir helpers must nest under the same root.
        let root = app_data_dir();
        assert!(sessions_dir().starts_with(&root));
        assert!(transcripts_dir().starts_with(&root));
        assert!(audio_dir().starts_with(&root));
        assert!(models_dir().starts_with(&root));
    }
}
