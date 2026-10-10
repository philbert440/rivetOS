use serde_json::Value;

pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

pub fn js_slice(text: &str, start: i64, end: Option<i64>) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let len = units.len() as i64;
    let start_index = clamp_index(start, len);
    let end_index = end
        .map(|value| clamp_index(value, len))
        .unwrap_or(units.len());
    if start_index >= end_index {
        return String::new();
    }
    String::from_utf16_lossy(&units[start_index..end_index])
}

fn clamp_index(index: i64, len: i64) -> usize {
    let bounded = if index < 0 {
        (len + index).max(0)
    } else {
        index.min(len)
    };
    usize::try_from(bounded).unwrap_or(0)
}

pub fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

pub fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(true) => "true".to_string(),
        Value::Bool(false) => "false".to_string(),
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                integer.to_string()
            } else if let Some(unsigned) = number.as_u64() {
                unsigned.to_string()
            } else {
                number.to_string()
            }
        }
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

pub fn js_replace_all(haystack: &str, needle: &str, replacement: &str) -> String {
    if needle.is_empty() {
        return haystack.to_string();
    }
    let mut out = String::new();
    let mut search_from = 0;
    while let Some(relative) = haystack[search_from..].find(needle) {
        let index = search_from + relative;
        let prefix = &haystack[..index];
        let suffix = &haystack[index + needle.len()..];
        out.push_str(&haystack[search_from..index]);
        out.push_str(&expand_replacement(replacement, needle, prefix, suffix));
        search_from = index + needle.len();
    }
    out.push_str(&haystack[search_from..]);
    out
}

fn expand_replacement(replacement: &str, matched: &str, prefix: &str, suffix: &str) -> String {
    let chars: Vec<char> = replacement.chars().collect();
    let mut out = String::new();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] != '$' || index + 1 >= chars.len() {
            out.push(chars[index]);
            index += 1;
            continue;
        }
        match chars[index + 1] {
            '$' => {
                out.push('$');
                index += 2;
            }
            '&' => {
                out.push_str(matched);
                index += 2;
            }
            '`' => {
                out.push_str(prefix);
                index += 2;
            }
            '\'' => {
                out.push_str(suffix);
                index += 2;
            }
            _ => {
                out.push('$');
                index += 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{js_replace_all, js_slice, js_string, js_truthy, utf16_len};
    use serde_json::json;

    #[test]
    fn slice_matches_javascript_indexes() {
        assert_eq!(js_slice("abcdef", 0, Some(200)), "abcdef");
        assert_eq!(js_slice("abcdef", -3, None), "def");
        assert_eq!(js_slice("abcdef", 4, Some(2)), "");
        assert_eq!(utf16_len("😀"), 2);
        assert_eq!(js_slice(&"x".repeat(5), 0, Some(3)), "xxx");
    }

    #[test]
    fn file_placeholder_uses_javascript_replacement_patterns() {
        assert_eq!(
            js_replace_all("echo {{file}}", "{{file}}", "/test.ts"),
            "echo /test.ts"
        );
        assert_eq!(
            js_replace_all("echo {{file}}", "{{file}}", "/tmp/$&"),
            "echo /tmp/{{file}}"
        );
        assert_eq!(js_replace_all("echo {{file}}", "{{file}}", "$$"), "echo $");
    }

    #[test]
    fn string_and_truthiness_follow_javascript() {
        assert_eq!(js_string(&json!(null)), "null");
        assert_eq!(js_string(&json!(true)), "true");
        assert_eq!(js_string(&json!([1, "a", null])), "1,a,null");
        assert_eq!(js_string(&json!({"a": 1})), "[object Object]");
        assert!(!js_truthy(&json!(null)));
        assert!(!js_truthy(&json!(false)));
        assert!(!js_truthy(&json!(0)));
        assert!(!js_truthy(&json!("")));
        assert!(js_truthy(&json!("0")));
        assert!(js_truthy(&json!([])));
        assert!(js_truthy(&json!({})));
    }
}
