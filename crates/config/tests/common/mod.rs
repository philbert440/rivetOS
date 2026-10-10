pub const BASE: &str = "\
runtime:
  workspace: /tmp/ws
  default_agent: main
agents:
  main:
    provider: anthropic
providers:
  anthropic:
    model: claude-opus
";

pub fn assert_has_error(yaml: &str, message: &str) {
    let value = config::parse_yaml(yaml).unwrap_or_else(|err| panic!("parse {err}\n{yaml}"));
    let result = config::validate_config(&value);
    assert!(
        result.errors.iter().any(|issue| issue.message == message),
        "missing {message}\nerrors: {:?}\nwarnings: {:?}\n{yaml}",
        result
            .errors
            .iter()
            .map(|issue| issue.message.as_str())
            .collect::<Vec<_>>(),
        result
            .warnings
            .iter()
            .map(|issue| issue.message.as_str())
            .collect::<Vec<_>>(),
    );
    assert!(!result.valid, "{message}");
}

pub fn with_base(extra: &str) -> String {
    format!("{BASE}{extra}")
}

pub fn runtime_body(body: &str) -> String {
    format!(
        "runtime:\n{body}agents:\n  main:\n    provider: anthropic\nproviders:\n  anthropic:\n    model: claude-opus\n"
    )
}

pub fn agent_body(body: &str) -> String {
    format!(
        "runtime:\n  workspace: /tmp/ws\n  default_agent: main\nagents:\n  main:\n{body}providers:\n  anthropic:\n    model: claude-opus\n"
    )
}

pub fn provider(name: &str, fields: &str) -> String {
    format!(
        "runtime:\n  workspace: /tmp/ws\n  default_agent: main\nagents:\n  main:\n    provider: {name}\nproviders:\n  {name}:\n{fields}"
    )
}

pub fn memory(body: &str) -> String {
    with_base(&format!("memory:\n{body}"))
}

pub fn harness(fields: &str) -> String {
    with_base(&format!("tasks:\n  harnesses:\n    claude-code:\n{fields}"))
}

pub fn eval_fields(fields: &str) -> String {
    with_base(&format!("tasks:\n  eval:\n{fields}"))
}

#[test]
fn helpers_build_parseable_yaml() {
    let samples = [
        BASE.to_string(),
        with_base(""),
        runtime_body("  workspace: /tmp/ws\n  default_agent: main\n"),
        agent_body("    provider: anthropic\n"),
        provider("anthropic", "    model: claude-opus\n"),
        memory("  sqlite:\n    path: \":memory:\"\n"),
        harness("      binary: claude\n"),
        eval_fields("    enabled: false\n"),
    ];
    for yaml in samples {
        config::parse_yaml(&yaml).unwrap_or_else(|err| panic!("{err}\n{yaml}"));
    }
    assert_has_error(
        "runtime: {}\n",
        "Missing required section \"agents\" — define at least one agent",
    );
}
