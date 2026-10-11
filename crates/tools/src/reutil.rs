pub(crate) fn compile(pattern: &str) -> Option<regress::Regex> {
    let (body, flags) = inline_flags(pattern);
    regress::Regex::with_flags(body, flags.as_str()).ok()
}

pub(crate) fn group<'a>(text: &'a str, matched: &regress::Match, index: usize) -> &'a str {
    matched
        .group(index)
        .and_then(|range| text.get(range))
        .unwrap_or("")
}

pub(crate) fn replace_all(text: &str, pattern: &str, replacement: &str) -> String {
    let Some(regex) = compile(pattern) else {
        return text.to_string();
    };
    replace_with(&regex, text, |_| replacement.to_string())
}

pub(crate) fn replace_with<F>(regex: &regress::Regex, text: &str, mut replacer: F) -> String
where
    F: FnMut(&regress::Match) -> String,
{
    let mut out = String::new();
    let mut last = 0usize;
    let mut cursor = 0usize;
    while let Some(found) = regex.find_from(text, cursor).next() {
        let start = found.start();
        let end = found.end();
        if start < last || end > text.len() {
            break;
        }
        out.push_str(&text[last..start]);
        out.push_str(&replacer(&found));
        if end == start {
            if end >= text.len() {
                last = end;
                break;
            }
            let step = text[end..].chars().next().map(char::len_utf8).unwrap_or(1);
            out.push_str(&text[end..end + step]);
            last = end + step;
            cursor = last;
        } else {
            last = end;
            cursor = end;
        }
    }
    out.push_str(&text[last..]);
    out
}

fn inline_flags(pattern: &str) -> (&str, String) {
    let mut flags = String::new();
    let mut rest = pattern;
    loop {
        if let Some(next) = rest.strip_prefix("(?i)") {
            if !flags.contains('i') {
                flags.push('i');
            }
            rest = next;
            continue;
        }
        if let Some(next) = rest.strip_prefix("(?m)") {
            if !flags.contains('m') {
                flags.push('m');
            }
            rest = next;
            continue;
        }
        break;
    }
    (rest, flags)
}
