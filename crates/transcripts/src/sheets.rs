use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::fsutil::{self, FileStamp};
use crate::value::jtrim;

pub const CODEX_DEFAULT_MODEL: &str = "default";

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct EffortOption {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub efforts: Option<Vec<EffortOption>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_modalities: Option<Vec<String>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelsSource {
    Discovered,
    Config,
    Merged,
    Static,
}

impl ModelsSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Discovered => "discovered",
            Self::Config => "config",
            Self::Merged => "merged",
            Self::Static => "static",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSheet {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<ModelOption>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models_source: Option<ModelsSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub efforts: Option<Vec<EffortOption>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_flag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub named_custom_provider: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort_flag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_model: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_model_when_listed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort_arg_values: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort_arg_prefix: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct SheetOverride {
    pub models: Option<Value>,
    pub efforts: Option<Value>,
    pub models_mode: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PresetList {
    pub ids: Vec<String>,
    pub strict: bool,
    pub source: ModelsSource,
}

#[derive(Clone, Debug)]
pub enum DiscoveryRun<T> {
    Ready(Result<T, String>),
    Hung,
}

pub trait ReadJson {
    fn read_json(&mut self, path: &str) -> Result<Value, String>;
}

impl<F> ReadJson for F
where
    F: FnMut(&str) -> Result<Value, String>,
{
    fn read_json(&mut self, path: &str) -> Result<Value, String> {
        self(path)
    }
}

pub trait ReadText {
    fn read_text(&mut self, path: &str) -> Result<String, String>;
}

impl<F> ReadText for F
where
    F: FnMut(&str) -> Result<String, String>,
{
    fn read_text(&mut self, path: &str) -> Result<String, String> {
        self(path)
    }
}

pub trait RunSheet {
    fn run_sheet(&mut self, argv: &[String], env: &HashMap<String, String>, timeout_ms: i64) -> DiscoveryRun<String>;
}

impl<F> RunSheet for F
where
    F: FnMut(&[String], &HashMap<String, String>, i64) -> DiscoveryRun<String>,
{
    fn run_sheet(&mut self, argv: &[String], env: &HashMap<String, String>, timeout_ms: i64) -> DiscoveryRun<String> {
        self(argv, env, timeout_ms)
    }
}

pub trait FetchSheet {
    fn fetch_sheet(&mut self, base: &str, api_key: Option<&str>) -> DiscoveryRun<Vec<String>>;
}

impl<F> FetchSheet for F
where
    F: FnMut(&str, Option<&str>) -> DiscoveryRun<Vec<String>>,
{
    fn fetch_sheet(&mut self, base: &str, api_key: Option<&str>) -> DiscoveryRun<Vec<String>> {
        self(base, api_key)
    }
}

pub struct SheetInput<'a> {
    pub home: &'a str,
    pub env: Option<&'a HashMap<String, String>>,
    pub now: i64,
    pub read_json: Option<&'a mut dyn ReadJson>,
    pub read_text: Option<&'a mut dyn ReadText>,
    pub run_command: Option<&'a mut dyn RunSheet>,
    pub fetch_ids: Option<&'a mut dyn FetchSheet>,
    pub log: Option<&'a mut dyn FnMut(&str)>,
}

pub struct CodexDeps<'a> {
    pub home: &'a str,
    pub env: Option<&'a HashMap<String, String>>,
    pub now: i64,
    pub read_json: &'a mut Option<&'a mut dyn ReadJson>,
    pub read_text: &'a mut Option<&'a mut dyn ReadText>,
    pub run_command: &'a mut Option<&'a mut dyn RunSheet>,
    pub log: &'a mut Option<&'a mut dyn FnMut(&str)>,
}

#[derive(Clone, Debug)]
enum Cached {
    Models(Vec<ModelOption>),
    Strings(Vec<String>),
    Number(i64),
}

struct Hung {
    timeout_ms: i64,
    started_now: i64,
    wants_log: bool,
}

struct Slot {
    value: Option<Cached>,
    at: Option<i64>,
    failing: bool,
    hung: Option<Hung>,
}

struct Memo {
    mtime_ms: i64,
    size: u64,
    models: Vec<ModelOption>,
}

#[derive(Default)]
pub struct SheetState {
    discovery: HashMap<String, Slot>,
    claude_memo: HashMap<String, Memo>,
    file_memo: HashMap<String, Memo>,
    pending_logs: Vec<String>,
}

impl SheetState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.discovery.clear();
        self.claude_memo.clear();
        self.file_memo.clear();
        self.pending_logs.clear();
    }

    pub fn take_logs(&mut self) -> Vec<String> {
        std::mem::take(&mut self.pending_logs)
    }
}

impl Slot {
    fn fresh() -> Self {
        Self { value: None, at: None, failing: false, hung: None }
    }
}

pub fn model_token_ok(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 || text.contains("..") {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| {
        byte.is_ascii_alphanumeric()
            || matches!(byte, b'.' | b'_' | b'[' | b']' | b':' | b'/' | b'-')
            || (index > 0 && *byte == b'~')
    })
}

pub fn effort_token_ok(text: &str) -> bool {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9._\[\]:-]{1,64}$").ok()).as_ref().is_some_and(|re| re.is_match(text))
}

pub fn resolve_models_mode(override_: Option<&SheetOverride>) -> &'static str {
    let Some(override_) = override_ else {
        return "discover";
    };
    if let Some(raw) = override_.models_mode.as_ref().and_then(Value::as_str)
        && (raw == "discover" || raw == "replace" || raw == "merge") {
            return match raw {
                "replace" => "replace",
                "merge" => "merge",
                _ => "discover",
            };
        }
    if override_.models.as_ref().is_some_and(|value| value.is_array())
        || override_.efforts.as_ref().is_some_and(|value| value.is_array())
    {
        "replace"
    } else {
        "discover"
    }
}

pub fn sanitize_efforts(raw: &Value) -> Vec<EffortOption> {
    let Some(entries) = raw.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries {
        let Some(record) = entry.as_object() else {
            continue;
        };
        let Some(id_raw) = record.get("id").and_then(Value::as_str) else {
            continue;
        };
        let id = jtrim(id_raw);
        if !effort_token_ok(id) {
            continue;
        }
        let label = label_or(record.get("label"), id);
        let mut opt = EffortOption { id: id.to_string(), label, default: None };
        if record.get("default") == Some(&Value::Bool(true)) {
            opt.default = Some(true);
        }
        out.push(opt);
    }
    out
}

pub fn sanitize_models(raw: &Value) -> Vec<ModelOption> {
    let Some(entries) = raw.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries {
        let Some(record) = entry.as_object() else {
            continue;
        };
        let Some(id_raw) = record.get("id").and_then(Value::as_str) else {
            continue;
        };
        let id = jtrim(id_raw);
        if !model_token_ok(id) {
            continue;
        }
        let label = label_or(record.get("label"), id);
        let mut opt = ModelOption {
            id: id.to_string(),
            label,
            default: None,
            efforts: None,
            input_modalities: None,
        };
        if record.get("default") == Some(&Value::Bool(true)) {
            opt.default = Some(true);
        }
        if let Some(raw_efforts) = record.get("efforts") {
            let efforts = sanitize_efforts(raw_efforts);
            if !efforts.is_empty() {
                opt.efforts = Some(efforts);
            }
        }
        out.push(opt);
    }
    out
}

pub fn apply_sheet_override(sheet: ModelSheet, override_: Option<&SheetOverride>, mut log: Option<&mut dyn FnMut(&str)>) -> ModelSheet {
    let Some(override_) = override_ else {
        return with_launch_model(sheet.clone(), &sheet);
    };
    let mode = resolve_models_mode(Some(override_));
    let mut next = sheet.clone();
    if mode == "discover" {
        if (override_.models.as_ref().is_some_and(|value| value.is_array())
            || override_.efforts.as_ref().is_some_and(|value| value.is_array()))
            && let Some(log) = log {
                log("[den-server] harness sheet: models_mode is discover — ignoring the models/efforts override");
            }
        return with_launch_model(next, &sheet);
    }
    apply_model_list(&mut next, &sheet, override_, mode, &mut log);
    apply_effort_list(&mut next, override_, mode, &mut log);
    with_launch_model(next, &sheet)
}

