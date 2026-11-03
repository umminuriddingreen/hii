//! Bracketed-paste staging for the interactive composer.
//!
//! Without bracketed paste a terminal delivers pasted text as if it were typed:
//! every newline in the clipboard becomes an Enter, so a multi-line paste is
//! submitted as several half-finished intents and a tab inside it queues the
//! line. The REPL enables bracketed paste (see `keyboard::RawModeGuard`) so the
//! whole clipboard arrives as one `Event::Paste`, and this module decides what
//! the composer should show for it.
//!
//! Short single-line pastes are inserted literally — that is what the operator
//! expects to see. Anything longer or multi-line is *staged*: the buffer gets a
//! compact placeholder such as `⟦paste #1 · 42 lines, 1.2k chars⟧` while the
//! real text is held here and substituted back in when the line is submitted.
//! That keeps the one-line composer renderer honest and keeps a 500-line paste
//! from scrolling the prompt off the screen, without losing a byte.

/// Longest single-line paste inserted literally instead of being staged.
const INLINE_LIMIT: usize = 240;

const OPEN: char = '⟦';
const CLOSE: char = '⟧';

/// Pasted blocks staged for the line currently being composed.
#[derive(Debug, Default, Clone)]
pub struct PasteStore {
    blocks: Vec<(String, String)>,
}

impl PasteStore {
    /// Prepare a raw clipboard payload for insertion at the cursor.
    ///
    /// Returns the text to insert into the composer buffer — the paste itself
    /// when it is short and single-line, otherwise a placeholder that
    /// [`PasteStore::expand`] resolves. An empty return means the paste carried
    /// nothing worth inserting.
    pub fn stage(&mut self, raw: &str) -> String {
        let text = normalize(raw);
        if text.is_empty() {
            return String::new();
        }
        let lines = text.lines().count().max(1);
        if lines == 1 && text.chars().count() <= INLINE_LIMIT {
            return text.replace('\t', " ");
        }
        let token = placeholder(self.blocks.len() + 1, lines, text.chars().count());
        self.blocks.push((token.clone(), text));
        token
    }

    /// Substitute every staged block back into a submitted line.
    ///
    /// Placeholders the operator deleted are simply never substituted, so
    /// removing one from the composer really does drop that paste.
    pub fn expand(&self, line: &str) -> String {
        if self.blocks.is_empty() || !line.contains(OPEN) {
            return line.to_string();
        }
        let mut expanded = line.to_string();
        for (token, text) in &self.blocks {
            if expanded.contains(token.as_str()) {
                expanded = expanded.replace(token.as_str(), text);
            }
        }
        expanded
    }

    /// Drop every staged block. Called once a line has been submitted.
    pub fn clear(&mut self) {
        self.blocks.clear();
    }
}

/// Whether a composer buffer currently holds a staged-paste placeholder.
///
/// The slash-command menu keys off the buffer text, and a buffer holding a
/// paste is prose, not a command — even when the paste begins with `/`.
pub fn holds_placeholder(buf: &str) -> bool {
    buf.contains(OPEN) && buf.contains(CLOSE)
}

/// Canonicalize a clipboard payload: normalize line endings, drop control
/// bytes a terminal would otherwise interpret, and trim trailing blank space.
///
/// Escape sequences matter here: pasting terminal output that contains raw
/// `\x1b[…m` colour codes would otherwise repaint the composer.
fn normalize(raw: &str) -> String {
    let unified = raw.replace("\r\n", "\n").replace('\r', "\n");
    let stripped = strip_ansi(&unified);
    let mut cleaned = String::with_capacity(stripped.len());
    for character in stripped.chars() {
        match character {
            '\n' | '\t' => cleaned.push(character),
            character if character.is_control() => {}
            character => cleaned.push(character),
        }
    }
    cleaned.trim_end().trim_start_matches('\n').to_string()
}

/// Remove CSI/OSC escape sequences from pasted terminal output.
fn strip_ansi(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(character) = chars.next() {
        if character != '\x1b' {
            out.push(character);
            continue;
        }
        match chars.peek() {
            // CSI: parameters and intermediates, then one final byte.
            Some('[') => {
                chars.next();
                for inner in chars.by_ref() {
                    if ('\x40'..='\x7e').contains(&inner) {
                        break;
                    }
                }
            }
            // OSC: runs until BEL or String Terminator.
            Some(']') => {
                chars.next();
                while let Some(inner) = chars.next() {
                    if inner == '\x07' {
                        break;
                    }
                    if inner == '\x1b' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            // Two-character escape.
            Some(_) => {
                chars.next();
            }
            None => {}
        }
    }
    out
}

fn placeholder(index: usize, lines: usize, chars: usize) -> String {
    let unit = if lines == 1 { "line" } else { "lines" };
    format!(
        "{OPEN}paste #{index} · {lines} {unit}, {}{CLOSE}",
        compact_chars(chars)
    )
}

fn compact_chars(chars: usize) -> String {
    if chars < 1000 {
        return format!("{chars} chars");
    }
    format!("{:.1}k chars", chars as f64 / 1000.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_single_line_paste_is_inserted_literally() {
        let mut store = PasteStore::default();
        assert_eq!(store.stage("deploy the worker"), "deploy the worker");
        // Nothing staged, so submitting is a pass-through.
        assert_eq!(store.expand("deploy the worker"), "deploy the worker");
    }

    #[test]
    fn multi_line_paste_is_staged_behind_a_placeholder() {
        let mut store = PasteStore::default();
        let token = store.stage("fn main() {\n    println!(\"hi\");\n}");
        assert!(token.starts_with('⟦') && token.contains("3 lines"));

        let submitted = store.expand(&format!("explain {token} please"));
        assert_eq!(
            submitted,
            "explain fn main() {\n    println!(\"hi\");\n} please"
        );
    }

    #[test]
    fn long_single_line_paste_is_staged_too() {
        let mut store = PasteStore::default();
        let long = "x".repeat(INLINE_LIMIT + 1);
        let token = store.stage(&long);
        assert!(token.contains("1 line"));
        assert_eq!(store.expand(&token), long);
    }

    #[test]
    fn crlf_and_escape_sequences_are_normalized_away() {
        let mut store = PasteStore::default();
        let token = store.stage("\x1b[31mred\x1b[0m\r\nplain\r\n");
        assert_eq!(store.expand(&token), "red\nplain");
    }

    #[test]
    fn deleting_a_placeholder_drops_that_paste() {
        let mut store = PasteStore::default();
        let first = store.stage("one\ntwo");
        let second = store.stage("three\nfour");
        assert_ne!(first, second);

        // Operator kept only the second placeholder.
        assert_eq!(store.expand(&second), "three\nfour");
    }

    #[test]
    fn whitespace_only_paste_inserts_nothing() {
        let mut store = PasteStore::default();
        assert_eq!(store.stage("\n\n   \n"), "");
    }

    #[test]
    fn a_staged_buffer_is_not_treated_as_a_slash_command() {
        let mut store = PasteStore::default();
        let token = store.stage("/usr/bin/env\n/usr/local/bin");
        assert!(holds_placeholder(&token));
        assert!(!holds_placeholder("/status"));
    }

    #[test]
    fn clearing_forgets_staged_blocks() {
        let mut store = PasteStore::default();
        let token = store.stage("one\ntwo");
        store.clear();
        assert_eq!(store.expand(&token), token);
    }
}
