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

pub fn truncate_middle(text: &str, max: usize) -> protocol::js::JsString {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= max {
        return protocol::js::JsString::from_text(text);
    }
    let half = max / 2;
    let elided = units.len() - 2 * half;
    let head = protocol::js::js_substring_units(&units, Some(0.0), Some(half as f64));
    let tail = protocol::js::js_substring_units(
        &units,
        Some((units.len() - half) as f64),
        Some(units.len() as f64),
    );
    let mut out = head;
    out.extend(format!("\n\n[… {elided} bytes elided …]\n\n").encode_utf16());
    out.extend(tail);
    protocol::js::JsString::from_units(out)
}

pub(crate) fn append_utf16(base: &protocol::js::JsString, extra: &str) -> protocol::js::JsString {
    let mut units = base.units().to_vec();
    units.extend(extra.encode_utf16());
    protocol::js::JsString::from_units(units)
}

pub(crate) fn concat_js(
    left: &protocol::js::JsString,
    right: &protocol::js::JsString,
) -> protocol::js::JsString {
    let mut units = left.units().to_vec();
    units.extend_from_slice(right.units());
    protocol::js::JsString::from_units(units)
}

pub(crate) fn prefix_utf16(prefix: &str, tail: &protocol::js::JsString) -> protocol::js::JsString {
    concat_js(&protocol::js::JsString::from_text(prefix), tail)
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
