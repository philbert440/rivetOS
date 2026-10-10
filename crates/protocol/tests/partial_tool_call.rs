use protocol::PartialToolCall;

#[test]
fn new_uses_canonical_order() {
    let call = PartialToolCall::new().set_index(0).set_name("lookup");
    assert_eq!(
        serde_json::to_string(&call).unwrap(),
        r#"{"name":"lookup","index":0}"#
    );
}

#[test]
fn null_fields_round_trip() {
    let call: PartialToolCall = serde_json::from_str(r#"{"id":null,"name":"lookup"}"#).unwrap();
    assert_eq!(
        serde_json::to_string(&call).unwrap(),
        r#"{"id":null,"name":"lookup"}"#
    );
}

#[test]
fn index_keeps_javascript_spelling() {
    let call: PartialToolCall = serde_json::from_str(r#"{"index":1000}"#).unwrap();
    assert_eq!(serde_json::to_string(&call).unwrap(), r#"{"index":1000}"#);
    let scientific: PartialToolCall = serde_json::from_str(r#"{"index":1e+21}"#).unwrap();
    assert_eq!(
        serde_json::to_string(&scientific).unwrap(),
        r#"{"index":1e+21}"#
    );
}