pub fn claude_global_config_path(home: &str, env: Option<&HashMap<String, String>>) -> String {
    if let Some(dir) = env_trimmed(env, "CLAUDE_CONFIG_DIR") {
        return join_path(&dir, ".claude.json");
    }
    join_path(home, ".claude.json")
}

pub fn claude_sheet(
    state: &mut SheetState,
    read_json: &mut Option<&mut dyn ReadJson>,
    home: &str,
    env: Option<&HashMap<String, String>>,
) -> ModelSheet {
    let mut models = claude_base();
    let mut discovered = false;
    for extra in claude_cache_for(state, read_json, home, env) {
        if models.iter().any(|row| row.id == extra.id) {
            continue;
        }
        models.push(extra);
        discovered = true;
    }
    ModelSheet {
        models: Some(models),
        models_source: Some(if discovered { ModelsSource::Discovered } else { ModelsSource::Static }),
        efforts: Some(claude_efforts()),
        model_flag: Some("--model".into()),
        named_custom_provider: None,
        effort_flag: Some("--effort".into()),
        launch_model: Some(true),
        launch_model_when_listed: None,
        effort_arg_values: None,
        effort_arg_prefix: None,
    }
}

pub fn grok_sheet(read_json: &mut Option<&mut dyn ReadJson>, home: &str) -> ModelSheet {
    let fallback = grok_fallback();
    let path = join_path(home, ".grok/models_cache.json");
    let Ok(raw) = call_json(read_json, &path) else {
        return fallback;
    };
    let Some(bag) = grok_models_bag(&raw) else {
        return fallback;
    };
    let mut models = Vec::new();
    for (id, entry) in bag {
        let Some(record) = entry.as_object() else {
            continue;
        };
        let info = record.get("info").and_then(Value::as_object).unwrap_or(record);
        if info.get("hidden") == Some(&Value::Bool(true)) || !model_token_ok(&id) {
            continue;
        }
        let label = name_or(info.get("name"), &id);
        let mut opt = ModelOption {
            id: id.clone(),
            label,
            default: None,
            efforts: None,
            input_modalities: None,
        };
        if info.get("supports_reasoning_effort") != Some(&Value::Bool(false))
            && let Some(raw_efforts) = info.get("reasoning_efforts").filter(|value| value.is_array()) {
                let efforts = sanitize_efforts(raw_efforts);
                if !efforts.is_empty() {
                    opt.efforts = Some(efforts);
                }
            }
        models.push(opt);
    }
    if models.is_empty() {
        return fallback;
    }
    models[0].default = Some(true);
    let efforts = models[0].efforts.clone();
    ModelSheet {
        models: Some(models),
        models_source: Some(ModelsSource::Discovered),
        efforts,
        model_flag: Some("--model".into()),
        named_custom_provider: None,
        effort_flag: Some("--reasoning-effort".into()),
        launch_model: None,
        launch_model_when_listed: None,
        effort_arg_values: None,
        effort_arg_prefix: None,
    }
}

pub fn parse_kimi_toml(text: &str) -> Vec<ModelOption> {
    let mut default_model = String::new();
    let mut aliases = Vec::new();
    let mut labels = HashMap::new();
    let mut seen = HashSet::new();
    let mut current: Option<String> = None;
    for raw_line in text.split('\n') {
        let line = strip_hash(raw_line.trim_end_matches('\r'));
        let line = jtrim(&line);
        if line.is_empty() {
            continue;
        }
        if let Some(found) = kimi_default(line) {
            default_model = found;
            continue;
        }
        if let Some(alias) = kimi_header(line) {
            if !alias.is_empty() && model_token_ok(&alias) {
                if seen.insert(alias.clone()) {
                    aliases.push(alias.clone());
                }
                current = Some(alias);
            } else {
                current = None;
            }
            continue;
        }
        if line.starts_with('[') {
            current = None;
            continue;
        }
        let Some(current_id) = current.clone() else {
            continue;
        };
        if let Some(label) = kimi_display(line)
            && !label.is_empty() {
                labels.insert(current_id, label);
            }
    }
    if !default_model.is_empty() && model_token_ok(&default_model) && seen.insert(default_model.clone()) {
        aliases.insert(0, default_model.clone());
    }
    aliases
        .into_iter()
        .map(|id| {
            let label = labels.get(&id).cloned().unwrap_or_else(|| id.clone());
            let default = (!default_model.is_empty() && id == default_model).then_some(true);
            ModelOption { id, label, default, efforts: None, input_modalities: None }
        })
        .collect()
}

