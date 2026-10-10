use protocol::js::JsValue;

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

pub(crate) fn js_split_whitespace(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0usize;
    let mut chars = text.char_indices().peekable();
    while let Some((index, ch)) = chars.next() {
        if !is_js_whitespace(ch) {
            continue;
        }
        parts.push(&text[start..index]);
        while chars
            .peek()
            .is_some_and(|(_, next)| is_js_whitespace(*next))
        {
            chars.next();
        }
        start = chars.peek().map(|(next, _)| *next).unwrap_or(text.len());
    }
    parts.push(&text[start..]);
    if parts.is_empty() {
        parts.push("");
    }
    parts
}

pub(crate) fn slice_utf16(text: &str, max_units: usize) -> String {
    let mut units = 0usize;
    let mut end = 0usize;
    for (index, ch) in text.char_indices() {
        let width = ch.len_utf16();
        if units + width > max_units {
            break;
        }
        units += width;
        end = index + ch.len_utf8();
    }
    text[..end].to_string()
}

pub(crate) fn kib_one_decimal(size: usize) -> String {
    let value = size as f64 / 1024.0;
    format!("{value:.1}")
}

pub(crate) fn js_is_truthy(value: &JsValue) -> bool {
    match value {
        JsValue::Null => false,
        JsValue::Bool(flag) => *flag,
        JsValue::Number(number) => *number != 0.0 && !number.is_nan(),
        JsValue::String(text) => !text.to_utf8().is_empty(),
        JsValue::Array(_) | JsValue::Object(_) => true,
    }
}

pub(crate) fn js_value_to_string(value: &JsValue) -> String {
    match value {
        JsValue::Null => "null".to_string(),
        JsValue::Bool(true) => "true".to_string(),
        JsValue::Bool(false) => "false".to_string(),
        JsValue::Number(number) => number_to_string(*number),
        JsValue::String(text) => text.to_utf8().to_string(),
        JsValue::Array(items) => items
            .iter()
            .map(|item| match item {
                JsValue::Null => String::new(),
                other => js_value_to_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        JsValue::Object(_) => "[object Object]".to_string(),
    }
}

fn number_to_string(number: f64) -> String {
    if number.is_nan() {
        return "NaN".to_string();
    }
    if number.is_infinite() {
        return if number.is_sign_positive() {
            "Infinity".to_string()
        } else {
            "-Infinity".to_string()
        };
    }
    if number == 0.0 {
        return "0".to_string();
    }
    if number.fract() == 0.0 && number.abs() < 1e21 {
        let integer = number as i64;
        if integer as f64 == number {
            return integer.to_string();
        }
    }
    format!("{number}")
}

#[cfg(test)]
mod tests {
    use super::{js_split_whitespace, kib_one_decimal, slice_utf16};

    #[test]
    fn split_matches_js_whitespace_class() {
        assert_eq!(
            js_split_whitespace("steer go faster"),
            ["steer", "go", "faster"]
        );
        assert_eq!(
            js_split_whitespace("steer go faster "),
            ["steer", "go", "faster", ""]
        );
        assert_eq!(js_split_whitespace("steer  go"), ["steer", "go"]);
        assert_eq!(js_split_whitespace(" steer"), ["", "steer"]);
        assert_eq!(js_split_whitespace(""), [""]);
        assert_eq!(js_split_whitespace(" "), ["", ""]);
        assert_eq!(js_split_whitespace("stop\nnow"), ["stop", "now"]);
        assert_eq!(js_split_whitespace("\tstop"), ["", "stop"]);
    }

    #[test]
    fn kib_matches_to_fixed_1() {
        assert_eq!(kib_one_decimal(51 * 1024), "51.0");
        assert_eq!(kib_one_decimal(50 * 1024 + 512), "50.5");
        assert_eq!(kib_one_decimal(45 * 1024), "45.0");
    }

    #[test]
    fn utf16_slice_stops_on_scalar_boundary() {
        let text = "a".repeat(2001);
        assert_eq!(slice_utf16(&text, 2000).chars().count(), 2000);
        assert_eq!(slice_utf16("hi", 2000), "hi");
        assert_eq!(slice_utf16("😀", 1), "");
        assert_eq!(slice_utf16("😀", 2), "😀");
    }
}
