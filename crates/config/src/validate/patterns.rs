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
    let err = regress::Regex::with_flags(source, "g").err()?;
    let detail = v8_detail(source, &err.to_string());
    Some(format!("Invalid regex: {detail}"))
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
    if regress_text == "Invalid atom character" {
        if lone_quantifier_brackets(source) {
            "Lone quantifier brackets"
        } else {
            "Nothing to repeat"
        }
    } else if regress_text == "Invalid braced quantifier"
        || regress_text == "Quantifier not allowed here"
    {
        "Nothing to repeat"
    } else if regress_text == "Unbalanced parenthesis" {
        if unmatched_close(source) {
            "Unmatched ')'"
        } else {
            "Unterminated group"
        }
    } else if regress_text == "Invalid token at named capture group identifier"
        || regress_text == "Invalid group modifier"
    {
        "Invalid group"
    } else if regress_text == "Unbalanced bracket" {
        "Unterminated character class"
    } else if regress_text == "Incomplete escape"
        || regress_text == "Unterminated escape"
        || regress_text == "Invalid character escape"
        || regress_text == "Invalid unicode escape"
    {
        "Invalid escape"
    } else if regress_text == "Invalid named backreference syntax"
        || regress_text.starts_with("Backreference to invalid named capture group")
    {
        "Invalid named capture referenced"
    } else if regress_text == "Duplicate capture group name" {
        "Duplicate capture group name"
    } else if regress_text == "Invalid quantifier" {
        quantifier_reason(source)
    } else if regress_text
        == "Range values reversed, start char code is greater than end char code."
        || regress_text == "Invalid character range"
    {
        "Range out of order in character class"
    } else {
        regress_text
    }
}

fn lone_quantifier_brackets(source: &str) -> bool {
    let brace = source.contains('{') || source.contains('}');
    let repeat = source.contains('*') || source.contains('+') || source.contains('?');
    brace && !repeat
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

fn quantifier_reason(source: &str) -> &'static str {
    if reversed_bounds(source) {
        "numbers out of order in {} quantifier"
    } else if incomplete_quantifier(source) {
        "Incomplete quantifier"
    } else {
        "Lone quantifier brackets"
    }
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

fn incomplete_quantifier(source: &str) -> bool {
    let bytes = source.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'{' {
            let mut cursor = index + 1;
            let mut digits = false;
            while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
                digits = true;
                cursor += 1;
            }
            if cursor < bytes.len() && bytes[cursor] == b',' {
                digits = true;
                cursor += 1;
                while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
                    cursor += 1;
                }
            }
            if digits && (cursor >= bytes.len() || bytes[cursor] != b'}') {
                return true;
            }
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
mod v8_map {
    use super::v8_reason;

    fn words(parts: &[&str]) -> String {
        let mut out = String::new();
        for (index, part) in parts.iter().enumerate() {
            if index > 0 {
                out.push(' ');
            }
            out.push_str(part);
        }
        out
    }

    #[test]
    fn unicode_only_reasons_follow_source_shape() {
        let atom = words(&["Invalid", "atom", "character"]);
        let quant = words(&["Invalid", "quantifier"]);
        let lone = words(&["Lone", "quantifier", "brackets"]);
        let incomplete = words(&["Incomplete", "quantifier"]);
        let escape = words(&["Invalid", "escape"]);
        let range = words(&["Range", "out", "of", "order", "in", "character", "class"]);
        let named = words(&["Invalid", "named", "capture", "referenced"]);
        assert_eq!(v8_reason("{", &atom), lone);
        assert_eq!(v8_reason("}", &atom), lone);
        assert_eq!(v8_reason("a{1", &quant), incomplete);
        assert_eq!(
            v8_reason("a{2,1}", &quant),
            words(&["numbers", "out", "of", "order", "in", "{}", "quantifier"])
        );
        assert_eq!(v8_reason("\\", &words(&["Unterminated", "escape"])), escape);
        assert_eq!(
            v8_reason("\\", &words(&["Invalid", "character", "escape"])),
            escape
        );
        assert_eq!(
            v8_reason("\\", &words(&["Invalid", "unicode", "escape"])),
            escape
        );
        assert_eq!(
            v8_reason("[z-a]", &words(&["Invalid", "character", "range"])),
            range
        );
        assert_eq!(
            v8_reason(
                "\\k",
                &words(&["Invalid", "named", "backreference", "syntax"])
            ),
            named
        );
        let backref = words(&[
            "Backreference",
            "to",
            "invalid",
            "named",
            "capture",
            "group:",
            "b",
        ]);
        assert_eq!(v8_reason("(?<a>x)\\k<b>", &backref), named);
    }
}
