// Copyright 2025 OpenAI
//
// Adapted from codex-rs/tui/src/width.rs at
// https://github.com/openai/codex/commit/86a54b051c08f34f373c507ae16a91915ab08700
// Licensed under Apache-2.0. See third_party/codex-ui/LICENSE and NOTICE.

use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

/// Terminal cell width matching Codex/Ratatui semantics, including visible
/// halfwidth sound marks used with Japanese katakana.
pub(crate) fn display_width(text: &str) -> usize {
    UnicodeWidthStr::width(text)
        + text
            .chars()
            .filter(|ch| matches!(ch, '\u{FF9E}' | '\u{FF9F}'))
            .count()
}

pub(crate) fn char_width(ch: char) -> usize {
    if matches!(ch, '\u{FF9E}' | '\u{FF9F}') {
        1
    } else {
        UnicodeWidthChar::width(ch).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_wide_and_halfwidth_kana_cells() {
        assert_eq!(display_width("界"), 2);
        assert_eq!(display_width("ｶﾞﾊﾟ"), 4);
        assert_eq!(char_width('\u{FF9E}'), 1);
    }
}
