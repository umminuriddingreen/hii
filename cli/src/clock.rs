// SPDX-License-Identifier: LicenseRef-BSL-1.1
//! The current time, in the two formats HII's stored state actually uses.
//!
//! Five modules defined a private `now`. Three of them produced different strings —
//! `to_rfc3339()`, a hand-written `%Y-%m-%dT%H:%M:%S%.3fZ`, and raw milliseconds — and
//! two of them silently substituted the epoch when the system clock was unreadable.
//! Both formats are kept because both are already on disk in existing receipts and
//! boards; what changes is that each is named for its contract and defined once.

use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch.
///
/// A clock before 1970 is a broken machine, not a recoverable condition, so this
/// saturates at the epoch rather than making every caller handle an error it cannot
/// act on. Callers that must distinguish should read [`SystemTime`] directly.
pub fn unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0)
}

/// RFC 3339, the format HII's receipts and JSON payloads are written in.
pub fn rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Fixed-width UTC with milliseconds: `2026-08-28T19:32:20.029Z`.
///
/// Distinct from [`rfc3339`] and not interchangeable with it: this always renders
/// `Z` and exactly three fractional digits, so stored values sort lexicographically
/// and line up in a column. Existing board and stream records are in this shape.
pub fn iso_millis() -> String {
    from_unix_ms(unix_ms())
}

/// [`iso_millis`] for a specific instant, for rendering stored timestamps.
pub fn from_unix_ms(millis: u128) -> String {
    chrono::DateTime::from_timestamp_millis(millis as i64)
        .unwrap_or_default()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two formats are both on disk, so a caller that swaps one for the other
    /// changes what it writes. This states the difference rather than leaving it to
    /// be discovered by a parser downstream.
    #[test]
    fn the_two_formats_are_not_interchangeable() {
        let fixed = from_unix_ms(1_772_309_540_029);
        assert_eq!(fixed, "2026-02-28T20:12:20.029Z");
        assert!(
            fixed.ends_with('Z'),
            "iso_millis must render Z, not an offset"
        );
        assert_eq!(
            fixed.len(),
            24,
            "iso_millis is fixed width so it sorts and aligns"
        );
        assert!(
            rfc3339().contains('+') || rfc3339().ends_with('Z'),
            "rfc3339 carries an explicit offset"
        );
    }

    #[test]
    fn fixed_width_timestamps_sort_chronologically() {
        assert!(from_unix_ms(1_000) < from_unix_ms(1_001));
        assert!(from_unix_ms(1_772_309_540_029) < from_unix_ms(1_772_309_541_000));
    }

    #[test]
    fn the_clock_moves_forward() {
        let first = unix_ms();
        assert!(first > 1_600_000_000_000, "the clock should be past 2020");
        assert!(unix_ms() >= first);
    }
}
