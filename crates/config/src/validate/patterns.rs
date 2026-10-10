use std::sync::OnceLock;

fn compile(pattern: &str) -> Option<regress::Regex> {
    regress::Regex::new(pattern).ok()
}

fn matches(pattern: &regress::Regex, text: &str) -> bool {
    pattern.find(text).is_some()
}

pub(crate) fn is_hardcoded_api_key(key: &str) -> bool {
    if key.contains("${") {
        return false;
    }
    static PATTERNS: OnceLock<Vec<regress::Regex>> = OnceLock::new();
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
        .any(|pattern| matches(pattern, key))
}

pub(crate) fn is_redos_pattern(source: &str) -> bool {
    static PATTERN: OnceLock<Option<regress::Regex>> = OnceLock::new();
    PATTERN
        .get_or_init(|| compile(r"\((?:[^\\)]|\\.)*[+*](?:[^\\)]|\\.)*\)(?:[+*?]|\{\d+,?\d*\})"))
        .as_ref()
        .is_some_and(|pattern| matches(pattern, source))
}

pub(crate) fn is_shell_unsafe(text: &str) -> bool {
    static PATTERN: OnceLock<Option<regress::Regex>> = OnceLock::new();
    PATTERN
        .get_or_init(|| compile(r#"[\s;&|`$<>()'"\\]"#))
        .as_ref()
        .is_some_and(|pattern| matches(pattern, text))
}

pub(crate) fn has_control_char(text: &str) -> bool {
    text.chars()
        .any(|ch| ('\u{0000}'..='\u{001f}').contains(&ch))
}

pub(crate) fn invalid_regex_message(source: &str) -> Option<String> {
    let prepared = prepare_pattern(source);
    let err = regress::Regex::with_flags(&prepared, "g").err()?;
    let detail = v8_detail(source, &err.to_string());
    Some(format!("Invalid regex: {detail}"))
}

fn prepare_pattern(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let mut out = String::new();
    let mut index = 0;
    let mut in_class = false;
    let mut in_name = false;
    while index < chars.len() {
        let ch = chars[index];
        if in_name {
            out.push(ch);
            index += 1;
            if ch == '\\' && index < chars.len() {
                out.push(chars[index]);
                index += 1;
                continue;
            }
            if ch == '>' {
                in_name = false;
            }
            continue;
        }
        if ch == '\\' {
            if index + 1 >= chars.len() {
                out.push('\\');
                break;
            }
            let next = chars[index + 1];
            if next == 'k' && !in_class && chars.get(index + 2) == Some(&'<') {
                out.push('\\');
                out.push('k');
                out.push('<');
                index += 3;
                in_name = true;
                continue;
            }
            if next == 'u' && chars.get(index + 2) == Some(&'{') {
                out.push('u');
                index += 2;
                continue;
            }
            out.push('\\');
            out.push(next);
            index += 2;
            continue;
        }
        if ch == '(' && !in_class && named_capture_open(&chars, index) {
            out.push('(');
            out.push('?');
            out.push('<');
            index += 3;
            in_name = true;
            continue;
        }
        if ch == '[' && !in_class {
            in_class = true;
            out.push('[');
            index += 1;
            if chars.get(index) == Some(&'^') {
                out.push('^');
                index += 1;
            }
            if chars.get(index) == Some(&']') {
                out.push(']');
                index += 1;
            }
            continue;
        }
        if ch == ']' && in_class {
            in_class = false;
            out.push(']');
            index += 1;
            continue;
        }
        out.push(ch);
        index += 1;
    }
    out
}

fn named_capture_open(chars: &[char], index: usize) -> bool {
    chars.get(index + 1) == Some(&'?')
        && chars.get(index + 2) == Some(&'<')
        && !matches!(chars.get(index + 3), Some('=' | '!'))
}

fn v8_detail(source: &str, regress_text: &str) -> String {
    let mut out = String::new();
    out.push_str("Invalid");
    out.push(' ');
    out.push_str("regular");
    out.push(' ');
    out.push_str("expression:");
    out.push(' ');
    out.push('/');
    out.push_str(source);
    out.push_str("/g:");
    out.push(' ');
    out.push_str(v8_reason(source, regress_text));
    out
}

fn v8_reason<'a>(source: &str, regress_text: &'a str) -> &'a str {
    if regress_text == "Invalid atom character"
        || regress_text == "Invalid braced quantifier"
        || regress_text == "Quantifier not allowed here"
    {
        "Nothing to repeat"
    } else if regress_text == "Unbalanced parenthesis" {
        if unmatched_close(source) {
            "Unmatched ')'"
        } else {
            "Unterminated group"
        }
    } else if regress_text == "Invalid group modifier" {
        "Invalid group"
    } else if regress_text == "Invalid token at named capture group identifier" {
        if source.contains("(?<") {
            "Invalid capture group name"
        } else {
            "Invalid group"
        }
    } else if regress_text == "Unbalanced bracket" {
        "Unterminated character class"
    } else if regress_text == "Incomplete escape" {
        "\\ at end of pattern"
    } else if regress_text == "Invalid named backreference syntax"
        || regress_text.starts_with("Backreference to invalid named capture group")
    {
        "Invalid named capture referenced"
    } else if regress_text == "Duplicate capture group name" {
        "Duplicate capture group name"
    } else if regress_text == "Invalid quantifier" {
        if reversed_bounds(source) {
            "numbers out of order in {} quantifier"
        } else {
            regress_text
        }
    } else if regress_text
        == "Range values reversed, start char code is greater than end char code."
        || regress_text == "Invalid character range"
    {
        "Range out of order in character class"
    } else {
        regress_text
    }
}

