use std::path::Path;
use std::sync::Arc;

use schemars::JsonSchema;
use serde_json::Value;

use crate::helpers::{
    ALLOWED_SUBDIRS, SkillMeta, atomic_write, bump_version_in_content, check_dedup, list_subdir,
    now_iso, parse_patch_blocks, read_meta, scan_issues, title_case_hyphen, under_roots,
    write_meta,
};
use crate::list_tool::node_dirname;
use crate::manager::{Skill, SkillManager};
use crate::text;
use tools::{
    CancellationToken, Tool, ToolContext, ToolSurface, set_property_description, set_property_enum,
};

const AGENT_DESCRIPTION: &str = "Create, edit, patch, or delete skills. Use to save reusable knowledge, workflows, or procedures.";

const SIDECAR_DESCRIPTION: &str = "Create, edit, patch, delete, retire, read, or extend RivetOS skills. Use to save reusable knowledge, workflows, or procedures. Workspace and system skill dirs are both writable. Mirrors the in-process `skill_manage` tool exposed to local agents.";

const ACTIONS: &[&str] = &[
    "create",
    "edit",
    "patch",
    "delete",
    "retire",
    "read",
    "write_file",
];

const NAME_RE: &str = r"^[a-z0-9][a-z0-9-]{0,63}$";

pub struct SkillManageTool {
    manager: SkillManager,
    skill_dirs: Vec<String>,
    pending_gate: bool,
    pending_dir: Option<String>,
    rediscover_all: bool,
    embed_endpoint: Option<String>,
    embed_model: Option<String>,
    http: Arc<dyn tools::HttpClient>,
    surface: ToolSurface,
}

#[derive(JsonSchema)]
struct SkillManageParams {
    action: String,
    name: String,
    description: Option<String>,
    content: Option<String>,
    file_path: Option<String>,
    file_content: Option<String>,
    category: Option<String>,
    tags: Option<String>,
    level: Option<f64>,
    force: Option<bool>,
    reason: Option<String>,
}

impl SkillManageTool {
    pub fn new(manager: SkillManager, skill_dirs: Vec<String>) -> Self {
        Self {
            manager,
            skill_dirs,
            pending_gate: false,
            pending_dir: None,
            rediscover_all: false,
            embed_endpoint: None,
            embed_model: None,
            http: tools::default_http(),
            surface: ToolSurface::Agent,
        }
    }

    pub fn pending_gate(mut self, enabled: bool) -> Self {
        self.pending_gate = enabled;
        self
    }

    pub fn pending_dir(mut self, dir: impl Into<String>) -> Self {
        self.pending_dir = Some(dir.into());
        self
    }

    pub fn rediscover_all(mut self, enabled: bool) -> Self {
        self.rediscover_all = enabled;
        self
    }

    pub fn embed(mut self, endpoint: impl Into<String>, model: impl Into<String>) -> Self {
        self.embed_endpoint = Some(endpoint.into());
        self.embed_model = Some(model.into());
        self
    }

    pub fn http(mut self, client: Arc<dyn tools::HttpClient>) -> Self {
        self.http = client;
        self
    }

    pub fn surface(mut self, surface: ToolSurface) -> Self {
        self.surface = surface;
        self
    }

    pub fn sidecar(manager: SkillManager, skill_dirs: Vec<String>) -> Self {
        Self::new(manager, skill_dirs)
            .rediscover_all(true)
            .surface(ToolSurface::Sidecar)
    }

    fn target_dir(&self) -> Option<String> {
        let first = self.skill_dirs.first()?;
        if self.pending_gate {
            Some(self.pending_dir.clone().unwrap_or_else(|| {
                Path::new(first)
                    .join("pending")
                    .to_string_lossy()
                    .into_owned()
            }))
        } else {
            Some(first.clone())
        }
    }
}

