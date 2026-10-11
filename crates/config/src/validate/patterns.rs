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
    let reason = match prepare_pattern_checked(source) {
        Ok(text) => {
            let err = regress::Regex::with_flags(&text, "g").err()?;
            err.to_string()
        }
        Err(reason) => reason.to_string(),
    };
    let detail = v8_detail(source, &reason);
    Some(format!("Invalid regex: {detail}"))
}

const QUANTIFIER_LIMIT: u32 = 2_147_483_647;

fn invalid_unicode_escape() -> &'static str {
    "Invalid Unicode escape sequence"
}

fn prepare_pattern_checked(source: &str) -> Result<String, &'static str> {
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
                if chars[index] == 'u' {
                    validate_group_name_unicode(&chars, index)?;
                }
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
                in_class = false;
            }
            continue;
        }
        if ch == '{'
            && !in_class
            && let Some((next, text)) = clamped_quantifier(&chars, index)
        {
            out.push_str(&text);
            index = next;
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
    Ok(out)
}

fn validate_group_name_unicode(chars: &[char], u_index: usize) -> Result<(), &'static str> {
    let after = u_index + 1;
    if chars.get(after) == Some(&'{') {
        let mut cursor = after + 1;
        if cursor >= chars.len() || chars[cursor] == '}' {
            return Err(invalid_unicode_escape());
        }
        while cursor < chars.len() && chars[cursor] != '}' {
            if !chars[cursor].is_ascii_hexdigit() {
                return Err(invalid_unicode_escape());
            }
            cursor += 1;
        }
        if cursor >= chars.len() || chars[cursor] != '}' {
            return Err(invalid_unicode_escape());
        }
        return Ok(());
    }
    if after + 4 > chars.len()
        || !chars[after..after + 4]
            .iter()
            .all(|ch| ch.is_ascii_hexdigit())
    {
        return Err(invalid_unicode_escape());
    }
    Ok(())
}

fn clamped_quantifier(chars: &[char], index: usize) -> Option<(usize, String)> {
    if chars.get(index) != Some(&'{') {
        return None;
    }
    let mut cursor = index + 1;
    let min = read_quantifier_bound(chars, &mut cursor)?;
    let (has_comma, max) = if chars.get(cursor) == Some(&',') {
        cursor += 1;
        if chars.get(cursor) == Some(&'}') {
            (true, None)
        } else {
            (true, Some(read_quantifier_bound(chars, &mut cursor)?))
        }
    } else {
        (false, None)
    };
    if chars.get(cursor) != Some(&'}') {
        return None;
    }
    cursor += 1;
    let mut text = String::new();
    text.push('{');
    text.push_str(&min.to_string());
    if has_comma {
        text.push(',');
        if let Some(max) = max {
            text.push_str(&max.to_string());
        }
    }
    text.push('}');
    Some((cursor, text))
}

