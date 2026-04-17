// Local AI cleanup — in-process GGUF inference.
//
// Goal: produce cleaned text from raw STT output without any network
// call or auxiliary daemon. We use the Qwen2.5-0.5B-Instruct GGUF
// (same file as the llama.cpp world) loaded via a pure-Rust crate so
// the build doesn't require libclang/bindgen on the host.
//
// Right now only the deterministic parts live here: prompt shaping
// (`build_prompt`) and the async wrapper (`cleanup_text`). The actual
// generation loop is `unimplemented!()` — the next TDD step swaps in
// a real implementation backed by `candle` or a similarly lean pure-
// Rust crate. Gating the model code behind a failing test keeps the
// rest of the binary buildable while the inference path is in flux.
//
// Greedy sampling is the intended default so the same raw STT output
// always produces the same cleaned text (useful for tests). If higher
// quality is needed later, swap in temperature/top-k at the sampler.

use anyhow::{anyhow, Context, Result};
use candle_core::quantized::gguf_file;
use candle_core::{Device, Tensor};
use candle_transformers::generation::{LogitsProcessor, Sampling};
use candle_transformers::models::quantized_qwen2::ModelWeights;
use std::path::{Path, PathBuf};
use tokenizers::Tokenizer;

use crate::ai::{AiConfig, FRAMING_TEXT};

// Cap generation. Cleaned text is always shorter than raw dictation
// in typical use; 512 tokens ≈ 350 words is comfortable headroom.
// Going higher costs per-token latency without a payoff, since qwen2.5
// reliably emits `<|im_end|>` when it's done.
const MAX_NEW_TOKENS: usize = 512;

// ArgMax seed is ignored (greedy sampling is deterministic), but the
// API wants a u64. Keep it pinned so any future switch to a
// temperature sampler still has a reproducible starting point.
const SAMPLER_SEED: u64 = 0;

// Known GGUF quantization suffixes that should be stripped from the
// model filename stem when searching for the sibling tokenizer. Order
// matters for longest-match: check "-q4_k_m" before "-q4_k" so the
// suffix is fully removed.
const QUANT_SUFFIXES: &[&str] = &[
    "-q8_0", "-q6_k", "-q5_k_m", "-q5_k_s", "-q5_0", "-q5_1",
    "-q4_k_m", "-q4_k_s", "-q4_0", "-q4_1", "-q3_k_m", "-q3_k_l",
    "-q2_k", "-f16", "-f32", "-iq1_s", "-iq2_xs", "-iq2_s", "-iq3_xs",
    "-iq4_xs", "-iq4_nl",
];

fn strip_quant_suffix(stem: &str) -> &str {
    for suffix in QUANT_SUFFIXES {
        if let Some(s) = stem.strip_suffix(suffix) {
            return s;
        }
    }
    stem
}

/// Find a tokenizer.json for the given GGUF. We look for (in order):
///   1. `<model-stem-without-quant>-tokenizer.json` next to the GGUF
///      (matches `make download-model` convention)
///   2. `tokenizer.json` in the same directory
///
/// Returning a specific error string here matters because the user
/// will see it verbatim when the llama backend can't start.
fn find_tokenizer_path(model_path: &Path) -> Result<PathBuf> {
    let model_dir = model_path
        .parent()
        .ok_or_else(|| anyhow!("model path has no parent: {}", model_path.display()))?;

    if let Some(stem) = model_path.file_stem().and_then(|s| s.to_str()) {
        let truncated = strip_quant_suffix(stem);
        let specific = model_dir.join(format!("{}-tokenizer.json", truncated));
        if specific.exists() {
            return Ok(specific);
        }
    }

    let generic = model_dir.join("tokenizer.json");
    if generic.exists() {
        return Ok(generic);
    }

    Err(anyhow!(
        "no tokenizer.json found near {}. Expected `<model>-tokenizer.json` \
         or `tokenizer.json` next to the GGUF.",
        model_path.display()
    ))
}

/// Render the Qwen2.5 / ChatML prompt for a single cleanup turn.
///
/// Pure string formatting — separated out so it's cheap to test and
/// independent of whichever inference crate we end up using. The
/// template matches what qwen2.5's tokenizer expects: an `<|im_start|>`
/// / `<|im_end|>` framed system + user turn, ending with an open
/// `assistant` header so the model continues from there.
pub fn build_prompt(system_prompt: &str, raw_text: &str) -> String {
    format!(
        "<|im_start|>system\n{sys}<|im_end|>\n\
         <|im_start|>user\n{framing}\n\n{raw}\n\nEND-OF-DICTATION<|im_end|>\n\
         <|im_start|>assistant\n",
        sys = system_prompt,
        framing = FRAMING_TEXT,
        raw = raw_text,
    )
}

