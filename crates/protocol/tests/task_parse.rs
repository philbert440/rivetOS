use protocol::{
    ArtifactKind, TASK_RESULT_FENCE, TaskVerdict, parse_task_result, parse_task_result_json,
};

#[test]
fn fence_constant() {
    assert_eq!(TASK_RESULT_FENCE, "TASK_RESULT");
}

#[test]
fn last_fence_coerces_runner_verdicts() {
    let text = [
        "```TASK_RESULT\n{\"verdict\":\"completed\",\"summary\":\"first\"}\n```",
        "more work...",
        "```TASK_RESULT\n{\"verdict\":\"timeout\",\"summary\":\"second\"}\n```",
    ]
    .join("\n");
    let parsed = parse_task_result(&text).unwrap();
    assert_eq!(parsed.verdict, TaskVerdict::Failed);
    assert_eq!(parsed.summary, "second");
}

#[test]
fn coerces_killed_and_budget_exceeded() {
    let killed = parse_task_result_json(r#"{"verdict":"killed","summary":"s"}"#).unwrap();
    assert_eq!(killed.verdict, TaskVerdict::Failed);
    let budget = parse_task_result_json(r#"{"verdict":"budget-exceeded","summary":"s"}"#).unwrap();
    assert_eq!(budget.verdict, TaskVerdict::Failed);
    let completed = parse_task_result_json(r#"{"verdict":"completed","summary":"s"}"#).unwrap();
    assert_eq!(completed.verdict, TaskVerdict::Completed);
}

#[test]
fn bad_json_and_unknown_verdict_are_none() {
    assert!(parse_task_result("```TASK_RESULT\nnot json\n```").is_none());
    assert!(parse_task_result_json(r#"{"summary":"no verdict"}"#).is_none());
    assert!(parse_task_result_json(r#"{"verdict":"vibes","summary":"s"}"#).is_none());
    assert!(parse_task_result("no fence").is_none());
    assert!(
        parse_task_result("```TASK_RESULT {\"verdict\":\"completed\",\"summary\":\"s\"}```")
            .is_none()
    );
}

#[test]
fn filters_malformed_artifacts_and_criteria() {
    let parsed = parse_task_result_json(
        r#"{"verdict":"completed","summary":"s","artifacts":[{"kind":"file","ref":"a.ts"},{"bogus":true},{"kind":"nope","ref":"x"}],"criteriaSelfReport":[{"id":"c1","met":true},{"id":42}]}"#,
    )
    .unwrap();
    assert_eq!(parsed.artifacts.len(), 2);
    assert_eq!(parsed.artifacts[0].kind(), Some(ArtifactKind::File));
    assert_eq!(parsed.artifacts[0].r#ref(), Some("a.ts"));
    assert_eq!(
        parsed.artifacts[1].kind(),
        Some(ArtifactKind::Other("nope".to_string()))
    );
    assert_eq!(parsed.artifacts[1].r#ref(), Some("x"));
    let criteria = parsed.criteria_self_report.unwrap();
    assert_eq!(criteria.len(), 1);
    assert_eq!(criteria[0].id(), Some("c1"));
    assert_eq!(criteria[0].met(), Some(true));
    assert!(criteria[0].evidence().is_none());
}

#[test]
fn keeps_unknown_kinds_extra_keys_and_non_string_payloads() {
    let raw = r#"{"verdict":"completed","summary":"ok","artifacts":[{"kind":"patch","ref":"x","note":1,"extra":true}],"criteriaSelfReport":[{"id":"c1","met":false,"evidence":{"ok":1}}]}"#;
    let parsed = parse_task_result_json(raw).unwrap();
    assert_eq!(
        parsed.artifacts[0].kind(),
        Some(ArtifactKind::Other("patch".to_string()))
    );
    assert_eq!(
        parsed.artifacts[0].note().and_then(|value| value.as_i64()),
        Some(1)
    );
    assert_eq!(
        serde_json::to_string(&parsed.artifacts[0]).unwrap(),
        r#"{"kind":"patch","ref":"x","note":1,"extra":true}"#
    );
    let criteria = parsed.criteria_self_report.unwrap();
    assert_eq!(
        criteria[0]
            .evidence()
            .and_then(|value| value.get("ok"))
            .and_then(|value| value.as_i64()),
        Some(1)
    );
    assert_eq!(
        serde_json::to_string(&criteria[0]).unwrap(),
        r#"{"id":"c1","met":false,"evidence":{"ok":1}}"#
    );
}

#[test]
fn null_array_entry_rejects_the_whole_parse() {
    assert!(
        parse_task_result_json(
            r#"{"verdict":"completed","summary":"s","artifacts":[{"kind":"file","ref":"a"},null]}"#
        )
        .is_none()
    );
    assert!(parse_task_result_json(
        r#"{"verdict":"completed","summary":"s","criteriaSelfReport":[{"id":"c1","met":true},null]}"#
    )
    .is_none());
}

#[test]
fn non_objects_are_filtered_and_missing_lists_follow_typescript() {
    let parsed = parse_task_result_json(
        r#"{"verdict":"completed","summary":"s","artifacts":[1,"x",{"kind":"file"}],"criteriaSelfReport":"nope"}"#,
    )
    .unwrap();
    assert!(parsed.artifacts.is_empty());
    assert!(parsed.criteria_self_report.is_none());
    let missing = parse_task_result_json(r#"{"verdict":"completed","summary":"s"}"#).unwrap();
    assert!(missing.artifacts.is_empty());
    assert!(missing.criteria_self_report.is_none());
}

#[test]
fn preserved_payloads_use_javascript_number_and_key_order() {
    let raw = r#"{"verdict":"completed","summary":"ok","artifacts":[{"kind":"patch","ref":"x","note":1.0,"extra":{"b":true,"2":2,"1":0.1}}],"criteriaSelfReport":[{"id":"c1","met":false,"evidence":{"n":-0,"big":1e21,"small":1.5e-7,"10":true,"9":null}}]}"#;
    let parsed = parse_task_result_json(raw).unwrap();
    assert_eq!(
        serde_json::to_string(&parsed.artifacts[0]).unwrap(),
        r#"{"kind":"patch","ref":"x","note":1,"extra":{"1":0.1,"2":2,"b":true}}"#
    );
    let criteria = parsed.criteria_self_report.unwrap();
    assert_eq!(
        serde_json::to_string(&criteria[0]).unwrap(),
        r#"{"id":"c1","met":false,"evidence":{"9":null,"10":true,"n":0,"big":1e+21,"small":1.5e-7}}"#
    );
}

#[test]
fn bom_between_fence_tag_and_newline_parses() {
    let text = "```TASK_RESULT\u{FEFF}\n{\"verdict\":\"completed\",\"summary\":\"s\"}\n```";
    let parsed = parse_task_result(text).unwrap();
    assert_eq!(parsed.summary, "s");
}

#[test]
fn next_line_at_fence_tag_is_not_whitespace() {
    let text = "```TASK_RESULT\u{0085}\n{\"verdict\":\"completed\",\"summary\":\"s\"}\n```";
    assert!(parse_task_result(text).is_none());
}

#[test]
fn lone_surrogate_in_artifact_note_is_kept() {
    let raw = r#"{"verdict":"completed","summary":"ok","artifacts":[{"kind":"file","ref":"x","note":"\ud800"}]}"#;
    let parsed = parse_task_result_json(raw).unwrap();
    let note = parsed.artifacts[0].note().unwrap();
    assert_eq!(protocol::js::stringify(note), r#""\ud800""#);
    assert_eq!(note.as_str(), Some("\u{FFFD}"));
}

#[test]
fn non_finite_artifact_note_stringifies_as_null() {
    let raw = r#"{"verdict":"completed","summary":"ok","artifacts":[{"kind":"file","ref":"x","note":1e400}]}"#;
    let parsed = parse_task_result_json(raw).unwrap();
    let note = parsed.artifacts[0].note().unwrap();
    assert_eq!(protocol::js::stringify(note), "null");
}

#[test]
fn lone_surrogate_summary_is_replacement_and_kept() {
    let parsed = parse_task_result_json(r#"{"verdict":"completed","summary":"\ud83d"}"#).unwrap();
    assert_eq!(parsed.summary, "\u{FFFD}");
    let fenced = "```TASK_RESULT\n{\"verdict\":\"completed\",\"summary\":\"\\ud83d\"}\n```";
    let parsed = parse_task_result(fenced).unwrap();
    assert_eq!(parsed.summary, "\u{FFFD}");
}
