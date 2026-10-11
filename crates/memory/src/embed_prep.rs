use std::sync::OnceLock;

use protocol::js::js_trim;
use regress::Regex;

use crate::scoring::LooseNumber;
use crate::text::{utf16_len, utf16_prefix};

pub const DEFAULT_EMBED_QUERY_INSTRUCTION: &str =
    "Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: ";
pub const EMBED_QUERY_INPUT_MAX: usize = 8_000;
pub const DEFAULT_EMBED_TIMEOUT_MS: i64 = 8_000;
pub const MIN_EMBED_TIMEOUT_MS: i64 = 500;
pub const MAX_EMBED_TIMEOUT_MS: i64 = 60_000;
pub const QUERY_EMBED_CACHE_MAX: usize = 256;
pub const QUERY_EMBED_CACHE_TTL_MS: i64 = 10 * 60 * 1000;

fn ws_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::with_flags(r"\s+", "").ok())
        .as_ref()
}

pub fn normalize_query_text(text: &str) -> String {
    let trimmed = js_trim(text);
    let Some(re) = ws_re() else {
        return trimmed.to_string();
    };
    let mut out = String::new();
    let mut last = 0usize;
    for hit in re.find_iter(trimmed) {
        let start = hit.start();
        let end = hit.end();
        if start > last && trimmed.is_char_boundary(start) && trimmed.is_char_boundary(end) {
            out.push_str(&trimmed[last..start]);
            out.push(' ');
            last = end;
        }
    }
    if trimmed.is_char_boundary(last) {
        out.push_str(&trimmed[last..]);
    }
    out
}

pub fn apply_embed_query_instruction(instruction: &str, text: &str) -> String {
    let budget = EMBED_QUERY_INPUT_MAX.saturating_sub(utf16_len(instruction));
    let sliced = utf16_prefix(text, budget);
    if instruction.is_empty() {
        sliced
    } else {
        format!("{instruction}{sliced}")
    }
}

pub fn clamp_embed_timeout_ms(raw: &LooseNumber) -> i64 {
    let Some(n) = crate::scoring::coerce_number(raw) else {
        return DEFAULT_EMBED_TIMEOUT_MS;
    };
    let truncated = if n.is_finite() { n.trunc() } else { 0.0 };
    let as_i = if truncated >= i64::MAX as f64 {
        i64::MAX
    } else if truncated <= i64::MIN as f64 {
        i64::MIN
    } else {
        truncated as i64
    };
    MAX_EMBED_TIMEOUT_MS.min(MIN_EMBED_TIMEOUT_MS.max(as_i))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instruction_prefix_and_cap() {
        assert_eq!(
            apply_embed_query_instruction(DEFAULT_EMBED_QUERY_INSTRUCTION, "hello"),
            format!("{DEFAULT_EMBED_QUERY_INSTRUCTION}hello")
        );
        assert_eq!(apply_embed_query_instruction("", "hello"), "hello");
        let instruction = "Instruct: x\nQuery: ";
        let out = apply_embed_query_instruction(instruction, &"q".repeat(9000));
        assert_eq!(utf16_len(&out), 8000);
        assert!(out.starts_with(instruction));
    }

    #[test]
    fn timeout_clamp_matches_search_tests() {
        assert_eq!(
            clamp_embed_timeout_ms(&LooseNumber::Absent),
            DEFAULT_EMBED_TIMEOUT_MS
        );
        assert_eq!(
            clamp_embed_timeout_ms(&LooseNumber::Number(100.0)),
            MIN_EMBED_TIMEOUT_MS
        );
        assert_eq!(
            clamp_embed_timeout_ms(&LooseNumber::Text("100".to_string())),
            MIN_EMBED_TIMEOUT_MS
        );
        assert_eq!(
            clamp_embed_timeout_ms(&LooseNumber::Text("12000".to_string())),
            12_000
        );
        assert_eq!(
            clamp_embed_timeout_ms(&LooseNumber::Text("nope".to_string())),
            DEFAULT_EMBED_TIMEOUT_MS
        );
        assert_eq!(
            clamp_embed_timeout_ms(&LooseNumber::Number(0.0)),
            MIN_EMBED_TIMEOUT_MS
        );
        assert_eq!(
            clamp_embed_timeout_ms(&LooseNumber::Number(-20.0)),
            MIN_EMBED_TIMEOUT_MS
        );
        assert_eq!(
            clamp_embed_timeout_ms(&LooseNumber::Number(800_000.0)),
            MAX_EMBED_TIMEOUT_MS
        );
    }

    #[test]
    fn whitespace_collapses_to_one_cache_key() {
        assert_eq!(normalize_query_text("  hello   world  "), "hello world");
        assert_eq!(normalize_query_text("hello"), "hello");
    }
}
