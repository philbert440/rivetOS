use std::sync::OnceLock;

use regex::Regex;

fn compile(pattern: &str) -> Option<Regex> {
    Regex::new(pattern).ok()
}

pub(crate) fn is_hardcoded_api_key(key: &str) -> bool {
    if key.contains("${") {
        return false;
    }
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS
        .get_or_init(|| {
            [
                r"^sk-[a-zA-Z0-9-]{20,}$",
                r"^xai-[a-zA-Z0-9]{20,}$",
                r"^AIza[a-zA-Z0-9_-]{30,}$",
                r"^[a-f0-9]{64,}$",
            ]
            .into_iter()
            .filter_map(compile)
            .collect()
        })
        .iter()
        .any(|pattern| pattern.is_match(key))
}

pub(crate) fn is_redos_pattern(source: &str) -> bool {
    static PATTERN: OnceLock<Option<Regex>> = OnceLock::new();
    PATTERN
        .get_or_init(|| compile(r"\((?:[^\\)]|\\.)*[+*](?:[^\\)]|\\.)*\)(?:[+*?]|\{\d+,?\d*\})"))
        .as_ref()
        .is_some_and(|pattern| pattern.is_match(source))
}

pub(crate) fn is_shell_unsafe(text: &str) -> bool {
    static PATTERN: OnceLock<Option<Regex>> = OnceLock::new();
    PATTERN
        .get_or_init(|| compile(r#"[\s;&|`$<>()'"\\]"#))
        .as_ref()
        .is_some_and(|pattern| pattern.is_match(text))
}

pub(crate) fn has_control_char(text: &str) -> bool {
    static PATTERN: OnceLock<Option<Regex>> = OnceLock::new();
    PATTERN
        .get_or_init(|| compile(r"[\u{0000}-\u{001f}]"))
        .as_ref()
        .is_some_and(|pattern| pattern.is_match(text))
}

pub(crate) fn invalid_regex_message(source: &str) -> Option<String> {
    match regress::Regex::with_flags(source, "g") {
        Ok(_) => None,
        Err(err) => Some(format!("Invalid regex: {err}")),
    }
}

pub(crate) fn api_key_env_hint(name: &str) -> String {
    let mut upper = name.to_uppercase();
    if let Some(index) = upper.find('-') {
        upper.replace_range(index..index + 1, "_");
    }
    upper
}
