pub fn js_replace_once(content: &str, search: &str, replacement: &str) -> String {
    if search.is_empty() {
        return content.to_string();
    }
    protocol::js::js_replace_string(
        &protocol::js::JsString::from_text(content),
        search,
        replacement,
    )
    .to_utf8()
    .to_string()
}

pub fn truncate_middle(text: &str, max: usize) -> String {
    let len = protocol::js::utf16_len(text);
    if len <= max {
        return text.to_string();
    }
    let half = max / 2;
    let elided = len - 2 * half;
    let head = protocol::js::js_substring(text, Some(0.0), Some(half as f64));
    let tail = protocol::js::js_substring(text, Some((len - half) as f64), Some(len as f64));
    format!(
        "{}\n\n[… {elided} bytes elided …]\n\n{}",
        head.to_utf8(),
        tail.to_utf8()
    )
}

pub fn js_split_ws(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = None;
    for (index, ch) in text.char_indices() {
        if protocol::js::is_js_whitespace(ch) {
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
