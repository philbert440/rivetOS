use protocol::{SessionIdError, parse_session_id, parse_session_id_str};
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
fn splits_on_the_first_colon_and_accepts_cowork() {
    let parsed = parse_session_id_str("cowork:abc:def").unwrap();
    assert_eq!(parsed.harness_id, "cowork");
    assert_eq!(parsed.native_session_id, "abc:def");
    let parsed = parse_session_id_str("claude-code:project/uuid").unwrap();
    assert_eq!(parsed.native_session_id, "project/uuid");
}
