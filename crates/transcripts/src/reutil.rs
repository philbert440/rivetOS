pub fn compile(pattern: &str) -> Result<regress::Regex, regress::Error> {
    let (pattern, flags) = match pattern.strip_prefix("(?i)") {
        Some(rest) => (rest, "i"),
        None => (pattern, ""),
    };
    regress::Regex::with_flags(pattern, flags)
}

pub fn hits(regex: &regress::Regex, text: &str) -> bool {
    regex.find(text).is_some()
}

pub fn nth<'a>(regex: &regress::Regex, text: &'a str, index: usize) -> Option<&'a str> {
    let found = regex.find(text)?;
    let range = found.group(index)?;
    text.get(range)
}

pub fn erase(pattern: &str, flags: &str, text: &str) -> Option<String> {
    protocol::js::js_replace(&protocol::js::JsString::from_text(text), pattern, flags, "")
        .ok()
        .map(|value| value.to_utf8().to_string())
}
