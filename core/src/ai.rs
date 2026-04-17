use anyhow::Result;

#[derive(Clone)]
pub struct AiConfig {
    pub backend: String,
    pub model: String,
    pub system_prompt: String,
}

pub const FRAMING_TEXT: &str = "What follows is raw output from a speech recognition engine. It will be lowercase, without punctuation, and may contain filler words, self-corrections, and false starts. All text up to the marker \"END-OF-DICTATION\" is raw dictation that needs cleanup. When you see that marker, output a properly capitalized, punctuated, and coherent version of everything that was dictated.";

pub fn load_system_prompt(explicit_path: Option<&str>, binary_path: &std::path::Path) -> String {
    let path = if let Some(p) = explicit_path {
        std::path::Path::new(p).to_path_buf()
    } else {
        let parent = binary_path.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        parent.join("../prompts/system.txt")
    };

    std::fs::read_to_string(&path).unwrap_or_default()
}

/// Dispatch cleanup to the configured backend. Only 'llama' does real
/// work; 'none' is a passthrough. Cloud backends were removed — if any
/// other value reaches here it's a config bug, not a runtime choice.
pub async fn cleanup_text(config: &AiConfig, raw_text: &str) -> Result<String> {
    match config.backend.as_str() {
        "llama" => crate::ai_local::cleanup_text(config, raw_text).await,
        "none" => Ok(raw_text.to_string()),
        other => Err(anyhow::anyhow!("unknown ai backend: {}", other)),
    }
}
