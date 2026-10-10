use protocol::{ErrorSeverity, SessionIdError, parse_session_id, parse_session_id_str};
use serde_json::json;

#[test]
fn rejects_non_string() {
    let err = parse_session_id(&json!(1)).unwrap_err();
    assert_eq!(err, SessionIdError::NotString);
    assert_eq!(err.to_string(), "SessionId must be a string");
}

#[test]
fn rejects_leading_or_trailing_whitespace() {
    let err = parse_session_id_str(" claude-code:abc").unwrap_err();
    assert_eq!(err.to_string(), "SessionId has leading/trailing whitespace");
    let err = parse_session_id_str("claude-code:abc\n").unwrap_err();
    assert_eq!(err.to_string(), "SessionId has leading/trailing whitespace");
}

#[test]
fn rejects_missing_harness_prefix() {
    for id in ["nocolon", ":native", ""] {
        let err = parse_session_id_str(id).unwrap_err();
        assert_eq!(
            err.to_string(),
            "SessionId is missing a harness-id prefix",
            "{id:?}"
        );
    }
}

#[test]
fn rejects_empty_native_id() {
    let err = parse_session_id_str("claude-code:").unwrap_err();
    assert_eq!(err.to_string(), "SessionId has an empty native session id");
}

#[test]
fn rejects_unknown_harness_id() {
    let err = parse_session_id_str("nope:abc").unwrap_err();
    assert_eq!(err.to_string(), "unknown harness id: nope");
}

#[test]
fn bom_is_whitespace_and_next_line_is_not() {
    let err = parse_session_id_str("cowork:abc\u{FEFF}").unwrap_err();
    assert_eq!(err, SessionIdError::Whitespace);
    assert_eq!(err.code(), "invalid_session_id");
    let parsed = parse_session_id_str("cowork:abc\u{0085}").unwrap();
    assert_eq!(parsed.native_session_id, "abc\u{0085}");
}

#[test]
fn error_json_uses_invalid_session_id_and_context_id() {
    let err = parse_session_id_str("nope:abc").unwrap_err();
    assert_eq!(err.code(), "invalid_session_id");
    let json = err.to_error_json("nope:abc");
    assert_eq!(json.name, "HarnessError");
    assert_eq!(json.code, "invalid_session_id");
    assert_eq!(json.severity, ErrorSeverity::Error);
    assert!(!json.retryable);
    assert!(json.stack.is_none());
    assert!(json.cause.is_none());
    assert_eq!(
        json.context.get("id").and_then(serde_json::Value::as_str),
        Some("nope:abc")
    );
    let text = serde_json::to_string(&json).unwrap();
    assert!(text.starts_with(
        "{\"name\":\"HarnessError\",\"code\":\"invalid_session_id\",\"message\":\"unknown harness id: nope\",\"severity\":\"error\",\"retryable\":false,\"timestamp\":"
    ));
    assert!(text.contains("\"context\":{\"id\":\"nope:abc\"}"));
    assert!(!text.contains("stack"));
    assert!(!text.contains("statusCode"));
    assert!(!text.contains("providerId"));
}

#[test]
fn splits_on_the_first_colon_and_accepts_cowork() {
    let parsed = parse_session_id_str("cowork:abc:def").unwrap();
    assert_eq!(parsed.harness_id, "cowork");
    assert_eq!(parsed.native_session_id, "abc:def");
    let parsed = parse_session_id_str("claude-code:project/uuid").unwrap();
    assert_eq!(parsed.native_session_id, "project/uuid");
}