#[async_trait::async_trait]
impl Tool for SkillManageTool {
    fn name(&self) -> &'static str {
        "skill_manage"
    }

    fn description(&self) -> &str {
        match self.surface {
            ToolSurface::Sidecar => SIDECAR_DESCRIPTION,
            ToolSurface::Agent => AGENT_DESCRIPTION,
        }
    }

    fn parameters(&self) -> Value {
        tools::anchor_schema!(SkillManageParams {
            action,
            name,
            description,
            content,
            file_path,
            file_content,
            category,
            tags,
            level,
            force,
            reason
        });
        let mut schema = tools::schema_of::<SkillManageParams>();
        set_property_description(&mut schema, "action", "Action to perform");
        set_property_enum(&mut schema, "action", ACTIONS);
        set_property_description(
            &mut schema,
            "name",
            "Skill name (lowercase, hyphens, letters, digits only, max 64 chars)",
        );
        set_property_description(
            &mut schema,
            "description",
            "Skill description (required for create)",
        );
        set_property_description(
            &mut schema,
            "content",
            "Full SKILL.md content for create/edit, or FIND/REPLACE blocks for patch",
        );
        set_property_description(
            &mut schema,
            "file_path",
            "Relative path for write_file (e.g., references/api.md)",
        );
        set_property_description(&mut schema, "file_content", "Content for write_file");
        set_property_description(
            &mut schema,
            "category",
            "Optional category for organizing skills",
        );
        set_property_description(&mut schema, "tags", "Comma-separated tags");
        set_property_description(
            &mut schema,
            "level",
            "Read detail level: 1 = full SKILL.md + file list (default), 2 = + file contents",
        );
        set_property_description(
            &mut schema,
            "force",
            "Force creation even if a similar skill exists (bypasses dedup check)",
        );
        set_property_description(
            &mut schema,
            "reason",
            "Reason for the change (added to changelog in SKILL.md on edit/patch)",
        );
        schema
    }

    async fn execute(
        &self,
        args: Value,
        _cancellation: &CancellationToken,
        _context: &ToolContext,
    ) -> protocol::ToolResult {
        let action = arg_str(&args, "action").unwrap_or("").to_string();
        let name = arg_str(&args, "name").unwrap_or("").to_string();
        let description = arg_str(&args, "description").map(str::to_string);
        let content = arg_str(&args, "content").map(str::to_string);
        let file_path = arg_str(&args, "file_path").map(str::to_string);
        let file_content = arg_str(&args, "file_content").map(str::to_string);
        let category = arg_str(&args, "category").map(str::to_string);
        let tags = arg_str(&args, "tags").map(str::to_string);
        let level = args.get("level").and_then(Value::as_f64).unwrap_or(1.0);
        let force = js_truthy(args.get("force"));
        let reason = arg_str(&args, "reason").map(str::to_string);
        let result = match action.as_str() {
            "create" => {
                self.handle_create(
                    &name,
                    description.as_deref(),
                    content.as_deref(),
                    category.as_deref(),
                    tags.as_deref(),
                    force,
                )
                .await
            }
            "edit" => {
                self.handle_edit(&name, content.as_deref(), reason.as_deref())
                    .await
            }
            "patch" => {
                self.handle_patch(&name, content.as_deref(), reason.as_deref())
                    .await
            }
            "delete" => self.handle_delete(&name).await,
            "retire" => self.handle_retire(&name, reason.as_deref()).await,
            "read" => self.handle_read(&name, level).await,
            "write_file" => {
                self.handle_write_file(&name, file_path.as_deref(), file_content.as_deref())
                    .await
            }
            _ => format!(
                "Unknown action: \"{action}\". Use: create, edit, patch, delete, retire, read, write_file"
            ),
        };
        if self.rediscover_all && !action.is_empty() && action != "read" {
            for dir in &self.skill_dirs {
                self.manager.rediscover(dir).await;
            }
        }
        text(result)
    }
}

