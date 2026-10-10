use serde_json::{Map, Value};

use crate::error::WikiParseError;

pub(crate) fn parse_yaml_value(text: &str) -> Result<Value, WikiParseError> {
    let options = serde_saphyr::Options {
        strict_booleans: true,
        ..serde_saphyr::Options::default()
    };
    serde_saphyr::from_str_with_options(text, options)
        .map_err(|err| WikiParseError::new(flatten_yaml_error(&err.to_string())))
}

fn flatten_yaml_error(message: &str) -> String {
    let mut line = message.lines().next().unwrap_or(message).trim();
    if let Some(stripped) = line.strip_prefix("yaml: ") {
        line = stripped;
    }
    if line.is_empty() {
        "invalid YAML frontmatter".to_string()
    } else {
        line.to_string()
    }
}

pub(crate) fn emit_yaml(value: &Value) -> String {
    let mut out = String::new();
    match value {
        Value::Object(map) => emit_map(map, 0, false, &mut out),
        other => {
            emit_scalar(other, &mut out);
            out.push('\n');
        }
    }
    out
}

fn emit_map(map: &Map<String, Value>, indent: usize, inline_first: bool, out: &mut String) {
    let mut first = true;
    for (key, value) in map {
        if !(inline_first && first) {
            write_indent(out, indent);
        }
        first = false;
        emit_key(out, key);
        match value {
            Value::Array(items) if items.is_empty() => out.push_str(" []\n"),
            Value::Object(child) if child.is_empty() => out.push_str(" {}\n"),
            Value::Array(items) => {
                out.push('\n');
                for item in items {
                    write_indent(out, indent + 2);
                    out.push_str("- ");
                    emit_seq_item(item, indent + 2, out);
                }
            }
            Value::Object(child) => {
                out.push('\n');
                emit_map(child, indent + 2, false, out);
            }
            other => {
                out.push(' ');
                emit_scalar(other, out);
                out.push('\n');
            }
        }
    }
}

fn emit_seq_item(item: &Value, dash_indent: usize, out: &mut String) {
    match item {
        Value::Object(map) if !map.is_empty() => emit_map(map, dash_indent + 2, true, out),
        Value::Array(items) if !items.is_empty() => {
            out.push('\n');
            for nested in items {
                write_indent(out, dash_indent + 2);
                out.push_str("- ");
                emit_seq_item(nested, dash_indent + 2, out);
            }
        }
        Value::Array(_) => out.push_str("[]\n"),
        Value::Object(_) => out.push_str("{}\n"),
        other => {
            emit_scalar(other, out);
            out.push('\n');
        }
    }
}

fn emit_key(out: &mut String, key: &str) {
    if is_plain_key(key) {
        out.push_str(key);
    } else {
        emit_quoted(key, out);
    }
    out.push(':');
}

fn emit_scalar(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => out.push_str(&number.to_string()),
        Value::String(text) => emit_string(text, out),
        Value::Array(items) if items.is_empty() => out.push_str("[]"),
        Value::Object(map) if map.is_empty() => out.push_str("{}"),
        Value::Array(_) | Value::Object(_) => out.push_str("null"),
    }
}

fn emit_string(text: &str, out: &mut String) {
    if is_plain_value(text) {
        out.push_str(text);
    } else {
        emit_quoted(text, out);
    }
}

fn emit_quoted(text: &str, out: &mut String) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn write_indent(out: &mut String, indent: usize) {
    for _ in 0..indent {
        out.push(' ');
    }
}

fn is_plain_key(text: &str) -> bool {
    is_plain_value(text) && !text.contains(':')
}

fn is_plain_value(text: &str) -> bool {
    if text.is_empty() || text == "." || text == ".." || text == "..." {
        return false;
    }
    let Some(first) = text.chars().next() else {
        return false;
    };
    if is_js_space(first) || is_indicator(first) || has_edge_space(text) {
        return false;
    }
    if text.ends_with(':') || text.contains(": ") || text.contains('#') {
        return false;
    }
    if text
        .chars()
        .any(|ch| ch.is_control() || matches!(ch, ',' | '[' | ']' | '{' | '}'))
    {
        return false;
    }
    !is_ambiguous_token(text)
}

fn has_edge_space(text: &str) -> bool {
    text.chars().next().is_some_and(is_js_space)
        || text.chars().next_back().is_some_and(is_js_space)
}

fn is_js_space(ch: char) -> bool {
    crate::text::is_js_whitespace(ch)
}

fn is_indicator(ch: char) -> bool {
    matches!(
        ch,
        '-' | '?'
            | ':'
            | '['
            | ']'
            | '{'
            | '}'
            | '#'
            | '&'
            | '*'
            | '!'
            | '|'
            | '>'
            | '\''
            | '"'
            | '%'
            | '@'
            | '`'
            | ','
    )
}

fn is_ambiguous_token(text: &str) -> bool {
    if text == "~"
        || text.eq_ignore_ascii_case("null")
        || text.eq_ignore_ascii_case("true")
        || text.eq_ignore_ascii_case("false")
        || text.eq_ignore_ascii_case(".nan")
        || text.eq_ignore_ascii_case(".inf")
        || text.eq_ignore_ascii_case("-.inf")
        || text.eq_ignore_ascii_case("+.inf")
        || text.eq_ignore_ascii_case("nan")
        || text.eq_ignore_ascii_case("inf")
        || text.eq_ignore_ascii_case("+inf")
        || text.eq_ignore_ascii_case("-inf")
    {
        return true;
    }
    is_numeric_token(text)
}

fn is_numeric_token(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let mut index = 0usize;
    if bytes[0] == b'+' || bytes[0] == b'-' {
        index = 1;
        if index >= bytes.len() {
            return false;
        }
    }
    if bytes.len() - index >= 2 && bytes[index] == b'0' {
        let mark = bytes[index + 1];
        if matches!(mark, b'x' | b'X' | b'o' | b'O' | b'b' | b'B') {
            return bytes[index + 2..]
                .iter()
                .all(|byte| byte.is_ascii_hexdigit() || *byte == b'_');
        }
    }
    let mut saw_digit = false;
    let mut saw_dot = false;
    let mut saw_exp = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte.is_ascii_digit() {
            saw_digit = true;
            index += 1;
            continue;
        }
        if byte == b'_' {
            index += 1;
            continue;
        }
        if byte == b'.' && !saw_dot && !saw_exp {
            saw_dot = true;
            index += 1;
            continue;
        }
        if matches!(byte, b'e' | b'E') && !saw_exp && saw_digit {
            saw_exp = true;
            saw_digit = false;
            index += 1;
            if index < bytes.len() && matches!(bytes[index], b'+' | b'-') {
                index += 1;
            }
            continue;
        }
        return false;
    }
    saw_digit
}
