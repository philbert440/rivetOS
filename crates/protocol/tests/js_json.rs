use serde_json::Value;

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
    assert_eq!(protocol::js::stringify(&Value::String(text)), expected);
}

#[test]
fn paired_surrogates_stringify_as_the_scalar() {
    let value = protocol::js::parse(r#""\uD83D\uDE00""#).unwrap();
    assert_eq!(protocol::js::stringify(&value), "\"\u{1F600}\"");
}

#[test]
fn parse_rejects_invalid_json_and_lone_surrogates() {
    assert!(protocol::js::parse("").is_err());
    assert!(protocol::js::parse("{").is_err());
    assert!(protocol::js::parse(r#""\uD800""#).is_err());
}