pub fn kimi_sheet(read_text: &mut Option<&mut dyn ReadText>, home: &str) -> ModelSheet {
    let paths = [
        join_path(home, ".kimi/config.toml"),
        join_path(home, ".config/kimi/config.toml"),
        join_path(home, ".kimi-code/config.toml"),
    ];
    for path in paths {
        if let Ok(text) = call_text(read_text, &path) {
            let models = parse_kimi_toml(&text);
            return flag_sheet(models, "--model", None);
        }
    }
    flag_sheet(Vec::new(), "--model", None)
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HermesModelConfig {
    pub default: Option<String>,
    pub provider: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
}

pub fn parse_hermes_model_config(text: &str) -> HermesModelConfig {
    let lines: Vec<&str> = text.split('\n').map(|line| line.trim_end_matches('\r')).collect();
    let Some(start) = lines.iter().position(|line| model_re_line(line)) else {
        return HermesModelConfig::default();
    };
    let inline = yaml_scalar(&lines[start]["model:".len()..]);
    if !inline.is_empty() {
        return HermesModelConfig { default: Some(inline), ..HermesModelConfig::default() };
    }
    let mut out = HermesModelConfig::default();
    let mut indent: Option<usize> = None;
    for line in lines.iter().skip(start + 1) {
        if jtrim(line).is_empty() || jtrim(line).starts_with('#') {
            continue;
        }
        let lead = line.len() - line.trim_start().len();
        if lead == 0 {
            break;
        }
        if indent.is_none() {
            indent = Some(lead);
        }
        if Some(lead) != indent {
            continue;
        }
        let Some((key, raw)) = yaml_key(line) else {
            continue;
        };
        let value = yaml_scalar(raw);
        if value.is_empty() {
            continue;
        }
        match key {
            "default" => out.default = Some(value),
            "provider" => out.provider = Some(value),
            "base_url" => out.base_url = Some(value),
            "api_key" => out.api_key = Some(value),
            _ => {}
        }
    }
    out
}

pub fn hermes_sheet(
    state: &mut SheetState,
    read_text: &mut Option<&mut dyn ReadText>,
    home: &str,
    fetch_ids: &mut Option<&mut dyn FetchSheet>,
    now: i64,
    log: &mut Option<&mut dyn FnMut(&str)>,
) -> ModelSheet {
    let config = call_text(read_text, &join_path(home, ".hermes/config.yaml"))
        .map(|text| parse_hermes_model_config(&text))
        .unwrap_or_default();
    let mut ids = Vec::new();
    let default_id = config.default.filter(|id| model_token_ok(id));
    if let Some(id) = &default_id {
        ids.push(id.clone());
    }
    if let Some(base) = config.base_url.as_deref().filter(|url| http_base(url)) {
        let fetched = hermes_endpoint(state, base, config.api_key.as_deref(), fetch_ids, now, log);
        for id in fetched {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    let models: Vec<ModelOption> = ids
        .into_iter()
        .map(|id| ModelOption {
            default: (Some(id.as_str()) == default_id.as_deref()).then_some(true),
            label: id.clone(),
            id,
            efforts: None,
            input_modalities: None,
        })
        .collect();
    let source = hermes_sheet_source(&models);
    ModelSheet {
        models: Some(models),
        models_source: Some(source),
        efforts: Some(hermes_efforts()),
        model_flag: Some("-m".into()),
        named_custom_provider: Some(true),
        effort_flag: Some("--reasoning".into()),
        launch_model: Some(true),
        launch_model_when_listed: None,
        effort_arg_values: None,
        effort_arg_prefix: None,
    }
}

pub fn codex_home(home: &str, env: Option<&HashMap<String, String>>) -> String {
    env_trimmed(env, "CODEX_HOME").unwrap_or_else(|| join_path(home, ".codex"))
}

pub fn parse_codex_catalog(raw: &Value) -> Vec<ModelOption> {
    let Some(models) = raw.as_object().and_then(|obj| obj.get("models")).and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    let mut seen = HashSet::new();
    for entry in models {
        let Some(record) = entry.as_object() else {
            continue;
        };
        let Some(id_raw) = record.get("slug").and_then(Value::as_str) else {
            continue;
        };
        let id = jtrim(id_raw);
        if !model_token_ok(id) || !seen.insert(id.to_string()) {
            continue;
        }
        if let Some(visibility) = record.get("visibility")
            && visibility.as_str() != Some("list") {
                continue;
            }
        let label = name_or(record.get("display_name"), id);
        let mut opt = ModelOption {
            id: id.to_string(),
            label,
            default: None,
            efforts: None,
            input_modalities: None,
        };
        attach_codex_efforts(&mut opt, record);
        if let Some(mods) = record.get("input_modalities").and_then(Value::as_array) {
            let modalities: Vec<String> = mods.iter().filter_map(|item| item.as_str().map(str::to_string)).collect();
            if !modalities.is_empty() {
                opt.input_modalities = Some(modalities);
            }
        }
        let priority = record.get("priority").and_then(Value::as_f64).unwrap_or(f64::INFINITY);
        rows.push((priority, opt));
    }
    rows.sort_by(|a, b| a.0.total_cmp(&b.0));
    rows.into_iter().map(|(_, opt)| opt).collect()
}

pub fn parse_codex_config_model(text: &str) -> Option<String> {
    for line in text.split('\n') {
        let trimmed = jtrim(line);
        if trimmed.starts_with('[') {
            break;
        }
        if let Some(found) = codex_model_line(trimmed) {
            return Some(found);
        }
    }
    None
}

pub fn codex_sheet(state: &mut SheetState, deps: &mut CodexDeps<'_>) -> ModelSheet {
    let root = codex_home(deps.home, deps.env);
    let base = codex_base();
    let key = format!("codex:debug-models:{root}");
    let env = discovery_env(deps.env, deps.home);
    let listed = {
        let run_command = &mut *deps.run_command;
        let log = &mut *deps.log;
        discover_models(state, &key, deps.now, 5 * 60_000, Some(6_000), log, || match call_run(run_command, &env, 5_000) {
            DiscoveryRun::Hung => DiscoveryRun::Hung,
            DiscoveryRun::Ready(Err(err)) => DiscoveryRun::Ready(Err(err)),
            DiscoveryRun::Ready(Ok(out)) => {
                let raw = serde_json::from_str::<Value>(&out).unwrap_or(Value::Null);
                let rows = parse_codex_catalog(&raw);
                if rows.is_empty() {
                    DiscoveryRun::Ready(Err("codex debug models returned no listed models".into()))
                } else {
                    DiscoveryRun::Ready(Ok(rows))
                }
            }
        })
    };
    let mut models = Vec::new();
    if let Some(rows) = listed {
        push_unique(&mut models, rows);
    } else {
        let path = join_path(&root, "models_cache.json");
        push_unique(&mut models, file_rows(state, deps.read_json, &path, parse_codex_catalog));
    }
    let configured = call_text(deps.read_text, &join_path(&root, "config.toml")).ok().and_then(|text| parse_codex_config_model(&text));
    if let Some(id) = configured.clone()
        && model_token_ok(&id) && models.iter().all(|row| row.id != id) {
            models.push(model_row(id));
        }
    finish_codex(base, models, configured)
}

pub fn parse_opencode_config(raw: &Value) -> Vec<ModelOption> {
    let Some(record) = raw.as_object() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let default_model = record.get("model").and_then(Value::as_str).map(|text| jtrim(text).to_string()).unwrap_or_default();
    if !default_model.is_empty() {
        push_opencode(&mut out, &mut seen, &default_model, true);
    }
    let Some(provider) = record.get("provider").and_then(Value::as_object) else {
        return out;
    };
    for (provider_id, prov) in provider {
        let Some(prov) = prov.as_object() else {
            continue;
        };
        let Some(models) = prov.get("models") else {
            continue;
        };
        if let Some(map) = models.as_object() {
            for model_id in map.keys() {
                push_opencode(&mut out, &mut seen, &format!("{provider_id}/{model_id}"), format!("{provider_id}/{model_id}") == default_model);
            }
        } else if let Some(list) = models.as_array() {
            for model_id in list.iter().filter_map(Value::as_str) {
                push_opencode(&mut out, &mut seen, &format!("{provider_id}/{model_id}"), format!("{provider_id}/{model_id}") == default_model);
            }
        }
    }
    out
}

pub fn opencode_sheet(
    read_json: &mut Option<&mut dyn ReadJson>,
    home: &str,
    env: Option<&HashMap<String, String>>,
) -> ModelSheet {
    let config_root = env_trimmed(env, "XDG_CONFIG_HOME").unwrap_or_else(|| join_path(home, ".config"));
    let paths = [join_path(&config_root, "opencode/opencode.json"), join_path(&config_root, "opencode/opencode.jsonc")];
    for path in paths {
        if let Ok(raw) = call_json(read_json, &path) {
            let models = parse_opencode_config(&raw);
            return opencode_flags(models);
        }
    }
    opencode_flags(Vec::new())
}

pub fn pi_sheet(read_json: &mut Option<&mut dyn ReadJson>, home: &str) -> ModelSheet {
    let agent = join_path(home, ".pi/agent");
    let mut default_id = "deepseek/deepseek-v4-flash".to_string();
    if let Ok(settings) = call_json(read_json, &join_path(&agent, "settings.json"))
        && let Some(record) = settings.as_object() {
            let provider = record.get("defaultProvider").and_then(Value::as_str).map(|text| jtrim(text).to_string()).unwrap_or_default();
            let model = record.get("defaultModel").and_then(Value::as_str).map(|text| jtrim(text).to_string()).unwrap_or_default();
            if !provider.is_empty() && !model.is_empty() {
                default_id = format!("{provider}/{model}");
            } else if model.contains('/') || !model.is_empty() {
                default_id = model;
            }
        }
    let from_store = pi_models_from_store(read_json, &join_path(&agent, "models-store.json"));
    let discovered = !from_store.is_empty();
    let mut models = if from_store.is_empty() {
        if model_token_ok(&default_id) {
            vec![ModelOption {
                id: default_id.clone(),
                label: default_id.clone(),
                default: Some(true),
                efforts: Some(pi_efforts()),
                input_modalities: None,
            }]
        } else {
            Vec::new()
        }
    } else {
        from_store
    };
    mark_pi_default(&mut models, &default_id);
    for row in &mut models {
        if row.efforts.is_none() {
            row.efforts = Some(pi_efforts());
        }
    }
    ModelSheet {
        models_source: Some(if discovered { ModelsSource::Discovered } else { ModelsSource::Static }),
        models: Some(models),
        efforts: Some(pi_efforts()),
        model_flag: Some("--model".into()),
        named_custom_provider: None,
        effort_flag: Some("--thinking".into()),
        launch_model: None,
        launch_model_when_listed: None,
        effort_arg_values: None,
        effort_arg_prefix: None,
    }
}

pub fn qwen_sheet(read_json: &mut Option<&mut dyn ReadJson>, home: &str) -> ModelSheet {
    let empty = ModelSheet {
        models: Some(Vec::new()),
        models_source: Some(ModelsSource::Static),
        efforts: None,
        model_flag: Some("-m".into()),
        named_custom_provider: None,
        effort_flag: None,
        launch_model: None,
        launch_model_when_listed: None,
        effort_arg_values: None,
        effort_arg_prefix: None,
    };
    let Ok(raw) = call_json(read_json, &join_path(home, ".qwen/settings.json")) else {
        return empty;
    };
    let Some(record) = raw.as_object() else {
        return empty;
    };
    let Some(providers) = record.get("modelProviders").and_then(Value::as_object) else {
        return empty;
    };
    let default_id = record
        .get("model")
        .and_then(Value::as_object)
        .and_then(|model| model.get("name"))
        .and_then(Value::as_str)
        .map(|text| jtrim(text).to_string())
        .unwrap_or_default();
    let mut models = Vec::new();
    let mut seen = HashSet::new();
    for entries in providers.values() {
        let Some(entries) = entries.as_array() else {
            continue;
        };
        for entry in entries {
            push_qwen(&mut models, &mut seen, entry, &default_id);
        }
    }
    if model_token_ok(&default_id)
        && let Some(index) = models.iter().position(|row| row.id == default_id) {
            for row in &mut models {
                row.default = None;
            }
            models[index].default = Some(true);
        }
    ModelSheet {
        models_source: Some(if models.is_empty() { ModelsSource::Static } else { ModelsSource::Discovered }),
        models: Some(models),
        ..empty
    }
}

pub fn cursor_sheet() -> ModelSheet {
    ModelSheet {
        model_flag: Some("--model".into()),
        models: Some(Vec::new()),
        models_source: Some(ModelsSource::Static),
        efforts: None,
        named_custom_provider: None,
        effort_flag: None,
        launch_model: None,
        launch_model_when_listed: None,
        effort_arg_values: None,
        effort_arg_prefix: None,
    }
}

pub fn cowork_sheet() -> ModelSheet {
    ModelSheet {
        models: Some(Vec::new()),
        models_source: Some(ModelsSource::Static),
        efforts: None,
        model_flag: None,
        named_custom_provider: None,
        effort_flag: None,
        launch_model: None,
        launch_model_when_listed: None,
        effort_arg_values: None,
        effort_arg_prefix: None,
    }
}

pub fn sheet_for_harness<'a>(state: &mut SheetState, harness: &str, input: &'a mut SheetInput<'a>) -> ModelSheet {
    match harness {
        "claude-code" => claude_sheet(state, &mut input.read_json, input.home, None),
        "grok-build" => grok_sheet(&mut input.read_json, input.home),
        "kimi-code" => kimi_sheet(&mut input.read_text, input.home),
        "hermes" => hermes_sheet(state, &mut input.read_text, input.home, &mut input.fetch_ids, input.now, &mut input.log),
        "codex" => codex_sheet(state, &mut codex_deps(input)),
        "opencode" => opencode_sheet(&mut input.read_json, input.home, None),
        "pi" => pi_sheet(&mut input.read_json, input.home),
        "qwen-code" => qwen_sheet(&mut input.read_json, input.home),
        "cursor" => cursor_sheet(),
        "cowork" => cowork_sheet(),
        _ => cowork_sheet(),
    }
}

pub fn sheet_for_roster_command<'a>(
    state: &mut SheetState,
    command: &str,
    overrides: &HashMap<String, SheetOverride>,
    input: &'a mut SheetInput<'a>,
) -> Option<ModelSheet> {
    let harness = crate::turn::roster_to_harness(command)?;
    let sheet = sheet_for_harness(state, harness, input);
    Some(apply_sheet_override(sheet, overrides.get(harness), None))
}

pub fn preset_model_list(state: &mut SheetState, harness: &str, override_: Option<&SheetOverride>, home: &str) -> PresetList {
    let mut input = SheetInput {
        home,
        env: None,
        now: 0,
        read_json: None,
        read_text: None,
        run_command: None,
        fetch_ids: None,
        log: None,
    };
    let sheet = apply_sheet_override(sheet_for_harness(state, harness, &mut input), override_, None);
    PresetList {
        ids: sheet.models.unwrap_or_default().into_iter().map(|row| row.id).collect(),
        strict: sheet.models_source == Some(ModelsSource::Config),
        source: sheet.models_source.unwrap_or(ModelsSource::Static),
    }
}

pub fn is_codex_default_model(harness: Option<&str>, model: Option<&str>) -> bool {
    harness == Some("codex") && model == Some(CODEX_DEFAULT_MODEL)
}

pub fn append_model_effort_argv(
    argv: &[String],
    sheet: Option<&ModelSheet>,
    mut model: Option<&str>,
    effort: Option<&str>,
    mut log: Option<&mut dyn FnMut(&str)>,
    harness: Option<&str>,
) -> Vec<String> {
    let Some(sheet) = sheet else {
        return argv.to_vec();
    };
    let mut out = argv.to_vec();
    let where_ = harness.map(|name| format!(" for {name}")).unwrap_or_default();
    if is_codex_default_model(harness, model) {
        model = None;
    }
    let model_ok = model.is_some_and(|id| {
        model_token_ok(id) && sheet.model_flag.is_some() && sheet.models.as_ref().is_some_and(|rows| rows.iter().any(|row| row.id == id))
    });
    if model_ok {
        if let Some(id) = model {
            push_model_arg(&mut out, sheet, id);
        }
    } else if let Some(id) = model
        && let Some(log) = log.as_mut() {
            let why = if sheet.model_flag.is_some() {
                format!(
                    "not on the {} model list — the harness will run its own default",
                    sheet.models_source.map(ModelsSource::as_str).unwrap_or("resolved")
                )
            } else {
                "the harness takes no model flag".into()
            };
            let shown = protocol::js::stringify(&Value::String(id.to_string()));
            log(&format!("[den-server] spawn: omitting model {shown}{where_} ({why})"));
        }
    let effort_ids = effort_ids_for(sheet, if model_ok { model } else { None });
    let effort_ok = effort.is_some_and(|id| effort_token_ok(id) && sheet.effort_flag.is_some() && effort_ids.iter().any(|row| row == id));
    if effort_ok {
        if let Some(id) = effort {
            push_effort_arg(&mut out, sheet, id);
        }
    } else if let Some(id) = effort
        && let Some(log) = log.as_mut() {
            let shown = protocol::js::stringify(&Value::String(id.to_string()));
            log(&format!("[den-server] spawn: omitting effort {shown}{where_} (unknown or no flag)"));
        }
    out
}

pub fn background_discovery_number(
    state: &mut SheetState,
    key: &str,
    run: impl FnOnce() -> DiscoveryRun<i64>,
    ttl_ms: i64,
    now: i64,
    timeout_ms: Option<i64>,
    log: Option<&mut dyn FnMut(&str)>,
) -> Option<i64> {
    discover(
        state,
        DiscoverArgs { key, now, ttl_ms, timeout_ms, log },
        |value| match value {
            Cached::Number(number) => Some(*number),
            _ => None,
        },
        run,
        Cached::Number,
    )
}

pub fn settle_timeouts(state: &mut SheetState, now: i64) {
    let keys: Vec<String> = state.discovery.keys().cloned().collect();
    for key in keys {
        settle_one(state, &key, now);
    }
}

fn finish_codex(base: ModelSheet, mut models: Vec<ModelOption>, configured: Option<String>) -> ModelSheet {
    if models.is_empty() {
        return base;
    }
    for row in &mut models {
        row.default = None;
    }
    let mark = configured
        .as_ref()
        .and_then(|id| models.iter().position(|row| row.id == *id))
        .unwrap_or(0);
    models[mark].default = Some(true);
    ModelSheet {
        models: Some(models),
        models_source: Some(ModelsSource::Discovered),
        launch_model: Some(true),
        ..base
    }
}

fn codex_deps<'a>(input: &'a mut SheetInput<'a>) -> CodexDeps<'a> {
    CodexDeps {
        home: input.home,
        env: input.env,
        now: input.now,
        read_json: &mut input.read_json,
        read_text: &mut input.read_text,
        run_command: &mut input.run_command,
        log: &mut input.log,
    }
}

fn hermes_endpoint(
    state: &mut SheetState,
    base: &str,
    api_key: Option<&str>,
    fetch_ids: &mut Option<&mut dyn FetchSheet>,
    now: i64,
    log: &mut Option<&mut dyn FnMut(&str)>,
) -> Vec<String> {
    let key = format!("hermes:{base}");
    discover_strings(state, &key, now, 60_000, Some(3_000), log, || match call_fetch(fetch_ids, base, api_key) {
        DiscoveryRun::Hung => DiscoveryRun::Hung,
        DiscoveryRun::Ready(Err(err)) => DiscoveryRun::Ready(Err(err)),
        DiscoveryRun::Ready(Ok(ids)) => DiscoveryRun::Ready(Ok(ids.into_iter().filter(|id| model_token_ok(id)).collect())),
    })
    .unwrap_or_default()
}

fn discover_models(
    state: &mut SheetState,
    key: &str,
    now: i64,
    ttl_ms: i64,
    timeout_ms: Option<i64>,
    log: &mut Option<&mut dyn FnMut(&str)>,
    run: impl FnOnce() -> DiscoveryRun<Vec<ModelOption>>,
) -> Option<Vec<ModelOption>> {
    let log_fn = log.as_mut().map(|log| log as &mut dyn FnMut(&str));
    discover(
        state,
        DiscoverArgs { key, now, ttl_ms, timeout_ms, log: log_fn },
        |value| match value {
            Cached::Models(rows) => Some(rows.clone()),
            _ => None,
        },
        run,
        Cached::Models,
    )
}

fn discover_strings(
    state: &mut SheetState,
    key: &str,
    now: i64,
    ttl_ms: i64,
    timeout_ms: Option<i64>,
    log: &mut Option<&mut dyn FnMut(&str)>,
    run: impl FnOnce() -> DiscoveryRun<Vec<String>>,
) -> Option<Vec<String>> {
    let log_fn = log.as_mut().map(|log| log as &mut dyn FnMut(&str));
    discover(
        state,
        DiscoverArgs { key, now, ttl_ms, timeout_ms, log: log_fn },
        |value| match value {
            Cached::Strings(rows) => Some(rows.clone()),
            _ => None,
        },
        run,
        Cached::Strings,
    )
}

struct DiscoverArgs<'a, 'b> {
    key: &'a str,
    now: i64,
    ttl_ms: i64,
    timeout_ms: Option<i64>,
    log: Option<&'b mut dyn FnMut(&str)>,
}

fn discover<T>(
    state: &mut SheetState,
    mut req: DiscoverArgs<'_, '_>,
    project: impl Fn(&Cached) -> Option<T>,
    run: impl FnOnce() -> DiscoveryRun<T>,
    wrap: impl FnOnce(T) -> Cached,
) -> Option<T> {
    state.discovery.entry(req.key.to_string()).or_insert_with(Slot::fresh);
    settle_one(state, req.key, req.now);
    flush_pending(state, &mut req.log);
    let previous = state.discovery.get(req.key).and_then(|slot| slot.value.as_ref()).and_then(&project);
    let due = state.discovery.get(req.key).is_some_and(|slot| {
        slot.hung.is_none() && slot.at.is_none_or(|at| req.now.saturating_sub(at) >= req.ttl_ms)
    });
    if !due {
        return previous;
    }
    let wants_log = req.log.is_some();
    match run() {
        DiscoveryRun::Ready(Ok(value)) => {
            if let Some(slot) = state.discovery.get_mut(req.key) {
                slot.value = Some(wrap(value));
                slot.failing = false;
                slot.at = Some(req.now);
            }
        }
        DiscoveryRun::Ready(Err(err)) => note_failure(state, req.key, req.now, &err, &mut req.log),
        DiscoveryRun::Hung => {
            if let Some(slot) = state.discovery.get_mut(req.key) {
                slot.hung = Some(Hung {
                    timeout_ms: req.timeout_ms.unwrap_or(i64::MAX),
                    started_now: req.now,
                    wants_log,
                });
            }
        }
    }
    previous
}

fn settle_one(state: &mut SheetState, key: &str, now: i64) {
    let Some(hung) = state.discovery.get(key).and_then(|slot| slot.hung.as_ref()).map(|hung| (hung.timeout_ms, hung.started_now, hung.wants_log)) else {
        return;
    };
    if hung.0 == i64::MAX || now < hung.1.saturating_add(hung.0) {
        return;
    }
    let msg = format!("timed out after {} ms", hung.0);
    if let Some(slot) = state.discovery.get_mut(key) {
        slot.hung = None;
        slot.at = Some(hung.1);
        if hung.2 {
            if !slot.failing {
                let kept = if slot.value.is_none() { "static sheet" } else { "last-known list" };
                state.pending_logs.push(format!("[den-server] model discovery {key}: {msg} — serving the {kept}"));
            }
            slot.failing = true;
        }
    }
}

fn flush_pending(state: &mut SheetState, log: &mut Option<&mut dyn FnMut(&str)>) {
    if log.is_none() {
        return;
    }
    let lines = std::mem::take(&mut state.pending_logs);
    if let Some(log) = log {
        for line in lines {
            log(&line);
        }
    }
}

fn note_failure(state: &mut SheetState, key: &str, now: i64, msg: &str, log: &mut Option<&mut dyn FnMut(&str)>) {
    let Some(slot) = state.discovery.get_mut(key) else {
        return;
    };
    if let Some(log) = log {
        if !slot.failing {
            let kept = if slot.value.is_none() { "static sheet" } else { "last-known list" };
            log(&format!("[den-server] model discovery {key}: {msg} — serving the {kept}"));
        }
        slot.failing = true;
    }
    slot.at = Some(now);
}

fn file_rows(
    state: &mut SheetState,
    read_json: &mut Option<&mut dyn ReadJson>,
    path: &str,
    parse: fn(&Value) -> Vec<ModelOption>,
) -> Vec<ModelOption> {
    if read_json.is_some() {
        return call_json(read_json, path).map(|raw| parse(&raw)).unwrap_or_default();
    }
    let Some(stamp) = fsutil::file_stamp(Path::new(path)) else {
        state.file_memo.remove(path);
        return Vec::new();
    };
    if let Some(memo) = state.file_memo.get(path)
        && memo.mtime_ms == stamp.mtime_ms && memo.size == stamp.size {
            return memo.models.clone();
        }
    let rows = read_json_file(path).map(|raw| parse(&raw)).unwrap_or_default();
    state.file_memo.insert(path.to_string(), memo_of(&stamp, rows.clone()));
    rows
}

fn claude_cache_for(
    state: &mut SheetState,
    read_json: &mut Option<&mut dyn ReadJson>,
    home: &str,
    env: Option<&HashMap<String, String>>,
) -> Vec<ModelOption> {
    if read_json.is_some() {
        return claude_cache_models(read_json, home, env);
    }
    let path = claude_global_config_path(home, env);
    let Some(stamp) = fsutil::file_stamp(Path::new(&path)) else {
        state.claude_memo.remove(&path);
        return Vec::new();
    };
    if let Some(memo) = state.claude_memo.get(&path)
        && memo.mtime_ms == stamp.mtime_ms && memo.size == stamp.size {
            return memo.models.clone();
        }
    let mut none = None;
    let models = claude_cache_models(&mut none, home, env);
    state.claude_memo.insert(path, memo_of(&stamp, models.clone()));
    models
}

fn claude_cache_models(
    read_json: &mut Option<&mut dyn ReadJson>,
    home: &str,
    env: Option<&HashMap<String, String>>,
) -> Vec<ModelOption> {
    let Ok(raw) = call_json(read_json, &claude_global_config_path(home, env)) else {
        return Vec::new();
    };
    let Some(entries) = raw.as_object().and_then(|obj| obj.get("additionalModelOptionsCache")).and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for entry in entries {
        let Some(record) = entry.as_object() else {
            continue;
        };
        if record.get("disabled") == Some(&Value::Bool(true)) {
            continue;
        }
        let Some(id_raw) = record.get("value").and_then(Value::as_str) else {
            continue;
        };
        let id = jtrim(id_raw);
        if !model_token_ok(id) || !seen.insert(id.to_string()) {
            continue;
        }
        out.push(ModelOption {
            id: id.to_string(),
            label: label_or(record.get("label"), id),
            default: None,
            efforts: None,
            input_modalities: None,
        });
    }
    out
}

fn with_launch_model(mut sheet: ModelSheet, base: &ModelSheet) -> ModelSheet {
    if sheet.launch_model_when_listed != Some(true) || sheet.models.as_ref().is_none_or(|rows| rows.is_empty()) {
        return sheet;
    }
    let settled = sheet.models_source == Some(ModelsSource::Config)
        || sheet.models_source == Some(ModelsSource::Discovered)
        || (sheet.models_source == Some(ModelsSource::Merged) && base.models_source == Some(ModelsSource::Discovered));
    if settled {
        sheet.launch_model = Some(true);
    }
    sheet
}

fn apply_model_list(
    next: &mut ModelSheet,
    sheet: &ModelSheet,
    override_: &SheetOverride,
    mode: &str,
    log: &mut Option<&mut dyn FnMut(&str)>,
) {
    let Some(raw) = override_.models.as_ref().filter(|value| value.is_array()) else {
        return;
    };
    let models = sanitize_models(raw);
    if models.is_empty() {
        if let Some(log) = log.as_mut() {
            log("[den-server] harness sheet: ignoring empty models override (keeping sheet list)");
        }
        return;
    }
    if mode == "replace" {
        next.models = Some(models);
        next.models_source = Some(ModelsSource::Config);
    } else {
        next.models = Some(merge_models(sheet.models.clone().unwrap_or_default(), models));
        next.models_source = Some(ModelsSource::Merged);
    }
}

fn apply_effort_list(next: &mut ModelSheet, override_: &SheetOverride, mode: &str, log: &mut Option<&mut dyn FnMut(&str)>) {
    let Some(raw) = override_.efforts.as_ref().filter(|value| value.is_array()) else {
        return;
    };
    let efforts = sanitize_efforts(raw);
    if efforts.is_empty() {
        if let Some(log) = log.as_mut() {
            log("[den-server] harness sheet: ignoring empty efforts override (keeping sheet list)");
        }
        return;
    }
    if mode == "replace" {
        next.efforts = Some(efforts);
    } else {
        next.efforts = Some(merge_efforts(next.efforts.clone().unwrap_or_default(), efforts));
    }
}

fn merge_models(mut discovered: Vec<ModelOption>, config: Vec<ModelOption>) -> Vec<ModelOption> {
    for row in config.iter().cloned() {
        if let Some(index) = discovered.iter().position(|item| item.id == row.id) {
            let mut merged = discovered[index].clone();
            merged.label = row.label.clone();
            if row.default.is_some() {
                merged.default = row.default;
            }
            if row.efforts.is_some() {
                merged.efforts = row.efforts.clone();
            }
            discovered[index] = merged;
        } else {
            discovered.push(row);
        }
    }
    if config.iter().any(|row| row.default == Some(true)) {
        for row in &mut discovered {
            let keep = config.iter().any(|item| item.id == row.id && item.default == Some(true));
            if !keep {
                row.default = None;
            }
        }
    }
    discovered
}

fn merge_efforts(mut discovered: Vec<EffortOption>, config: Vec<EffortOption>) -> Vec<EffortOption> {
    for row in config.iter().cloned() {
        if let Some(index) = discovered.iter().position(|item| item.id == row.id) {
            discovered[index].label = row.label.clone();
            if row.default.is_some() {
                discovered[index].default = row.default;
            }
        } else {
            discovered.push(row);
        }
    }
    if config.iter().any(|row| row.default == Some(true)) {
        for row in &mut discovered {
            let keep = config.iter().any(|item| item.id == row.id && item.default == Some(true));
            if !keep {
                row.default = None;
            }
        }
    }
    discovered
}

fn push_model_arg(out: &mut Vec<String>, sheet: &ModelSheet, model: &str) {
    let Some(flag) = sheet.model_flag.clone() else {
        return;
    };
    if sheet.named_custom_provider == Some(true)
        && let Some((provider, rest)) = hermes_named(model) {
            out.push("--provider".into());
            out.push(provider);
            out.push(flag);
            out.push(rest);
            return;
        }
    out.push(flag);
    out.push(model.to_string());
}

fn push_effort_arg(out: &mut Vec<String>, sheet: &ModelSheet, effort: &str) {
    let Some(flag) = sheet.effort_flag.clone() else {
        return;
    };
    let mapped = sheet
        .effort_arg_values
        .as_ref()
        .and_then(|map| map.get(effort).cloned())
        .unwrap_or_else(|| effort.to_string());
    if mapped.is_empty() {
        return;
    }
    let prefix = sheet.effort_arg_prefix.clone().unwrap_or_default();
    out.push(flag);
    out.push(format!("{prefix}{mapped}"));
}

fn effort_ids_for(sheet: &ModelSheet, model_id: Option<&str>) -> Vec<String> {
    let model = if let Some(id) = model_id {
        sheet.models.as_ref().and_then(|rows| rows.iter().find(|row| row.id == id))
    } else {
        sheet.models.as_ref().and_then(|rows| rows.iter().find(|row| row.default == Some(true)))
    };
    let efforts = model.and_then(|row| row.efforts.as_ref()).or(sheet.efforts.as_ref());
    efforts.map(|rows| rows.iter().map(|row| row.id.clone()).collect()).unwrap_or_default()
}

fn push_unique(models: &mut Vec<ModelOption>, rows: Vec<ModelOption>) {
    for row in rows {
        if models.iter().any(|item| item.id == row.id) {
            continue;
        }
        models.push(ModelOption { efforts: row.efforts.clone(), ..row });
    }
}

fn grok_models_bag(raw: &Value) -> Option<Map<String, Value>> {
    let record = raw.as_object()?;
    if let Some(models) = record.get("models").and_then(Value::as_object) {
        return Some(models.clone());
    }
    let values: Vec<&Value> = record.values().collect();
    if !values.is_empty() && values.iter().all(|value| value.as_object().is_some_and(|row| row.get("info").and_then(Value::as_object).is_some() || row.contains_key("name"))) {
        return Some(record.clone());
    }
    None
}

fn attach_codex_efforts(opt: &mut ModelOption, record: &Map<String, Value>) {
    let default_effort = record.get("default_reasoning_level").and_then(Value::as_str).map(|text| jtrim(text).to_string()).unwrap_or_default();
    let Some(levels) = record.get("supported_reasoning_levels").and_then(Value::as_array) else {
        return;
    };
    let mut efforts = Vec::new();
    for level in levels {
        let effort = if let Some(record) = level.as_object() {
            record.get("effort").and_then(Value::as_str).map(|text| jtrim(text).to_string()).unwrap_or_default()
        } else {
            level.as_str().map(|text| jtrim(text).to_string()).unwrap_or_default()
        };
        if !effort_token_ok(&effort) || efforts.iter().any(|row: &EffortOption| row.id == effort) {
            continue;
        }
        efforts.push(EffortOption {
            id: effort.clone(),
            label: codex_effort_label(&effort),
            default: (effort == default_effort).then_some(true),
        });
    }
    if !efforts.is_empty() {
        opt.efforts = Some(efforts);
    }
}

fn pi_models_from_store(read_json: &mut Option<&mut dyn ReadJson>, path: &str) -> Vec<ModelOption> {
    let Ok(raw) = call_json(read_json, path) else {
        return Vec::new();
    };
    let mut items = Vec::new();
    if let Some(list) = raw.as_array() {
        items.extend(list.iter().cloned());
    } else if let Some(record) = raw.as_object() {
        if let Some(list) = record.get("models").and_then(Value::as_array) {
            items.extend(list.iter().cloned());
        } else {
            for (id, entry) in record {
                if id == "models" || id == "version" {
                    continue;
                }
                if let Some(mut obj) = entry.as_object().cloned() {
                    obj.entry("id").or_insert_with(|| Value::String(id.clone()));
                    items.push(Value::Object(obj));
                } else {
                    items.push(serde_json::json!({ "id": id }));
                }
            }
        }
    }
    items.iter().filter_map(pi_model_entry).collect()
}

fn pi_model_entry(entry: &Value) -> Option<ModelOption> {
    if let Some(text) = entry.as_str() {
        return model_token_ok(text).then(|| model_row(text.to_string()));
    }
    let record = entry.as_object()?;
    let provider = record.get("provider").or_else(|| record.get("providerID")).and_then(Value::as_str).unwrap_or("");
    let model_id = record.get("modelId").or_else(|| record.get("model")).and_then(Value::as_str).unwrap_or("");
    let raw_id = record.get("id").and_then(Value::as_str).map(|text| jtrim(text).to_string()).unwrap_or_default();
    let id = if raw_id.contains('/') {
        raw_id
    } else if !provider.is_empty() && !model_id.is_empty() {
        format!("{provider}/{model_id}")
    } else if !raw_id.is_empty() {
        raw_id
    } else {
        model_id.to_string()
    };
    if id.is_empty() || !model_token_ok(&id) {
        return None;
    }
    let label = record
        .get("name")
        .and_then(Value::as_str)
        .map(jtrim)
        .filter(|text| !text.is_empty())
        .or_else(|| record.get("label").and_then(Value::as_str).map(jtrim).filter(|text| !text.is_empty()))
        .unwrap_or(id.as_str())
        .to_string();
    Some(ModelOption { id, label, default: None, efforts: None, input_modalities: None })
}

fn mark_pi_default(models: &mut [ModelOption], default_id: &str) {
    if let Some(index) = models.iter().position(|row| row.id == default_id) {
        for row in models.iter_mut() {
            row.default = None;
        }
        models[index].default = Some(true);
    } else if let Some(first) = models.first_mut() {
        first.default = Some(true);
    }
}

fn push_qwen(models: &mut Vec<ModelOption>, seen: &mut HashSet<String>, entry: &Value, default_id: &str) {
    let Some(record) = entry.as_object() else {
        return;
    };
    let Some(id_raw) = record.get("id").and_then(Value::as_str) else {
        return;
    };
    let id = jtrim(id_raw);
    if id.is_empty() || !model_token_ok(id) || !seen.insert(id.to_string()) {
        return;
    }
    let mut opt = ModelOption {
        id: id.to_string(),
        label: name_or(record.get("name"), id),
        default: (default_id == id).then_some(true),
        efforts: qwen_efforts(record.get("capabilities")),
        input_modalities: None,
    };
    if default_id.is_empty() {
        opt.default = None;
    }
    models.push(opt);
}

fn qwen_efforts(raw: Option<&Value>) -> Option<Vec<EffortOption>> {
    let reasoning = raw?.as_object()?.get("reasoning")?.as_object()?;
    let tokens = reasoning.get("efforts")?.as_array()?;
    let default_effort = reasoning.get("defaultEffort").and_then(Value::as_str).map(|text| jtrim(text).to_string()).unwrap_or_default();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for token in tokens {
        let Some(id) = token.as_str().map(|text| jtrim(text).to_string()) else {
            continue;
        };
        let Some(label) = qwen_label(&id) else {
            continue;
        };
        if !seen.insert(id.clone()) {
            continue;
        }
        out.push(EffortOption { id: id.clone(), label, default: (!default_effort.is_empty() && id == default_effort).then_some(true) });
    }
    (!out.is_empty()).then_some(out)
}

fn push_opencode(out: &mut Vec<ModelOption>, seen: &mut HashSet<String>, id: &str, is_default: bool) {
    let trimmed = jtrim(id);
    if trimmed.is_empty() || !model_token_ok(trimmed) || !seen.insert(trimmed.to_string()) {
        return;
    }
    out.push(ModelOption {
        id: trimmed.to_string(),
        label: trimmed.to_string(),
        default: is_default.then_some(true),
        efforts: None,
        input_modalities: None,
    });
}

fn flag_sheet(models: Vec<ModelOption>, model_flag: &str, effort_flag: Option<&str>) -> ModelSheet {
    ModelSheet {
        models_source: Some(if models.is_empty() { ModelsSource::Static } else { ModelsSource::Discovered }),
        models: Some(models),
        efforts: None,
        model_flag: Some(model_flag.into()),
        named_custom_provider: None,
        effort_flag: effort_flag.map(str::to_string),
        launch_model: None,
        launch_model_when_listed: None,
        effort_arg_values: None,
        effort_arg_prefix: None,
    }
}

fn hermes_sheet_source(models: &[ModelOption]) -> ModelsSource {
    if models.is_empty() { ModelsSource::Static } else { ModelsSource::Discovered }
}

fn opencode_flags(models: Vec<ModelOption>) -> ModelSheet {
    let mut sheet = flag_sheet(models, "--model", Some("--variant"));
    sheet.efforts = Some(opencode_efforts());
    let mut map = HashMap::new();
    map.insert("low".into(), "minimal".into());
    map.insert("medium".into(), String::new());
    map.insert("high".into(), "high".into());
    map.insert("max".into(), "max".into());
    map.insert("xhigh".into(), "max".into());
    sheet.effort_arg_values = Some(map);
    sheet
}

fn codex_base() -> ModelSheet {
    ModelSheet {
        models: Some(Vec::new()),
        models_source: Some(ModelsSource::Static),
        efforts: Some(codex_efforts()),
        model_flag: Some("--model".into()),
        named_custom_provider: None,
        effort_flag: Some("-c".into()),
        launch_model: None,
        launch_model_when_listed: Some(true),
        effort_arg_values: None,
        effort_arg_prefix: Some("model_reasoning_effort=".into()),
    }
}

fn grok_fallback() -> ModelSheet {
    let efforts = grok_fallback_efforts();
    ModelSheet {
        models: Some(vec![ModelOption {
            id: "grok-4.6".into(),
            label: "grok-4.6".into(),
            default: Some(true),
            efforts: Some(efforts.clone()),
            input_modalities: None,
        }]),
        models_source: Some(ModelsSource::Static),
        efforts: Some(efforts),
        model_flag: Some("--model".into()),
        named_custom_provider: None,
        effort_flag: Some("--reasoning-effort".into()),
        launch_model: None,
        launch_model_when_listed: None,
        effort_arg_values: None,
        effort_arg_prefix: None,
    }
}

fn claude_base() -> Vec<ModelOption> {
    vec![
        labeled("fable", "Fable 5.1", true),
        labeled("opus", "Opus 5", false),
        labeled("sonnet", "Sonnet 5", false),
        labeled("haiku", "Haiku 4.5", false),
        labeled("fable[1m]", "Fable 5.1 1M context", false),
        labeled("opus[1m]", "Opus 5 1M context", false),
        labeled("sonnet[1m]", "Sonnet 5 1M context", false),
    ]
}

fn labeled(id: &str, label: &str, default: bool) -> ModelOption {
    ModelOption {
        id: id.into(),
        label: label.into(),
        default: default.then_some(true),
        efforts: None,
        input_modalities: None,
    }
}

fn model_row(id: String) -> ModelOption {
    ModelOption { label: id.clone(), id, default: None, efforts: None, input_modalities: None }
}

fn effort(id: &str, label: &str, default: bool) -> EffortOption {
    EffortOption { id: id.into(), label: label.into(), default: default.then_some(true) }
}

fn claude_efforts() -> Vec<EffortOption> {
    vec![effort("low", "Low", false), effort("medium", "Medium", true), effort("high", "High", false), effort("xhigh", "X-High", false), effort("max", "Max", false)]
}

fn grok_fallback_efforts() -> Vec<EffortOption> {
    vec![effort("low", "Low", false), effort("medium", "Medium", false), effort("high", "High", true), effort("xhigh", "X-High", false)]
}

fn hermes_efforts() -> Vec<EffortOption> {
    vec![effort("low", "Low", false), effort("medium", "Medium", true), effort("high", "High", false)]
}

fn codex_efforts() -> Vec<EffortOption> {
    vec![effort("low", "Low", false), effort("medium", "Medium", true), effort("high", "High", false), effort("xhigh", "X-High", false)]
}

fn opencode_efforts() -> Vec<EffortOption> {
    vec![effort("low", "Low", false), effort("medium", "Medium", true), effort("high", "High", false), effort("max", "Max", false)]
}

fn pi_efforts() -> Vec<EffortOption> {
    vec![
        effort("low", "Low", false),
        effort("medium", "Medium", false),
        effort("high", "High", false),
        effort("xhigh", "X-High", false),
        effort("max", "Max", false),
    ]
}

fn codex_effort_label(id: &str) -> String {
    match id {
        "low" => "Low",
        "medium" => "Medium",
        "high" => "High",
        "xhigh" => "X-High",
        "max" => "Max",
        "ultra" => "Ultra",
        other => other,
    }
    .to_string()
}

fn qwen_label(id: &str) -> Option<String> {
    match id {
        "low" => Some("Low".into()),
        "medium" => Some("Medium".into()),
        "high" => Some("High".into()),
        "xhigh" => Some("X-High".into()),
        "max" => Some("Max".into()),
        _ => None,
    }
}

fn label_or(label: Option<&Value>, id: &str) -> String {
    label.and_then(Value::as_str).map(jtrim).filter(|text| !text.is_empty()).unwrap_or(id).to_string()
}

fn name_or(name: Option<&Value>, id: &str) -> String {
    name.and_then(Value::as_str).map(jtrim).filter(|text| !text.is_empty()).unwrap_or(id).to_string()
}

fn call_json(read_json: &mut Option<&mut dyn ReadJson>, path: &str) -> Result<Value, String> {
    if let Some(reader) = read_json.as_mut() {
        reader.read_json(path)
    } else {
        read_json_file(path)
    }
}

fn call_text(read_text: &mut Option<&mut dyn ReadText>, path: &str) -> Result<String, String> {
    if let Some(reader) = read_text.as_mut() {
        reader.read_text(path)
    } else {
        fsutil::read_lossy(Path::new(path)).ok_or_else(|| "unreadable".into())
    }
}

fn call_run(
    run_command: &mut Option<&mut dyn RunSheet>,
    env: &HashMap<String, String>,
    timeout_ms: i64,
) -> DiscoveryRun<String> {
    if let Some(run) = run_command.as_mut() {
        run.run_sheet(&["codex".into(), "debug".into(), "models".into()], env, timeout_ms)
    } else {
        DiscoveryRun::Ready(Err("listing failed".into()))
    }
}

fn call_fetch(
    fetch_ids: &mut Option<&mut dyn FetchSheet>,
    base: &str,
    api_key: Option<&str>,
) -> DiscoveryRun<Vec<String>> {
    if let Some(fetch) = fetch_ids.as_mut() {
        fetch.fetch_sheet(base, api_key)
    } else {
        DiscoveryRun::Ready(Err("listing failed".into()))
    }
}

fn read_json_file(path: &str) -> Result<Value, String> {
    let text = fsutil::read_lossy(Path::new(path)).ok_or_else(|| "unreadable".to_string())?;
    serde_json::from_str(&text).map_err(|err| err.to_string())
}

fn discovery_env(env: Option<&HashMap<String, String>>, home: &str) -> HashMap<String, String> {
    let mut out = env.cloned().unwrap_or_else(process_env);
    let local_bin = join_path(home, ".local/bin");
    let mut parts: Vec<String> = out.get("PATH").map(|text| text.split(':').filter(|part| !part.is_empty()).map(str::to_string).collect()).unwrap_or_default();
    if !parts.iter().any(|part| part == &local_bin) {
        parts.push(local_bin);
    }
    out.insert("PATH".into(), parts.join(":"));
    out
}

fn process_env() -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Ok(path) = std::env::var("PATH") {
        map.insert("PATH".into(), path);
    }
    if let Ok(home) = std::env::var("HOME") {
        map.insert("HOME".into(), home);
    }
    map
}

