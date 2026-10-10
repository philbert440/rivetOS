use protocol::{
    BLOCKED_PREFIX, ContentPart, TOOL_ERROR_PREFIX, ToolResult, is_blocked, is_thrown_error,
};

#[test]
fn string_result_round_trips() {
    let text = format!("{BLOCKED_PREFIX}rm -rf");
    let value = serde_json::to_value(ToolResult::Text(text.clone())).unwrap();
    assert_eq!(value, serde_json::Value::String(text));
    let parsed: ToolResult = serde_json::from_value(value).unwrap();
    assert!(is_blocked(&parsed));
    assert!(!is_thrown_error(&parsed));
}

#[test]
fn thrown_error_prefix() {
    let parsed: ToolResult = serde_json::from_str(&format!("\"{TOOL_ERROR_PREFIX}boom\"")).unwrap();
    assert!(is_thrown_error(&parsed));
    assert!(!is_blocked(&parsed));
}

#[test]
fn array_of_parts_round_trips() {
    let json = r#"[{"type":"text","text":"see"},{"type":"image","mimeType":"image/png"}]"#;
    let parsed: ToolResult = serde_json::from_str(json).unwrap();
    match parsed {
        ToolResult::Parts(parts) => {
            assert!(matches!(parts[0], ContentPart::Text { .. }));
            assert!(matches!(parts[1], ContentPart::Image { .. }));
        }
        ToolResult::Text(_) => panic!("expected parts"),
    }
    let back = serde_json::to_string(&serde_json::from_str::<ToolResult>(json).unwrap()).unwrap();
    let again: ToolResult = serde_json::from_str(&back).unwrap();
    assert!(matches!(again, ToolResult::Parts(_)));
}
