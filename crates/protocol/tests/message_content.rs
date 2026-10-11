use protocol::{ContentPart, Message, MessageContent, SessionState};

fn assert_message_round_trip(raw: &str) -> Message {
    let parsed: Message = serde_json::from_str(raw).unwrap();
    assert_eq!(serde_json::to_string(&parsed).unwrap(), raw);
    let again: Message = serde_json::from_str(raw).unwrap();
    assert_eq!(again, parsed);
    parsed
}

#[test]
fn string_content_round_trips_through_message() {
    let parsed = assert_message_round_trip(r#"{"role":"user","content":"hi"}"#);
    assert!(matches!(parsed.content, MessageContent::Text(text) if text == "hi"));
    assert!(parsed.tool_calls.is_none());
    assert!(parsed.tool_call_id.is_none());
}

#[test]
fn ordinary_text_part_array_round_trips_through_message() {
    let parsed =
        assert_message_round_trip(r#"{"role":"user","content":[{"type":"text","text":"hi"}]}"#);
    match parsed.content {
        MessageContent::Parts(parts) => match &parts[0] {
            ContentPart::Text { text } => assert_eq!(text.to_utf8(), "hi"),
            other => panic!("{other:?}"),
        },
        MessageContent::Text(_) => panic!("parts"),
    }
}

#[test]
fn multipart_text_image_video_and_tool_call_round_trip_through_message() {
    let raw = concat!(
        r#"{"role":"assistant","content":["#,
        r#"{"type":"text","text":"see"},"#,
        r#"{"type":"image","data":"aGVsbG8=","url":"https://example.test/a.png","mimeType":"image/png"},"#,
        r#"{"type":"video","url":"https://example.test/a.mp4","mimeType":"video/mp4"}"#,
        r#"],"toolCalls":[{"id":"call_1","name":"search","arguments":{"q":"rivet"}}]}"#
    );
    let parsed = assert_message_round_trip(raw);
    match &parsed.content {
        MessageContent::Parts(parts) => {
            assert!(matches!(&parts[0], ContentPart::Text { text } if text.to_utf8() == "see"));
            assert!(matches!(
                &parts[1],
                ContentPart::Image {
                    data: Some(data),
                    url: Some(url),
                    mime_type: Some(mime),
                } if data == "aGVsbG8=" && url == "https://example.test/a.png" && mime == "image/png"
            ));
            assert!(matches!(
                &parts[2],
                ContentPart::Video {
                    data: None,
                    url: Some(url),
                    mime_type: Some(mime),
                } if url == "https://example.test/a.mp4" && mime == "video/mp4"
            ));
        }
        MessageContent::Text(_) => panic!("parts"),
    }
    let calls = parsed.tool_calls.expect("tool calls");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].id, "call_1");
    assert_eq!(calls[0].name, "search");
    assert_eq!(
        calls[0].argument("q").and_then(|value| value.as_str()),
        Some("rivet")
    );
}

#[test]
fn tool_role_parts_round_trip_through_message() {
    let parsed = assert_message_round_trip(
        r#"{"role":"tool","content":[{"type":"text","text":"ok"},{"type":"image","mimeType":"image/png"}],"toolCallId":"call_1"}"#,
    );
    assert_eq!(parsed.tool_call_id.as_deref(), Some("call_1"));
    match parsed.content {
        MessageContent::Parts(parts) => {
            assert!(matches!(parts[0], ContentPart::Text { .. }));
            assert!(matches!(parts[1], ContentPart::Image { .. }));
        }
        MessageContent::Text(_) => panic!("parts"),
    }
}

#[test]
fn text_part_keeps_an_unpaired_surrogate_through_message() {
    let raw = r#"{"role":"user","content":[{"type":"text","text":"\ud800"}]}"#;
    let parsed: Message = serde_json::from_str(raw).unwrap();
    match &parsed.content {
        MessageContent::Parts(parts) => match &parts[0] {
            ContentPart::Text { text } => assert_eq!(text.units(), &[0xD800]),
            other => panic!("{other:?}"),
        },
        MessageContent::Text(_) => panic!("parts"),
    }
    assert_eq!(serde_json::to_string(&parsed).unwrap(), raw);
    let again: Message = serde_json::from_str(raw).unwrap();
    assert_eq!(again, parsed);
}

#[test]
fn string_content_rejects_an_unpaired_surrogate() {
    assert!(serde_json::from_str::<Message>(r#"{"role":"user","content":"\ud800"}"#).is_err());
    assert!(serde_json::from_str::<Message>(r#"{"role":"user","content":1}"#).is_err());
    assert!(
        serde_json::from_str::<Message>(r#"{"role":"user","content":{"type":"text","text":"hi"}}"#)
            .is_err()
    );
}

#[test]
fn session_state_history_round_trips_string_parts_and_surrogate() {
    let raw = concat!(
        r#"{"id":"s1","thinking":"off","reasoningVisible":false,"toolsVisible":true,"history":["#,
        r#"{"role":"user","content":"hi"},"#,
        r#"{"role":"user","content":[{"type":"text","text":"see"},{"type":"image","mimeType":"image/png"},{"type":"video","data":"AAAA"}]},"#,
        r#"{"role":"user","content":[{"type":"image","url":"https://example.test/a.png"}]},"#,
        r#"{"role":"user","content":[{"type":"video","url":"https://example.test/a.mp4","mimeType":"video/mp4"}]},"#,
        r#"{"role":"assistant","content":[{"type":"text","text":"\ud800"}],"toolCalls":[{"id":"call_1","name":"search","arguments":{"q":"rivet"}}]},"#,
        r#"{"role":"tool","content":[{"type":"text","text":"done"}],"toolCallId":"call_1"}"#,
        r#"],"compactionCount":0,"nudgesFired":[]}"#
    );
    let parsed: SessionState = serde_json::from_str(raw).unwrap();
    assert_eq!(serde_json::to_string(&parsed).unwrap(), raw);
    let again: SessionState = serde_json::from_str(raw).unwrap();
    assert_eq!(again, parsed);
    match &again.history[4].content {
        MessageContent::Parts(parts) => match &parts[0] {
            ContentPart::Text { text } => assert_eq!(text.units(), &[0xD800]),
            other => panic!("{other:?}"),
        },
        MessageContent::Text(_) => panic!("parts"),
    }
}
