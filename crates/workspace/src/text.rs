use protocol::js::is_js_whitespace;

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

pub(crate) fn cap_utf16(text: &str, max_units: usize) -> protocol::js::JsString {
    protocol::js::js_slice(text, Some(0.0), Some(max_units as f64))
}

pub(crate) fn kib_one_decimal(size: usize) -> String {
    protocol::js::to_fixed(size as f64 / 1024.0, 1.0).unwrap_or_else(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{cap_utf16, js_split_whitespace, kib_one_decimal};

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
        assert_eq!(kib_one_decimal(51_456), "50.3");
    }

    #[test]
    fn utf16_cap_keeps_a_split_surrogate() {
        let text = format!("{}😀z", "a".repeat(1999));
        let capped = cap_utf16(&text, 2000);
        assert_eq!(capped.len(), 2000);
        assert_eq!(capped.units()[1999], 0xD83D);
        assert_eq!(capped.to_utf8(), format!("{}\u{FFFD}", "a".repeat(1999)));
        assert_eq!(cap_utf16("hi", 2000).to_utf8(), "hi");
        assert_eq!(cap_utf16("😀", 1).units(), &[0xD83D]);
        assert_eq!(cap_utf16("😀", 1).to_utf8(), "\u{FFFD}");
        assert_eq!(cap_utf16("😀", 2).to_utf8(), "😀");
    }
}