fn unmatched_close(source: &str) -> bool {
    let mut chars = source.chars().peekable();
    let mut depth = 0i32;
    let mut in_class = false;
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            chars.next();
            continue;
        }
        if in_class {
            if ch == ']' {
                in_class = false;
            }
            continue;
        }
        match ch {
            '[' => in_class = true,
            '(' => depth += 1,
            ')' => {
                if depth == 0 {
                    return true;
                }
                depth -= 1;
            }
            _ => {}
        }
    }
    false
}

fn reversed_bounds(source: &str) -> bool {
    let bytes = source.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'{'
            && let Some((min, max)) = braced_bounds(bytes, index)
            && let Some(max) = max
            && min > max
        {
            return true;
        }
        index += 1;
    }
    false
}

fn braced_bounds(bytes: &[u8], start: usize) -> Option<(usize, Option<usize>)> {
    let mut cursor = start + 1;
    let min = read_usize(bytes, &mut cursor)?;
    let max = if cursor < bytes.len() && bytes[cursor] == b',' {
        cursor += 1;
        read_usize(bytes, &mut cursor)
    } else {
        Some(min)
    };
    if cursor < bytes.len() && bytes[cursor] == b'}' {
        Some((min, max))
    } else {
        None
    }
}

fn read_usize(bytes: &[u8], cursor: &mut usize) -> Option<usize> {
    if *cursor >= bytes.len() || !bytes[*cursor].is_ascii_digit() {
        return None;
    }
    let mut value = 0usize;
    while *cursor < bytes.len() && bytes[*cursor].is_ascii_digit() {
        value = value
            .saturating_mul(10)
            .saturating_add(usize::from(bytes[*cursor] - b'0'));
        *cursor += 1;
    }
    Some(value)
}

pub(crate) fn api_key_env_hint(name: &str) -> String {
    let mut upper = name.to_uppercase();
    if let Some(index) = upper.find('-') {
        upper.replace_range(index..index + 1, "_");
    }
    upper
}

#[cfg(test)]
mod v8_golden {
    use super::{invalid_regex_message, is_shell_unsafe, prepare_pattern};
    use serde_json::Value;

