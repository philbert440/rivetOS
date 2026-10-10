use std::time::Instant;

use capture::{
    CaptureMessage, CaptureRedactionOptions, CaptureRole, MapEnv, REDACT_SCAN_LIMIT,
    capture_redaction_from_env, redact_message, redact_text, resolve_capture_redaction,
};
use serde_json::json;

fn enabled() -> capture::ResolvedCaptureRedaction {
    resolve_capture_redaction(Some(&CaptureRedactionOptions {
        enabled: Some(true),
        ..CaptureRedactionOptions::default()
    }))
    .unwrap()
}

fn patterns(sources: &[&str], builtins: bool) -> capture::ResolvedCaptureRedaction {
    resolve_capture_redaction(Some(&CaptureRedactionOptions {
        enabled: Some(true),
        builtins: Some(builtins),
        patterns: Some(sources.iter().map(|item| (*item).to_string()).collect()),
    }))
    .unwrap()
}

fn message(content: &str) -> CaptureMessage {
    CaptureMessage {
        event_id: "e".to_string(),
        role: CaptureRole::User,
        content: content.to_string(),
        tool_name: None,
        tool_args: None,
        tool_result: None,
        metadata: None,
        created_at: None,
    }
}

fn b64(input: &str) -> String {
    const ALPHA: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = input.as_bytes();
    let mut out = String::new();
    let mut index = 0;
    while index + 3 <= bytes.len() {
        let chunk = ((bytes[index] as u32) << 16)
            | ((bytes[index + 1] as u32) << 8)
            | bytes[index + 2] as u32;
        out.push(ALPHA[((chunk >> 18) & 63) as usize] as char);
        out.push(ALPHA[((chunk >> 12) & 63) as usize] as char);
        out.push(ALPHA[((chunk >> 6) & 63) as usize] as char);
        out.push(ALPHA[(chunk & 63) as usize] as char);
        index += 3;
    }
    if index < bytes.len() {
        let mut chunk = (bytes[index] as u32) << 16;
        if index + 1 < bytes.len() {
            chunk |= (bytes[index + 1] as u32) << 8;
        }
        out.push(ALPHA[((chunk >> 18) & 63) as usize] as char);
        out.push(ALPHA[((chunk >> 12) & 63) as usize] as char);
        if index + 1 < bytes.len() {
            out.push(ALPHA[((chunk >> 6) & 63) as usize] as char);
            out.push('=');
        } else {
            out.push('=');
            out.push('=');
        }
    }
    out
}

#[test]
fn resolve_returns_none_when_unset_or_empty() {
    assert!(resolve_capture_redaction(None).is_none());
    assert!(resolve_capture_redaction(Some(&CaptureRedactionOptions::default())).is_none());
    assert!(
        resolve_capture_redaction(Some(&CaptureRedactionOptions {
            enabled: Some(false),
            ..CaptureRedactionOptions::default()
        }))
        .is_none()
    );
    assert!(
        resolve_capture_redaction(Some(&CaptureRedactionOptions {
            enabled: Some(true),
            builtins: Some(false),
            patterns: Some(Vec::new()),
        }))
        .is_none()
    );
}

#[test]
fn resolve_enables_builtins_and_compiles_patterns() {
    let resolved = patterns(&[r"\bCUSTOM-[A-Z0-9]{8}\b"], true);
    assert!(resolved.enabled);
    assert!(resolved.builtins);
    assert_eq!(resolved.patterns.len(), 1);
    assert_eq!(resolved.patterns[0].index, 0);
}

#[test]
fn env_redaction_is_none_for_falsey_values() {
    assert!(capture_redaction_from_env(&MapEnv::from_pairs(&[])).is_none());
    assert!(
        capture_redaction_from_env(&MapEnv::from_pairs(&[("RIVETOS_CAPTURE_REDACTION", "0")]))
            .is_none()
    );
    assert!(
        capture_redaction_from_env(&MapEnv::from_pairs(&[(
            "RIVETOS_CAPTURE_REDACTION",
            "false"
        )]))
        .is_none()
    );
}

