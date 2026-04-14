use anyhow::Result;
use serde::Deserialize;

#[derive(Clone)]
pub struct AiConfig {
    pub backend: String,
    pub api_key: Option<String>,
    pub model: String,
    pub url: String,
    pub system_prompt: String,
}

const FRAMING_TEXT: &str = "What follows is raw output from a speech recognition engine. It will be lowercase, without punctuation, and may contain filler words, self-corrections, and false starts. All text up to the marker \"END-OF-DICTATION\" is raw dictation that needs cleanup. When you see that marker, output a properly capitalized, punctuated, and coherent version of everything that was dictated.";

#[derive(Deserialize)]
struct ApiResponse {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: Message,
}

#[derive(Deserialize)]
struct Message {
    content: String,
}

pub fn load_system_prompt(explicit_path: Option<&str>, binary_path: &std::path::Path) -> String {
    let path = if let Some(p) = explicit_path {
        std::path::Path::new(p).to_path_buf()
    } else {
        let parent = binary_path.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        parent.join("../prompts/system.txt")
    };

    std::fs::read_to_string(&path).unwrap_or_default()
}

pub fn get_default_model(backend: &str) -> &'static str {
    match backend {
        "openrouter" => "anthropic/claude-haiku-4-5-20251001",
        "ollama" => "qwen2.5:3b",
        _ => "qwen2.5:3b",
    }
}

pub fn get_default_url(backend: &str) -> &'static str {
    match backend {
        "openrouter" => "https://openrouter.ai/api/v1",
        "ollama" => "http://localhost:11434",
        _ => "http://localhost:11434",
    }
}

pub async fn cleanup_text(config: &AiConfig, raw_text: &str) -> Result<String> {
    let client = reqwest::Client::new();

    let base = config.url.trim_end_matches('/');
    let url = if config.backend == "ollama" {
        format!("{}/v1/chat/completions", base)
    } else {
        format!("{}/chat/completions", base)
    };

    let mut request = client
        .post(&url)
        .timeout(std::time::Duration::from_secs(30))
        .header("Content-Type", "application/json");

    if config.backend == "openrouter" {
        if let Some(ref key) = config.api_key {
            request = request.header("Authorization", format!("Bearer {}", key));
        }
        request = request
            .header("HTTP-Referer", "https://github.com/anomalyco/speakeasy")
            .header("X-Title", "Speakeasy");
    }

    let body = serde_json::json!({
        "model": config.model,
        "stream": false,
        "temperature": 0.3,
        "messages": [
            {"role": "system", "content": config.system_prompt},
            {"role": "user", "content": format!("{}\n\n{}\n\nEND-OF-DICTATION", FRAMING_TEXT, raw_text)}
        ]
    });

    let response = request
        .json(&body)
        .send()
        .await?
        .error_for_status()?
        .json::<ApiResponse>()
        .await?;

    Ok(response.choices.first()
        .map(|c| c.message.content.clone())
        .unwrap_or_else(|| raw_text.to_string()))
}