    #[test]
    fn node24_flag_g_matches_v8() {
        let doc: Value =
            serde_json::from_str(include_str!("../../tests/golden/v8-regex-g.node24.json"))
                .unwrap();
        let rows = doc.get("rows").and_then(Value::as_array).unwrap();
        assert_eq!(rows.len(), 80);
        for row in rows {
            let pattern = row.get("pattern").and_then(Value::as_str).unwrap();
            let ok = row.get("ok").and_then(Value::as_bool).unwrap();
            let actual = invalid_regex_message(pattern);
            if ok {
                assert!(actual.is_none(), "{pattern:?}={actual:?}");
            } else {
                let message = row.get("message").and_then(Value::as_str).unwrap();
                let mut expected = String::new();
                expected.push_str("Invalid regex: ");
                expected.push_str(message);
                assert_eq!(actual.as_deref(), Some(expected.as_str()), "{pattern:?}");
            }
        }
    }

    #[test]
    fn legacy_quantifiers_and_unicode_escapes_match_v8() {
        let reversed = invalid_regex_message("x{2147483648,1}").unwrap();
        assert!(reversed.contains("numbers out of order in {} quantifier"));
        let unbounded =
            regress::Regex::with_flags(&prepare_pattern("x{0,2147483648}"), "g").unwrap();
        assert_eq!(unbounded.find("x").unwrap().range(), 0..1);
        assert_eq!(unbounded.find("").unwrap().range(), 0..0);
        let exact = regress::Regex::with_flags(&prepare_pattern("x{2147483648}"), "g").unwrap();
        assert!(exact.find("x").is_none());
        assert!(exact.find("x{2147483648}").is_none());
        let escape = regress::Regex::with_flags(&prepare_pattern(r"\u{1F600}"), "g").unwrap();
        assert!(escape.find("u{1F600}").is_some());
        assert!(escape.find("\u{1F600}").is_none());
        let class = regress::Regex::with_flags(&prepare_pattern(r"[\u{1F600}]"), "g").unwrap();
        assert!(class.find("u").is_some());
        assert!(class.find("\u{1F600}").is_none());
        let folded = regress::Regex::with_flags(&prepare_pattern("(?i:secret)"), "g").unwrap();
        assert!(folded.find("SECRET").is_some());
        let sensitive = regress::Regex::with_flags(&prepare_pattern("(?-i:a)"), "g").unwrap();
        assert!(sensitive.find("a").is_some());
        assert!(sensitive.find("A").is_none());
        let annex = regress::Regex::with_flags(&prepare_pattern("a{1,2,3}"), "g").unwrap();
        assert!(annex.find("a{1,2,3}").is_some());
        assert_eq!(prepare_pattern(r"(?<\u{61}>x)"), r"(?<\u{61}>x)");
        let named = regress::Regex::with_flags(&prepare_pattern(r"(?<\u{61}>x)"), "g").unwrap();
        let hit = named.find("x").unwrap();
        assert_eq!(hit.named_group("a").unwrap(), 0..1);
        let paired = r"(?<\u0061>x)\k<\u{61}>";
        assert_eq!(prepare_pattern(paired), paired);
        let backref = regress::Regex::with_flags(&prepare_pattern(paired), "g").unwrap();
        assert!(backref.find("xx").is_some());
        assert!(backref.find("xy").is_none());
        let brace_name = r"(?<\u{61}>x)\k<\u{61}>";
        assert!(invalid_regex_message(brace_name).is_none());
        let brace_ref = regress::Regex::with_flags(&prepare_pattern(brace_name), "g").unwrap();
        assert_eq!(
            brace_ref.find("xx").unwrap().named_group("a").unwrap(),
            0..1
        );
        assert!(brace_ref.find("xy").is_none());
    }

    #[test]
    fn shell_unsafe_uses_javascript_whitespace() {
        assert!(is_shell_unsafe("a\u{FEFF}b"));
        let mut next_line = String::from("a");
        next_line.push('\u{0085}');
        next_line.push('b');
        assert!(!is_shell_unsafe(&next_line));
        let mut spaced = String::from("a");
        spaced.push(' ');
        spaced.push('b');
        assert!(is_shell_unsafe(&spaced));
        assert!(is_shell_unsafe("a;b"));
        assert!(!is_shell_unsafe("ab"));
    }
}