/// Run cleanup synchronously. CPU-bound; callers should wrap in
/// `spawn_blocking`. Uses greedy sampling so output is deterministic
/// for a given input, which is important for reproducible tests and
/// stable snapshots of cleaned transcripts.
pub fn cleanup_text_sync(config: &AiConfig, raw_text: &str) -> Result<String> {
    if config.model.is_empty() {
        return Err(anyhow!(
            "--ai-model must be set to a GGUF file path for the 'llama' backend"
        ));
    }

    let model_path = Path::new(&config.model);
    let tokenizer_path = find_tokenizer_path(model_path)?;
    let tokenizer = Tokenizer::from_file(&tokenizer_path)
        .map_err(|e| anyhow!("failed to load tokenizer {}: {}", tokenizer_path.display(), e))?;

    // Qwen2.5 uses `<|im_end|>` as the end-of-turn token. If the
    // tokenizer vocab doesn't expose it under that literal, something
    // upstream is wrong (wrong tokenizer file for this model family)
    // and we should fail loudly rather than generate until MAX_NEW_TOKENS.
    let eos_token_id = tokenizer
        .get_vocab(true)
        .get("<|im_end|>")
        .copied()
        .ok_or_else(|| anyhow!("tokenizer missing <|im_end|> — wrong tokenizer for this model?"))?;

    let device = Device::Cpu;
    let mut file = std::fs::File::open(model_path)
        .with_context(|| format!("failed to open GGUF model: {}", config.model))?;
    let content = gguf_file::Content::read(&mut file)
        .with_context(|| format!("failed to parse GGUF: {}", config.model))?;
    let mut model = ModelWeights::from_gguf(content, &mut file, &device)
        .context("failed to initialize model from GGUF weights")?;

    let prompt = build_prompt(&config.system_prompt, raw_text);
    // `add_special_tokens = false` because our prompt already contains
    // the ChatML specials — letting the tokenizer add its own would
    // double-BOS the stream.
    let encoding = tokenizer
        .encode(prompt, false)
        .map_err(|e| anyhow!("failed to encode prompt: {}", e))?;
    let prompt_tokens: Vec<u32> = encoding.get_ids().to_vec();
    if prompt_tokens.is_empty() {
        return Err(anyhow!("prompt tokenized to zero tokens"));
    }

    let mut logits_processor = LogitsProcessor::from_sampling(SAMPLER_SEED, Sampling::ArgMax);

    // Prefill: single forward pass over the whole prompt, taking the
    // last-position logits as the next-token distribution. `index_pos`
    // = 0 tells the KV cache this is a fresh sequence.
    let input = Tensor::new(prompt_tokens.as_slice(), &device)?.unsqueeze(0)?;
    let logits = model.forward(&input, 0)?;
    let logits = logits.squeeze(0)?.to_dtype(candle_core::DType::F32)?;
    let logits = if logits.dims().len() > 1 {
        // Some model impls return [seq, vocab]; take the final step.
        let last = logits.dims()[0] - 1;
        logits.get(last)?
    } else {
        logits
    };

    let mut next_token = logits_processor.sample(&logits)?;
    let mut n_cur = prompt_tokens.len();
    let mut generated: Vec<u32> = Vec::with_capacity(MAX_NEW_TOKENS);

    for _ in 0..MAX_NEW_TOKENS {
        if next_token == eos_token_id {
            break;
        }
        generated.push(next_token);

        let input = Tensor::new(&[next_token], &device)?.unsqueeze(0)?;
        let logits = model.forward(&input, n_cur)?;
        let logits = logits.squeeze(0)?.to_dtype(candle_core::DType::F32)?;
        let logits = if logits.dims().len() > 1 {
            let last = logits.dims()[0] - 1;
            logits.get(last)?
        } else {
            logits
        };
        next_token = logits_processor.sample(&logits)?;
        n_cur += 1;
    }

    let text = tokenizer
        .decode(&generated, true)
        .map_err(|e| anyhow!("failed to decode output: {}", e))?;

    Ok(text.trim().to_string())
}

