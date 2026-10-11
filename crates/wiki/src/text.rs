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

pub(crate) fn js_trim(text: &str) -> &str {
    protocol::js::js_trim(text)
}

pub(crate) fn js_trim_end(text: &str) -> &str {
    let mut end = text.len();
    while end > 0 {
        let Some(ch) = text[..end].chars().next_back() else {
            break;
        };
        if !is_js_whitespace(ch) {
            break;
        }
        end -= ch.len_utf8();
    }
    &text[..end]
}

pub(crate) fn js_len(text: &str) -> usize {
    if text.is_ascii() {
        text.len()
    } else {
        text.encode_utf16().count()
    }
}

pub(crate) fn split_utf16(text: &str, index: usize) -> (String, String) {
    if index == 0 {
        return (String::new(), text.to_string());
    }
    if text.is_ascii() {
        let index = index.min(text.len());
        let (left, right) = text.split_at(index);
        return (left.to_string(), right.to_string());
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    if index >= units.len() {
        return (text.to_string(), String::new());
    }
    if splits_surrogate_pair(&units, index) {
        return (
            units_as_text(&units[..index]),
            units_as_text(&units[index..]),
        );
    }
    let mut seen = 0usize;
    for (byte, ch) in text.char_indices() {
        if seen == index {
            return (text[..byte].to_string(), text[byte..].to_string());
        }
        seen += ch.len_utf16();
    }
    (text.to_string(), String::new())
}

fn splits_surrogate_pair(units: &[u16], index: usize) -> bool {
    index > 0
        && index < units.len()
        && (0xD800..=0xDBFF).contains(&units[index - 1])
        && (0xDC00..=0xDFFF).contains(&units[index])
}

fn units_as_text(units: &[u16]) -> String {
    let mut json = String::from("\"");
    let mut index = 0usize;
    while index < units.len() {
        let unit = units[index];
        if (0xD800..=0xDBFF).contains(&unit) {
            if let Some(low) = units.get(index + 1)
                && (0xDC00..=0xDFFF).contains(low)
            {
                let scalar =
                    0x10000 + (((u32::from(unit) - 0xD800) << 10) | (u32::from(*low) - 0xDC00));
                if let Some(ch) = char::from_u32(scalar) {
                    push_json_char(&mut json, ch);
                    index += 2;
                    continue;
                }
            }
            json.push_str(&format!("\\u{unit:04x}"));
            index += 1;
            continue;
        }
        if (0xDC00..=0xDFFF).contains(&unit) {
            json.push_str(&format!("\\u{unit:04x}"));
            index += 1;
            continue;
        }
        if let Some(ch) = char::from_u32(u32::from(unit)) {
            push_json_char(&mut json, ch);
        }
        index += 1;
    }
    json.push('"');
    match protocol::js::parse(&json) {
        Ok(value) => value.as_str().unwrap_or("").to_string(),
        Err(_) => String::new(),
    }
}

fn push_json_char(out: &mut String, ch: char) {
    match ch {
        '"' => out.push_str("\\\""),
        '\\' => out.push_str("\\\\"),
        '\u{0008}' => out.push_str("\\b"),
        '\u{000c}' => out.push_str("\\f"),
        '\n' => out.push_str("\\n"),
        '\r' => out.push_str("\\r"),
        '\t' => out.push_str("\\t"),
        c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
        c => out.push(c),
    }
}

pub(crate) fn js_slice(text: &str, start: usize, end: usize) -> String {
    let (rest, _) = split_utf16(text, end);
    let (_, kept) = split_utf16(&rest, start.min(end));
    kept
}

pub(crate) fn js_prefix(text: &str, len: usize) -> String {
    split_utf16(text, len).0
}

pub(crate) fn js_last_index_of(hay: &str, needle: &str, from: usize) -> Option<usize> {
    if needle.is_empty() {
        return Some(from.min(js_len(hay)));
    }
    if hay.is_ascii() && needle.is_ascii() {
        let mut found = None;
        let mut offset = 0usize;
        while offset < hay.len() {
            let Some(rel) = hay[offset..].find(needle) else {
                break;
            };
            let at = offset + rel;
            if at > from {
                break;
            }
            found = Some(at);
            offset = at + 1;
        }
        return found;
    }
    let hay16: Vec<u16> = hay.encode_utf16().collect();
    let needle16: Vec<u16> = needle.encode_utf16().collect();
    if needle16.len() > hay16.len() {
        return None;
    }
    let last = from.min(hay16.len().saturating_sub(needle16.len()));
    let mut index = last;
    loop {
        if hay16[index..index + needle16.len()] == needle16[..] {
            return Some(index);
        }
        if index == 0 {
            return None;
        }
        index -= 1;
    }
}

pub(crate) fn js_sort(ids: &mut [String]) {
    ids.sort_by(|left, right| {
        let left: Vec<u16> = left.encode_utf16().collect();
        let right: Vec<u16> = right.encode_utf16().collect();
        left.cmp(&right)
    });
}

pub(crate) fn fmt_count(n: usize) -> String {
    let raw = n.to_string();
    let mut out = String::new();
    for (index, ch) in raw.chars().enumerate() {
        if index > 0 && (raw.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

pub(crate) fn fmt_kb(chars: usize) -> String {
    let scaled = (chars as f64) / 1024.0 * 10.0;
    let tenths = if (scaled - scaled.floor() - 0.5).abs() < 1e-9 {
        scaled.floor() + 1.0
    } else {
        scaled.round()
    } as u64;
    format!("{}.{}", tenths / 10, tenths % 10)
}

pub(crate) fn utc_day() -> String {
    let Ok(duration) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) else {
        return "1970-01-01".to_string();
    };
    civil_from_unix_days(duration.as_secs() / 86_400)
}

pub(crate) fn civil_from_unix_days(unix_days: u64) -> String {
    let z = unix_days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    if month <= 2 {
        year += 1;
    }
    format!("{year:04}-{month:02}-{day:02}")
}

#[cfg(test)]
mod tests {
    use super::civil_from_unix_days;

    #[test]
    fn unix_epoch_and_known_days() {
        assert_eq!(civil_from_unix_days(0), "1970-01-01");
        assert_eq!(civil_from_unix_days(10957), "2000-01-01");
        assert_eq!(civil_from_unix_days(20736), "2026-10-10");
    }
}