fn env_trimmed(env: Option<&HashMap<String, String>>, key: &str) -> Option<String> {
    let raw = if let Some(env) = env { env.get(key).cloned() } else { std::env::var(key).ok() }?;
    let trimmed = jtrim(&raw);
    if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
}

fn join_path(base: &str, rest: &str) -> String {
    if base.is_empty() {
        return rest.to_string();
    }
    let mut path = base.trim_end_matches('/').to_string();
    for part in rest.split('/') {
        if part.is_empty() {
            continue;
        }
        path.push('/');
        path.push_str(part);
    }
    path
}

fn memo_of(stamp: &FileStamp, models: Vec<ModelOption>) -> Memo {
    Memo { mtime_ms: stamp.mtime_ms, size: stamp.size, models }
}

fn strip_hash(line: &str) -> String {
    match line.find('#') {
        Some(index) => line[..index].to_string(),
        None => line.to_string(),
    }
}

fn kimi_default(line: &str) -> Option<String> {
    capture(kimi_default_re(), line, &[1, 2, 3])
}

fn kimi_header(line: &str) -> Option<String> {
    let re = kimi_header_re()?;
    let caps = re.captures(line)?;
    let alias = caps.get(2).or_else(|| caps.get(3)).or_else(|| caps.get(4)).map(|item| item.as_str().to_string()).unwrap_or_default();
    Some(jtrim(&alias).to_string())
}

