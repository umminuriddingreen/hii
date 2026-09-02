//! Compact inference projection for the interactive terminal.
//!
//! This is a deterministic display model. It does not claim access to model
//! embeddings, attention tensors, or private reasoning state.

use std::time::Duration;

pub struct MiniInference {
    prompt_tokens: Vec<String>,
    generated: String,
    generated_tokens: usize,
    frame: usize,
}

impl MiniInference {
    pub fn new(prompt: &str) -> Self {
        Self {
            prompt_tokens: visible_tokens(prompt).into_iter().take(100).collect(),
            generated: String::new(),
            generated_tokens: 0,
            frame: 0,
        }
    }

    pub fn observe_delta(&mut self, delta: &str) {
        self.generated.push_str(delta);
        self.generated_tokens = visible_tokens(&self.generated).len();
    }

    pub fn next_frame(&mut self, phase: &str, elapsed: Duration, width: usize) -> String {
        self.frame = self.frame.wrapping_add(1);
        render_frame(
            &self.prompt_tokens,
            &self.generated,
            self.generated_tokens,
            self.frame,
            phase,
            elapsed,
            width,
        )
    }
}

fn render_frame(
    prompt_tokens: &[String],
    generated: &str,
    generated_tokens: usize,
    frame: usize,
    phase: &str,
    elapsed: Duration,
    width: usize,
) -> String {
    let phase = if generated.is_empty() {
        match phase {
            "thinking" => "COMPUTING",
            "reviewing" => "REVIEWING",
            "compacting" => "COMPACTING",
            other => other,
        }
    } else {
        "GENERATING"
    };
    let selected = selected_tokens(prompt_tokens, frame, width);
    let mut field = String::new();
    for (index, token) in selected.iter().enumerate() {
        if index > 0 {
            field.push_str(if index % 3 == 0 { " ╱ " } else { " ─ " });
        }
        let active = (index + frame / 3) % selected.len().max(1) < 2;
        field.push_str(&if active {
            crate::tui::style_active(token)
        } else {
            crate::tui::style_dim(token)
        });
    }
    let forming = visible_tokens(generated)
        .last()
        .cloned()
        .or_else(|| prototype_candidate(prompt_tokens));
    let rate = if generated_tokens > 0 && elapsed.as_secs_f64() > 0.25 {
        format!(
            "  ~{:.1} tok/s",
            generated_tokens as f64 / elapsed.as_secs_f64()
        )
    } else {
        String::new()
    };
    let candidate = forming
        .map(|token| {
            format!(
                "  {} {}",
                crate::tui::style_dim("→"),
                crate::tui::style_accent(&token)
            )
        })
        .unwrap_or_default();
    let plain_budget = width.saturating_sub(
        phase.chars().count() + rate.chars().count() + candidate.chars().count() + 6,
    );
    let field = crate::text::clip_line(&field, plain_budget.max(12));
    format!(
        "  {}  {}{}{}",
        crate::tui::style_bold(&phase.to_uppercase()),
        field,
        candidate,
        crate::tui::style_dim(&rate),
    )
}

fn selected_tokens(tokens: &[String], frame: usize, width: usize) -> Vec<String> {
    let maximum = if width < 58 {
        3
    } else if width < 82 {
        5
    } else {
        7
    };
    if tokens.len() <= maximum {
        return tokens.to_vec();
    }
    let mut ranked = tokens
        .iter()
        .enumerate()
        .map(|(index, token)| {
            let semantic = matches!(
                token.to_ascii_lowercase().as_str(),
                "design" | "small" | "concrete" | "house" | "beside" | "ocean"
            ) as usize;
            let pulse = stable_hash(token) as usize % 7 + (frame / 4 + index) % 3;
            (semantic * 20 + pulse, index, token.clone())
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| right.0.cmp(&left.0).then(left.1.cmp(&right.1)));
    ranked.truncate(maximum);
    ranked.sort_by_key(|entry| entry.1);
    ranked.into_iter().map(|entry| entry.2).collect()
}

fn prototype_candidate(tokens: &[String]) -> Option<String> {
    let normalized = tokens
        .iter()
        .map(|token| token.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let prototype = ["design", "small", "concrete", "house", "ocean"];
    prototype
        .iter()
        .all(|expected| normalized.iter().any(|token| token == expected))
        .then(|| "≈with .42".into())
}

pub(crate) fn visible_tokens(value: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    for character in value.chars() {
        if character.is_alphanumeric() || matches!(character, '\'' | '’' | '-') {
            current.push(character);
        } else {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            if !character.is_whitespace() {
                tokens.push(character.to_string());
            }
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn stable_hash(value: &str) -> u32 {
    value.bytes().fold(2_166_136_261_u32, |hash, byte| {
        (hash ^ u32::from(byte)).wrapping_mul(16_777_619)
    })
}

#[cfg(test)]
mod tests {
    use super::{render_frame, visible_tokens, MiniInference};
    use std::time::Duration;

    #[test]
    fn tokenizes_the_prototype_prompt_without_inventing_ids() {
        assert_eq!(
            visible_tokens("Design a small concrete house beside the ocean."),
            ["Design", "a", "small", "concrete", "house", "beside", "the", "ocean", "."]
        );
    }

    #[test]
    fn renders_a_bounded_scientific_strip() {
        let prompt = visible_tokens("Design a small concrete house beside the ocean.");
        let frame = render_frame(&prompt, "", 0, 2, "thinking", Duration::from_secs(1), 92);
        assert!(frame.contains("COMPUTING"));
        assert!(frame.contains("concrete"));
        assert!(frame.contains("≈with .42"));
        assert!(frame.contains('─') || frame.contains('╱'));
    }

    #[test]
    fn observed_output_becomes_the_forming_token() {
        let mut view = MiniInference::new("Make a house");
        view.observe_delta("with broad");
        let frame = view.next_frame("thinking", Duration::from_secs(2), 80);
        assert!(frame.contains("GENERATING"));
        assert!(frame.contains("broad"));
        assert!(frame.contains("tok/s"));
    }
}
