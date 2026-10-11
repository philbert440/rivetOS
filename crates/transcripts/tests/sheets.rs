use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Instant;

use serde_json::{Value, json};
use transcripts::{
    CodexDeps, DiscoveryRun, EffortOption, FetchSheet, HermesModelConfig, ModelOption, ModelSheet,
    ModelsSource, ReadJson, ReadText, RunSheet, SheetInput, SheetOverride, SheetState,
    append_model_effort_argv, apply_sheet_override, background_discovery_number,
    claude_global_config_path, claude_sheet, codex_home, codex_sheet, default_run_command,
    effort_token_ok, grok_sheet, hermes_sheet, kimi_sheet, model_token_ok, opencode_sheet,
    parse_codex_catalog, parse_codex_config_model, parse_hermes_model_config, parse_kimi_toml,
    parse_opencode_config, pi_sheet, preset_model_list, qwen_sheet, resolve_models_mode,
    sanitize_efforts, sanitize_models, settle_timeouts, sheet_for_harness,
};

const SAMPLE_TOML: &str = include_str!("fixtures/kimi/kimi-config-sample.toml");
const BASE_CLAUDE: &[&str] = &[
    "fable",
    "opus",
    "sonnet",
    "haiku",
    "fable[1m]",
    "opus[1m]",
    "sonnet[1m]",
];
const HERMES_YAML: &str = "\
# comment
model:
  default: qwen-27b
  provider: custom
  base_url: 'http://192.0.2.10:8003/v1' # local vLLM
auxiliary:
  vision:
    model: other
";

fn ids(sheet: &ModelSheet) -> Vec<String> {
    sheet
        .models
        .as_ref()
        .map(|rows| rows.iter().map(|row| row.id.clone()).collect())
        .unwrap_or_default()
}

fn effort_ids(rows: Option<&Vec<EffortOption>>) -> Vec<String> {
    rows.map(|items| items.iter().map(|row| row.id.clone()).collect())
        .unwrap_or_default()
}

fn row(id: &str, label: &str, default: bool) -> ModelOption {
    ModelOption {
        id: id.into(),
        label: label.into(),
        default: default.then_some(true),
        efforts: None,
        input_modalities: None,
    }
}

fn grok_cache() -> Value {
    json!({
        "models": {
            "grok-4.6": {"info": {"name": "Grok 4.6", "hidden": false, "reasoning_efforts": [
                {"id": "low", "label": "Low"},
                {"id": "high", "label": "High", "default": true},
                {"id": "xhigh", "label": "X-High"}
            ]}},
            "grok-4.5": {"info": {"name": "Grok 4.5", "hidden": false, "reasoning_efforts": [
                {"id": "high", "label": "High", "default": true}
            ]}},
            "grok-hidden": {"info": {"name": "Hidden", "hidden": true, "reasoning_efforts": []}},
            "grok-no-reason": {"info": {"name": "No reason", "hidden": false, "supports_reasoning_effort": false, "reasoning_efforts": [
                {"id": "low", "label": "Low"},
                {"id": "high", "label": "High", "default": true}
            ]}}
        }
    })
}

fn claude_json() -> Value {
    json!({
        "additionalModelOptionsCache": [
            {"value": "claude-fable-5-1[1m]", "label": "Fable", "description": "Fable 5.1 · Most capable"},
            {"value": "cc-update-required-1", "label": "Opus 5.5 (disabled)", "disabled": true}
        ]
    })
}

fn codex_catalog() -> Value {
    json!({
        "models": [
            {
                "slug": "gpt-5.5",
                "display_name": "GPT-5.5",
                "visibility": "list",
                "priority": 12,
                "default_reasoning_level": "medium",
                "supported_reasoning_levels": [
                    {"effort": "low"}, {"effort": "medium"}, {"effort": "high"}, {"effort": "xhigh"}
                ],
                "input_modalities": ["text", "image"]
            },
            {
                "slug": "gpt-6-astra",
                "display_name": "GPT-6-Astra",
                "visibility": "list",
                "priority": 1,
                "default_reasoning_level": "medium",
                "supported_reasoning_levels": [
                    {"effort": "low"}, {"effort": "medium"}, {"effort": "high"},
                    {"effort": "xhigh"}, {"effort": "max"}, {"effort": "ultra"}
                ],
                "input_modalities": ["text", "image"]
            },
            {"slug": "gpt-reserve", "display_name": "GPT-Reserve", "visibility": "hide", "priority": 3},
            {"slug": "bad id!", "display_name": "Bad", "visibility": "list", "priority": 0}
        ]
    })
}

fn argv(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_string()).collect()
}

fn override_of(models: Option<Value>, efforts: Option<Value>, mode: Option<&str>) -> SheetOverride {
    SheetOverride {
        models,
        efforts,
        models_mode: mode.map(|text| Value::String(text.into())),
    }
}

struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!("rr4a-sheets-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("tmpdir");
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn claude_with(
    state: &mut SheetState,
    value: Value,
    home: &str,
    env: Option<&HashMap<String, String>>,
) -> ModelSheet {
    let mut reader = move |_: &str| Ok::<Value, String>(value.clone());
    let mut slot: Option<&mut dyn ReadJson> = Some(&mut reader);
    claude_sheet(state, &mut slot, home, env)
}

fn claude_err(state: &mut SheetState, home: &str) -> ModelSheet {
    let mut reader = |_: &str| Err::<Value, String>("ENOENT".into());
    let mut slot: Option<&mut dyn ReadJson> = Some(&mut reader);
    claude_sheet(state, &mut slot, home, None)
}

#[test]
fn claude_declares_aliases_and_medium_default_efforts() {
    let mut state = SheetState::new();
    let sheet = claude_err(&mut state, "/tmp/fake-home");
    assert_eq!(sheet.model_flag.as_deref(), Some("--model"));
    assert_eq!(sheet.effort_flag.as_deref(), Some("--effort"));
    assert_eq!(ids(&sheet), BASE_CLAUDE);
    assert_eq!(
        sheet
            .models
            .as_ref()
            .and_then(|rows| rows.iter().find(|row| row.default == Some(true)))
            .map(|row| row.id.as_str()),
        Some("fable")
    );
    assert_eq!(
        sheet
            .efforts
            .as_ref()
            .and_then(|rows| rows.iter().find(|row| row.default == Some(true)))
            .map(|row| row.id.as_str()),
        Some("medium")
    );
    assert_eq!(
        effort_ids(sheet.efforts.as_ref()),
        ["low", "medium", "high", "xhigh", "max"]
    );
}

#[test]
fn claude_advertises_launch_time_model_selection() {
    let mut state = SheetState::new();
    assert_eq!(
        claude_err(&mut state, "/tmp/fake-home").launch_model,
        Some(true)
    );
    let mut miss = |_: &str| Err::<Value, String>("ENOENT".into());
    let mut text = |_: &str| Err::<String, String>("ENOENT".into());
    let mut hung = |_: &[String], _: &HashMap<String, String>, _: i64| DiscoveryRun::Hung;
    let env = HashMap::new();
    let mut json_slot: Option<&mut dyn ReadJson> = Some(&mut miss);
    let mut text_slot: Option<&mut dyn ReadText> = Some(&mut text);
    let mut run_slot: Option<&mut dyn RunSheet> = Some(&mut hung);
    let mut log_slot: Option<&mut dyn FnMut(&str)> = None;
    let mut deps = CodexDeps {
        home: "/h",
        env: Some(&env),
        now: 0,
        read_json: &mut json_slot,
        read_text: &mut text_slot,
        run_command: &mut run_slot,
        log: &mut log_slot,
    };
    assert!(codex_sheet(&mut state, &mut deps).launch_model.is_none());
    let mut hit = |_: &str| Ok::<Value, String>(codex_catalog());
    let mut json_hit: Option<&mut dyn ReadJson> = Some(&mut hit);
    deps.read_json = &mut json_hit;
    assert_eq!(codex_sheet(&mut state, &mut deps).launch_model, Some(true));
    let mut grok = |_: &str| Ok::<Value, String>(grok_cache());
    let mut grok_slot: Option<&mut dyn ReadJson> = Some(&mut grok);
    assert!(
        grok_sheet(&mut grok_slot, "/tmp/fake-home")
            .launch_model
            .is_none()
    );
    let mut empty = |_: &str| Ok::<String, String>(String::new());
    let mut empty_slot: Option<&mut dyn ReadText> = Some(&mut empty);
    assert!(
        kimi_sheet(&mut empty_slot, "/tmp/fake-home")
            .launch_model
            .is_none()
    );
}

#[test]
fn claude_appends_cache_models_and_skips_gated_ones() {
    let mut state = SheetState::new();
    let sheet = claude_with(&mut state, claude_json(), "/tmp/fake-home", None);
    let mut expected: Vec<String> = BASE_CLAUDE.iter().map(|id| (*id).to_string()).collect();
    expected.push("claude-fable-5-1[1m]".into());
    assert_eq!(ids(&sheet), expected);
    let fable = sheet
        .models
        .as_ref()
        .and_then(|rows| rows.iter().find(|row| row.id == "claude-fable-5-1[1m]"))
        .expect("fable");
    assert_eq!(fable.label, "Fable");
    assert!(fable.efforts.is_none());
    assert!(
        sheet
            .models
            .as_ref()
            .is_some_and(|rows| rows.iter().all(|row| row.id != "cc-update-required-1"))
    );
    assert_eq!(
        sheet
            .models
            .as_ref()
            .and_then(|rows| rows.iter().find(|row| row.default == Some(true)))
            .map(|row| row.id.as_str()),
        Some("fable")
    );
}

#[test]
fn claude_global_config_path_honors_config_dir() {
    let mut env = HashMap::new();
    assert_eq!(
        claude_global_config_path("/h", Some(&env)),
        "/h/.claude.json"
    );
    env.insert("CLAUDE_CONFIG_DIR".into(), "/cfg".into());
    assert_eq!(
        claude_global_config_path("/h", Some(&env)),
        "/cfg/.claude.json"
    );
    env.insert("CLAUDE_CONFIG_DIR".into(), "   ".into());
    assert_eq!(
        claude_global_config_path("/h", Some(&env)),
        "/h/.claude.json"
    );
}

#[test]
fn claude_merges_cache_from_config_dir() {
    let mut state = SheetState::new();
    let paths = RefCell::new(Vec::new());
    let mut reader = |path: &str| {
        paths.borrow_mut().push(path.to_string());
        Ok(claude_json())
    };
    let mut env = HashMap::new();
    env.insert("CLAUDE_CONFIG_DIR".into(), "/cfg".into());
    let mut slot: Option<&mut dyn ReadJson> = Some(&mut reader);
    let sheet = claude_sheet(&mut state, &mut slot, "/h", Some(&env));
    assert_eq!(paths.borrow().as_slice(), ["/cfg/.claude.json"]);
    assert!(ids(&sheet).ends_with(&["claude-fable-5-1[1m]".to_string()]));
}

#[test]
fn claude_drops_a_cache_row_already_in_the_base_list() {
    let mut state = SheetState::new();
    let sheet = claude_with(
        &mut state,
        json!({"additionalModelOptionsCache": [{"value": "opus", "label": "Dup Opus"}]}),
        "/tmp/fake-home",
        None,
    );
    assert_eq!(ids(&sheet), BASE_CLAUDE);
    assert_eq!(
        sheet
            .models
            .as_ref()
            .and_then(|rows| rows.iter().find(|row| row.id == "opus"))
            .map(|row| row.label.as_str()),
        Some("Opus 5")
    );
}

#[test]
fn claude_drops_malformed_and_invalid_cache_rows() {
    let mut state = SheetState::new();
    let sheet = claude_with(
        &mut state,
        json!({"additionalModelOptionsCache": [
            {"value": "../evil", "label": "Traversal"},
            {"value": 42},
            {"label": "no value"},
            "not-an-object",
            {"value": "claude-new-model", "label": ""}
        ]}),
        "/tmp/fake-home",
        None,
    );
    let mut expected: Vec<String> = BASE_CLAUDE.iter().map(|id| (*id).to_string()).collect();
    expected.push("claude-new-model".into());
    assert_eq!(ids(&sheet), expected);
    assert_eq!(
        sheet
            .models
            .as_ref()
            .and_then(|rows| rows.iter().find(|row| row.id == "claude-new-model"))
            .map(|row| row.label.as_str()),
        Some("claude-new-model")
    );
}

#[test]
fn claude_keeps_the_base_list_when_the_cache_is_unshaped() {
    let mut state = SheetState::new();
    assert_eq!(
        ids(&claude_with(&mut state, json!({}), "/tmp/fake-home", None)),
        BASE_CLAUDE
    );
    assert_eq!(
        ids(&claude_with(
            &mut state,
            json!({"additionalModelOptionsCache": "nope"}),
            "/tmp/fake-home",
            None
        )),
        BASE_CLAUDE
    );
}

#[test]
fn claude_memoizes_cache_rows_until_mtime_or_size_changes() {
    let dir = TempDir::new("claude-memo");
    let path = dir.0.join(".claude.json");
    let mut env = HashMap::new();
    env.insert(
        "CLAUDE_CONFIG_DIR".into(),
        dir.0.to_string_lossy().into_owned(),
    );
    let write_at = |id: &str, ms: u64| {
        std::fs::write(
            &path,
            json!({"additionalModelOptionsCache": [{"value": id}]}).to_string(),
        )
        .expect("write");
        assert!(transcripts::fsutil::set_mtime(&path, ms), "mtime");
    };
    write_at("claude-first", 1_000_000_000);
    let mut state = SheetState::new();
    let mut slot: Option<&mut dyn ReadJson> = None;
    let first = claude_sheet(&mut state, &mut slot, &dir.0.to_string_lossy(), Some(&env));
    assert!(ids(&first).ends_with(&["claude-first".to_string()]));
    write_at("claude-second", 2_000_000_000);
    let mut slot: Option<&mut dyn ReadJson> = None;
    let second = claude_sheet(&mut state, &mut slot, &dir.0.to_string_lossy(), Some(&env));
    assert!(ids(&second).ends_with(&["claude-second".to_string()]));
    let mut slot: Option<&mut dyn ReadJson> = None;
    let third = claude_sheet(&mut state, &mut slot, &dir.0.to_string_lossy(), Some(&env));
    assert_eq!(third.models, second.models);
}

#[test]
fn grok_filters_hidden_and_marks_the_first_visible_default() {
    let mut reader = |_: &str| Ok::<Value, String>(grok_cache());
    let mut slot: Option<&mut dyn ReadJson> = Some(&mut reader);
    let sheet = grok_sheet(&mut slot, "/tmp/fake-home");
    assert_eq!(sheet.model_flag.as_deref(), Some("--model"));
    assert_eq!(sheet.effort_flag.as_deref(), Some("--reasoning-effort"));
    assert_eq!(ids(&sheet), ["grok-4.6", "grok-4.5", "grok-no-reason"]);
    let first = &sheet.models.as_ref().expect("models")[0];
    assert_eq!(first.label, "Grok 4.6");
    assert_eq!(first.default, Some(true));
    assert_eq!(effort_ids(first.efforts.as_ref()), ["low", "high", "xhigh"]);
    assert_eq!(
        first
            .efforts
            .as_ref()
            .and_then(|rows| rows.iter().find(|row| row.default == Some(true)))
            .map(|row| row.id.as_str()),
        Some("high")
    );
    assert!(
        sheet
            .models
            .as_ref()
            .is_some_and(|rows| rows.iter().all(|row| row.id != "grok-hidden"))
    );
    let plain = sheet
        .models
        .as_ref()
        .and_then(|rows| rows.iter().find(|row| row.id == "grok-no-reason"))
        .expect("plain");
    assert!(plain.efforts.is_none());
    assert_eq!(sheet.efforts, first.efforts.clone());
}

#[test]
fn grok_falls_back_when_the_cache_is_unreadable() {
    let mut reader = |_: &str| Err::<Value, String>("ENOENT".into());
    let mut slot: Option<&mut dyn ReadJson> = Some(&mut reader);
    let sheet = grok_sheet(&mut slot, "/tmp/fake-home");
    assert_eq!(ids(&sheet), ["grok-4.6"]);
    assert_eq!(
        sheet
            .models
            .as_ref()
            .and_then(|rows| rows.first())
            .and_then(|row| row.default),
        Some(true)
    );
    assert_eq!(
        sheet
            .efforts
            .as_ref()
            .and_then(|rows| rows.iter().find(|row| row.default == Some(true)))
            .map(|row| row.id.as_str()),
        Some("high")
    );
    assert_eq!(sheet.effort_flag.as_deref(), Some("--reasoning-effort"));
}

#[test]
fn kimi_parses_aliases_and_the_sample_fixture() {
    let toml = "\
# comment
default_model = \"k2p5\"

[models.k2p5]
provider = \"moonshot\"

[models.kimi-for-coding]
provider = \"moonshot\"

[other]
x = 1
";
    let models = parse_kimi_toml(toml);
    assert_eq!(
        models.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
        ["k2p5", "kimi-for-coding"]
    );
    assert_eq!(
        models
            .iter()
            .find(|row| row.default == Some(true))
            .map(|row| row.id.as_str()),
        Some("k2p5")
    );
    let mut reader = move |path: &str| {
        if path.ends_with(".kimi/config.toml") {
            Ok(toml.to_string())
        } else {
            Err("missing".into())
        }
    };
    let mut slot: Option<&mut dyn ReadText> = Some(&mut reader);
    let sheet = kimi_sheet(&mut slot, "/home/user");
    assert_eq!(sheet.model_flag.as_deref(), Some("--model"));
    assert!(sheet.effort_flag.is_none());
    assert!(sheet.efforts.is_none());
    assert_eq!(ids(&sheet), ["k2p5", "kimi-for-coding"]);
    let mut missing = |_: &str| Err::<String, String>("ENOENT".into());
    let mut missing_slot: Option<&mut dyn ReadText> = Some(&mut missing);
    let empty = kimi_sheet(&mut missing_slot, "/no-such-home");
    assert!(empty.models.as_ref().is_some_and(Vec::is_empty));
    assert_eq!(empty.models_source, Some(ModelsSource::Static));
    assert_eq!(empty.model_flag.as_deref(), Some("--model"));
    let sample = parse_kimi_toml(SAMPLE_TOML);
    assert!(sample.len() >= 3);
    assert_eq!(
        sample
            .iter()
            .find(|row| row.default == Some(true))
            .map(|row| row.id.as_str()),
        Some("moonshotai/kimi-k3")
    );
    let preview = sample
        .iter()
        .find(|row| row.id == "moonshotai/kimi-k2-0905-preview")
        .expect("preview");
    assert_eq!(preview.label, "Kimi K2 0905");
    assert!(sample.iter().all(|row| row.id.starts_with("moonshotai/")));
    assert!(
        sample
            .iter()
            .all(|row| row.id != "hooks" && row.id != "moonshotai")
    );
}

#[test]
fn model_and_effort_tokens_reject_traversal_and_a_leading_tilde() {
    assert!(model_token_ok("moonshotai/kimi-k3"));
    assert!(!effort_token_ok("moonshotai/kimi-k3"));
    assert!(!effort_token_ok("a/b"));
    assert!(!model_token_ok("../x"));
    assert!(!effort_token_ok("../x"));
    assert!(!model_token_ok("a b"));
    assert!(!effort_token_ok("a b"));
    assert!(model_token_ok("openrouter/~z-ai/glm-latest"));
    assert!(model_token_ok("openrouter/~deepseek/deepseek-flash-latest"));
    assert!(!model_token_ok("~z-ai/glm-latest"));
    assert!(!model_token_ok("~"));
    let ok = format!("a~{}", "b".repeat(62));
    let too_long = format!("a~{}", "b".repeat(63));
    assert!(model_token_ok(&ok));
    assert!(!model_token_ok(&too_long));
    assert!(!model_token_ok("openrouter/~z-ai/../x"));
    assert!(model_token_ok("a:~b"));
}

#[test]
fn hermes_parses_the_top_level_model_block() {
    assert_eq!(
        parse_hermes_model_config(HERMES_YAML),
        HermesModelConfig {
            default: Some("qwen-27b".into()),
            provider: Some("custom".into()),
            base_url: Some("http://192.0.2.10:8003/v1".into()),
            api_key: None,
        }
    );
    assert_eq!(
        parse_hermes_model_config("model: \"anthropic/claude-x\"\n"),
        HermesModelConfig {
            default: Some("anthropic/claude-x".into()),
            ..HermesModelConfig::default()
        }
    );
    assert_eq!(
        parse_hermes_model_config("agent:\n  model: x\n"),
        HermesModelConfig::default()
    );
}

#[test]
fn hermes_without_config_still_has_flags() {
    let mut state = SheetState::new();
    let mut reader = |_: &str| Err::<String, String>("ENOENT".into());
    let mut text: Option<&mut dyn ReadText> = Some(&mut reader);
    let mut fetch: Option<&mut dyn FetchSheet> = None;
    let mut log: Option<&mut dyn FnMut(&str)> = None;
    let sheet = hermes_sheet(
        &mut state,
        &mut text,
        "/no-such-home",
        &mut fetch,
        0,
        &mut log,
    );
    assert!(sheet.models.as_ref().is_some_and(Vec::is_empty));
    assert_eq!(sheet.model_flag.as_deref(), Some("-m"));
    assert_eq!(sheet.effort_flag.as_deref(), Some("--reasoning"));
    assert_eq!(
        sheet
            .efforts
            .as_ref()
            .and_then(|rows| rows.iter().find(|row| row.default == Some(true)))
            .map(|row| row.id.as_str()),
        Some("medium")
    );
    assert_eq!(sheet.launch_model, Some(true));
}

#[test]
fn hermes_lists_endpoint_ids_once_the_fetch_lands() {
    let mut state = SheetState::new();
    let calls = RefCell::new(Vec::new());
    let mut reader = |_: &str| Ok::<String, String>(HERMES_YAML.to_string());
    let mut fetch = |base: &str, _: Option<&str>| {
        calls.borrow_mut().push(base.to_string());
        DiscoveryRun::Ready(Ok(vec![
            "qwen-27b".into(),
            "aggressive".into(),
            "bad id!".into(),
        ]))
    };
    let mut text: Option<&mut dyn ReadText> = Some(&mut reader);
    let mut fetch_slot: Option<&mut dyn FetchSheet> = Some(&mut fetch);
    let mut log: Option<&mut dyn FnMut(&str)> = None;
    let first = hermes_sheet(&mut state, &mut text, "/h", &mut fetch_slot, 0, &mut log);
    assert_eq!(ids(&first), ["qwen-27b"]);
    assert_eq!(first.launch_model, Some(true));
    let second = hermes_sheet(&mut state, &mut text, "/h", &mut fetch_slot, 1, &mut log);
    assert_eq!(ids(&second), ["qwen-27b", "aggressive"]);
    assert_eq!(calls.borrow().as_slice(), ["http://192.0.2.10:8003/v1"]);
    assert_eq!(
        append_model_effort_argv(
            &argv(&["hermes"]),
            Some(&second),
            Some("aggressive"),
            Some("high"),
            None,
            None
        ),
        argv(&["hermes", "-m", "aggressive", "--reasoning", "high"])
    );
}

#[test]
fn hermes_keeps_the_config_default_when_the_endpoint_is_down() {
    let mut state = SheetState::new();
    let mut reader = |_: &str| Ok::<String, String>(HERMES_YAML.to_string());
    let mut fetch =
        |_: &str, _: Option<&str>| DiscoveryRun::<Vec<String>>::Ready(Err("ECONNREFUSED".into()));
    let mut text: Option<&mut dyn ReadText> = Some(&mut reader);
    let mut fetch_slot: Option<&mut dyn FetchSheet> = Some(&mut fetch);
    let mut log: Option<&mut dyn FnMut(&str)> = None;
    let _ = hermes_sheet(&mut state, &mut text, "/h", &mut fetch_slot, 0, &mut log);
    let second = hermes_sheet(&mut state, &mut text, "/h", &mut fetch_slot, 1, &mut log);
    assert_eq!(ids(&second), ["qwen-27b"]);
}

#[test]
fn deepseek_is_empty() {}

#[test]
fn pi_falls_back_and_reads_the_store_when_present() {
    let mut missing = |_: &str| Err::<Value, String>("ENOENT".into());
    let mut slot: Option<&mut dyn ReadJson> = Some(&mut missing);
    let sheet = pi_sheet(&mut slot, "/no-such-home");
    assert_eq!(sheet.model_flag.as_deref(), Some("--model"));
    assert_eq!(sheet.effort_flag.as_deref(), Some("--thinking"));
    assert_eq!(ids(&sheet), ["deepseek/deepseek-v4-flash"]);
    assert_eq!(
        sheet
            .models
            .as_ref()
            .and_then(|rows| rows.first())
            .and_then(|row| row.default),
        Some(true)
    );
    assert_eq!(
        effort_ids(sheet.efforts.as_ref()),
        ["low", "medium", "high", "xhigh", "max"]
    );
    assert!(sheet.efforts.as_ref().is_some_and(|rows| {
        rows.iter()
            .all(|row| row.id != "off" && row.id != "minimal")
    }));
    assert_eq!(
        append_model_effort_argv(
            &argv(&["pi"]),
            Some(&sheet),
            Some("deepseek/deepseek-v4-flash"),
            Some("high"),
            None,
            None
        ),
        argv(&[
            "pi",
            "--model",
            "deepseek/deepseek-v4-flash",
            "--thinking",
            "high"
        ])
    );
    let files = json!({
        "/home/rivet/.pi/agent/settings.json": {"defaultModel": "deepseek-v4-flash"},
        "/home/rivet/.pi/agent/models-store.json": {"models": [
            {"id": "deepseek/deepseek-v4-flash", "name": "DeepSeek V4 Flash"},
            {"provider": "openai", "modelId": "gpt-4"}
        ]}
    });
    let mut reader = move |path: &str| files.get(path).cloned().ok_or_else(|| "ENOENT".into());
    let mut slot: Option<&mut dyn ReadJson> = Some(&mut reader);
    let present = pi_sheet(&mut slot, "/home/rivet");
    assert_eq!(
        ids(&present),
        ["deepseek/deepseek-v4-flash", "openai/gpt-4"]
    );
    assert_eq!(
        present
            .models
            .as_ref()
            .and_then(|rows| rows.first())
            .and_then(|row| row.default),
        Some(true)
    );
    assert_eq!(
        present
            .models
            .as_ref()
            .and_then(|rows| rows.first())
            .map(|row| row.label.as_str()),
        Some("DeepSeek V4 Flash")
    );
}

#[test]
fn qwen_is_empty_until_settings_declare_providers() {
    let mut missing = |_: &str| Err::<Value, String>("ENOENT".into());
    let mut slot: Option<&mut dyn ReadJson> = Some(&mut missing);
    let empty = qwen_sheet(&mut slot, "/no-such-home");
    assert_eq!(empty.model_flag.as_deref(), Some("-m"));
    assert!(empty.effort_flag.is_none());
    assert!(empty.models.as_ref().is_some_and(Vec::is_empty));
    assert!(empty.efforts.is_none());
    assert_eq!(
        append_model_effort_argv(
            &argv(&["qwen"]),
            Some(&empty),
            Some("qwen-27b"),
            None,
            None,
            None
        ),
        argv(&["qwen"])
    );
    let settings = json!({
        "modelProviders": {"openai": [
            {"id": "qwen-27b", "name": "qwen-27b (local vLLM)", "baseUrl": "http://192.0.2.10:8003/v1", "envKey": "OPENAI_API_KEY"},
            {"id": "qwen-think", "name": "qwen-think", "capabilities": {"reasoning": {"profile": "qwen-chat-template", "efforts": ["low", "medium", "high"], "defaultEffort": "medium"}}}
        ]},
        "model": {"name": "qwen-27b"}
    });
    let again_settings = settings.clone();
    let mut reader = move |path: &str| {
        if path == "/home/example/.qwen/settings.json" {
            Ok(settings.clone())
        } else {
            Err("ENOENT".into())
        }
    };
    let mut slot: Option<&mut dyn ReadJson> = Some(&mut reader);
    let sheet = qwen_sheet(&mut slot, "/home/example");
    assert_eq!(sheet.model_flag.as_deref(), Some("-m"));
    assert!(sheet.effort_flag.is_none());
    assert_eq!(ids(&sheet), ["qwen-27b", "qwen-think"]);
    let first = &sheet.models.as_ref().expect("models")[0];
    assert_eq!(first.label, "qwen-27b (local vLLM)");
    assert_eq!(first.default, Some(true));
    assert!(first.efforts.is_none());
    let second = &sheet.models.as_ref().expect("models")[1];
    assert_eq!(
        effort_ids(second.efforts.as_ref()),
        ["low", "medium", "high"]
    );
    assert_eq!(
        second
            .efforts
            .as_ref()
            .and_then(|rows| rows.iter().find(|row| row.default == Some(true)))
            .map(|row| row.id.as_str()),
        Some("medium")
    );
    assert_eq!(
        append_model_effort_argv(
            &argv(&["qwen"]),
            Some(&sheet),
            Some("qwen-27b"),
            None,
            None,
            None
        ),
        argv(&["qwen", "-m", "qwen-27b"])
    );
    assert_eq!(
        append_model_effort_argv(
            &argv(&["qwen"]),
            Some(&sheet),
            Some("qwen-think"),
            Some("high"),
            None,
            None
        ),
        argv(&["qwen", "-m", "qwen-think"])
    );
    let mut state = SheetState::new();
    let mut again = move |_: &str| Ok::<Value, String>(again_settings.clone());
    let mut input = SheetInput {
        home: "/home/example",
        env: None,
        now: 0,
        read_json: Some(&mut again),
        read_text: None,
        run_command: None,
        fetch_ids: None,
        log: None,
    };
    assert_eq!(
        sheet_for_harness(&mut state, "qwen-code", &mut input)
            .model_flag
            .as_deref(),
        Some("-m")
    );
}

#[test]
fn opencode_reads_config_provider_keys_and_tilde_aliases() {
    let mut reader = |path: &str| {
        if path.ends_with("opencode.json") {
            Ok(json!({"model": "zai/glm-5.3-flash"}))
        } else {
            Err("missing".into())
        }
    };
    let mut slot: Option<&mut dyn ReadJson> = Some(&mut reader);
    let sheet = opencode_sheet(&mut slot, "/home/user", None);
    assert_eq!(sheet.model_flag.as_deref(), Some("--model"));
    assert_eq!(sheet.effort_flag.as_deref(), Some("--variant"));
    assert_eq!(
        effort_ids(sheet.efforts.as_ref()),
        ["low", "medium", "high", "max"]
    );
    assert_eq!(
        sheet.models.as_ref().expect("models").as_slice(),
        &[row("zai/glm-5.3-flash", "zai/glm-5.3-flash", true)]
    );
    let mut state = SheetState::new();
    let mut harness_reader = |_: &str| Ok::<Value, String>(json!({"model": "x"}));
    let mut input = SheetInput {
        home: "/home/user",
        env: None,
        now: 0,
        read_json: Some(&mut harness_reader),
        read_text: None,
        run_command: None,
        fetch_ids: None,
        log: None,
    };
    assert_eq!(
        sheet_for_harness(&mut state, "opencode", &mut input)
            .model_flag
            .as_deref(),
        Some("--model")
    );
    assert_eq!(
        append_model_effort_argv(
            &argv(&["opencode"]),
            Some(&sheet),
            Some("zai/glm-5.3-flash"),
            None,
            None,
            None
        ),
        argv(&["opencode", "--model", "zai/glm-5.3-flash"])
    );
    assert_eq!(
        append_model_effort_argv(
            &argv(&["opencode"]),
            Some(&sheet),
            Some("zai/glm-5.3-flash"),
            Some("low"),
            None,
            None
        ),
        argv(&[
            "opencode",
            "--model",
            "zai/glm-5.3-flash",
            "--variant",
            "minimal"
        ])
    );
    assert_eq!(
        append_model_effort_argv(
            &argv(&["opencode"]),
            Some(&sheet),
            Some("zai/glm-5.3-flash"),
            Some("medium"),
            None,
            None
        ),
        argv(&["opencode", "--model", "zai/glm-5.3-flash"])
    );
    assert_eq!(
        append_model_effort_argv(
            &argv(&["opencode"]),
            Some(&sheet),
            Some("zai/glm-5.3-flash"),
            Some("max"),
            None,
            None
        ),
        argv(&[
            "opencode",
            "--model",
            "zai/glm-5.3-flash",
            "--variant",
            "max"
        ])
    );
    assert_eq!(
        parse_opencode_config(&json!({"model": "zai/glm-5.3-flash", "provider": {"zai": {"models": {"glm-5.3-flash": {}, "glm-5": {}}}}})).into_iter().map(|item| item.id).collect::<Vec<_>>(),
        ["zai/glm-5.3-flash", "zai/glm-5"]
    );
    assert_eq!(
        parse_opencode_config(
            &json!({"provider": {"openrouter": {"models": {"~z-ai/glm-latest": {}}}}})
        ),
        vec![row(
            "openrouter/~z-ai/glm-latest",
            "openrouter/~z-ai/glm-latest",
            false
        )]
    );
    let mut tilde = |path: &str| {
        if path.ends_with("opencode.json") {
            Ok(json!({"provider": {"openrouter": {"models": {"~z-ai/glm-latest": {}}}}}))
        } else {
            Err("missing".into())
        }
    };
    let mut tilde_slot: Option<&mut dyn ReadJson> = Some(&mut tilde);
    let tilde_sheet = opencode_sheet(&mut tilde_slot, "/home/user", None);
    assert_eq!(
        append_model_effort_argv(
            &argv(&["opencode"]),
            Some(&tilde_sheet),
            Some("openrouter/~z-ai/glm-latest"),
            None,
            None,
            None
        ),
        argv(&["opencode", "--model", "openrouter/~z-ai/glm-latest"])
    );
    let mut gone = |_: &str| Err::<Value, String>("missing".into());
    let mut gone_slot: Option<&mut dyn ReadJson> = Some(&mut gone);
    let empty = opencode_sheet(&mut gone_slot, "/nope", None);
    assert!(empty.models.as_ref().is_some_and(Vec::is_empty));
    assert_eq!(empty.model_flag.as_deref(), Some("--model"));
    assert_eq!(empty.effort_flag.as_deref(), Some("--variant"));
    assert!(parse_opencode_config(&json!({"model": "../x"})).is_empty());
    assert!(parse_opencode_config(&json!({"model": 1})).is_empty());
    assert!(parse_opencode_config(&Value::Null).is_empty());
}

#[test]
fn parse_codex_catalog_and_config_model() {
    let rows = parse_codex_catalog(&codex_catalog());
    assert_eq!(
        rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
        ["gpt-6-astra", "gpt-5.5"]
    );
    assert_eq!(rows[0].label, "GPT-6-Astra");
    assert_eq!(
        effort_ids(rows[0].efforts.as_ref()),
        ["low", "medium", "high", "xhigh", "max", "ultra"]
    );
    assert_eq!(
        rows[0]
            .efforts
            .as_ref()
            .and_then(|items| items.iter().find(|row| row.default == Some(true)))
            .map(|row| row.id.as_str()),
        Some("medium")
    );
    assert_eq!(
        rows[0]
            .efforts
            .as_ref()
            .and_then(|items| items.iter().find(|row| row.id == "ultra"))
            .map(|row| row.label.as_str()),
        Some("Ultra")
    );
    assert_eq!(
        rows[0].input_modalities.as_deref(),
        Some(["text".to_string(), "image".to_string()].as_slice())
    );
    assert!(parse_codex_catalog(&json!({"models": "nope"})).is_empty());
    assert!(parse_codex_catalog(&Value::Null).is_empty());
    assert_eq!(
        parse_codex_config_model(
            "approvals = \"user\"\nmodel = \"gpt-5.5\"\n[tui]\nmodel = \"x\"\n"
        )
        .as_deref(),
        Some("gpt-5.5")
    );
    assert!(parse_codex_config_model("[tui]\nmodel = \"x\"\n").is_none());
    assert!(parse_codex_config_model("").is_none());
    assert_eq!(codex_home("/h", Some(&HashMap::new())), "/h/.codex");
    let mut env = HashMap::new();
    env.insert("CODEX_HOME".into(), "/cfg".into());
    assert_eq!(codex_home("/h", Some(&env)), "/cfg");
}

fn hung_run(_: &[String], _: &HashMap<String, String>, _: i64) -> DiscoveryRun<String> {
    DiscoveryRun::Hung
}

#[test]
fn codex_static_floor_when_nothing_is_discoverable() {
    let mut state = SheetState::new();
    let mut miss = |_: &str| Err::<Value, String>("ENOENT".into());
    let mut text = |_: &str| Err::<String, String>("ENOENT".into());
    let mut hung = hung_run;
    let env = HashMap::new();
    let sheet = {
        let mut json_slot: Option<&mut dyn ReadJson> = Some(&mut miss);
        let mut text_slot: Option<&mut dyn ReadText> = Some(&mut text);
        let mut run_slot: Option<&mut dyn RunSheet> = Some(&mut hung);
        let mut log_slot: Option<&mut dyn FnMut(&str)> = None;
        let mut deps = CodexDeps {
            home: "/h",
            env: Some(&env),
            now: 0,
            read_json: &mut json_slot,
            read_text: &mut text_slot,
            run_command: &mut run_slot,
            log: &mut log_slot,
        };
        codex_sheet(&mut state, &mut deps)
    };
    assert!(sheet.models.as_ref().is_some_and(Vec::is_empty));
    assert_eq!(sheet.models_source, Some(ModelsSource::Static));
    assert_eq!(sheet.model_flag.as_deref(), Some("--model"));
    assert_eq!(sheet.effort_flag.as_deref(), Some("-c"));
    assert_eq!(
        sheet.effort_arg_prefix.as_deref(),
        Some("model_reasoning_effort=")
    );
    assert!(sheet.launch_model.is_none());
    assert_eq!(
        effort_ids(sheet.efforts.as_ref()),
        ["low", "medium", "high", "xhigh"]
    );
    assert_eq!(
        sheet
            .efforts
            .as_ref()
            .and_then(|rows| rows.iter().find(|row| row.default == Some(true)))
            .map(|row| row.id.as_str()),
        Some("medium")
    );
    let mut input = SheetInput {
        home: "/h",
        env: Some(&env),
        now: 0,
        read_json: Some(&mut miss),
        read_text: Some(&mut text),
        run_command: Some(&mut hung),
        fetch_ids: None,
        log: None,
    };
    assert_eq!(sheet_for_harness(&mut state, "codex", &mut input), sheet);
    let mut logs = Vec::new();
    let mut log = |line: &str| logs.push(line.to_string());
    assert_eq!(
        append_model_effort_argv(
            &argv(&["codex"]),
            Some(&sheet),
            Some("gpt-5.5"),
            Some("high"),
            Some(&mut log),
            Some("codex")
        ),
        argv(&["codex", "-c", "model_reasoning_effort=high"])
    );
    assert_eq!(logs.len(), 1);
    assert!(logs[0].contains("for codex"));
    assert!(logs[0].contains("static model list"));
}

#[test]
fn codex_reads_the_cli_catalog_cache() {
    let mut state = SheetState::new();
    let paths = RefCell::new(Vec::new());
    let mut read_json = |path: &str| {
        paths.borrow_mut().push(path.to_string());
        Ok(codex_catalog())
    };
    let mut read_text = |_: &str| {
        Ok::<String, String>(
            "approvals_reviewer = \"user\"\nmodel = \"gpt-5.5\"\n[tui]\nmodel = \"x\"\n".into(),
        )
    };
    let mut hung = hung_run;
    let mut env = HashMap::new();
    env.insert("CODEX_HOME".into(), "/cfg".into());
    let mut json_slot: Option<&mut dyn ReadJson> = Some(&mut read_json);
    let mut text_slot: Option<&mut dyn ReadText> = Some(&mut read_text);
    let mut run_slot: Option<&mut dyn RunSheet> = Some(&mut hung);
    let mut log_slot: Option<&mut dyn FnMut(&str)> = None;
    let mut deps = CodexDeps {
        home: "/h",
        env: Some(&env),
        now: 0,
        read_json: &mut json_slot,
        read_text: &mut text_slot,
        run_command: &mut run_slot,
        log: &mut log_slot,
    };
    let sheet = codex_sheet(&mut state, &mut deps);
    assert_eq!(paths.borrow().as_slice(), ["/cfg/models_cache.json"]);
    assert_eq!(sheet.models_source, Some(ModelsSource::Discovered));
    assert_eq!(ids(&sheet), ["gpt-6-astra", "gpt-5.5"]);
    assert_eq!(
        sheet
            .models
            .as_ref()
            .and_then(|rows| rows.iter().find(|row| row.default == Some(true)))
            .map(|row| row.id.as_str()),
        Some("gpt-5.5")
    );
    assert_eq!(
        append_model_effort_argv(
            &argv(&["codex"]),
            Some(&sheet),
            Some("gpt-6-astra"),
            Some("ultra"),
            None,
            None
        ),
        argv(&[
            "codex",
            "--model",
            "gpt-6-astra",
            "-c",
            "model_reasoning_effort=ultra"
        ])
    );
    assert_eq!(
        append_model_effort_argv(
            &argv(&["codex"]),
            Some(&sheet),
            Some("gpt-5.5"),
            Some("ultra"),
            None,
            None
        ),
        argv(&["codex", "--model", "gpt-5.5"])
    );
    assert_eq!(
        append_model_effort_argv(
            &argv(&["codex"]),
            Some(&sheet),
            None,
            Some("xhigh"),
            None,
            None
        ),
        argv(&["codex", "-c", "model_reasoning_effort=xhigh"])
    );
    assert_eq!(
        append_model_effort_argv(
            &argv(&["codex"]),
            Some(&sheet),
            None,
            Some("max"),
            None,
            None
        ),
        argv(&["codex"])
    );
    let mut logs = Vec::new();
    let mut log = |line: &str| logs.push(line.to_string());
    assert_eq!(
        append_model_effort_argv(
            &argv(&["codex"]),
            Some(&sheet),
            Some("default"),
            Some("high"),
            Some(&mut log),
            Some("codex")
        ),
        argv(&["codex", "-c", "model_reasoning_effort=high"])
    );
    assert!(logs.is_empty());
    let hermes_like = ModelSheet {
        models: Some(vec![row("default", "d", false)]),
        models_source: None,
        efforts: None,
        model_flag: Some("-m".into()),
        named_custom_provider: None,
        effort_flag: None,
        launch_model: None,
        launch_model_when_listed: None,
        effort_arg_values: None,
        effort_arg_prefix: None,
    };
    assert_eq!(
        append_model_effort_argv(
            &argv(&["hermes"]),
            Some(&hermes_like),
            Some("default"),
            None,
            None,
            Some("hermes")
        ),
        argv(&["hermes", "-m", "default"])
    );
}

#[test]
fn codex_config_list_declares_launch_model() {
    let mut state = SheetState::new();
    let floor = {
        let mut miss = |_: &str| Err::<Value, String>("ENOENT".into());
        let mut text = |_: &str| Err::<String, String>("ENOENT".into());
        let mut hung = hung_run;
        let env = HashMap::new();
        let mut json_slot: Option<&mut dyn ReadJson> = Some(&mut miss);
        let mut text_slot: Option<&mut dyn ReadText> = Some(&mut text);
        let mut run_slot: Option<&mut dyn RunSheet> = Some(&mut hung);
        let mut log_slot: Option<&mut dyn FnMut(&str)> = None;
        let mut deps = CodexDeps {
            home: "/h",
            env: Some(&env),
            now: 0,
            read_json: &mut json_slot,
            read_text: &mut text_slot,
            run_command: &mut run_slot,
            log: &mut log_slot,
        };
        codex_sheet(&mut state, &mut deps)
    };
    let pinned = apply_sheet_override(
        floor.clone(),
        Some(&override_of(Some(json!([{"id": "gw/x"}])), None, None)),
        None,
    );
    assert_eq!(pinned.launch_model, Some(true));
    assert_eq!(pinned.models_source, Some(ModelsSource::Config));
    assert!(
        apply_sheet_override(
            floor.clone(),
            Some(&override_of(Some(json!([])), None, None)),
            None
        )
        .launch_model
        .is_none()
    );
    assert!(
        preset_model_list(
            &mut state,
            "codex",
            Some(&override_of(Some(json!([{"id": "gw/x"}])), None, None)),
            "/no/such/rr4a-home"
        )
        .strict
    );
    let cold = apply_sheet_override(
        floor,
        Some(&override_of(
            Some(json!([{"id": "gw/x"}])),
            None,
            Some("merge"),
        )),
        None,
    );
    assert_eq!(cold.models_source, Some(ModelsSource::Merged));
    assert!(cold.launch_model.is_none());
    let mut state = SheetState::new();
    let mut hit = |_: &str| Ok::<Value, String>(codex_catalog());
    let mut text = |_: &str| Err::<String, String>("ENOENT".into());
    let mut hung = hung_run;
    let env = HashMap::new();
    let mut json_slot: Option<&mut dyn ReadJson> = Some(&mut hit);
    let mut text_slot: Option<&mut dyn ReadText> = Some(&mut text);
    let mut run_slot: Option<&mut dyn RunSheet> = Some(&mut hung);
    let mut log_slot: Option<&mut dyn FnMut(&str)> = None;
    let mut deps = CodexDeps {
        home: "/h",
        env: Some(&env),
        now: 0,
        read_json: &mut json_slot,
        read_text: &mut text_slot,
        run_command: &mut run_slot,
        log: &mut log_slot,
    };
    let warm = codex_sheet(&mut state, &mut deps);
    let merged = apply_sheet_override(
        warm,
        Some(&override_of(
            Some(json!([{"id": "gw/x"}])),
            None,
            Some("merge"),
        )),
        None,
    );
    assert_eq!(merged.launch_model, Some(true));
}

#[test]
fn codex_listing_replaces_a_stale_cache_and_keeps_it_across_an_outage() {
    let mut state = SheetState::new();
    let stale = json!({"models": [
        {"slug": "gpt-5.5", "display_name": "OLD LABEL", "visibility": "list", "priority": 12},
        {"slug": "gpt-retired", "display_name": "Retired", "visibility": "list", "priority": 50}
    ]});
    let phase = Cell::new(0);
    let mut read_json = move |_: &str| Ok::<Value, String>(stale.clone());
    let mut read_text = |_: &str| Err::<String, String>("ENOENT".into());
    let mut run = |_: &[String], _: &HashMap<String, String>, _: i64| match phase.get() {
        0 => DiscoveryRun::Ready(Ok(codex_catalog().to_string())),
        1 => DiscoveryRun::Ready(Err("spawn codex EAGAIN".into())),
        _ => DiscoveryRun::Ready(Ok(json!({"models": [{"wrong": "shape"}]}).to_string())),
    };
    let env = HashMap::new();
    let logs = RefCell::new(Vec::new());
    let mut log = |line: &str| logs.borrow_mut().push(line.to_string());
    let mut json_slot: Option<&mut dyn ReadJson> = Some(&mut read_json);
    let mut text_slot: Option<&mut dyn ReadText> = Some(&mut read_text);
    let mut run_slot: Option<&mut dyn RunSheet> = Some(&mut run);
    let mut log_slot: Option<&mut dyn FnMut(&str)> = Some(&mut log);
    let mut deps = CodexDeps {
        home: "/h",
        env: Some(&env),
        now: 0,
        read_json: &mut json_slot,
        read_text: &mut text_slot,
        run_command: &mut run_slot,
        log: &mut log_slot,
    };
    let _ = codex_sheet(&mut state, &mut deps);
    deps.now = 1;
    let sheet = codex_sheet(&mut state, &mut deps);
    assert_eq!(
        sheet
            .models
            .as_ref()
            .map(|rows| rows
                .iter()
                .map(|row| (row.id.as_str(), row.label.as_str()))
                .collect::<Vec<_>>())
            .unwrap_or_default(),
        [("gpt-6-astra", "GPT-6-Astra"), ("gpt-5.5", "GPT-5.5")]
    );
    phase.set(1);
    deps.now = 5 * 60_000 + 1;
    let _ = codex_sheet(&mut state, &mut deps);
    deps.now = 5 * 60_000 + 2;
    let kept = codex_sheet(&mut state, &mut deps);
    assert_eq!(ids(&kept), ["gpt-6-astra", "gpt-5.5"]);
    assert_eq!(logs.borrow().len(), 1);
    assert!(logs.borrow()[0].contains("last-known list"));
    phase.set(2);
    deps.now = 10 * 60_000 + 3;
    let _ = codex_sheet(&mut state, &mut deps);
    deps.now = 10 * 60_000 + 4;
    let still = codex_sheet(&mut state, &mut deps);
    assert_eq!(ids(&still), ["gpt-6-astra", "gpt-5.5"]);
    assert_eq!(logs.borrow().len(), 1);
}

#[test]
fn codex_configured_model_missing_from_the_catalog_becomes_the_default() {
    let mut state = SheetState::new();
    let mut read_json = |_: &str| Ok::<Value, String>(codex_catalog());
    let mut read_text = |_: &str| Ok::<String, String>("model = \"my-gateway/model-x\"\n".into());
    let mut hung = hung_run;
    let env = HashMap::new();
    let mut json_slot: Option<&mut dyn ReadJson> = Some(&mut read_json);
    let mut text_slot: Option<&mut dyn ReadText> = Some(&mut read_text);
    let mut run_slot: Option<&mut dyn RunSheet> = Some(&mut hung);
    let mut log_slot: Option<&mut dyn FnMut(&str)> = None;
    let mut deps = CodexDeps {
        home: "/h",
        env: Some(&env),
        now: 0,
        read_json: &mut json_slot,
        read_text: &mut text_slot,
        run_command: &mut run_slot,
        log: &mut log_slot,
    };
    let sheet = codex_sheet(&mut state, &mut deps);
    assert_eq!(
        ids(&sheet),
        ["gpt-6-astra", "gpt-5.5", "my-gateway/model-x"]
    );
    let defaults: Vec<_> = sheet
        .models
        .as_ref()
        .map(|rows| {
            rows.iter()
                .filter(|row| row.default == Some(true))
                .map(|row| row.id.as_str())
                .collect()
        })
        .unwrap_or_default();
    assert_eq!(defaults, ["my-gateway/model-x"]);
}

#[test]
fn codex_debug_models_lands_once_per_ttl_on_the_spawn_path() {
    let mut state = SheetState::new();
    let calls = RefCell::new(Vec::new());
    let mut read_json = |_: &str| Err::<Value, String>("ENOENT".into());
    let mut read_text = |_: &str| Err::<String, String>("ENOENT".into());
    let mut run = |argv: &[String], env: &HashMap<String, String>, _: i64| {
        calls
            .borrow_mut()
            .push((argv.to_vec(), env.get("PATH").cloned().unwrap_or_default()));
        DiscoveryRun::Ready(Ok(codex_catalog().to_string()))
    };
    let mut env = HashMap::new();
    env.insert("PATH".into(), "/usr/bin".into());
    let mut json_slot: Option<&mut dyn ReadJson> = Some(&mut read_json);
    let mut text_slot: Option<&mut dyn ReadText> = Some(&mut read_text);
    let mut run_slot: Option<&mut dyn RunSheet> = Some(&mut run);
    let mut log_slot: Option<&mut dyn FnMut(&str)> = None;
    let mut deps = CodexDeps {
        home: "/h",
        env: Some(&env),
        now: 0,
        read_json: &mut json_slot,
        read_text: &mut text_slot,
        run_command: &mut run_slot,
        log: &mut log_slot,
    };
    let first = codex_sheet(&mut state, &mut deps);
    assert!(first.models.as_ref().is_some_and(Vec::is_empty));
    assert_eq!(first.models_source, Some(ModelsSource::Static));
    assert_eq!(
        calls.borrow().as_slice(),
        [(
            argv(&["codex", "debug", "models"]),
            "/usr/bin:/h/.local/bin".to_string()
        )]
        .as_slice()
    );
    deps.now = 1;
    let second = codex_sheet(&mut state, &mut deps);
    assert_eq!(second.models_source, Some(ModelsSource::Discovered));
    assert_eq!(ids(&second), ["gpt-6-astra", "gpt-5.5"]);
    assert_eq!(
        second
            .models
            .as_ref()
            .and_then(|rows| rows.iter().find(|row| row.default == Some(true)))
            .map(|row| row.id.as_str()),
        Some("gpt-6-astra")
    );
    assert_eq!(calls.borrow().len(), 1);
    let mut cached = |_: &str| Ok::<Value, String>(codex_catalog());
    let mut cached_slot: Option<&mut dyn ReadJson> = Some(&mut cached);
    deps.read_json = &mut cached_slot;
    deps.now = 2;
    let both = codex_sheet(&mut state, &mut deps);
    assert_eq!(ids(&both), ["gpt-6-astra", "gpt-5.5"]);
    assert_eq!(calls.borrow().len(), 1);
}

#[test]
fn codex_failing_listing_keeps_the_static_sheet_and_logs_once() {
    let mut state = SheetState::new();
    let calls = Cell::new(0);
    let mut read_json = |_: &str| Err::<Value, String>("ENOENT".into());
    let mut read_text = |_: &str| Err::<String, String>("ENOENT".into());
    let mut run = |_: &[String], _: &HashMap<String, String>, _: i64| {
        calls.set(calls.get() + 1);
        DiscoveryRun::Ready(Err("spawn codex ENOENT".into()))
    };
    let env = HashMap::new();
    let logs = RefCell::new(Vec::new());
    let mut log = |line: &str| logs.borrow_mut().push(line.to_string());
    let mut json_slot: Option<&mut dyn ReadJson> = Some(&mut read_json);
    let mut text_slot: Option<&mut dyn ReadText> = Some(&mut read_text);
    let mut run_slot: Option<&mut dyn RunSheet> = Some(&mut run);
    let mut log_slot: Option<&mut dyn FnMut(&str)> = Some(&mut log);
    let mut deps = CodexDeps {
        home: "/h",
        env: Some(&env),
        now: 0,
        read_json: &mut json_slot,
        read_text: &mut text_slot,
        run_command: &mut run_slot,
        log: &mut log_slot,
    };
    assert_eq!(
        codex_sheet(&mut state, &mut deps).models_source,
        Some(ModelsSource::Static)
    );
    deps.now = 1;
    assert_eq!(
        codex_sheet(&mut state, &mut deps).models_source,
        Some(ModelsSource::Static)
    );
    assert_eq!(calls.get(), 1);
    assert_eq!(logs.borrow().len(), 1);
    assert!(logs.borrow()[0].contains("codex:debug-models"));
    assert!(logs.borrow()[0].contains("ENOENT"));
    assert!(logs.borrow()[0].contains("static sheet"));
    deps.now = 5 * 60_000 + 1;
    let _ = codex_sheet(&mut state, &mut deps);
    assert_eq!(calls.get(), 2);
    assert_eq!(logs.borrow().len(), 1);
}

#[test]
fn discovery_sink_less_caller_does_not_claim_the_outage() {
    let mut state = SheetState::new();
    let run = || DiscoveryRun::Ready(Err::<i64, String>("down".into()));
    assert!(background_discovery_number(&mut state, "s", run, 10, 0, None, None).is_none());
    let mut logs = Vec::new();
    let mut log = |line: &str| logs.push(line.to_string());
    let _ = background_discovery_number(
        &mut state,
        "s",
        || DiscoveryRun::Ready(Err("down".into())),
        10,
        20,
        None,
        Some(&mut log),
    );
    assert_eq!(logs.len(), 1);
}

#[test]
fn discovery_deadline_retries_and_a_sync_error_is_a_failure() {
    let mut state = SheetState::new();
    let calls = Cell::new(0);
    let logs = RefCell::new(Vec::new());
    let mut log = |line: &str| logs.borrow_mut().push(line.to_string());
    let _ = background_discovery_number(
        &mut state,
        "d",
        || {
            calls.set(calls.get() + 1);
            DiscoveryRun::Hung
        },
        10,
        0,
        Some(5),
        Some(&mut log),
    );
    settle_timeouts(&mut state, 20);
    logs.borrow_mut().extend(state.take_logs());
    assert_eq!(logs.borrow().len(), 1);
    assert!(logs.borrow()[0].contains("timed out after 5 ms"));
    let _ = background_discovery_number(
        &mut state,
        "d",
        || {
            calls.set(calls.get() + 1);
            DiscoveryRun::Hung
        },
        10,
        100,
        Some(5),
        Some(&mut log),
    );
    assert_eq!(calls.get(), 2);
    let got = background_discovery_number(
        &mut state,
        "t2",
        || DiscoveryRun::Ready(Err("sync boom".into())),
        10,
        0,
        None,
        Some(&mut log),
    );
    assert!(got.is_none());
    assert!(
        logs.borrow()
            .last()
            .is_some_and(|line| line.contains("sync boom"))
    );
}

#[test]
fn discovery_rearms_the_outage_log_after_a_success() {
    let mut state = SheetState::new();
    let ok = Cell::new(false);
    let mut logs = Vec::new();
    let mut log = |line: &str| logs.push(line.to_string());
    let run = || {
        if ok.get() {
            DiscoveryRun::Ready(Ok(1))
        } else {
            DiscoveryRun::Ready(Err("down".into()))
        }
    };
    assert!(
        background_discovery_number(&mut state, "t", run, 10, 0, None, Some(&mut log)).is_none()
    );
    ok.set(true);
    assert!(
        background_discovery_number(
            &mut state,
            "t",
            || DiscoveryRun::Ready(Ok(1_i64)),
            10,
            20,
            None,
            Some(&mut log)
        )
        .is_none()
    );
    assert_eq!(
        background_discovery_number(
            &mut state,
            "t",
            || DiscoveryRun::Ready(Ok(1_i64)),
            10,
            21,
            None,
            Some(&mut log)
        ),
        Some(1)
    );
    ok.set(false);
    let _ = background_discovery_number(
        &mut state,
        "t",
        || DiscoveryRun::Ready(Err::<i64, String>("down".into())),
        10,
        40,
        None,
        Some(&mut log),
    );
    assert_eq!(
        background_discovery_number(
            &mut state,
            "t",
            || DiscoveryRun::Ready(Err("down".into())),
            10,
            41,
            None,
            Some(&mut log)
        ),
        Some(1)
    );
    assert_eq!(logs.len(), 2);
    assert!(logs[1].contains("last-known list"));
}

#[test]
fn default_run_command_kills_a_child_that_ignores_sigterm() {
    let mut env = HashMap::new();
    env.insert("PATH".into(), "/usr/bin:/bin".into());
    let started = Instant::now();
    let err = default_run_command(&argv(&["sh", "-c", "sleep 5"]), &env, 200).expect_err("timeout");
    assert!(err.contains("timed out after 200 ms"), "{err}");
    assert!(
        started.elapsed().as_millis() < 3_000,
        "kill took {:?}",
        started.elapsed()
    );
    assert_eq!(
        default_run_command(&argv(&["sh", "-c", "echo ok"]), &env, 5_000).expect("echo"),
        "ok\n"
    );
}

#[test]
fn codex_without_a_runner_returns_before_the_listing_finishes() {
    let mut state = SheetState::new();
    let mut read_json = |_: &str| Err::<Value, String>("ENOENT".into());
    let mut read_text = |_: &str| Err::<String, String>("ENOENT".into());
    let mut env = HashMap::new();
    env.insert("PATH".into(), "/no/such/rr4a-bin".into());
    let logs = RefCell::new(Vec::new());
    let mut log = |line: &str| logs.borrow_mut().push(line.to_string());
    let mut json_slot: Option<&mut dyn ReadJson> = Some(&mut read_json);
    let mut text_slot: Option<&mut dyn ReadText> = Some(&mut read_text);
    let mut run_slot: Option<&mut dyn RunSheet> = None;
    let mut log_slot: Option<&mut dyn FnMut(&str)> = Some(&mut log);
    let mut deps = CodexDeps {
        home: "/h",
        env: Some(&env),
        now: 0,
        read_json: &mut json_slot,
        read_text: &mut text_slot,
        run_command: &mut run_slot,
        log: &mut log_slot,
    };
    let started = Instant::now();
    let first = codex_sheet(&mut state, &mut deps);
    assert!(first.models.as_ref().is_some_and(Vec::is_empty));
    assert!(
        started.elapsed().as_millis() < 1_000,
        "sheet blocked for {:?}",
        started.elapsed()
    );
    let mut saw = false;
    for _ in 0..50 {
        if logs
            .borrow()
            .iter()
            .any(|line| line.contains("static sheet"))
        {
            saw = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
        deps.now = 1;
        let again = codex_sheet(&mut state, &mut deps);
        assert!(again.models.as_ref().is_some_and(Vec::is_empty));
    }
    assert!(saw, "{:?}", logs.borrow());
    assert!(
        started.elapsed().as_millis() < 3_000,
        "follow-up blocked for {:?}",
        started.elapsed()
    );
}

#[test]
fn codex_omitted_env_inherits_the_process_environment() {
    let mut state = SheetState::new();
    let seen = RefCell::new(HashMap::new());
    let mut read_json = |_: &str| Err::<Value, String>("ENOENT".into());
    let mut read_text = |_: &str| Err::<String, String>("ENOENT".into());
    let mut run = |_argv: &[String], env: &HashMap<String, String>, _: i64| {
        *seen.borrow_mut() = env.clone();
        DiscoveryRun::Hung
    };
    let inherited: HashMap<String, String> = std::env::vars().collect();
    let mut json_slot: Option<&mut dyn ReadJson> = Some(&mut read_json);
    let mut text_slot: Option<&mut dyn ReadText> = Some(&mut read_text);
    let mut run_slot: Option<&mut dyn RunSheet> = Some(&mut run);
    let mut log_slot: Option<&mut dyn FnMut(&str)> = None;
    let mut deps = CodexDeps {
        home: "/h",
        env: None,
        now: 0,
        read_json: &mut json_slot,
        read_text: &mut text_slot,
        run_command: &mut run_slot,
        log: &mut log_slot,
    };
    let _ = codex_sheet(&mut state, &mut deps);
    let got = seen.borrow();
    for (key, value) in &inherited {
        if key == "PATH" {
            continue;
        }
        assert_eq!(got.get(key), Some(value), "{key}");
    }
    let path = got.get("PATH").cloned().unwrap_or_default();
    assert!(
        path.split(':').any(|part| part == "/h/.local/bin"),
        "{path}"
    );
}

#[test]
fn hermes_https_listing_fails_closed_on_the_next_read() {
    let mut state = SheetState::new();
    let yaml = "model:\n  default: local-a\n  base_url: https://example.invalid/v1\n";
    let mut reader = |_path: &str| Ok::<String, String>(yaml.to_string());
    let mut text: Option<&mut dyn ReadText> = Some(&mut reader);
    let mut fetch: Option<&mut dyn FetchSheet> = None;
    let logs = RefCell::new(Vec::new());
    let mut log = |line: &str| logs.borrow_mut().push(line.to_string());
    let mut log_slot: Option<&mut dyn FnMut(&str)> = Some(&mut log);
    let started = Instant::now();
    let first = hermes_sheet(&mut state, &mut text, "/h", &mut fetch, 0, &mut log_slot);
    assert_eq!(ids(&first), ["local-a"]);
    assert!(
        started.elapsed().as_millis() < 1_000,
        "{:?}",
        started.elapsed()
    );
    let mut saw = false;
    for _ in 0..40 {
        if logs
            .borrow()
            .iter()
            .any(|line| line.contains("listing failed"))
        {
            saw = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
        let sheet = hermes_sheet(&mut state, &mut text, "/h", &mut fetch, 1, &mut log_slot);
        assert_eq!(ids(&sheet), ["local-a"]);
    }
    assert!(saw, "{:?}", logs.borrow());
    assert!(
        started.elapsed().as_millis() < 3_000,
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn hermes_default_fetch_applies_http_models_on_the_next_read() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    std::thread::spawn(move || {
        let Ok((mut sock, _)) = listener.accept() else {
            return;
        };
        let _ = sock.set_read_timeout(Some(std::time::Duration::from_secs(2)));
        let mut buf = [0_u8; 2048];
        let _ = std::io::Read::read(&mut sock, &mut buf);
        let body = br#"{"data":[{"id":"local-b"},{"id":"bad id"}]}"#;
        let mut resp = format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n",
            body.len()
        )
        .into_bytes();
        resp.extend_from_slice(body);
        resp.extend_from_slice(b"\r\n0\r\n\r\n");
        let _ = std::io::Write::write_all(&mut sock, &resp);
    });
    let yaml = format!("model:\n  default: local-a\n  base_url: http://127.0.0.1:{port}/v1\n");
    let mut state = SheetState::new();
    let mut reader = move |_path: &str| Ok::<String, String>(yaml.clone());
    let mut text: Option<&mut dyn ReadText> = Some(&mut reader);
    let mut fetch: Option<&mut dyn FetchSheet> = None;
    let mut log: Option<&mut dyn FnMut(&str)> = None;
    let first = hermes_sheet(&mut state, &mut text, "/h", &mut fetch, 0, &mut log);
    assert_eq!(ids(&first), ["local-a"]);
    let mut landed = false;
    for _ in 0..50 {
        std::thread::sleep(std::time::Duration::from_millis(40));
        let sheet = hermes_sheet(&mut state, &mut text, "/h", &mut fetch, 1, &mut log);
        if ids(&sheet) == ["local-a".to_string(), "local-b".to_string()] {
            landed = true;
            break;
        }
    }
    assert!(landed);
}

#[test]
fn preset_model_list_is_strict_only_for_a_real_replacement() {
    let mut state = SheetState::new();
    let home = "/no/such/rr4a-preset-home";
    let pinned = preset_model_list(
        &mut state,
        "claude-code",
        Some(&override_of(Some(json!([{"id": "only"}])), None, None)),
        home,
    );
    assert_eq!(pinned.ids, ["only"]);
    assert!(pinned.strict);
    assert_eq!(pinned.source, ModelsSource::Config);
    assert!(
        !preset_model_list(
            &mut state,
            "claude-code",
            Some(&override_of(Some(json!([])), None, Some("replace"))),
            home
        )
        .strict
    );
    assert!(
        !preset_model_list(
            &mut state,
            "claude-code",
            Some(&override_of(None, Some(json!([{"id": "max"}])), None)),
            home
        )
        .strict
    );
    let merged = preset_model_list(
        &mut state,
        "claude-code",
        Some(&override_of(
            Some(json!([{"id": "x"}])),
            None,
            Some("merge"),
        )),
        home,
    );
    assert!(!merged.strict);
    assert_eq!(merged.source, ModelsSource::Merged);
    assert!(
        preset_model_list(&mut state, "cursor", None, home)
            .ids
            .is_empty()
    );
}

#[test]
fn resolve_models_mode_prefers_an_explicit_mode() {
    assert_eq!(resolve_models_mode(None), "discover");
    assert_eq!(
        resolve_models_mode(Some(&SheetOverride::default())),
        "discover"
    );
    assert_eq!(
        resolve_models_mode(Some(&override_of(Some(json!([{"id": "x"}])), None, None))),
        "replace"
    );
    assert_eq!(
        resolve_models_mode(Some(&override_of(None, Some(json!([])), None))),
        "replace"
    );
    assert_eq!(
        resolve_models_mode(Some(&override_of(
            Some(json!([{"id": "x"}])),
            None,
            Some("merge")
        ))),
        "merge"
    );
    assert_eq!(
        resolve_models_mode(Some(&override_of(
            Some(json!([{"id": "x"}])),
            None,
            Some("discover")
        ))),
        "discover"
    );
    assert_eq!(
        resolve_models_mode(Some(&override_of(
            Some(json!([{"id": "x"}])),
            None,
            Some("bogus")
        ))),
        "replace"
    );
}

#[test]
fn apply_sheet_override_replaces_merges_and_ignores_empty_lists() {
    let mut state = SheetState::new();
    let base = claude_err(&mut state, "/tmp/fake-home");
    let replaced = apply_sheet_override(
        base.clone(),
        Some(&override_of(
            Some(json!([{"id": "only", "label": "Only"}])),
            None,
            None,
        )),
        None,
    );
    assert_eq!(
        replaced.models.as_ref().expect("models").as_slice(),
        &[row("only", "Only", false)]
    );
    assert_eq!(replaced.models_source, Some(ModelsSource::Config));
    let merged = apply_sheet_override(
        base.clone(),
        Some(&override_of(
            Some(json!([
                {"id": "opus", "label": "Opus (gateway)", "efforts": [{"id": "max", "label": "Max"}]},
                {"id": "gateway-x", "label": "Gateway X", "default": true}
            ])),
            Some(json!([{"id": "xhigh", "label": "Extra"}, {"id": "ultra", "label": "Ultra"}])),
            Some("merge"),
        )),
        None,
    );
    assert_eq!(merged.models_source, Some(ModelsSource::Merged));
    let merged_ids = ids(&merged);
    assert_eq!(&merged_ids[..4], ["fable", "opus", "sonnet", "haiku"]);
    assert_eq!(merged_ids.last().map(String::as_str), Some("gateway-x"));
    assert_eq!(
        merged_ids.iter().filter(|id| id.as_str() == "opus").count(),
        1
    );
    let opus = merged
        .models
        .as_ref()
        .and_then(|rows| rows.iter().find(|row| row.id == "opus"))
        .expect("opus");
    assert_eq!(opus.label, "Opus (gateway)");
    assert_eq!(
        opus.efforts
            .as_ref()
            .map(|rows| rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>())
            .unwrap_or_default(),
        ["max"]
    );
    let defaults: Vec<_> = merged
        .models
        .as_ref()
        .map(|rows| {
            rows.iter()
                .filter(|row| row.default == Some(true))
                .map(|row| row.id.as_str())
                .collect()
        })
        .unwrap_or_default();
    assert_eq!(defaults, ["gateway-x"]);
    assert_eq!(
        effort_ids(merged.efforts.as_ref()),
        ["low", "medium", "high", "xhigh", "max", "ultra"]
    );
    assert_eq!(
        merged
            .efforts
            .as_ref()
            .and_then(|rows| rows.iter().find(|row| row.id == "xhigh"))
            .map(|row| row.label.as_str()),
        Some("Extra")
    );
    assert_eq!(
        merged
            .efforts
            .as_ref()
            .and_then(|rows| rows.iter().find(|row| row.default == Some(true)))
            .map(|row| row.id.as_str()),
        Some("medium")
    );
    assert_eq!(
        base.models
            .as_ref()
            .and_then(|rows| rows.iter().find(|row| row.default == Some(true)))
            .map(|row| row.id.as_str()),
        Some("fable")
    );
    let mut logs = Vec::new();
    let mut log = |line: &str| logs.push(line.to_string());
    let discovered = apply_sheet_override(
        base.clone(),
        Some(&override_of(
            Some(json!([{"id": "x"}])),
            None,
            Some("discover"),
        )),
        Some(&mut log),
    );
    assert_eq!(discovered.models, base.models);
    assert_eq!(discovered.models_source, Some(ModelsSource::Static));
    assert_eq!(
        logs,
        [
            "[den-server] harness sheet: models_mode is discover — ignoring the models/efforts override"
        ]
    );
    let next = apply_sheet_override(
        base.clone(),
        Some(&override_of(
            Some(json!([{"id": "only", "label": "Only"}, {"id": 1}, {"nope": true}])),
            Some(json!([{"id": "max", "label": "Max", "default": true}, "bad"])),
            None,
        )),
        None,
    );
    assert_eq!(
        next.models.as_ref().expect("models").as_slice(),
        &[row("only", "Only", false)]
    );
    assert_eq!(
        next.efforts.as_ref().expect("efforts").as_slice(),
        &[EffortOption {
            id: "max".into(),
            label: "Max".into(),
            default: Some(true)
        }]
    );
    assert_eq!(next.model_flag.as_deref(), Some("--model"));
    assert_eq!(next.effort_flag.as_deref(), Some("--effort"));
    let kept = apply_sheet_override(
        base.clone(),
        Some(&override_of(
            Some(json!("nope")),
            Some(json!({"id": "x"})),
            None,
        )),
        None,
    );
    assert_eq!(kept.models, base.models);
    assert_eq!(kept.efforts, base.efforts);
    let mut empty_logs = Vec::new();
    let mut empty_log = |line: &str| empty_logs.push(line.to_string());
    let ignored = apply_sheet_override(
        base.clone(),
        Some(&override_of(
            Some(json!([])),
            Some(json!([{"id": "bad id!"}])),
            None,
        )),
        Some(&mut empty_log),
    );
    assert_eq!(ignored.models, base.models);
    assert_eq!(ignored.efforts, base.efforts);
    assert!(
        empty_logs
            .iter()
            .any(|line| line.contains("empty models override"))
    );
    assert!(
        empty_logs
            .iter()
            .any(|line| line.contains("empty efforts override"))
    );
}

#[test]
fn sanitize_models_keeps_nested_efforts_and_slash_ids() {
    assert_eq!(
        sanitize_models(&json!([
            {"id": "ok", "label": "OK", "efforts": [{"id": "low", "label": "Low"}, {"id": ""}]},
            {"id": "bad id!"},
            null
        ])),
        vec![ModelOption {
            id: "ok".into(),
            label: "OK".into(),
            default: None,
            efforts: Some(vec![EffortOption {
                id: "low".into(),
                label: "Low".into(),
                default: None
            }]),
            input_modalities: None,
        }]
    );
    assert_eq!(
        sanitize_models(&json!([{"id": "moonshotai/kimi-k3", "label": "Kimi K3"}])),
        vec![row("moonshotai/kimi-k3", "Kimi K3", false)]
    );
    assert!(sanitize_efforts(&json!([{"id": "a/b", "label": "nope"}])).is_empty());
    assert!(sanitize_models(&json!([{"id": "../x"}, {"id": "a b"}])).is_empty());
    assert!(sanitize_efforts(&json!([{"id": "../x"}, {"id": "a b"}])).is_empty());
}

#[test]
fn append_model_effort_argv_matches_each_harness() {
    let mut state = SheetState::new();
    let claude = claude_err(&mut state, "/tmp/fake-home");
    assert_eq!(
        append_model_effort_argv(
            &argv(&["claude"]),
            Some(&claude),
            Some("fable"),
            Some("high"),
            None,
            None
        ),
        argv(&["claude", "--model", "fable", "--effort", "high"])
    );
    assert_eq!(
        append_model_effort_argv(
            &argv(&["claude"]),
            Some(&claude),
            Some("not-a-model"),
            Some("nope"),
            None,
            None
        ),
        argv(&["claude"])
    );
    let kimi_like = ModelSheet {
        models: Some(vec![row("k2p5", "k2p5", false)]),
        models_source: Some(ModelsSource::Static),
        efforts: None,
        model_flag: Some("--model".into()),
        named_custom_provider: None,
        effort_flag: None,
        launch_model: None,
        launch_model_when_listed: None,
        effort_arg_values: None,
        effort_arg_prefix: None,
    };
    assert_eq!(
        append_model_effort_argv(
            &argv(&["kimi"]),
            Some(&kimi_like),
            Some("k2"),
            Some("high"),
            None,
            None
        ),
        argv(&["kimi"])
    );
    let mut sample = |_: &str| Ok::<String, String>(SAMPLE_TOML.to_string());
    let mut sample_slot: Option<&mut dyn ReadText> = Some(&mut sample);
    let kimi = kimi_sheet(&mut sample_slot, "/home/user");
    assert!(kimi.effort_flag.is_none());
    assert_eq!(
        append_model_effort_argv(
            &argv(&["kimi"]),
            Some(&kimi),
            Some("moonshotai/kimi-k3"),
            Some("high"),
            None,
            None
        ),
        argv(&["kimi", "--model", "moonshotai/kimi-k3"])
    );
    let mut grok = |_: &str| Ok::<Value, String>(grok_cache());
    let mut grok_slot: Option<&mut dyn ReadJson> = Some(&mut grok);
    let grok_sheet = grok_sheet(&mut grok_slot, "/tmp");
    assert_eq!(
        append_model_effort_argv(
            &argv(&["grok"]),
            Some(&grok_sheet),
            Some("grok-4.6"),
            Some("xhigh"),
            None,
            None
        ),
        argv(&["grok", "--model", "grok-4.6", "--reasoning-effort", "xhigh"])
    );
    assert_eq!(
        append_model_effort_argv(
            &argv(&["grok"]),
            Some(&grok_sheet),
            Some("grok-4.5"),
            Some("xhigh"),
            None,
            None
        ),
        argv(&["grok", "--model", "grok-4.5"])
    );
    let mut missing = |_: &str| Err::<String, String>("ENOENT".into());
    let mut text: Option<&mut dyn ReadText> = Some(&mut missing);
    let mut fetch: Option<&mut dyn FetchSheet> = None;
    let mut log: Option<&mut dyn FnMut(&str)> = None;
    let hermes = apply_sheet_override(
        hermes_sheet(
            &mut state,
            &mut text,
            "/no-such-home",
            &mut fetch,
            0,
            &mut log,
        ),
        Some(&override_of(
            Some(json!([
                {"id": "custom:p:m", "label": "named"},
                {"id": "qwen-27b", "label": "plain"},
                {"id": "custom:local:qwen3.5:27b", "label": "colons"}
            ])),
            None,
            None,
        )),
        None,
    );
    assert!(model_token_ok("custom:p:m"));
    assert!(model_token_ok("custom:local:qwen3.5:27b"));
    assert_eq!(
        append_model_effort_argv(
            &argv(&["hermes"]),
            Some(&hermes),
            Some("custom:p:m"),
            None,
            None,
            None
        ),
        argv(&["hermes", "--provider", "p", "-m", "m"])
    );
    assert_eq!(
        append_model_effort_argv(
            &argv(&["hermes"]),
            Some(&hermes),
            Some("custom:local:qwen3.5:27b"),
            None,
            None,
            None
        ),
        argv(&["hermes", "--provider", "local", "-m", "qwen3.5:27b"])
    );
    assert_eq!(
        append_model_effort_argv(
            &argv(&["hermes"]),
            Some(&hermes),
            Some("qwen-27b"),
            None,
            None,
            None
        ),
        argv(&["hermes", "-m", "qwen-27b"])
    );
    let mut qwen_missing = |_: &str| Err::<Value, String>("ENOENT".into());
    let mut qwen_slot: Option<&mut dyn ReadJson> = Some(&mut qwen_missing);
    let qwen = apply_sheet_override(
        qwen_sheet(&mut qwen_slot, "/no-such-home"),
        Some(&override_of(
            Some(json!([{"id": "custom:p:m", "label": "colon"}])),
            None,
            None,
        )),
        None,
    );
    assert!(qwen.named_custom_provider.is_none());
    assert_eq!(
        append_model_effort_argv(
            &argv(&["qwen"]),
            Some(&qwen),
            Some("custom:p:m"),
            None,
            None,
            None
        ),
        argv(&["qwen", "-m", "custom:p:m"])
    );
}