#[test]
fn env_redaction_enables_builtins() {
    for value in ["1", "true", "YES", "on"] {
        let options = capture_redaction_from_env(&MapEnv::from_pairs(&[(
            "RIVETOS_CAPTURE_REDACTION",
            value,
        )]))
        .unwrap();
        assert_eq!(options.enabled, Some(true));
        assert_eq!(options.builtins, Some(true));
        assert!(options.patterns.is_none());
    }
}

#[test]
fn replaces_common_secret_shapes() {
    let sample = "Bearer aaaabbbbccccdddd1234 \
api_key=not-an-akia-shape \
bare AKIAIOSFODNN7EXAMPLE \
temp ASIAY34F92NBKMABCDEF \
ghp_abcdefghijklmnopqrstuvwxyz0123456789 \
github_pat_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF \
xoxb-1234567890-abcdefghij \
sk-abcdefghijklmnopqrstuvwxyz \
eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signaturepad";
    let result = redact_text(sample, &enabled());
    assert!(result.count > 0);
    assert!(result.text.contains("[REDACTED:bearer]"));
    assert!(result.text.contains("[REDACTED:aws_access_key]"));
    assert!(result.text.contains("[REDACTED:github_token]"));
    assert!(result.text.contains("[REDACTED:slack_token]"));
    assert!(result.text.contains("[REDACTED:sk_token]"));
    assert!(result.text.contains("[REDACTED:jwt]"));
    assert!(result.text.contains("api_key=[REDACTED:assignment]"));
    for secret in [
        "aaaabbbbccccdddd1234",
        "AKIAIOSFODNN7EXAMPLE",
        "ASIAY34F92NBKMABCDEF",
        "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "github_pat_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF",
    ] {
        assert!(!result.text.contains(secret), "{secret} leaked");
    }
}

#[test]
fn leaves_ordinary_prose() {
    let prose = [
        "the basic understanding of X",
        "Basic authentication was enabled",
        "Bearer credentials expire tomorrow",
        "author: Jane Doe",
        "monkey: business",
        "secretary: Ann",
        "hockey: game",
        "tokenizer: bpe",
        "token_count: 1200",
        "authority: local",
        "keyword: true",
    ]
    .join("\n");
    let result = redact_text(&prose, &enabled());
    assert_eq!(result.count, 0);
    assert_eq!(result.text, prose);
}

#[test]
fn redacts_underscore_compound_assignments() {
    let sample = [
        "SECRET_KEY=abc123def456",
        "db_password: hunter2",
        "secret_key: s3cr3tvalue",
        "api_secret: xyzzy12345",
        "auth_key: zz-top-secret",
    ]
    .join("\n");
    let result = redact_text(&sample, &enabled());
    assert_eq!(result.count, 5);
    assert!(result.text.contains("SECRET_KEY=[REDACTED:assignment]"));
    assert!(result.text.contains("db_password: [REDACTED:assignment]"));
    assert!(result.text.contains("secret_key: [REDACTED:assignment]"));
    assert!(result.text.contains("api_secret: [REDACTED:assignment]"));
    assert!(result.text.contains("auth_key: [REDACTED:assignment]"));
    assert!(!result.text.contains("abc123def456"));
    assert!(!result.text.contains("hunter2"));
}

#[test]
fn redacts_http_basic_credentials() {
    let basic = format!("Basic {}", b64("user:pass-secret-value"));
    let result = redact_text(&basic, &enabled());
    assert_eq!(result.count, 1);
    assert_eq!(result.text, "[REDACTED:bearer]");
    let prose = redact_text("the basic understanding of auth flows", &enabled());
    assert_eq!(prose.count, 0);
    assert!(prose.text.contains("basic understanding"));
}

#[test]
fn redacts_multi_word_assignment_values() {
    let result = redact_text("password: hunter2 and other words, next=ok", &enabled());
    assert_eq!(result.count, 1);
    assert_eq!(result.text, "password: [REDACTED:assignment], next=ok");
}

#[test]
fn redacts_pem_private_key_blocks() {
    let pem = "before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKFAKESECRET\n-----END RSA PRIVATE KEY-----\nafter";
    let result = redact_text(pem, &enabled());
    assert_eq!(result.count, 1);
    assert!(result.text.contains("[REDACTED:pem_private_key]"));
    assert!(!result.text.contains("MIIEowIBAAKFAKESECRET"));
    assert!(result.text.starts_with("before\n"));
    assert!(result.text.ends_with("\nafter"));
}

