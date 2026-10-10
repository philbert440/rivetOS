use protocol::js::js_trim;

#[test]
fn trims_ecmascript_whitespace_only() {
    assert_eq!(js_trim("\u{FEFF}abc\u{FEFF}"), "abc");
    assert_eq!(js_trim("\u{00A0}abc\u{00A0}"), "abc");
    assert_eq!(js_trim("\u{2028}abc\u{2028}"), "abc");
    assert_eq!(js_trim("\u{3000}abc\u{3000}"), "abc");
    assert_eq!(js_trim("\u{0085}abc\u{0085}"), "\u{0085}abc\u{0085}");
    assert_eq!(js_trim(" \t\nabc\r"), "abc");
}
