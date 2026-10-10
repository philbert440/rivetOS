use serde_json::{Map, Value};

pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

pub(crate) fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            | '\u{2001}'
            | '\u{2002}'
            | '\u{2003}'
            | '\u{2004}'
            | '\u{2005}'
            | '\u{2006}'
            | '\u{2007}'
            | '\u{2008}'
            | '\u{2009}'
            | '\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

pub fn parse(text: &str) -> Result<Value, serde_json::Error> {
    serde_json::from_str(text)
}

pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_value(value, &mut out);
    out
}

fn write_value(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => write_number(number, out),
        Value::String(text) => write_string(text, out),
        Value::Array(items) => write_array(items, out),
        Value::Object(map) => write_object(map, out),
    }
}

fn write_number(number: &serde_json::Number, out: &mut String) {
    match number.as_f64() {
        Some(value) => out.push_str(&crate::js_number::json_number(value)),
        None => out.push_str(&number.to_string()),
    }
}

fn write_array(items: &[Value], out: &mut String) {
    out.push('[');
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        write_value(item, out);
    }
    out.push(']');
}

fn write_object(map: &Map<String, Value>, out: &mut String) {
    out.push('{');
    let mut indexed = Vec::new();
    let mut rest = Vec::new();
    for (key, value) in map {
        if let Some(index) = array_index(key) {
            indexed.push((index, key, value));
        } else {
            rest.push((key, value));
        }
    }
    indexed.sort_by_key(|(index, _, _)| *index);
    let mut first = true;
    for (_, key, value) in indexed {
        write_entry(key, value, &mut first, out);
    }
    for (key, value) in rest {
        write_entry(key, value, &mut first, out);
    }
    out.push('}');
}

fn write_entry(key: &str, value: &Value, first: &mut bool, out: &mut String) {
    if !*first {
        out.push(',');
    }
    *first = false;
    write_string(key, out);
    out.push(':');
    write_value(value, out);
}

fn array_index(key: &str) -> Option<u32> {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 10 {
        return None;
    }
    if bytes.len() > 1 && bytes[0] == b'0' {
        return None;
    }
    if !bytes.iter().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let value: u64 = key.parse().ok()?;
    if value > 4_294_967_294 {
        return None;
    }
    u32::try_from(value).ok()
}

fn write_string(text: &str, out: &mut String) {
    out.push('"');
    for ch in text.chars() {
        append_code_unit(u32::from(ch), out);
    }
    out.push('"');
}

fn append_code_unit(unit: u32, out: &mut String) {
    match unit {
        0x22 => out.push_str("\\\""),
        0x5C => out.push_str("\\\\"),
        0x08 => out.push_str("\\b"),
        0x0C => out.push_str("\\f"),
        0x0A => out.push_str("\\n"),
        0x0D => out.push_str("\\r"),
        0x09 => out.push_str("\\t"),
        0x00..=0x1F => {
            out.push_str("\\u00");
            push_hex(unit, out);
        }
        0xD800..=0xDFFF => {
            out.push_str("\\u");
            push_hex(unit >> 8, out);
            push_hex(unit, out);
        }
        _ => {
            if let Some(ch) = char::from_u32(unit) {
                out.push(ch);
            }
        }
    }
}

fn push_hex(unit: u32, out: &mut String) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push(char::from(HEX[((unit >> 4) & 0xF) as usize]));
    out.push(char::from(HEX[(unit & 0xF) as usize]));
}

#[cfg(test)]
mod code_units {
    use super::append_code_unit;

    #[test]
    fn lone_surrogates_escape() {
        let mut low = String::new();
        append_code_unit(0xD800, &mut low);
        assert_eq!(low, "\\ud800");
        let mut high = String::new();
        append_code_unit(0xDFFF, &mut high);
        assert_eq!(high, "\\udfff");
    }
}
