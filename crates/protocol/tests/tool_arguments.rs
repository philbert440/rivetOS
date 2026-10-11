use protocol::js::{JsObject, JsValue};
use protocol::{Message, PartialToolCall, ToolCall};

const ORDERED_ARGUMENTS: &str = r#"{"2":"two","10":"ten","limit":1,"note":"\ud800"}"#;

#[test]
fn tool_call_arguments_match_javascript_json() {
    let raw = r#"{"id":"call_1","name":"search","arguments":{"10":"ten","2":"two","limit":1.0,"note":"\ud800"}}"#;
    let call: ToolCall = serde_json::from_str(raw).unwrap();
    assert_eq!(
        serde_json::to_string(&call).unwrap(),
        format!(r#"{{"id":"call_1","name":"search","arguments":{ORDERED_ARGUMENTS}}}"#)
    );
    assert_eq!(call.arguments_json(), ORDERED_ARGUMENTS);
    assert_eq!(call.argument("2").and_then(JsValue::as_str), Some("two"));
    assert_eq!(call.argument("10").and_then(JsValue::as_str), Some("ten"));
    assert_eq!(call.argument("limit").and_then(JsValue::as_i64), Some(1));
    assert_eq!(
        call.argument("note").and_then(JsValue::as_str),
        Some("\u{FFFD}")
    );
    let again: ToolCall = serde_json::from_str(&serde_json::to_string(&call).unwrap()).unwrap();
    assert_eq!(again, call);
}

#[test]
fn built_arguments_serialize_with_javascript_order() {
    let mut arguments = JsObject::new();
    arguments.insert("10", JsValue::from_text("ten"));
    arguments.insert("2", JsValue::from_text("two"));
    arguments.insert("limit", JsValue::Number(1.0));
    let call = ToolCall {
        id: "call_1".to_string(),
        name: "search".to_string(),
        arguments,
        thought_signature: None,
    };
    assert_eq!(call.arguments_json(), r#"{"2":"two","10":"ten","limit":1}"#);
    assert_eq!(
        serde_json::to_string(&call).unwrap(),
        r#"{"id":"call_1","name":"search","arguments":{"2":"two","10":"ten","limit":1}}"#
    );
}

#[test]
fn message_tool_calls_keep_argument_bytes() {
    let raw = r#"{"role":"assistant","content":"ok","toolCalls":[{"id":"call_1","name":"search","arguments":{"10":"ten","2":"two","limit":1.0,"note":"\uD800"}}]}"#;
    let message: Message = serde_json::from_str(raw).unwrap();
    assert_eq!(
        serde_json::to_string(&message).unwrap(),
        format!(
            r#"{{"role":"assistant","content":"ok","toolCalls":[{{"id":"call_1","name":"search","arguments":{ORDERED_ARGUMENTS}}}]}}"#
        )
    );
}

#[test]
fn partial_arguments_match_javascript_json() {
    let raw = r#"{"name":"search","arguments":{"10":"ten","2":"two","limit":1.0,"note":"\ud800"},"index":0}"#;
    let call: PartialToolCall = serde_json::from_str(raw).unwrap();
    assert_eq!(
        serde_json::to_string(&call).unwrap(),
        format!(r#"{{"name":"search","arguments":{ORDERED_ARGUMENTS},"index":0}}"#)
    );
    assert_eq!(call.arguments_json().as_deref(), Some(ORDERED_ARGUMENTS));
    assert_eq!(call.argument("limit").and_then(JsValue::as_i64), Some(1));
    let absent = PartialToolCall::new().set_name("search");
    assert!(absent.argument("limit").is_none());
    assert!(absent.arguments_json().is_none());
}

#[test]
fn partial_argument_equality_ignores_key_order_and_number_spelling() {
    let spelled: PartialToolCall =
        serde_json::from_str(r#"{"arguments":{"b":1,"a":2.0}}"#).unwrap();
    let reordered: PartialToolCall =
        serde_json::from_str(r#"{"arguments":{"a":2,"b":1.0}}"#).unwrap();
    assert_eq!(spelled, reordered);
    assert_eq!(
        serde_json::to_string(&spelled).unwrap(),
        r#"{"arguments":{"b":1,"a":2}}"#
    );
    assert_eq!(
        serde_json::to_string(&reordered).unwrap(),
        r#"{"arguments":{"a":2,"b":1}}"#
    );
}

#[test]
fn partial_null_arguments_round_trip_and_non_objects_fail() {
    let call: PartialToolCall = serde_json::from_str(r#"{"arguments":null}"#).unwrap();
    assert_eq!(
        serde_json::to_string(&call).unwrap(),
        r#"{"arguments":null}"#
    );
    assert!(serde_json::from_str::<PartialToolCall>(r#"{"name":"search"}"#).is_ok());
    assert!(serde_json::from_str::<PartialToolCall>(r#"{"arguments":[]}"#).is_err());
    assert!(serde_json::from_str::<PartialToolCall>(r#"{"arguments":1}"#).is_err());
    assert!(
        serde_json::from_str::<ToolCall>(r#"{"id":"call_1","name":"search","arguments":null}"#)
            .is_err()
    );
    assert!(
        serde_json::from_str::<ToolCall>(r#"{"id":"call_1","name":"search","arguments":"q"}"#)
            .is_err()
    );
}

#[test]
fn partial_set_arguments_uses_the_value_model() {
    let mut arguments = JsObject::new();
    arguments.insert("limit", JsValue::Number(1.0));
    let call = PartialToolCall::new()
        .set_name("search")
        .set_arguments(arguments);
    assert_eq!(
        serde_json::to_string(&call).unwrap(),
        r#"{"name":"search","arguments":{"limit":1}}"#
    );
    assert_eq!(call.argument("limit").and_then(JsValue::as_i64), Some(1));
}
