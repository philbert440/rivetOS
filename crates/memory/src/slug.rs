use std::sync::OnceLock;

use protocol::js::js_trim;
use regex::Regex;
use unicode_normalization::UnicodeNormalization;

pub const TAG_KEY_PROJECT: &str = "project";
pub const TAG_KEY_MAX: usize = 64;
pub const TAG_VALUE_MAX: usize = 128;
pub const PROJECT_RULE_NAME: &str = "cwd-git-root";

fn cf_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\p{Cf}").ok()).as_ref()
}

pub fn slug(raw: &str, max: usize) -> String {
    let nfkc: String = raw.nfkc().collect();
    let stripped = match cf_re() {
        Some(re) => re.replace_all(&nfkc, "").into_owned(),
        None => nfkc,
    };
    let mut spaced = String::new();
    for ch in stripped.chars() {
        if ch.is_control() {
            spaced.push(' ');
        } else {
            spaced.push(ch);
        }
    }
    let lower = js_trim(&spaced).to_lowercase();
    let mut dashed = String::new();
    let mut prev_dash = false;
    for ch in lower.chars() {
        if ch.is_whitespace() || ch == '/' {
            if !prev_dash && !dashed.is_empty() {
                dashed.push('-');
                prev_dash = true;
            }
        } else {
            dashed.push(ch);
            prev_dash = false;
        }
    }
    let trimmed = dashed.trim_matches('-');
    let cut: String = trimmed.chars().take(max).collect();
    cut.trim_end_matches('-').to_string()
}

pub fn normalize_tag_value(raw: &str) -> String {
    slug(raw, TAG_VALUE_MAX)
}

pub fn normalize_tag_key(raw: &str) -> String {
    let nfkc: String = raw.nfkc().collect();
    let replaced = nfkc.replace(':', "-");
    slug(&replaced, TAG_KEY_MAX)
}

pub fn split_tag_literal(literal: &str) -> Option<(&str, &str)> {
    let idx = literal.find([':', '\u{FF1A}', '\u{FE13}', '\u{FE55}'])?;
    if idx == 0 {
        return None;
    }
    Some((&literal[..idx], &literal[idx + literal[idx..].chars().next()?.len_utf8()..]))
}

pub fn parse_tag_literal(literal: &str) -> Option<(String, String)> {
    let (key, value) = split_tag_literal(literal)?;
    let key = normalize_tag_key(key);
    let value = normalize_tag_value(value);
    if key.is_empty() || value.is_empty() {
        None
    } else {
        Some((key, value))
    }
}
