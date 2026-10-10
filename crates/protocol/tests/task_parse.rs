use protocol::{ArtifactKind, TASK_RESULT, TaskVerdict, parse, parse_json};

#[test]
fn fence_constant() {
    assert_eq!(TASK_RESULT, "TASK_RESULT");
}

#[test]
fn last_fence_coerces_runner_verdicts() {
    let text = [
        "```TASK_RESULT\n{\"verdict\":\"completed\",\"summary\":\"first\"}\n```",
        "more work...",
        "```TASK_RESULT\n{\"verdict\":\"timeout\",\"summary\":\"second\"}\n```",
    ]
    .join("\n");
    let parsed = parse(&text).unwrap();
    assert_eq!(parsed.verdict, TaskVerdict::Failed);
    assert_eq!(parsed.summary, "second");
}

#[test]
fn coerces_killed_and_budget_exceeded() {
    let killed = parse_json(r#"{"verdict":"killed","summary":"s"}"#).unwrap();
    assert_eq!(killed.verdict, TaskVerdict::Failed);
    let budget = parse_json(r#"{"verdict":"budget-exceeded","summary":"s"}"#).unwrap();
    assert_eq!(budget.verdict, TaskVerdict::Failed);
    let completed = parse_json(r#"{"verdict":"completed","summary":"s"}"#).unwrap();
    assert_eq!(completed.verdict, TaskVerdict::Completed);
}

#[test]
fn bad_json_and_unknown_verdict_are_none() {
    assert!(parse("```TASK_RESULT\nnot json\n```").is_none());
    assert!(parse_json(r#"{"summary":"no verdict"}"#).is_none());
    assert!(parse_json(r#"{"verdict":"vibes","summary":"s"}"#).is_none());
    assert!(parse("no fence").is_none());
    assert!(parse("```TASK_RESULT {\"verdict\":\"completed\",\"summary\":\"s\"}```").is_none());
}

#[test]
fn filters_malformed_artifacts_and_criteria() {
    let parsed = parse_json(
        r#"{"verdict":"completed","summary":"s","artifacts":[{"kind":"file","ref":"a.ts"},{"bogus":true},{"kind":"nope","ref":"x"}],"criteriaSelfReport":[{"id":"c1","met":true},{"id":42}]}"#,
    )
    .unwrap();
    assert_eq!(parsed.artifacts.len(), 1);
    assert_eq!(parsed.artifacts[0].kind, ArtifactKind::File);
    assert_eq!(parsed.artifacts[0].r#ref, "a.ts");
    let criteria = parsed.criteria_self_report.unwrap();
    assert_eq!(criteria.len(), 1);
    assert_eq!(criteria[0].id, "c1");
    assert!(criteria[0].met);
    assert!(criteria[0].evidence.is_none());
}