impl SkillManageTool {
    async fn handle_create(
        &self,
        name: &str,
        description: Option<&str>,
        content: Option<&str>,
        category: Option<&str>,
        tags: Option<&str>,
        force: bool,
    ) -> String {
        let Some(target_dir) = self.target_dir() else {
            return "Error: no skill directory configured".to_string();
        };
        if !name_ok(name) {
            return format!(
                "Invalid skill name: \"{name}\". Must be lowercase letters, digits, hyphens only (1-64 chars, start with letter or digit)."
            );
        }
        if let Some(existing) = self
            .manager
            .list()
            .into_iter()
            .find(|skill| skill.name.to_lowercase() == name.to_lowercase())
        {
            return format!("Skill \"{name}\" already exists at {}", existing.location);
        }
        if let (Some(endpoint), Some(model)) = (&self.embed_endpoint, &self.embed_model)
            && !endpoint.is_empty()
            && !model.is_empty()
            && !force
        {
            let desc = description
                .map(str::to_string)
                .or_else(|| content.map(|value| utf16_prefix(value, 500)))
                .unwrap_or_else(|| name.to_string());
            let existing = self
                .manager
                .list()
                .into_iter()
                .map(|skill| (skill.name, skill.description))
                .collect::<Vec<_>>();
            if !existing.is_empty()
                && let Some((dup_name, similarity)) =
                    check_dedup(self.http.as_ref(), endpoint, &desc, &existing, model).await
            {
                return format!(
                    "Possible duplicate: \"{dup_name}\" (similarity: {}). Use a different name, edit the existing skill, or pass force: true to create anyway.",
                    fixed2(similarity)
                );
            }
        }
        let skill_content = build_skill_content(name, description, content, category, tags);
        if let Err(issues) = scan_issues(&skill_content) {
            return format!("Security scan failed:\n{issues}");
        }
        let skill_dir = Path::new(&target_dir).join(name);
        if let Some(message) = jail(&skill_dir, &self.skill_dirs, &target_dir) {
            return message;
        }
        if let Err(err) = tokio::fs::create_dir_all(&skill_dir).await {
            return format!("Error: {err}");
        }
        let skill_md = skill_dir.join("SKILL.md");
        if let Err(err) = atomic_write(&skill_md, &skill_content).await {
            return format!("Error: {err}");
        }
        let meta = SkillMeta {
            created_by: "agent".to_string(),
            created_at: now_iso(),
            version: 1,
            source: None,
            last_modified_at: None,
            last_modified_by: None,
            retired_at: None,
            retired_reason: None,
        };
        if let Err(err) = write_meta(&skill_dir, &meta).await {
            return format!("Error: {err}");
        }
        self.manager.rediscover(&target_dir).await;
        let shown = skill_dir.to_string_lossy();
        tracing::info!("Created skill: {name} at {shown}");
        format!("Skill \"{name}\" created at {shown}")
    }

    async fn handle_edit(&self, name: &str, content: Option<&str>, reason: Option<&str>) -> String {
        let Some(content) = content.filter(|value| !value.is_empty()) else {
            return "Edit requires \"content\" — the new full SKILL.md content.".to_string();
        };
        let Some(skill) = find_skill(&self.manager, name) else {
            return not_found(&self.manager, name);
        };
        let skill_dir = node_dirname(Path::new(&skill.location));
        let mut meta = read_meta(&skill_dir).await.unwrap_or_else(|| SkillMeta {
            created_by: "unknown".to_string(),
            created_at: now_iso(),
            version: 0,
            source: None,
            last_modified_at: None,
            last_modified_by: None,
            retired_at: None,
            retired_reason: None,
        });
        meta.version += 1;
        meta.last_modified_at = Some(now_iso());
        meta.last_modified_by = Some("agent".to_string());
        let updated = bump_version_in_content(content, meta.version, reason);
        if let Err(issues) = scan_issues(&updated) {
            return format!("Security scan failed:\n{issues}");
        }
        if let Some(message) = jail(
            Path::new(&skill.location),
            &self.skill_dirs,
            &skill_dir.to_string_lossy(),
        ) {
            return message;
        }
        if let Err(err) = atomic_write(Path::new(&skill.location), &updated).await {
            return format!("Error: {err}");
        }
        if let Err(err) = write_meta(&skill_dir, &meta).await {
            return format!("Error: {err}");
        }
        let parent = node_dirname(&skill_dir);
        self.manager.rediscover(&parent.to_string_lossy()).await;
        tracing::info!("Updated skill: {name} (version {})", meta.version);
        format!("Skill \"{name}\" updated (version {})", meta.version)
    }

