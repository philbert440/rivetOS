use std::sync::OnceLock;

use regress::Regex;

pub fn compile_static(
    cell: &'static OnceLock<Option<Regex>>,
    pattern: &'static str,
    flags: &'static str,
) -> Option<&'static Regex> {
    cell.get_or_init(|| compile_regex(pattern, flags).ok())
        .as_ref()
}

pub fn compile_regex(pattern: &str, flags: &str) -> Result<Regex, String> {
    let compiled = if flags.is_empty() {
        Regex::new(pattern)
    } else {
        Regex::with_flags(pattern, flags)
    };
    compiled.map_err(|err| err.to_string())
}

pub fn is_match(regex: &Regex, text: &str) -> bool {
    regex.find(text).is_some()
}

pub fn compile_user_pattern(source: &str, flags: &str) -> Result<Regex, String> {
    if let Some(message) = flag_error(flags) {
        return Err(message);
    }
    compile_regex(source, flags).map_err(|err| js_regexp_message(source, flags, &err))
}

fn flag_error(flags: &str) -> Option<String> {
    let mut seen = [false; 128];
    let mut unicode = false;
    let mut sets = false;
    for ch in flags.chars() {
        let index = match ch {
            'd' | 'g' | 'i' | 'm' | 's' | 'u' | 'v' | 'y' => ch as usize,
            _ => return Some(invalid_flags(flags)),
        };
        if seen[index] {
            return Some(invalid_flags(flags));
        }
        seen[index] = true;
        unicode |= ch == 'u';
        sets |= ch == 'v';
    }
    if unicode && sets {
        Some(invalid_flags(flags))
    } else {
        None
    }
}

fn invalid_flags(flags: &str) -> String {
    format!("Invalid flags supplied to RegExp constructor '{flags}'")
}

fn js_regexp_message(source: &str, flags: &str, regress_text: &str) -> String {
    format!(
        "Invalid regular expression: /{source}/{flags}: {}",
        v8_reason(source, regress_text)
    )
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
    let mut depth = 0_i32;
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
    let mut value = 0_usize;
    while *cursor < bytes.len() && bytes[*cursor].is_ascii_digit() {
        value = value
            .saturating_mul(10)
            .saturating_add(usize::from(bytes[*cursor] - b'0'));
        *cursor += 1;
    }
    Some(value)
}

#[cfg(test)]
mod tests {
    use std::sync::OnceLock;

    use super::{compile_regex, compile_static, is_match};

    #[test]
    fn compiles_ecmascript_patterns_and_keeps_failures() {
        let ok = compile_regex("a+", "").expect("pattern");
        assert!(is_match(&ok, "aaa"));
        assert!(!is_match(&ok, "b"));
        assert!(compile_regex("(", "").is_err());
        static CELL: OnceLock<Option<regress::Regex>> = OnceLock::new();
        assert!(compile_static(&CELL, "ab", "").is_some());
        static BAD: OnceLock<Option<regress::Regex>> = OnceLock::new();
        assert!(compile_static(&BAD, "(", "").is_none());
        assert_eq!(
            super::compile_user_pattern("*.ts", "").unwrap_err(),
            "Invalid regular expression: /*.ts/: Nothing to repeat"
        );
        assert_eq!(
            super::compile_user_pattern("(", "").unwrap_err(),
            "Invalid regular expression: /(/: Unterminated group"
        );
        assert_eq!(
            super::compile_user_pattern(")", "").unwrap_err(),
            "Invalid regular expression: /)/: Unmatched ')'"
        );
        assert_eq!(
            super::compile_user_pattern("a", "z").unwrap_err(),
            "Invalid flags supplied to RegExp constructor 'z'"
        );
        assert!(super::compile_user_pattern(r"\.ts$", "i").is_ok());
    }
}
