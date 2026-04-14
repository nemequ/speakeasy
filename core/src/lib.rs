use anyhow::{Context, Result};
use std::path::Path;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

pub struct WhisperModel {
    context: WhisperContext,
}

impl WhisperModel {
    pub fn load(model_path: &str) -> Result<Self> {
        let path = Path::new(model_path);
        let actual_path = if path.is_dir() {
            let mut found = None;
            for entry in std::fs::read_dir(path)? {
                let entry = entry?;
                let entry_path = entry.path();
                if let Some(ext) = entry_path.extension() {
                    if ext == "bin" {
                        if let Some(name) = entry_path.file_name().and_then(|n| n.to_str()) {
                            if name.starts_with("ggml-") {
                                found = Some(entry_path.to_string_lossy().into_owned());
                                break;
                            }
                        }
                    }
                }
            }
            found.context("No ggml-*.bin model file found in directory")?
        } else {
            model_path.to_string()
        };

        let ctx = WhisperContext::new_with_params(
            &actual_path,
            WhisperContextParameters::default(),
        )
        .context("failed to load whisper model")?;

        Ok(Self { context: ctx })
    }

    pub fn transcribe(&mut self, pcm_data: &[f32]) -> Result<String> {
        if pcm_data.is_empty() {
            return Ok(String::new());
        }

        let mut state = self
            .context
            .create_state()
            .context("failed to create whisper state")?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some("en"));
        params.set_no_timestamps(true);
        params.set_single_segment(true);

        state
            .full(params, pcm_data)
            .context("failed to run whisper")?;

        let num_segments = state.full_n_segments();

        if num_segments == 0 {
            return Ok(String::new());
        }

        let mut text = String::new();
        for i in 0..num_segments {
            if let Some(segment) = state.get_segment(i) {
                if let Ok(s) = segment.to_str() {
                    text.push_str(s);
                }
            }
        }

        Ok(text.trim().to_string())
    }
}