/// Async wrapper so the HTTP and local backends share a call-site
/// signature. Local inference is CPU-bound, so it runs on a blocking
/// thread pool.
pub async fn cleanup_text(config: &AiConfig, raw_text: &str) -> Result<String> {
    let config = config.clone();
    let raw_text = raw_text.to_string();
    tokio::task::spawn_blocking(move || cleanup_text_sync(&config, &raw_text))
        .await
        .map_err(|e| anyhow!("ai_local task panicked: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    // ChatML markers the model recognizes as turn boundaries. If we
    // ever emit more or fewer in a prompt, the model will generate the
    // wrong thing — hence these invariants.
    const IM_START: &str = "<|im_start|>";
    const IM_END: &str = "<|im_end|>";

    #[test]
    fn build_prompt_wraps_system_and_user_turns_in_chatml() {
        let prompt = build_prompt("SYS", "raw words");
        // Three opens: system, user, assistant.
        assert_eq!(prompt.matches(IM_START).count(), 3, "prompt:\n{}", prompt);
        // Two closes: system, user. The assistant turn is left open
        // because that's where generation begins.
        assert_eq!(prompt.matches(IM_END).count(), 2, "prompt:\n{}", prompt);
        assert!(prompt.contains("<|im_start|>system\nSYS<|im_end|>"));
        assert!(prompt.ends_with("<|im_start|>assistant\n"));
    }

    #[test]
    fn build_prompt_embeds_raw_text_and_end_marker() {
        let prompt = build_prompt("", "hello world");
        // The framing text is what tells the model *why* it's seeing
        // lowercase unpunctuated input. Missing it would degrade
        // cleanup quality in hard-to-diagnose ways.
        assert!(prompt.contains(FRAMING_TEXT), "missing framing in:\n{}", prompt);
        assert!(prompt.contains("hello world"));
        // The END-OF-DICTATION sentinel must appear between the raw
        // text and the user-turn close. This is part of the contract
        // with the system prompt ("when you see that marker, output
        // the cleaned version").
        let end_marker_idx = prompt
            .find("END-OF-DICTATION")
            .expect("END-OF-DICTATION missing");
        let user_close_idx = prompt[end_marker_idx..]
            .find(IM_END)
            .expect("no <|im_end|> after END-OF-DICTATION");
        // user_close_idx is offset from end_marker_idx, so it's >= 0
        // by construction — the assertion is that there's *some*
        // content between them (the marker itself, whitespace).
        assert!(user_close_idx >= "END-OF-DICTATION".len());
    }

    #[test]
    fn cleanup_sync_errors_when_model_path_empty() {
        let cfg = AiConfig {
            backend: "llama".into(),
            api_key: None,
            model: String::new(),
            url: String::new(),
            system_prompt: String::new(),
        };
        let err = cleanup_text_sync(&cfg, "anything").expect_err("empty model should error");
        // Caller (main.rs) surfaces this string verbatim, so lock down
        // the --ai-model hint.
        assert!(err.to_string().contains("--ai-model"), "got: {}", err);
    }

    // Integration test — exercises the full in-process inference path
    // against the real quantized GGUF. Gated on the model + tokenizer
    // being cached locally so `cargo test` stays green on fresh clones
    // and in CI. On the dev box, download with
    // `make download-qwen-model` (or equivalent) before running.
    //
    // Invariants (not exact-string) because token sampling and model
    // versions shift the byte layout of "correct" output:
    //   - non-empty result
    //   - no ChatML sentinels or framing leaked through
    //   - at least one capital letter OR one terminal punctuation
    //     (the raw input has neither, so either appearing means the
    //     model did *some* cleanup work). We don't require both —
    //     the 0.5B qwen reliably capitalizes but frequently skips
    //     sentence-terminal punctuation on short inputs. Quality is
    //     a model-size problem; correctness of our wiring is what
    //     this test is for.
    //   - output differs from the raw input byte-for-byte (proves
    //     inference actually ran vs. echoing the prompt back)
    //   - deterministic (ArgMax sampling): two runs return the same
    //     bytes. This is what lets us treat the local backend as a
    //     reproducible text transform in downstream tests.
    #[test]
    fn cleanup_sync_produces_cleaned_text_deterministically() {
        let home = std::env::var("HOME").unwrap_or_default();
        let model = format!(
            "{}/.cache/speakeasy/qwen2.5-0.5b-instruct-q4_k_m.gguf",
            home
        );
        if !std::path::Path::new(&model).exists() {
            eprintln!("SKIP: model not at {}", model);
            return;
        }

        let cfg = AiConfig {
            backend: "llama".into(),
            api_key: None,
            model,
            url: String::new(),
            system_prompt:
                "You are a helpful assistant that cleans up dictated speech. Output ONLY the cleaned text with no preamble."
                    .into(),
        };

        let raw = "this is a test of the stt system i don't know if it's working well or not";

        let cleaned = cleanup_text_sync(&cfg, raw).expect("cleanup should succeed");
        eprintln!("cleaned: {:?}", cleaned);

        assert!(!cleaned.is_empty(), "empty output");
        assert!(!cleaned.contains("<|im_"), "ChatML leaked: {:?}", cleaned);
        assert!(!cleaned.contains("END-OF-DICTATION"), "framing leaked: {:?}", cleaned);
        assert_ne!(cleaned, raw, "output matches raw input — model didn't transform");
        let has_capital = cleaned.chars().any(|c| c.is_uppercase());
        let has_punct = cleaned.chars().any(|c| matches!(c, '.' | '!' | '?' | ','));
        assert!(
            has_capital || has_punct,
            "no cleanup evidence (no capitals, no punctuation): {:?}",
            cleaned
        );

        // Determinism under greedy sampling. If this starts flaking
        // we've accidentally introduced randomness (temperature, top-k
        // without a fixed seed, etc.) and tests downstream will break
        // in subtle ways.
        let cleaned2 = cleanup_text_sync(&cfg, raw).expect("second call should succeed");
        assert_eq!(cleaned, cleaned2, "non-deterministic output");
    }
}
