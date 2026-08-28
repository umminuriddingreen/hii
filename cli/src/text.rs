// SPDX-License-Identifier: LicenseRef-BSL-1.1
//! Bounding text for display and for payloads.
//!
//! Nine `truncate` functions were spread across the CLI implementing four different
//! contracts, and the differences were invisible because nothing named them. One of
//! them — `capability_index::truncate` — took `max` characters and *then* appended an
//! ellipsis, so it returned `max + 1` characters and quietly overflowed the column it
//! was measured into. Each contract now exists exactly once, under a name that says
//! which one it is.

/// Shorten for display so the result is never wider than `max` characters.
///
/// The ellipsis is inside the budget, not added to it: `clip("abcdef", 4) == "abc…"`.
/// This is what a column-aligned display needs, and getting it wrong is invisible
/// until a value overflows by exactly one character.
pub fn clip(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    if max == 0 {
        return String::new();
    }
    let mut clipped: String = value.chars().take(max - 1).collect();
    clipped.push('…');
    clipped
}

/// Shorten to at most `max` characters with no ellipsis.
///
/// For values that are stored or matched rather than read, where a trailing `…`
/// would become part of the data.
pub fn clip_hard(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

/// Collapse all whitespace to single spaces, then [`clip`].
///
/// For rendering a multi-line value into a single-line slot.
pub fn clip_line(value: &str, max: usize) -> String {
    clip(&value.split_whitespace().collect::<Vec<_>>().join(" "), max)
}

/// Shorten to at most `max_bytes` bytes without splitting a character.
///
/// A payload bound, not a display bound: protocol limits are counted in bytes, and
/// a char-count bound cannot honor them because one character can occupy four.
pub fn clip_bytes(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut boundary = max_bytes;
    while boundary > 0 && !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    value[..boundary].to_string()
}

/// A lowercase, dash-separated identifier of at most `max` characters.
///
/// `skills` and `project` each had one of these, differing only in their cap (63 and
/// 48). Normalization is identical, so the cap is now the caller's to state and the
/// rule is written once: runs of non-alphanumerics collapse to a single dash, and the
/// result never starts or ends with one — including after the cap is applied, which
/// the character-by-character version could not guarantee.
pub fn slug(value: &str, max: usize) -> String {
    let mut output = String::new();
    let mut pending_dash = false;
    for character in value.trim().to_ascii_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            if pending_dash && !output.is_empty() {
                output.push('-');
            }
            pending_dash = false;
            output.push(character);
        } else {
            pending_dash = true;
        }
    }
    clip_hard(&output, max).trim_matches('-').to_string()
}

/// Percent-encode for an `application/x-www-form-urlencoded` query value.
///
/// Encodes a space as `+`, which is the form-encoding rule and *not* RFC 3986
/// percent-encoding — the name says "query" because using this for a path segment
/// would silently produce a `+` where a space was meant.
pub fn percent_encode_query(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            b' ' => "+".into(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bug that hid inside nine copies: an ellipsis appended *after* taking the
    /// full budget makes the result one character too wide.
    #[test]
    fn the_ellipsis_is_inside_the_budget() {
        assert_eq!(clip("abcdef", 4), "abc…");
        assert_eq!(clip("abcdef", 4).chars().count(), 4);
        for max in 1..12 {
            assert!(
                clip("a very long value that will not fit", max)
                    .chars()
                    .count()
                    <= max,
                "clip overflowed its budget at max={max}"
            );
        }
    }

    #[test]
    fn values_that_fit_are_returned_whole() {
        assert_eq!(clip("abc", 3), "abc");
        assert_eq!(clip("abc", 9), "abc");
        assert_eq!(clip("", 0), "");
        assert_eq!(clip("abc", 0), "");
    }

    /// A stored value must not gain an ellipsis it will later be compared against.
    #[test]
    fn hard_clipping_adds_nothing() {
        assert_eq!(clip_hard("abcdef", 3), "abc");
        assert_eq!(clip_hard("abc", 9), "abc");
    }

    #[test]
    fn line_clipping_collapses_whitespace_first() {
        assert_eq!(clip_line("a\n  b\tc", 16), "a b c");
        assert_eq!(clip_line("a\n  b\tc", 4), "a b…");
    }

    /// The reason a byte bound cannot be a character bound.
    #[test]
    fn byte_clipping_never_splits_a_character() {
        let value = "héllo wörld";
        for max in 0..=value.len() {
            let clipped = clip_bytes(value, max);
            assert!(clipped.len() <= max);
            assert!(value.starts_with(&clipped));
        }
        assert_eq!(clip_bytes("é", 1), "");
    }

    /// The cap used to be applied while building the slug, so a value clipped
    /// mid-run could end on the separator it was supposed to never end on.
    #[test]
    fn slugs_never_start_or_end_with_a_separator() {
        assert_eq!(slug("  Hello, World!  ", 63), "hello-world");
        assert_eq!(slug("a///b", 63), "a-b");
        assert_eq!(slug("!!!", 63), "");
        for max in 1..16 {
            let made = slug("some very long project name here", max);
            assert!(made.len() <= max);
            assert!(
                !made.starts_with('-') && !made.ends_with('-'),
                "{made:?} at max={max}"
            );
        }
    }

    /// Form encoding and path encoding disagree about the space, which is why the
    /// name carries `query`.
    #[test]
    fn query_encoding_uses_plus_for_a_space() {
        assert_eq!(percent_encode_query("a b"), "a+b");
        assert_eq!(percent_encode_query("a/b?c=d"), "a%2Fb%3Fc%3Dd");
        assert_eq!(percent_encode_query("safe-_.~"), "safe-_.~");
        assert_eq!(percent_encode_query("é"), "%C3%A9");
    }

    /// Character counts and byte counts are different budgets, and the multi-byte
    /// case is where treating them as interchangeable starts truncating real text.
    #[test]
    fn character_and_byte_budgets_are_not_interchangeable() {
        let value = "ééééé";
        assert_eq!(value.chars().count(), 5);
        assert_eq!(value.len(), 10);
        assert_eq!(clip(value, 5), value);
        assert_eq!(clip_bytes(value, 5), "éé");
    }
}
