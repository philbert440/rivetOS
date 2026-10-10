pub fn is_js_ws(ch: char) -> bool {
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

pub fn js_trim(text: &str) -> &str {
    protocol::js::js_trim(text)
}

pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

pub fn utf16_slice(text: &str, start: usize, end: usize) -> String {
    let units: Vec<u16> = text
        .encode_utf16()
        .skip(start)
        .take(end.saturating_sub(start))
        .collect();
    String::from_utf16_lossy(&units)
}

pub fn truncate_middle(text: &str, max: usize) -> String {
    let len = utf16_len(text);
    if len <= max {
        return text.to_string();
    }
    let half = max / 2;
    let elided = len - 2 * half;
    format!(
        "{}\n\n[… {elided} bytes elided …]\n\n{}",
        utf16_slice(text, 0, half),
        utf16_slice(text, len - half, len)
    )
}

pub fn js_split_ws(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = None;
    for (index, ch) in text.char_indices() {
        if is_js_ws(ch) {
            if let Some(from) = start.take() {
                parts.push(&text[from..index]);
            }
        } else if start.is_none() {
            start = Some(index);
        }
    }
    if let Some(from) = start {
        parts.push(&text[from..]);
    }
    parts
}

pub fn strip_one_quote_pair(text: &str) -> String {
    let mut chars: Vec<char> = text.chars().collect();
    if chars.first().is_some_and(|ch| *ch == '"' || *ch == '\'') {
        chars.remove(0);
    }
    if chars.last().is_some_and(|ch| *ch == '"' || *ch == '\'') {
        chars.pop();
    }
    chars.into_iter().collect()
}