fn kimi_display(line: &str) -> Option<String> {
    capture(kimi_display_re(), line, &[1, 2])
}

fn codex_model_line(line: &str) -> Option<String> {
    capture(codex_model_re(), line, &[1])
}

fn capture(re: Option<&Regex>, line: &str, groups: &[usize]) -> Option<String> {
    let caps = re?.captures(line)?;
    for group in groups {
        if let Some(text) = caps.get(*group) {
            return Some(jtrim(text.as_str()).to_string());
        }
    }
    None
}

fn yaml_scalar(raw: &str) -> String {
    let mut value = jtrim(raw).to_string();
    if value.starts_with('"') || value.starts_with('\'') {
        let quote = value.chars().next().unwrap_or('"');
        let rest = &value[quote.len_utf8()..];
        if let Some(end) = rest.find(quote) {
            return rest[..end].to_string();
        }
        return rest.to_string();
    }
    if let Some(index) = hash_comment(&value) {
        value = value[..index].to_string();
    }
    jtrim(&value).to_string()
}

fn hash_comment(value: &str) -> Option<usize> {
    value.match_indices(" #").map(|(index, _)| index).next()
}

fn yaml_key(line: &str) -> Option<(&str, &str)> {
    let re = yaml_key_re()?;
    let caps = re.captures(line)?;
    Some((caps.get(1)?.as_str(), caps.get(2).map(|item| item.as_str()).unwrap_or("")))
}

fn model_re_line(line: &str) -> bool {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^model:").ok()).as_ref().is_some_and(|re| re.is_match(line))
}

fn http_base(url: &str) -> bool {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^https?://").ok()).as_ref().is_some_and(|re| re.is_match(url))
}

fn hermes_named(model: &str) -> Option<(String, String)> {
    let re = hermes_named_re()?;
    let caps = re.captures(model)?;
    Some((caps.get(1)?.as_str().to_string(), caps.get(2)?.as_str().to_string()))
}

fn kimi_default_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"^default_model\s*=\s*(?:"([^"]+)"|'([^']+)'|(\S+))\s*$"#).ok()).as_ref()
}

fn kimi_header_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"^\[models\.("([^"]+)"|'([^']+)'|([^.\]]+))\]$"#).ok()).as_ref()
}

fn kimi_display_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"^display_name\s*=\s*(?:"([^"]*)"|'([^']*)')\s*$"#).ok()).as_ref()
}

fn codex_model_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"^model\s*=\s*["']([^"']+)["']"#).ok()).as_ref()
}

fn yaml_key_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\s*([A-Za-z_]+):(.*)$").ok()).as_ref()
}

fn hermes_named_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^custom:([^:\s]+):(.+)$").ok()).as_ref()
}
