use protocol::js::{JsObject, JsString, JsValue};
use protocol::{ErrorJson, InboundMessage, StreamEvent, StreamEventType};

fn capped_units(prefix: &str) -> Vec<u16> {
    let mut units: Vec<u16> = prefix.encode_utf16().collect();
    units.extend(std::iter::repeat_n(u16::from(b'a'), 199));
    units.push(0xD83D);
    units
}

#[test]
fn tool_result_content_keeps_a_sliced_surrogate() {
    let head = "✅ search: ";
    let sliced = format!("{head}{}\\ud83d", "a".repeat(199));
    let raw =
        format!(r#"{{"type":"tool_result","content":"{sliced}","metadata":{{"tool":"search"}}}}"#);
    let event: StreamEvent = serde_json::from_str(&raw).unwrap();
    assert_eq!(event.r#type, StreamEventType::ToolResult);
    assert_eq!(event.content.units(), capped_units(head).as_slice());
    assert_eq!(
        event
            .metadata
            .as_ref()
            .and_then(|object| object.get("tool"))
            .and_then(JsValue::as_str),
        Some("search")
    );
    assert_eq!(serde_json::to_string(&event).unwrap(), raw);
}

#[test]
fn tool_start_summary_keeps_surrogate_and_orders_keys() {
    let query = format!("{}\\ud83d…", "a".repeat(199));
    let raw = format!(
        r#"{{"type":"tool_start","content":"🔧 search","metadata":{{"10":"ten","2":"two","tool":"search","args":{{"query":"{query}","limit":1.0}}}}}}"#
    );
    let event: StreamEvent = serde_json::from_str(&raw).unwrap();
    let expected = format!(
        r#"{{"type":"tool_start","content":"🔧 search","metadata":{{"2":"two","10":"ten","tool":"search","args":{{"query":"{query}","limit":1}}}}}}"#
    );
    assert_eq!(serde_json::to_string(&event).unwrap(), expected);
    let metadata = event.metadata.unwrap();
    let query_value = metadata
        .get("args")
        .and_then(JsValue::as_object)
        .and_then(|object| object.get("query"))
        .and_then(JsValue::as_js_string)
        .unwrap();
    let mut units = vec![u16::from(b'a'); 199];
    units.push(0xD83D);
    units.push(0x2026);
    assert_eq!(query_value.units(), units.as_slice());
    assert_eq!(
        metadata
            .get("args")
            .and_then(JsValue::as_object)
            .and_then(|object| object.get("limit"))
            .and_then(JsValue::as_i64),
        Some(1)
    );
}

#[test]
fn built_stream_metadata_orders_index_keys() {
    let mut metadata = JsObject::new();
    metadata.insert("10", JsValue::from_text("ten"));
    metadata.insert("2", JsValue::from_text("two"));
    metadata.insert("limit", JsValue::Number(1.0));
    let event = StreamEvent {
        r#type: StreamEventType::Status,
        content: JsString::from_text("ok"),
        metadata: Some(metadata),
    };
    assert_eq!(
        serde_json::to_string(&event).unwrap(),
        r#"{"type":"status","content":"ok","metadata":{"2":"two","10":"ten","limit":1}}"#
    );
}

#[test]
fn ordinary_stream_content_bytes_stay_plain() {
    let event: StreamEvent =
        serde_json::from_str(r#"{"type":"text","content":"hello","metadata":{"k":"v"}}"#).unwrap();
    assert_eq!(
        serde_json::to_string(&event).unwrap(),
        r#"{"type":"text","content":"hello","metadata":{"k":"v"}}"#
    );
    assert_eq!(event.content.to_utf8(), "hello");
}

#[test]
fn absent_metadata_stays_absent() {
    assert!(
        serde_json::from_str::<StreamEvent>(r#"{"type":"status","content":"ok","metadata":1}"#)
            .is_err()
    );
    assert!(
        serde_json::from_str::<StreamEvent>(r#"{"type":"status","content":"ok","metadata":[]}"#)
            .is_err()
    );
    let absent: StreamEvent = serde_json::from_str(r#"{"type":"done","content":""}"#).unwrap();
    assert!(absent.metadata.is_none());
    assert_eq!(
        serde_json::to_string(&absent).unwrap(),
        r#"{"type":"done","content":""}"#
    );
}

#[test]
fn inbound_metadata_orders_keys_and_keeps_surrogates() {
    let raw = r#"{"id":"m1","userId":"u1","channelId":"c1","chatType":"direct","text":"hello","platform":"agent","metadata":{"10":"ten","2":{"s":"\ud83d"},"limit":1.0},"timestamp":1}"#;
    let message: InboundMessage = serde_json::from_str(raw).unwrap();
    assert_eq!(
        serde_json::to_string(&message).unwrap(),
        r#"{"id":"m1","userId":"u1","channelId":"c1","chatType":"direct","text":"hello","platform":"agent","metadata":{"2":{"s":"\ud83d"},"10":"ten","limit":1},"timestamp":1}"#
    );
}

#[test]
fn error_context_orders_keys_and_keeps_surrogates() {
    let raw = r#"{"name":"ToolError","code":"TOOL_EXECUTION_FAILED","message":"x","severity":"error","retryable":false,"timestamp":1,"context":{"10":"ten","2":"two","note":"\ud800"}}"#;
    let value: ErrorJson = serde_json::from_str(raw).unwrap();
    assert_eq!(
        serde_json::to_string(&value).unwrap(),
        r#"{"name":"ToolError","code":"TOOL_EXECUTION_FAILED","message":"x","severity":"error","retryable":false,"timestamp":1,"context":{"2":"two","10":"ten","note":"\ud800"}}"#
    );
}
