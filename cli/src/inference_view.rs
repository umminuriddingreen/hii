//! A transient, factual status line for local inference.

use std::time::Duration;

pub struct MiniInference {
    frame: usize,
    output_started: bool,
}

impl MiniInference {
    pub fn new(_prompt: &str) -> Self {
        Self { frame: 0, output_started: false }
    }

    pub fn observe_delta(&mut self, delta: &str) {
        self.output_started |= !delta.is_empty();
    }

    pub fn next_frame(&mut self, phase: &str, elapsed: Duration, width: usize) -> String {
        let motion = std::env::var("HII_MOTION").map(|value| value != "off").unwrap_or(true);
        let glyph = if motion { ["|", "/", "-", "\\"][self.frame % 4] } else { "*" };
        self.frame = self.frame.wrapping_add(1);
        let phase = if self.output_started { "Generating" } else {
            match phase {
                "thinking" => "Thinking",
                "reviewing" => "Reviewing",
                "compacting" => "Compacting",
                other => other,
            }
        };
        crate::text::clip(&format!("  {glyph} HII  {phase}  {}s", elapsed.as_secs()), width)
    }
}

#[cfg(test)]
mod tests {
    use super::MiniInference;
    use std::time::Duration;

    #[test]
    fn status_is_one_bounded_ascii_line_without_invented_model_content() {
        let mut view = MiniInference::new("private request about an ocean house");
        let before = view.next_frame("thinking", Duration::from_secs(2), 80);
        assert!(before.contains("HII  Thinking  2s"));
        assert!(!before.contains("ocean"));
        assert!(before.is_ascii());
        view.observe_delta("hello");
        let after = view.next_frame("thinking", Duration::from_secs(3), 80);
        assert!(after.contains("Generating  3s"));
        assert!(!after.contains("hello"));
        assert!(after.is_ascii());
    }
}