    async fn handle_patch(
        &self,
        name: &str,
        content: Option<&str>,
        reason: Option<&str>,
    ) -> String {
        let Some(content) = content.filter(|value| !value.is_empty()) else {
            return "Patch requires \"content\" with FIND/REPLACE blocks.".to_string();
        };
        let Some(skill) = find_skill(&self.manager, name) else {
            return not_found(&self.manager, name);
        };
        let blocks = parse_patch_blocks(content);
        if blocks.is_empty() {
            return "No valid FIND/REPLACE blocks found in content.".to_string();
        }
        let mut current = match tokio::fs::read_to_string(&skill.location).await {
            Ok(current) => current,
            Err(err) => return format!("Error: {err}"),
        };
        for (find, replace) in &blocks {
            if !current.contains(find) {
                let preview = if utf16_len(find) > 50 {
                    format!("{}...", utf16_prefix(find, 50))
                } else {
                    find.clone()
                };
                return format!("Patch failed: text not found: \"{preview}\"");
            }
            current = current.replacen(find, replace, 1);
        }
        let skill_dir = node_dirname(Path::new(&skill.location));
        let mut meta = read_meta(&skill_dir).await.unwrap_or_else(|| SkillMeta {
            created_by: "unknown".to_string(),
            created_at: now_iso(),
            version: 0,
            source: None,
            last_modified_at: None,
            last_modified_by: None,
            retired_at: None,
            retired_reason: None,
        });
        meta.version += 1;
        meta.last_modified_at = Some(now_iso());
        meta.last_modified_by = Some("agent".to_string());
        current = bump_version_in_content(&current, meta.version, reason);
        if let Err(issues) = scan_issues(&current) {
            return format!("Security scan failed after patching:\n{issues}");
        }
        if let Some(message) = jail(
            Path::new(&skill.location),
            &self.skill_dirs,
            &skill_dir.to_string_lossy(),
        ) {
            return message;
        }
        if let Err(err) = atomic_write(Path::new(&skill.location), &current).await {
            return format!("Error: {err}");
        }
        if let Err(err) = write_meta(&skill_dir, &meta).await {
            return format!("Error: {err}");
        }
        let parent = node_dirname(&skill_dir);
        self.manager.rediscover(&parent.to_string_lossy()).await;
        tracing::info!("Patched skill: {name} ({} replacements)", blocks.len());
        format!(
            "Skill \"{name}\" patched ({} replacements, version {})",
            blocks.len(),
            meta.version
        )
    }

    async fn handle_delete(&self, name: &str) -> String {
        let Some(skill) = find_skill(&self.manager, name) else {
            return not_found(&self.manager, name);
        };
        let skill_dir = node_dirname(Path::new(&skill.location));
        let parent = node_dirname(&skill_dir);
        let trash_dir = parent.join(".trash");
        let trash_name = format!("{name}-{}", chrono::Utc::now().timestamp_millis());
        let trash_path = trash_dir.join(&trash_name);
        if let Some(message) = jail(&trash_path, &self.skill_dirs, &parent.to_string_lossy()) {
            return message;
        }
        if let Err(err) = tokio::fs::create_dir_all(&trash_dir).await {
            return format!("Error: {err}");
        }
        if let Err(err) = tokio::fs::rename(&skill_dir, &trash_path).await {
            return format!("Error: {err}");
        }
        self.manager.rediscover(&parent.to_string_lossy()).await;
        tracing::info!("Deleted skill: {name} → .trash/{trash_name}");
        format!("Skill \"{name}\" moved to trash (.trash/{trash_name})")
    }