#[test]
fn applies_operator_patterns_with_stable_indices() {
    let resolved = patterns(&[r"\bCUSTOM-[A-Z0-9]{8}\b", r"\bOTHER-[0-9]{4}\b"], false);
    let result = redact_text("see CUSTOM-ABCD1234 and OTHER-9999", &resolved);
    assert_eq!(result.count, 2);
    assert_eq!(
        result.text,
        "see [REDACTED:pattern:0] and [REDACTED:pattern:1]"
    );
}

#[test]
fn skips_nested_quantifier_patterns() {
    let resolved = patterns(&[r"(a+)+b", r"\bSAFE-[A-Z0-9]{4}\b"], false);
    assert_eq!(resolved.patterns.len(), 1);
    assert_eq!(resolved.patterns[0].source, r"\bSAFE-[A-Z0-9]{4}\b");
    assert_eq!(resolved.patterns[0].index, 1);
    let huge = format!("SAFE-ABCD {}", "a".repeat(REDACT_SCAN_LIMIT + 5_000));
    let started = Instant::now();
    let result = redact_text(&huge, &resolved);
    assert!(started.elapsed().as_millis() < 2_000);
    assert_eq!(result.count, 1);
    assert!(result.text.contains("[REDACTED:pattern:1]"));
    assert!(!result.text.contains("SAFE-ABCD"));
}

#[test]
fn scans_only_the_prefix() {
    let resolved = patterns(&[r"\bCUSTOM-[A-Z0-9]{8}\b"], false);
    let secret = "CUSTOM-ABCD1234";
    let head = format!("{} {secret} {}", "x".repeat(100), "y".repeat(100));
    let tail = format!("{} {secret}", "x".repeat(REDACT_SCAN_LIMIT + 10));
    assert!(
        redact_text(&head, &resolved)
            .text
            .contains("[REDACTED:pattern:0]")
    );
    assert!(redact_text(&tail, &resolved).text.contains(secret));
}

#[test]
fn compiles_the_case_insensitive_example() {
    let source = r"\b[Mm][Yy][Pp]refix-[a-z0-9]{20,}\b";
    let resolved = patterns(&[source], false);
    let result = redact_text("leak MyPrefix-abcdefghijklmnopqrstuvwxyz", &resolved);
    assert_eq!(result.count, 1);
    assert_eq!(result.text, "leak [REDACTED:pattern:0]");
}

#[test]
fn redacts_message_fields_and_secret_keys() {
    let mut input = message("token sk-abcdefghijklmnopqrstuvwxyz");
    input.event_id = "e1".to_string();
    input.role = CaptureRole::Tool;
    input.tool_result = Some("Authorization: Bearer aaaabbbbccccdddd1234".to_string());
    input.tool_args = Some(json!({
        "prompt": "use ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "api_key": "should-not-appear",
        "nested": { "password": "also-secret", "note": "ok" }
    }));
    let (next, count) = redact_message(input, &enabled());
    assert!(count > 0);
    assert!(next.content.contains("[REDACTED:sk_token]"));
    assert!(
        next.tool_result
            .as_ref()
            .unwrap()
            .contains("[REDACTED:bearer]")
    );
    let args = next.tool_args.as_ref().unwrap();
    assert_eq!(args["api_key"], "[REDACTED:secret_key]");
    assert_eq!(args["nested"]["password"], "[REDACTED:secret_key]");
    assert_eq!(args["nested"]["note"], "ok");
    assert!(
        args["prompt"]
            .as_str()
            .unwrap()
            .contains("[REDACTED:github_token]")
    );
    let encoded = serde_json::to_string(&next).unwrap();
    assert!(!encoded.contains("should-not-appear"));
    assert!(!encoded.contains("also-secret"));
}

