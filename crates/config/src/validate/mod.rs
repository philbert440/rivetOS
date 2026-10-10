mod agents;
mod channels;
mod cross;
mod den;
mod deployment;
mod keys;
mod memory;
mod mesh;
mod patterns;
mod providers;
mod runtime;
mod tasks;
mod token;
pub(crate) mod value;

pub use keys::KNOWN_MEMORY_SQLITE_KEYS;

use serde_json::{Map, Value};

use self::value::{is_falsy, js_trim, js_typeof};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationIssue {
    pub severity: Severity,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationResult {
    pub valid: bool,
    pub errors: Vec<ValidationIssue>,
    pub warnings: Vec<ValidationIssue>,
}

#[derive(Debug, Clone)]
pub struct LoadedConfig {
    pub document: Value,
    pub validation: ValidationResult,
}

#[derive(Default)]
pub(crate) struct Issues {
    items: Vec<ValidationIssue>,
}

impl Issues {
    pub(crate) fn error(&mut self, path: impl Into<String>, message: impl Into<String>) {
        self.push(Severity::Error, path, message);
    }

    pub(crate) fn warning(&mut self, path: impl Into<String>, message: impl Into<String>) {
        self.push(Severity::Warning, path, message);
    }

    fn push(&mut self, severity: Severity, path: impl Into<String>, message: impl Into<String>) {
        self.items.push(ValidationIssue {
            severity,
            path: path.into(),
            message: message.into(),
        });
    }

    fn finish(self) -> ValidationResult {
        let mut errors = Vec::new();
        let mut warnings = Vec::new();
        for issue in self.items {
            match issue.severity {
                Severity::Error => errors.push(issue),
                Severity::Warning => warnings.push(issue),
            }
        }
        ValidationResult {
            valid: errors.is_empty(),
            errors,
            warnings,
        }
    }
}

pub fn validate_config(config: &Value) -> ValidationResult {
    let mut issues = Issues::default();
    let Some(cfg) = root_object(config) else {
        issues.error(
            "",
            format!("Config must be a YAML object (got {})", js_typeof(config)),
        );
        return issues.finish();
    };
    warn_unknown_top_level(&mut issues, cfg);
    validate_sections(&mut issues, cfg);
    cross::validate_cross_references(cfg, &mut issues);
    issues.finish()
}

fn root_object(config: &Value) -> Option<&Map<String, Value>> {
    if is_falsy(config) {
        return None;
    }
    config.as_object()
}

fn warn_unknown_top_level(issues: &mut Issues, cfg: &Map<String, Value>) {
    for key in cfg.keys() {
        if !keys::has(keys::KNOWN_TOP_LEVEL, key) {
            issues.warning(
                key.clone(),
                format!("Unknown top-level key \"{key}\" — will be ignored"),
            );
        }
    }
}

fn validate_sections(issues: &mut Issues, cfg: &Map<String, Value>) {
    required_object(
        issues,
        cfg,
        "runtime",
        "Missing required section \"runtime\"",
        "\"runtime\" must be an object",
        runtime::validate_runtime,
    );
    required_object(
        issues,
        cfg,
        "agents",
        "Missing required section \"agents\" — define at least one agent",
        "\"agents\" must be an object mapping agent names to their config",
        agents::validate_agents,
    );
    required_object(
        issues,
        cfg,
        "providers",
        "Missing required section \"providers\" — define at least one provider",
        "\"providers\" must be an object mapping provider names to their config",
        providers::validate_providers,
    );
    optional_object(
        issues,
        cfg,
        "channels",
        "\"channels\" must be an object",
        channels::validate_channels,
    );
    optional_object(
        issues,
        cfg,
        "memory",
        "\"memory\" must be an object",
        memory::validate_memory,
    );
    optional_shape(
        issues,
        cfg,
        "transports",
        "\"transports\" must be an object mapping transport names to their config",
    );
    optional_object(
        issues,
        cfg,
        "deployment",
        "\"deployment\" must be an object",
        deployment::validate_deployment,
    );
    validate_plugins(issues, cfg);
    optional_object(
        issues,
        cfg,
        "mesh",
        "\"mesh\" must be an object",
        mesh::validate_mesh,
    );
    optional_object(
        issues,
        cfg,
        "den",
        "\"den\" must be an object",
        den::validate_den,
    );
    optional_object(
        issues,
        cfg,
        "tasks",
        "\"tasks\" must be an object",
        tasks::validate_tasks,
    );
    optional_object(
        issues,
        cfg,
        "workflows",
        "\"workflows\" must be an object",
        tasks::validate_workflows,
    );
}

fn required_object(
    issues: &mut Issues,
    cfg: &Map<String, Value>,
    key: &str,
    missing: &str,
    type_message: &str,
    validate: impl FnOnce(&Map<String, Value>, &mut Issues),
) {
    match cfg.get(key) {
        Some(value) if !is_falsy(value) => match value.as_object() {
            Some(map) => validate(map, issues),
            None => issues.error(key, type_message),
        },
        _ => issues.error(key, missing),
    }
}

fn optional_object(
    issues: &mut Issues,
    cfg: &Map<String, Value>,
    key: &str,
    type_message: &str,
    validate: impl FnOnce(&Map<String, Value>, &mut Issues),
) {
    match cfg.get(key) {
        Some(value) if !is_falsy(value) => match value.as_object() {
            Some(map) => validate(map, issues),
            None => issues.error(key, type_message),
        },
        _ => {}
    }
}

fn optional_shape(issues: &mut Issues, cfg: &Map<String, Value>, key: &str, type_message: &str) {
    if let Some(value) = cfg.get(key)
        && !is_falsy(value)
        && !value.is_object()
    {
        issues.error(key, type_message);
    }
}

fn validate_plugins(issues: &mut Issues, cfg: &Map<String, Value>) {
    let Some(plugins) = cfg.get("plugins") else {
        return;
    };
    let Some(list) = plugins.as_array() else {
        issues.error(
            "plugins",
            "\"plugins\" must be an array of npm package names",
        );
        return;
    };
    let mut seen = Vec::<&str>::new();
    for (index, entry) in list.iter().enumerate() {
        match entry.as_str() {
            Some(text) if !js_trim(text).is_empty() => {
                if seen.contains(&text) {
                    issues.error(
                        format!("plugins[{index}]"),
                        format!("Duplicate plugin entry \"{text}\""),
                    );
                } else {
                    seen.push(text);
                }
            }
            _ => issues.error(
                format!("plugins[{index}]"),
                "Each plugins entry must be a non-empty package name string",
            ),
        }
    }
}

pub fn format_validation_result(result: &ValidationResult) -> String {
    let mut lines = Vec::new();
    if !result.errors.is_empty() {
        lines.push("Errors:".to_string());
        for err in &result.errors {
            lines.push(format_line("  \u{274c} ", &err.path, &err.message));
        }
    }
    if !result.warnings.is_empty() {
        if !lines.is_empty() {
            lines.push(String::new());
        }
        lines.push("Warnings:".to_string());
        for warn in &result.warnings {
            lines.push(format_line(
                "  \u{26a0}\u{fe0f}  ",
                &warn.path,
                &warn.message,
            ));
        }
    }
    if result.valid && result.warnings.is_empty() {
        lines.push("\u{2705} Config is valid.".to_string());
    } else if result.valid {
        lines.push(String::new());
        let noun = plural(result.warnings.len(), "warning", "warnings");
        lines.push(format!(
            "\u{2705} Config is valid ({} {noun}).",
            result.warnings.len()
        ));
    } else {
        lines.push(String::new());
        let errors = plural(result.errors.len(), "error", "errors");
        let mut summary = format!("\u{274c} Config has {} {errors}", result.errors.len());
        if !result.warnings.is_empty() {
            let warnings = plural(result.warnings.len(), "warning", "warnings");
            summary.push_str(&format!(" and {} {warnings}", result.warnings.len()));
        }
        summary.push('.');
        lines.push(summary);
    }
    lines.join("\n")
}

fn format_line(icon: &str, path: &str, message: &str) -> String {
    if path.is_empty() {
        format!("{icon}{message}")
    } else {
        format!("{icon}[{path}] {message}")
    }
}

fn plural<'a>(count: usize, one: &'a str, many: &'a str) -> &'a str {
    if count == 1 { one } else { many }
}
