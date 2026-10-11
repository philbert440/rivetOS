use super::JsString;

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct ReplaceError {
    message: String,
}

pub fn js_replace(
    text: &JsString,
    pattern: &str,
    flags: &str,
    replacement: &str,
) -> Result<JsString, ReplaceError> {
    let units = replace_regex(text.units(), pattern, flags, replacement)?;
    Ok(JsString::from_units(units))
}

pub fn js_replace_string(text: &JsString, pattern: &str, replacement: &str) -> JsString {
    JsString::from_units(replace_literal(text.units(), pattern, replacement, false))
}

pub fn js_replace_all_string(text: &JsString, pattern: &str, replacement: &str) -> JsString {
    JsString::from_units(replace_literal(text.units(), pattern, replacement, true))
}

fn replace_regex(
    units: &[u16],
    pattern: &str,
    flags: &str,
    replacement: &str,
) -> Result<Vec<u16>, ReplaceError> {
    let regex = regress::Regex::with_flags(pattern, flags).map_err(|err| ReplaceError {
        message: err.to_string(),
    })?;
    let global = flags.contains('g');
    let unicode = flags.contains('u');
    let mut out = Vec::new();
    let mut last = 0usize;
    let mut cursor = 0usize;
    while let Some(found) = find_at(&regex, units, cursor, unicode) {
        let start = found.start();
        let end = found.end();
        if start < cursor || start > units.len() {
            break;
        }
        out.extend_from_slice(&units[last.min(units.len())..start.min(units.len())]);
        let has_named = found.named_groups().next().is_some();
        out.extend(expand(
            units,
            start,
            end,
            Some(&found),
            has_named,
            replacement,
        ));
        if !global {
            last = end.min(units.len());
            break;
        }
        if end == start {
            if start >= units.len() {
                last = start;
                break;
            }
            let next = advance_index(units, start, unicode);
            last = start;
            if next == start {
                break;
            }
            cursor = next;
            continue;
        }
        last = end.min(units.len());
        cursor = last;
    }
    if last < units.len() {
        out.extend_from_slice(&units[last..]);
    }
    Ok(out)
}

fn find_at(
    regex: &regress::Regex,
    units: &[u16],
    cursor: usize,
    unicode: bool,
) -> Option<regress::Match> {
    if unicode {
        regex.find_from_utf16(units, cursor).next()
    } else {
        regex.find_from_ucs2(units, cursor).next()
    }
}

fn replace_literal(units: &[u16], pattern: &str, replacement: &str, all: bool) -> Vec<u16> {
    let needle: Vec<u16> = pattern.encode_utf16().collect();
    let mut out = Vec::new();
    let mut last = 0usize;
    let mut cursor = 0usize;
    while let Some(start) = find_literal(units, &needle, cursor) {
        let end = start + needle.len();
        out.extend_from_slice(&units[last..start]);
        out.extend(expand(units, start, end, None, false, replacement));
        if !all {
            last = end;
            break;
        }
        if needle.is_empty() {
            if start >= units.len() {
                last = start;
                break;
            }
            last = start;
            cursor = start + 1;
            continue;
        }
        last = end;
        cursor = end;
    }
    if last < units.len() {
        out.extend_from_slice(&units[last..]);
    }
    out
}

fn find_literal(haystack: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if from > haystack.len() {
        return None;
    }
    if needle.is_empty() {
        return Some(from);
    }
    haystack[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|index| index + from)
}

fn advance_index(units: &[u16], index: usize, unicode: bool) -> usize {
    if index >= units.len() {
        return units.len();
    }
    if unicode
        && (0xD800..=0xDBFF).contains(&units[index])
        && units
            .get(index + 1)
            .is_some_and(|next| (0xDC00..=0xDFFF).contains(next))
    {
        return index + 2;
    }
    index + 1
}

fn expand(
    units: &[u16],
    start: usize,
    end: usize,
    found: Option<&regress::Match>,
    has_named: bool,
    replacement: &str,
) -> Vec<u16> {
    let template: Vec<u16> = replacement.encode_utf16().collect();
    let captures = found.map(|item| item.captures.len()).unwrap_or(0);
    let mut out = Vec::new();
    let mut index = 0usize;
    while index < template.len() {
        let current = template[index];
        if current != u16::from(b'$') {
            out.push(current);
            index += 1;
            continue;
        }
        if index + 1 >= template.len() {
            out.push(current);
            break;
        }
        let next = template[index + 1];
        if next == u16::from(b'$') {
            out.push(u16::from(b'$'));
            index += 2;
        } else if next == u16::from(b'&') {
            out.extend(copy_units(units, start, end));
            index += 2;
        } else if next == u16::from(b'`') {
            out.extend(copy_units(units, 0, start));
            index += 2;
        } else if next == u16::from(b'\'') {
            out.extend(copy_units(units, end, units.len()));
            index += 2;
        } else if next == u16::from(b'<') {
            if !has_named {
                out.push(u16::from(b'$'));
                index += 1;
                continue;
            }
            let close = template[index + 2..]
                .iter()
                .position(|unit| *unit == u16::from(b'>'));
            let Some(offset) = close else {
                out.push(u16::from(b'$'));
                index += 1;
                continue;
            };
            let name = String::from_utf16_lossy(&template[index + 2..index + 2 + offset]);
            if let Some(found) = found
                && let Some(range) = found.named_group(&name)
            {
                out.extend(copy_units(units, range.start, range.end));
            }
            index += offset + 3;
        } else if (u16::from(b'0')..=u16::from(b'9')).contains(&next) {
            let first = usize::from(next - u16::from(b'0'));
            let mut used_pair = false;
            if index + 2 < template.len()
                && (u16::from(b'0')..=u16::from(b'9')).contains(&template[index + 2])
            {
                let second = usize::from(template[index + 2] - u16::from(b'0'));
                let number = first * 10 + second;
                if number != 0 && number <= captures {
                    out.extend(capture_units(units, found, number));
                    index += 3;
                    used_pair = true;
                }
            }
            if used_pair {
                continue;
            }
            if first == 0 || first > captures {
                out.push(u16::from(b'$'));
                out.push(next);
                index += 2;
            } else {
                out.extend(capture_units(units, found, first));
                index += 2;
            }
        } else {
            out.push(u16::from(b'$'));
            index += 1;
        }
    }
    out
}

fn capture_units(units: &[u16], found: Option<&regress::Match>, number: usize) -> Vec<u16> {
    let Some(found) = found else {
        return Vec::new();
    };
    match found.group(number) {
        Some(range) => copy_units(units, range.start, range.end),
        None => Vec::new(),
    }
}

fn copy_units(units: &[u16], start: usize, end: usize) -> Vec<u16> {
    let start = start.min(units.len());
    let end = end.min(units.len()).max(start);
    units[start..end].to_vec()
}

#[cfg(test)]
mod tests {
    use super::{js_replace, js_replace_all_string, js_replace_string};
    use crate::js::JsString;

    #[test]
    fn substitutions_and_invalid_pattern() {
        let text = JsString::from_text("abc");
        let replaced = js_replace(&text, "b", "", "$`|$'").unwrap();
        assert_eq!(replaced.to_utf8(), "aa|cc");
        assert_eq!(js_replace_string(&text, "b", "$$").to_utf8(), "a$c");
        assert_eq!(
            js_replace_all_string(&JsString::from_text("a.b"), ".", "-").to_utf8(),
            "a-b"
        );
        assert!(js_replace(&text, "(", "", "x").is_err());
    }
}