#[test]
fn does_not_wipe_ordinary_keys() {
    let mut input = message("ok");
    input.event_id = "e3".to_string();
    input.role = CaptureRole::Tool;
    input.tool_args = Some(json!({
        "author": "Jane",
        "token_count": 1200,
        "max_tokens": 4096,
        "authority": { "level": 1 },
        "api_key": "real-secret"
    }));
    let (next, count) = redact_message(input, &enabled());
    let args = next.tool_args.unwrap();
    assert_eq!(args["author"], "Jane");
    assert_eq!(args["token_count"], 1200);
    assert_eq!(args["max_tokens"], 4096);
    assert_eq!(args["authority"], json!({"level": 1}));
    assert_eq!(args["api_key"], "[REDACTED:secret_key]");
    assert_eq!(count, 1);
}

#[test]
fn redacts_compound_secret_key_names() {
    let mut input = message("ok");
    input.event_id = "e4".to_string();
    input.role = CaptureRole::Tool;
    input.tool_args = Some(json!({
        "SECRET_KEY": "django-secret-abc",
        "db_password": "hunter2",
        "author": "Jane"
    }));
    let (next, count) = redact_message(input, &enabled());
    let args = next.tool_args.as_ref().unwrap();
    assert_eq!(args["SECRET_KEY"], "[REDACTED:secret_key]");
    assert_eq!(args["db_password"], "[REDACTED:secret_key]");
    assert_eq!(args["author"], "Jane");
    assert_eq!(count, 2);
    let encoded = serde_json::to_string(&next).unwrap();
    assert!(!encoded.contains("django-secret-abc"));
    assert!(!encoded.contains("hunter2"));
}

#[test]
fn scans_tool_args_past_the_content_limit() {
    let secret = "AKIAIOSFODNN7EXAMPLE";
    let body = format!("{} {secret}", "x".repeat(REDACT_SCAN_LIMIT + 100));
    assert!(redact_text(&body, &enabled()).text.contains(secret));
    let mut input = message("ok");
    input.event_id = "e5".to_string();
    input.role = CaptureRole::Tool;
    input.tool_args = Some(json!({ "dump": body }));
    let (next, count) = redact_message(input, &enabled());
    assert!(count > 0);
    let dump = next.tool_args.unwrap()["dump"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(dump.contains("[REDACTED:aws_access_key]"));
    assert!(!dump.contains(secret));
}

#[test]
fn redacts_bearer_across_nbsp() {
    let text = "Authorization: Bearer\u{00a0}aaaabbbbccccdddd1234";
    let result = redact_text(text, &enabled());
    assert!(result.text.contains("[REDACTED:bearer]"));
    assert!(!result.text.contains("aaaabbbbccccdddd1234"));
}

#[test]
fn compiles_lookbehind_and_backreferences() {
    let resolved = patterns(&[r"(?<=code=)[A-Z0-9]+", r"(a)\1"], false);
    assert_eq!(resolved.patterns.len(), 2);
    assert_eq!(
        redact_text("code=SECRET42", &resolved).text,
        "code=[REDACTED:pattern:0]"
    );
    assert_eq!(
        redact_text("xx aa yy", &resolved).text,
        "xx [REDACTED:pattern:1] yy"
    );
    let skipped = patterns(&[r"(unclosed"], false);
    assert!(skipped.patterns.is_empty());
}

#[test]
fn scan_window_may_split_a_surrogate_pair() {
    let resolved = patterns(&[r"\bCUSTOM-[A-Z0-9]{8}\b"], false);
    let secret = "CUSTOM-ABCD1234";
    let text = format!("{}😀{secret}", "a".repeat(REDACT_SCAN_LIMIT - 1));
    let result = redact_text(&text, &resolved);
    assert!(result.text.contains('😀'));
    assert!(result.text.contains(secret));
}

#[test]
fn full_length_keys_reject_line_separators() {
    assert!(capture::keep_metadata_key("full_content_length"));
    assert!(!capture::keep_metadata_key("full_a\rb_length"));
    assert!(!capture::keep_metadata_key("full_a\u{2028}b_length"));
    assert!(!capture::keep_metadata_key("full_a\u{2029}b_length"));
}

#[test]
fn unchanged_message_compares_equal() {
    let input = message("hello world");
    let original = input.clone();
    let (next, count) = redact_message(input, &enabled());
    assert_eq!(count, 0);
    assert_eq!(next, original);
}