fn read_quantifier_bound(chars: &[char], cursor: &mut usize) -> Option<u32> {
    if *cursor >= chars.len() || !chars[*cursor].is_ascii_digit() {
        return None;
    }
    let mut value = 0u32;
    let mut saturated = false;
    while *cursor < chars.len() && chars[*cursor].is_ascii_digit() {
        let digit = u32::from(chars[*cursor] as u8 - b'0');
        if !saturated {
            match value
                .checked_mul(10)
                .and_then(|next| next.checked_add(digit))
            {
                Some(next) if next <= QUANTIFIER_LIMIT => value = next,
                _ => {
                    value = QUANTIFIER_LIMIT;
                    saturated = true;
                }
            }
        }
        *cursor += 1;
    }
    Some(value)
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
            && clamp_bound(min) > clamp_bound(max)
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

fn clamp_bound(value: usize) -> usize {
    value.min(2_147_483_647)
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
    use super::{invalid_regex_message, is_shell_unsafe, prepare_pattern_checked};
    use serde_json::Value;

    fn prepared(source: &str) -> String {
        match prepare_pattern_checked(source) {
            Ok(text) => text,
            Err(_) => source.to_string(),
        }
    }

    fn regex_diagnostic(source: &str) -> String {
        let mut out = String::new();
        out.push_str("Invalid regex: Invalid regular expression: /");
        out.push_str(source);
        out.push_str("/g: ");
        out.push_str("Invalid Unicode escape sequence");
        out
    }

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
        let unbounded = regress::Regex::with_flags(&prepared("x{0,2147483648}"), "g").unwrap();
        assert_eq!(unbounded.find("x").unwrap().range(), 0..1);
        assert_eq!(unbounded.find("").unwrap().range(), 0..0);
        let exact = regress::Regex::with_flags(&prepared("x{2147483648}"), "g").unwrap();
        assert!(exact.find("x").is_none());
        assert!(exact.find("x{2147483648}").is_none());
        let escape = regress::Regex::with_flags(&prepared(r"\u{1F600}"), "g").unwrap();
        assert!(escape.find("u{1F600}").is_some());
        assert!(escape.find("\u{1F600}").is_none());
        let class = regress::Regex::with_flags(&prepared(r"[\u{1F600}]"), "g").unwrap();
        assert!(class.find("u").is_some());
        assert!(class.find("\u{1F600}").is_none());
        let folded = regress::Regex::with_flags(&prepared("(?i:secret)"), "g").unwrap();
        assert!(folded.find("SECRET").is_some());
        let sensitive = regress::Regex::with_flags(&prepared("(?-i:a)"), "g").unwrap();
        assert!(sensitive.find("a").is_some());
        assert!(sensitive.find("A").is_none());
        let annex = regress::Regex::with_flags(&prepared("a{1,2,3}"), "g").unwrap();
        assert!(annex.find("a{1,2,3}").is_some());
        assert_eq!(prepared(r"(?<\u{61}>x)"), r"(?<\u{61}>x)");
        let named = regress::Regex::with_flags(&prepared(r"(?<\u{61}>x)"), "g").unwrap();
        let hit = named.find("x").unwrap();
        assert_eq!(hit.named_group("a").unwrap(), 0..1);
        let paired = r"(?<\u0061>x)\k<\u{61}>";
        assert_eq!(prepared(paired), paired);
        let backref = regress::Regex::with_flags(&prepared(paired), "g").unwrap();
        assert!(backref.find("xx").is_some());
        assert!(backref.find("xy").is_none());
        let brace_name = r"(?<\u{61}>x)\k<\u{61}>";
        assert!(invalid_regex_message(brace_name).is_none());
        let brace_ref = regress::Regex::with_flags(&prepared(brace_name), "g").unwrap();
        assert_eq!(
            brace_ref.find("xx").unwrap().named_group("a").unwrap(),
            0..1
        );
        assert!(brace_ref.find("xy").is_none());
    }

    #[test]
    fn v8_quantifier_saturation_empty_class_and_signed_name_escapes() {
        let saturated = "x{2147483648,2147483647}";
        assert_eq!(prepared(saturated), "x{2147483647,2147483647}");
        assert!(invalid_regex_message(saturated).is_none());
        let compiled = regress::Regex::with_flags(&prepared(saturated), "g").unwrap();
        assert!(compiled.find("x").is_none());
        assert!(compiled.find("").is_none());
        let pattern = r"[^](?<\u{61}>x)";
        assert_eq!(prepared(pattern), pattern);
        assert!(invalid_regex_message(pattern).is_none());
        let named = regress::Regex::with_flags(&prepared(pattern), "g").unwrap();
        let hit = named.find("yx").unwrap();
        assert_eq!(hit.range(), 0..2);
        assert_eq!(hit.named_group("a").unwrap(), 1..2);
        let plus = r"(?<\u+061>x)";
        assert_eq!(
            invalid_regex_message(plus).as_deref(),
            Some(regex_diagnostic(plus).as_str())
        );
        let brace = r"(?<\u{+61}>x)";
        assert_eq!(
            invalid_regex_message(brace).as_deref(),
            Some(regex_diagnostic(brace).as_str())
        );
        let backref = r"(?<\u0061>x)\k<\u+061>";
        assert_eq!(
            invalid_regex_message(backref).as_deref(),
            Some(regex_diagnostic(backref).as_str())
        );
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
