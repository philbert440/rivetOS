#[test]
fn golden_parse_then_stringify() {
    let input = r#"{"b":1.0,"2":2,"a":12345678901234567890,"1":0.1,"neg":-0,"big":1e21,"small":1.5e-7,"nested":{"z":1,"10":true,"9":null}}"#;
    let value = protocol::js::parse(input).unwrap();
    assert_eq!(
        protocol::js::stringify(&value),
        r#"{"1":0.1,"2":2,"b":1,"a":12345678901234567000,"neg":0,"big":1e+21,"small":1.5e-7,"nested":{"9":null,"10":true,"z":1}}"#
    );
}

#[test]
fn array_index_keys_sort_ahead_of_insertion_order() {
    let input = r#"{"b":1,"01":2,"-1":3,"1.0":4,"4294967295":5,"4294967294":6,"0":7,"2":8}"#;
    let value = protocol::js::parse(input).unwrap();
    assert_eq!(
        protocol::js::stringify(&value),
        r#"{"0":7,"2":8,"4294967294":6,"b":1,"01":2,"-1":3,"1.0":4,"4294967295":5}"#
    );
}

#[test]
fn duplicate_keys_keep_the_last_value_in_the_first_position() {
    let value = protocol::js::parse(r#"{"a":1,"b":2,"a":3}"#).unwrap();
    assert_eq!(protocol::js::stringify(&value), r#"{"a":3,"b":2}"#);
    let mixed = protocol::js::parse(r#"{"a":1,"b":2,"a":3,"0":4,"0":5}"#).unwrap();
    assert_eq!(protocol::js::stringify(&mixed), r#"{"0":5,"a":3,"b":2}"#);
}

#[test]
fn nested_array_numbers_and_objects() {
    let value = protocol::js::parse(r#"[1.0,{"2":2,"a":true},null]"#).unwrap();
    assert_eq!(
        protocol::js::stringify(&value),
        r#"[1,{"2":2,"a":true},null]"#
    );
}

#[test]
fn string_escapes_follow_json_stringify() {
    let mut text = String::new();
    text.push('"');
    text.push('\\');
    text.push('\u{0008}');
    text.push('\u{000c}');
    text.push('\n');
    text.push('\r');
    text.push('\t');
    text.push('\u{0000}');
    text.push('\u{000b}');
    text.push('\u{001f}');
    text.push('/');
    text.push('\u{2028}');
    text.push('\u{2029}');
    text.push('é');
    text.push('<');
    let expected = "\"\\\"\\\\\\b\\f\\n\\r\\t\\u0000\\u000b\\u001f/\u{2028}\u{2029}é<\"";
    assert_eq!(
        protocol::js::stringify(&protocol::js::JsValue::from_text(&text)),
        expected
    );
}

#[test]
fn paired_surrogates_stringify_as_the_scalar() {
    let value = protocol::js::parse(r#""\uD83D\uDE00""#).unwrap();
    assert_eq!(protocol::js::stringify(&value), "\"\u{1F600}\"");
}

#[test]
fn parse_rejects_invalid_json() {
    assert!(protocol::js::parse("").is_err());
    assert!(protocol::js::parse("{").is_err());
    assert!(protocol::js::parse("[").is_err());
    assert!(protocol::js::parse("1e").is_err());
    assert!(protocol::js::parse(r#""\u""#).is_err());
}

#[test]
fn lone_surrogate_round_trips_as_escape() {
    let value = protocol::js::parse(r#""\ud800""#).unwrap();
    assert_eq!(protocol::js::stringify(&value), r#""\ud800""#);
    assert_eq!(value.as_str(), Some("\u{FFFD}"));
    let upper = protocol::js::parse(r#""\uD800""#).unwrap();
    assert_eq!(protocol::js::stringify(&upper), r#""\ud800""#);
}

#[test]
fn unicode_escape_is_four_hex_digits() {
    assert!(protocol::js::parse(r#""\u+041""#).is_err());
    assert!(protocol::js::parse(r#""\u 041""#).is_err());
    let value = protocol::js::parse(r#""\u0041""#).unwrap();
    assert_eq!(value.as_str(), Some("A"));
}

#[test]
fn two_mib_string_literal_parses_within_five_seconds() {
    let mut text = String::with_capacity(2 * 1024 * 1024 + 2);
    text.push('"');
    text.extend(std::iter::repeat_n('a', 2 * 1024 * 1024));
    text.push('"');
    let started = std::time::Instant::now();
    let value = protocol::js::parse(&text).unwrap();
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    assert_eq!(value.as_str().map(str::len), Some(2 * 1024 * 1024));
}

#[test]
fn two_mib_document_of_short_strings_parses_within_five_seconds() {
    let item = "\"ab\",";
    let target = 2 * 1024 * 1024;
    let mut text = String::from('[');
    while text.len() < target {
        text.push_str(item);
    }
    if text.ends_with(',') {
        text.pop();
    }
    text.push(']');
    assert!(text.len() >= target);
    let started = std::time::Instant::now();
    let value = protocol::js::parse(&text).unwrap();
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    let items = value.as_array().unwrap();
    assert!(items.len() > 1_000);
    assert_eq!(items[0].as_str(), Some("ab"));
}

#[test]
fn non_finite_numbers_stringify_as_null() {
    let value = protocol::js::parse("1e400").unwrap();
    assert_eq!(protocol::js::stringify(&value), "null");
    let negative = protocol::js::parse("-1e400").unwrap();
    assert_eq!(protocol::js::stringify(&negative), "null");
    let object = protocol::js::parse(r#"{"n":1e400}"#).unwrap();
    assert_eq!(protocol::js::stringify(&object), r#"{"n":null}"#);
}
