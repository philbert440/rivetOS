use std::sync::OnceLock;

use regress::Regex;

pub fn compile_static(
    cell: &'static OnceLock<Option<Regex>>,
    pattern: &'static str,
    flags: &'static str,
) -> Option<&'static Regex> {
    cell.get_or_init(|| compile_regex(pattern, flags).ok())
        .as_ref()
}

pub fn compile_regex(pattern: &str, flags: &str) -> Result<Regex, String> {
    let compiled = if flags.is_empty() {
        Regex::new(pattern)
    } else {
        Regex::with_flags(pattern, flags)
    };
    compiled.map_err(|err| err.to_string())
}

pub fn is_match(regex: &Regex, text: &str) -> bool {
    regex.find(text).is_some()
}

#[cfg(test)]
mod tests {
    use std::sync::OnceLock;

    use super::{compile_regex, compile_static, is_match};

    #[test]
    fn compiles_ecmascript_patterns_and_keeps_failures() {
        let ok = compile_regex("a+", "").expect("pattern");
        assert!(is_match(&ok, "aaa"));
        assert!(!is_match(&ok, "b"));
        assert!(compile_regex("(", "").is_err());
        static CELL: OnceLock<Option<regress::Regex>> = OnceLock::new();
        assert!(compile_static(&CELL, "ab", "").is_some());
        static BAD: OnceLock<Option<regress::Regex>> = OnceLock::new();
        assert!(compile_static(&BAD, "(", "").is_none());
    }
}