    async fn handle_retire(&self, name: &str, reason: Option<&str>) -> String {
        let Some(first) = self.skill_dirs.first() else {
            return "Error: no skill directory configured".to_string();
        };
        let Some(skill) = find_skill(&self.manager, name) else {
            return not_found(&self.manager, name);
        };
        let skill_dir = node_dirname(Path::new(&skill.location));
        let parent = node_dirname(&skill_dir);
        let retired_dir = Path::new(first).join("retired");
        let retired_path = retired_dir.join(name);
        if let Some(message) = jail(&retired_path, &self.skill_dirs, first) {
            return message;
        }
        if let Err(err) = tokio::fs::create_dir_all(&retired_dir).await {
            return format!("Error: {err}");
        }
        let mut meta = read_meta(&skill_dir).await.unwrap_or_else(|| SkillMeta {
            created_by: "unknown".to_string(),
            created_at: now_iso(),
            version: 1,
            source: None,
            last_modified_at: None,
            last_modified_by: None,
            retired_at: None,
            retired_reason: None,
        });
        meta.last_modified_at = Some(now_iso());
        meta.last_modified_by = Some("agent".to_string());
        meta.retired_at = Some(now_iso());
        meta.retired_reason = Some(reason.unwrap_or("No longer useful").to_string());
        if let Err(err) = write_meta(&skill_dir, &meta).await {
            return format!("Error: {err}");
        }
        if let Err(err) = tokio::fs::rename(&skill_dir, &retired_path).await {
            return format!("Error: {err}");
        }
        self.manager.rediscover(&parent.to_string_lossy()).await;
        tracing::info!("Retired skill: {name} → retired/{name}");
        let shown = retired_path.to_string_lossy();
        match reason {
            Some(reason) if !reason.is_empty() => {
                format!("Skill \"{name}\" retired to {shown} (reason: {reason})")
            }
            _ => format!("Skill \"{name}\" retired to {shown}"),
        }
    }

    async fn handle_read(&self, name: &str, level: f64) -> String {
        let Some(skill) = find_skill(&self.manager, name) else {
            return not_found(&self.manager, name);
        };
        let content = match tokio::fs::read_to_string(&skill.location).await {
            Ok(content) => content,
            Err(err) => return format!("Error: {err}"),
        };
        let skill_dir = node_dirname(Path::new(&skill.location));
        let mut files = Vec::new();
        for subdir in ALLOWED_SUBDIRS {
            files.extend(list_subdir(&skill_dir, subdir).await);
        }
        let mut result = format!("## {name}\n\n{content}");
        if !files.is_empty() {
            let listed = files
                .iter()
                .map(|file| format!("- {file}"))
                .collect::<Vec<_>>()
                .join("\n");
            result.push_str(&format!("\n\n## Supporting Files\n{listed}"));
        }
        if let Some(meta) = read_meta(&skill_dir).await {
            result.push_str(&format!(
                "\n\n## Metadata\n- Version: {}\n- Created: {}\n- By: {}",
                meta.version, meta.created_at, meta.created_by
            ));
            if let Some(modified) = meta
                .last_modified_at
                .as_deref()
                .filter(|value| !value.is_empty())
            {
                result.push_str(&format!("\n- Modified: {modified}"));
            }
        }
        if level >= 2.0 && !files.is_empty() {
            result.push_str("\n\n## File Contents");
            for file_path in &files {
                match tokio::fs::read_to_string(skill_dir.join(file_path)).await {
                    Ok(file_content) => {
                        result.push_str(&format!("\n\n### {file_path}\n```\n{file_content}\n```"));
                    }
                    Err(_) => {
                        result.push_str(&format!("\n\n### {file_path}\n*(unable to read)*"));
                    }
                }
            }
        }
        result
    }

    async fn handle_write_file(
        &self,
        name: &str,
        file_path: Option<&str>,
        file_content: Option<&str>,
    ) -> String {
        let (Some(file_path), Some(file_content)) = (file_path, file_content) else {
            return "write_file requires both \"file_path\" and \"file_content\".".to_string();
        };
        if file_path.is_empty() || file_content.is_empty() {
            return "write_file requires both \"file_path\" and \"file_content\".".to_string();
        }
        let Some(skill) = find_skill(&self.manager, name) else {
            return not_found(&self.manager, name);
        };
        let normalized = file_path.replace('\\', "/");
        let first_segment = normalized.split('/').next().unwrap_or("");
        if !ALLOWED_SUBDIRS.contains(&first_segment) {
            return format!(
                "Invalid file path: \"{file_path}\". Must be under: {}",
                ALLOWED_SUBDIRS.join(", ")
            );
        }
        if normalized.contains("..") {
            return format!("Invalid file path: \"{file_path}\". Path traversal not allowed.");
        }
        if let Err(issues) = scan_issues(file_content) {
            return format!("Security scan failed:\n{issues}");
        }
        let skill_dir = node_dirname(Path::new(&skill.location));
        let full_path = skill_dir.join(&normalized);
        if let Some(message) = jail(&full_path, &self.skill_dirs, &skill_dir.to_string_lossy()) {
            return message;
        }
        let parent = full_path.parent().unwrap_or(Path::new("."));
        if let Err(err) = tokio::fs::create_dir_all(parent).await {
            return format!("Error: {err}");
        }
        if let Err(err) = atomic_write(&full_path, file_content).await {
            return format!("Error: {err}");
        }
        tracing::info!("Wrote file: {name}/{file_path}");
        format!("File written: {name}/{file_path}")
    }
}

fn build_skill_content(
    name: &str,
    description: Option<&str>,
    content: Option<&str>,
    category: Option<&str>,
    tags: Option<&str>,
) -> String {
    if let Some(content) = content {
        if content.starts_with("---") {
            return content.to_string();
        }
        let mut lines = vec!["---".to_string(), format!("name: {name}")];
        if let Some(description) = description {
            lines.push(format!("description: {description}"));
        }
        if let Some(category) = category {
            lines.push(format!("category: {category}"));
        }
        if let Some(tags) = tags {
            lines.push(format!("tags: {tags}"));
        }
        lines.push("---".to_string());
        lines.push(String::new());
        return format!("{}{content}", lines.join("\n"));
    }
    let fallback = format!("Skill: {name}");
    let desc = description.unwrap_or(fallback.as_str()).to_string();
    let title = title_case_hyphen(name);
    let mut lines = vec![
        "---".to_string(),
        format!("name: {name}"),
        format!("description: {desc}"),
    ];
    if let Some(category) = category {
        lines.push(format!("category: {category}"));
    }
    if let Some(tags) = tags {
        lines.push(format!("tags: {tags}"));
    }
    lines.push("---".to_string());
    lines.push(String::new());
    lines.push(format!("# {title}"));
    lines.push(String::new());
    lines.push(desc);
    lines.push(String::new());
    lines.join("\n")
}

fn find_skill(manager: &SkillManager, name: &str) -> Option<Skill> {
    manager.list().into_iter().find(|skill| skill.name == name)
}

fn not_found(manager: &SkillManager, name: &str) -> String {
    let available = manager
        .list()
        .into_iter()
        .map(|skill| skill.name)
        .collect::<Vec<_>>()
        .join(", ");
    format!("Skill \"{name}\" not found. Available: {available}")
}

fn name_ok(name: &str) -> bool {
    regex::Regex::new(NAME_RE)
        .ok()
        .and_then(|regex| regex.find(name).map(|item| item.as_str() == name))
        .unwrap_or(false)
}

fn jail(path: &Path, roots: &[String], extra: &str) -> Option<String> {
    let mut allowed = roots.to_vec();
    if !extra.is_empty() {
        allowed.push(extra.to_string());
    }
    if under_roots(path, &allowed) {
        None
    } else {
        Some(format!(
            "Refusing to write outside skill directories: {}",
            path.display()
        ))
    }
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|number| number != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
        _ => false,
    }
}

fn fixed2(value: f64) -> String {
    let factor = 100.0;
    let rounded = (value * factor).round() / factor;
    format!("{rounded:.2}")
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn utf16_prefix(text: &str, max: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(max).collect();
    String::from_utf16_lossy(&units)
}
