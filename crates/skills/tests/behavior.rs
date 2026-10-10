use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use skills::{
    Skill, SkillHookPipeline, SkillListTool, SkillManageTool, SkillManager, catalog_text,
    cosine_similarity, default_runtime_skill_dirs, parse_frontmatter, resolve_skill_dirs,
    scan_skill_content,
};
use tools::{CancellationToken, Tool, ToolContext, ToolSurface, result_text};

struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("rr5a-{label}-{}-{n}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn write_skill(dir: &Path, name: &str, content: &str) {
    let skill = dir.join(name);
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(skill.join("SKILL.md"), content).unwrap();
}

async fn run(tool: &impl Tool, args: Value) -> String {
    result_text(
        &tool
            .execute(args, &CancellationToken::new(), &ToolContext::default())
            .await,
    )
    .to_string()
}

fn read_text(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap()
}

#[tokio::test]
async fn discover_finds_skills_and_skips_bare_directories() {
    let dir = TempDir::new("discover");
    write_skill(
        dir.path(),
        "camera",
        "---\nname: Camera\ndescription: Controls cameras\ntriggers: camera, surveillance, ptz\n---\n# Camera Skill",
    );
    write_skill(
        dir.path(),
        "email",
        "---\nname: Email\ndescription: Send and read emails\ntriggers: email, gmail, inbox\n---\n# Email Skill",
    );
    let manager = SkillManager::new();
    let skills = manager
        .discover(vec![dir.path().display().to_string()])
        .await;
    assert_eq!(skills.len(), 2);
    let names: Vec<_> = skills.iter().map(|skill| skill.name.as_str()).collect();
    assert!(names.contains(&"Camera"));
    assert!(names.contains(&"Email"));

    let empty = TempDir::new("discover-empty");
    std::fs::create_dir_all(empty.path().join("no-skill")).unwrap();
    std::fs::write(
        empty.path().join("no-skill").join("README.md"),
        "# Not a skill",
    )
    .unwrap();
    let manager = SkillManager::new();
    let skills = manager
        .discover(vec![empty.path().display().to_string()])
        .await;
    assert!(skills.is_empty());
}

#[tokio::test]
async fn discover_parses_frontmatter_and_fallbacks() {
    let dir = TempDir::new("frontmatter");
    write_skill(
        dir.path(),
        "weather",
        "---\nname: Weather\ndescription: Check weather forecasts\ntriggers: weather, forecast, temperature\n---",
    );
    let manager = SkillManager::new();
    manager
        .discover(vec![dir.path().display().to_string()])
        .await;
    let skills = manager.list();
    assert_eq!(skills.len(), 1);
    assert_eq!(skills[0].name, "Weather");
    assert_eq!(skills[0].description, "Check weather forecasts");
    assert!(skills[0].triggers.iter().any(|item| item == "weather"));
    assert!(skills[0].triggers.iter().any(|item| item == "forecast"));
    assert!(skills[0].triggers.iter().any(|item| item == "temperature"));
    let matches = manager.match_message("what is the weather forecast");
    assert!(
        matches
            .iter()
            .any(|item| item.name == "Weather" && item.score > 0.0)
    );
    assert!(manager.match_message("zzzz-no-overlap-qqq").is_empty());

    let fallback = TempDir::new("fallback");
    write_skill(
        fallback.path(),
        "fallback",
        "# My Cool Skill\nThis skill does amazing things.\n\n## Usage\nRun it.",
    );
    let manager = SkillManager::new();
    manager
        .discover(vec![fallback.path().display().to_string()])
        .await;
    let skills = manager.list();
    assert_eq!(skills[0].name, "My Cool Skill");
    assert_eq!(skills[0].description, "This skill does amazing things.");

    let named = TempDir::new("dirname");
    write_skill(
        named.path(),
        "my-dir-name",
        "---\ndescription: No name field\n---",
    );
    let manager = SkillManager::new();
    manager
        .discover(vec![named.path().display().to_string()])
        .await;
    assert_eq!(manager.list()[0].name, "my-dir-name");
}

#[tokio::test]
async fn discover_missing_and_multiple_directories() {
    let manager = SkillManager::new();
    let skills = manager
        .discover(vec!["/tmp/this-does-not-exist-at-all".to_string()])
        .await;
    assert!(skills.is_empty());

    let first = TempDir::new("multi-a");
    let second = TempDir::new("multi-b");
    write_skill(
        first.path(),
        "skill-a",
        "---\nname: Skill A\ndescription: First\n---",
    );
    write_skill(
        second.path(),
        "skill-b",
        "---\nname: Skill B\ndescription: Second\n---",
    );
    let manager = SkillManager::new();
    let dirs = vec![
        first.path().display().to_string(),
        second.path().display().to_string(),
    ];
    let skills = manager.discover(dirs.clone()).await;
    assert_eq!(skills.len(), 2);
    assert_eq!(manager.get_skill_dirs(), dirs);
}

#[tokio::test]
async fn load_list_and_hooks() {
    let dir = TempDir::new("load");
    let content = "---\nname: Full\ndescription: Full content test\n---\n# Full Skill\n\nDetailed instructions here.";
    write_skill(dir.path(), "full", content);
    let manager = SkillManager::new();
    assert!(manager.list().is_empty());
    manager
        .discover(vec![dir.path().display().to_string()])
        .await;
    assert_eq!(manager.load("Full").await.unwrap(), content);
    let missing = manager.load("nonexistent").await.unwrap_err();
    assert!(missing.to_string().contains("Skill not found"));

    write_skill(
        dir.path(),
        "hooked",
        "---\nname: Hooked\ndescription: Hook test\ntriggers: hook\n---\n# Hooked",
    );
    write_skill(dir.path(), "one", "---\nname: One\ndescription: First\n---");
    write_skill(
        dir.path(),
        "two",
        "---\nname: Two\ndescription: Second\n---",
    );
    manager
        .discover(vec![dir.path().display().to_string()])
        .await;
    assert!(manager.list().len() >= 3);

    let events = Arc::new(Mutex::new(Vec::new()));
    let before_name = Arc::new(Mutex::new(String::new()));
    let before_location = Arc::new(Mutex::new(String::new()));
    let before_score = Arc::new(Mutex::new(-1.0));
    let after_name = Arc::new(Mutex::new(String::new()));
    let after_success = Arc::new(Mutex::new(false));
    let pipeline = Arc::new(SkillHookPipeline::new());
    pipeline.on_before(false, {
        let events = Arc::clone(&events);
        let before_name = Arc::clone(&before_name);
        let before_location = Arc::clone(&before_location);
        let before_score = Arc::clone(&before_score);
        move |ctx| {
            events.lock().unwrap().push("before".to_string());
            *before_name.lock().unwrap() = ctx.skill_name.clone();
            *before_location.lock().unwrap() = ctx.skill_location.clone();
            *before_score.lock().unwrap() = ctx.match_score;
            Ok(())
        }
    });
    pipeline.on_after(false, {
        let events = Arc::clone(&events);
        let after_name = Arc::clone(&after_name);
        let after_success = Arc::clone(&after_success);
        move |ctx| {
            events.lock().unwrap().push("after".to_string());
            *after_name.lock().unwrap() = ctx.skill_name.clone();
            *after_success.lock().unwrap() = ctx.success;
            let _ = ctx.duration_ms;
            Ok(())
        }
    });
    manager.set_pipeline(Arc::clone(&pipeline));
    assert_eq!(
        manager.load("Hooked").await.unwrap(),
        "---\nname: Hooked\ndescription: Hook test\ntriggers: hook\n---\n# Hooked"
    );
    assert_eq!(
        events.lock().unwrap().as_slice(),
        ["before".to_string(), "after".to_string()]
    );
    assert_eq!(before_name.lock().unwrap().as_str(), "Hooked");
    assert!(before_location.lock().unwrap().contains("SKILL.md"));
    assert_eq!(*before_score.lock().unwrap(), 0.0);
    assert_eq!(after_name.lock().unwrap().as_str(), "Hooked");
    assert!(*after_success.lock().unwrap());

    let skip_dir = TempDir::new("skip");
    write_skill(
        skip_dir.path(),
        "skipme",
        "---\nname: SkipMe\ndescription: Will be skipped\n---\n# Skip",
    );
    let manager = SkillManager::new();
    manager
        .discover(vec![skip_dir.path().display().to_string()])
        .await;
    let pipeline = Arc::new(SkillHookPipeline::new());
    pipeline.on_before(false, |ctx| {
        ctx.skip = true;
        ctx.skip_reason = Some("blocked for test".to_string());
        Ok(())
    });
    manager.set_pipeline(pipeline);
    let err = manager.load("SkipMe").await.unwrap_err().to_string();
    assert!(err.contains("skipped by hook"), "{err}");
    assert!(err.contains("blocked for test"));

    let resilient = TempDir::new("resilient");
    let body = "---\nname: Resilient\ndescription: Resilient\n---\n# R";
    write_skill(resilient.path(), "resilient", body);
    let manager = SkillManager::new();
    manager
        .discover(vec![resilient.path().display().to_string()])
        .await;
    let pipeline = Arc::new(SkillHookPipeline::new());
    pipeline.on_before(true, |_| Err("before exploded".to_string()));
    manager.set_pipeline(pipeline);
    assert_eq!(manager.load("Resilient").await.unwrap(), body);
}

#[tokio::test]
async fn rediscover_adds_and_removes() {
    let dir = TempDir::new("rediscover");
    let path = dir.path().display().to_string();
    write_skill(
        dir.path(),
        "alpha",
        "---\nname: alpha\ndescription: Alpha skill\n---",
    );
    let manager = SkillManager::new();
    manager.discover(vec![path.clone()]).await;
    assert_eq!(manager.list().len(), 1);
    write_skill(
        dir.path(),
        "beta",
        "---\nname: beta\ndescription: Beta skill\n---",
    );
    manager.rediscover(&path).await;
    assert_eq!(manager.list().len(), 2);
    std::fs::remove_dir_all(dir.path().join("to-delete")).ok();
    write_skill(
        dir.path(),
        "to-delete",
        "---\nname: to-delete\ndescription: Will be deleted\n---",
    );
    manager.rediscover(&path).await;
    assert_eq!(manager.list().len(), 3);
    std::fs::remove_dir_all(dir.path().join("to-delete")).unwrap();
    manager.rediscover(&path).await;
    assert!(manager.list().iter().all(|skill| skill.name != "to-delete"));
    assert_eq!(manager.list().len(), 2);
}

#[tokio::test]
async fn skill_list_formats_names() {
    let manager = SkillManager::new();
    let tool = SkillListTool::new(manager.clone());
    assert_eq!(tool.name(), "skill_list");
    assert!(!tool.description().is_empty());
    assert!(tool.parameters().is_object());
    assert!(run(&tool, json!({})).await.contains("No skills"));
    let sidecar = SkillListTool::new(manager.clone()).surface(ToolSurface::Sidecar);
    assert!(sidecar.description().contains("Mirrors"));
    assert_ne!(tool.description(), sidecar.description());

    let dir = TempDir::new("list");
    write_skill(
        dir.path(),
        "test-skill",
        "---\nname: TestSkill\ndescription: A test skill\n---",
    );
    manager
        .discover(vec![dir.path().display().to_string()])
        .await;
    let listed = run(&tool, json!({})).await;
    assert!(listed.contains("TestSkill"), "{listed}");
    assert!(listed.contains("A test skill"));
}

#[test]
fn security_scan_matches_plugin_cases() {
    let clean = scan_skill_content(
        "# My Skill\n\nThis skill helps with weather.\n\n## Usage\n\n```bash\ncurl \"wttr.in/London\"\n```",
    );
    assert!(clean.safe);
    assert!(clean.issues.is_empty());
    let shell = scan_skill_content("Run this: $(whoami)");
    assert!(!shell.safe);
    assert!(
        shell
            .issues
            .iter()
            .any(|issue| issue.contains("Shell injection"))
    );
    let eval = scan_skill_content("eval(userInput)");
    assert!(!eval.safe);
    assert!(eval.issues.iter().any(|issue| issue.contains("eval")));
    let password = scan_skill_content("password= \"secret123\"");
    assert!(!password.safe);
    assert!(
        password
            .issues
            .iter()
            .any(|issue| issue.to_lowercase().contains("password"))
    );
    let key = scan_skill_content("api_key= \"sk-abc123\"");
    assert!(!key.safe);
    assert!(
        key.issues
            .iter()
            .any(|issue| issue.to_lowercase().contains("api key"))
    );
    let rm = scan_skill_content("rm -rf /");
    assert!(!rm.safe);
    assert!(rm.issues.iter().any(|issue| issue.contains("rm -rf")));
    let chmod = scan_skill_content("chmod 777 /var/www");
    assert!(!chmod.safe);
    assert!(chmod.issues.iter().any(|issue| issue.contains("chmod 777")));
}

#[tokio::test]
async fn skill_manage_create_edit_patch_delete() {
    let dir = TempDir::new("manage");
    let path = dir.path().display().to_string();
    let manager = SkillManager::new();
    manager.discover(vec![path.clone()]).await;
    let tool = SkillManageTool::new(manager.clone(), vec![path.clone()]);
    assert_eq!(tool.name(), "skill_manage");
    assert!(tool.description().contains("Create, edit, patch"));
    let sidecar = SkillManageTool::sidecar(manager.clone(), vec![path.clone()]);
    assert!(sidecar.description().contains("Mirrors"));

    let created = run(
        &tool,
        json!({"action": "create", "name": "my-skill", "description": "A test skill"}),
    )
    .await;
    assert!(created.contains("created"), "{created}");
    let body = read_text(&dir.path().join("my-skill").join("SKILL.md"));
    assert!(body.contains("name: my-skill"));
    assert!(body.contains("A test skill"));
    let meta: Value =
        serde_json::from_str(&read_text(&dir.path().join("my-skill").join("_meta.json"))).unwrap();
    assert_eq!(meta["version"], 1);
    assert_eq!(meta["created_by"], "agent");

    let custom = "---\nname: custom\ndescription: Custom skill\n---\n# Custom\n\nDo custom things.";
    let result = run(
        &tool,
        json!({"action": "create", "name": "custom", "content": custom}),
    )
    .await;
    assert!(result.contains("created"), "{result}");
    assert_eq!(
        read_text(&dir.path().join("custom").join("SKILL.md")),
        custom
    );

    let spaced = run(
        &tool,
        json!({"action": "create", "name": "my skill", "description": "Bad name"}),
    )
    .await;
    assert!(spaced.contains("Invalid skill name"), "{spaced}");
    let upper = run(
        &tool,
        json!({"action": "create", "name": "MySkill", "description": "Bad name"}),
    )
    .await;
    assert!(upper.contains("Invalid skill name"), "{upper}");

    let _ = run(
        &tool,
        json!({"action": "create", "name": "dup-test", "description": "First"}),
    )
    .await;
    let dup = run(
        &tool,
        json!({"action": "create", "name": "dup-test", "description": "Second"}),
    )
    .await;
    assert!(dup.contains("already exists"), "{dup}");

    let _ = run(
        &tool,
        json!({"action": "create", "name": "editable", "description": "Original"}),
    )
    .await;
    let new_content = "---\nname: editable\ndescription: Updated\n---\n# Editable\n\nNew content.";
    let edited = run(
        &tool,
        json!({"action": "edit", "name": "editable", "content": new_content}),
    )
    .await;
    assert!(edited.contains("updated"), "{edited}");
    assert!(edited.contains("version 2"));
    let edited_body = read_text(&dir.path().join("editable").join("SKILL.md"));
    assert!(edited_body.contains("name: editable"));
    assert!(edited_body.contains("description: Updated"));
    assert!(edited_body.contains("version: 2"));
    assert!(edited_body.contains("## Changelog"));

    let original = "---\nname: patchable\ndescription: Patchable skill\n---\n# Patchable\n\nOriginal text here.";
    let _ = run(
        &tool,
        json!({"action": "create", "name": "patchable", "content": original}),
    )
    .await;
    let patched = run(
        &tool,
        json!({
            "action": "patch",
            "name": "patchable",
            "content": "FIND: Original text here.\nREPLACE: Patched text instead."
        }),
    )
    .await;
    assert!(patched.contains("patched"), "{patched}");
    assert!(patched.contains("1 replacements"));
    let patched_body = read_text(&dir.path().join("patchable").join("SKILL.md"));
    assert!(patched_body.contains("Patched text instead."));
    assert!(!patched_body.contains("Original text here."));

    let _ = run(
        &tool,
        json!({"action": "create", "name": "patch-fail", "description": "Test"}),
    )
    .await;
    let missed = run(
        &tool,
        json!({
            "action": "patch",
            "name": "patch-fail",
            "content": "FIND: this text does not exist\nREPLACE: whatever"
        }),
    )
    .await;
    assert!(missed.contains("not found"), "{missed}");

    let _ = run(
        &tool,
        json!({"action": "create", "name": "to-delete", "description": "Delete me"}),
    )
    .await;
    let deleted = run(&tool, json!({"action": "delete", "name": "to-delete"})).await;
    assert!(deleted.contains("trash"), "{deleted}");
    assert!(!dir.path().join("to-delete").exists());
    let trashed = std::fs::read_dir(dir.path().join(".trash"))
        .unwrap()
        .filter_map(|entry| entry.ok())
        .any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("to-delete-")
        });
    assert!(trashed);

    let empty = SkillManageTool::new(SkillManager::new(), Vec::new());
    let missing_dir = run(
        &empty,
        json!({"action": "create", "name": "x", "description": "y"}),
    )
    .await;
    assert!(
        missing_dir.contains("no skill directory configured"),
        "{missing_dir}"
    );
    let unknown = run(&tool, json!({"action": "nope", "name": "x"})).await;
    assert!(unknown.contains("Unknown action"), "{unknown}");
}

#[tokio::test]
async fn skill_manage_read_write_and_list_metadata() {
    let dir = TempDir::new("files");
    let path = dir.path().display().to_string();
    let manager = SkillManager::new();
    manager.discover(vec![path.clone()]).await;
    let tool = SkillManageTool::new(manager.clone(), vec![path.clone()]);
    let _ = run(
        &tool,
        json!({"action": "create", "name": "readable", "description": "Read me"}),
    )
    .await;
    std::fs::create_dir_all(dir.path().join("readable").join("references")).unwrap();
    std::fs::write(
        dir.path()
            .join("readable")
            .join("references")
            .join("api.md"),
        "# API docs",
    )
    .unwrap();
    let read = run(&tool, json!({"action": "read", "name": "readable"})).await;
    assert!(read.contains("Read me"), "{read}");
    assert!(read.contains("references/api.md"));

    let _ = run(
        &tool,
        json!({"action": "create", "name": "with-files", "description": "Has files"}),
    )
    .await;
    let written = run(
        &tool,
        json!({
            "action": "write_file",
            "name": "with-files",
            "file_path": "references/guide.md",
            "file_content": "# Guide\n\nSome guide content."
        }),
    )
    .await;
    assert!(written.contains("File written"), "{written}");
    assert!(
        read_text(
            &dir.path()
                .join("with-files")
                .join("references")
                .join("guide.md")
        )
        .contains("Guide")
    );

    let _ = run(
        &tool,
        json!({"action": "create", "name": "path-test", "description": "Test"}),
    )
    .await;
    let traversal = run(
        &tool,
        json!({
            "action": "write_file",
            "name": "path-test",
            "file_path": "../../etc/passwd",
            "file_content": "bad stuff"
        }),
    )
    .await;
    assert!(
        traversal.contains("Invalid file path") || traversal.contains("Path traversal"),
        "{traversal}"
    );
    let _ = run(
        &tool,
        json!({"action": "create", "name": "subdir-test", "description": "Test"}),
    )
    .await;
    let subdir = run(
        &tool,
        json!({
            "action": "write_file",
            "name": "subdir-test",
            "file_path": "config/secret.yaml",
            "file_content": "not allowed"
        }),
    )
    .await;
    assert!(subdir.contains("Invalid file path"), "{subdir}");

    let evil = run(
        &tool,
        json!({
            "action": "create",
            "name": "evil-skill",
            "content": "---\nname: evil-skill\ndescription: Evil\n---\n# Evil\n\nRun $(rm -rf /)"
        }),
    )
    .await;
    assert!(evil.contains("Security scan failed"), "{evil}");

    let _ = run(
        &tool,
        json!({"action": "create", "name": "deep-read", "description": "Deep read test"}),
    )
    .await;
    std::fs::create_dir_all(dir.path().join("deep-read").join("references")).unwrap();
    std::fs::write(
        dir.path()
            .join("deep-read")
            .join("references")
            .join("api.md"),
        "# API Reference\n\nEndpoint: /v1/things",
    )
    .unwrap();
    std::fs::create_dir_all(dir.path().join("deep-read").join("templates")).unwrap();
    std::fs::write(
        dir.path()
            .join("deep-read")
            .join("templates")
            .join("config.yaml"),
        "port: 8080\nhost: localhost",
    )
    .unwrap();
    let deep = run(
        &tool,
        json!({"action": "read", "name": "deep-read", "level": 2}),
    )
    .await;
    assert!(deep.contains("File Contents"), "{deep}");
    assert!(deep.contains("API Reference"));
    assert!(deep.contains("Endpoint: /v1/things"));
    assert!(deep.contains("port: 8080"));

    let _ = run(
        &tool,
        json!({"action": "create", "name": "shallow-read", "description": "Shallow read test"}),
    )
    .await;
    std::fs::create_dir_all(dir.path().join("shallow-read").join("references")).unwrap();
    std::fs::write(
        dir.path()
            .join("shallow-read")
            .join("references")
            .join("secret.md"),
        "TOP SECRET DATA",
    )
    .unwrap();
    let shallow = run(
        &tool,
        json!({"action": "read", "name": "shallow-read", "level": 1}),
    )
    .await;
    assert!(shallow.contains("references/secret.md"), "{shallow}");
    assert!(!shallow.contains("TOP SECRET DATA"));
    assert!(!shallow.contains("File Contents"));

    let list = SkillListTool::new(manager.clone());
    let _ = run(
        &tool,
        json!({"action": "create", "name": "rich-list", "description": "Rich listing test"}),
    )
    .await;
    std::fs::create_dir_all(dir.path().join("rich-list").join("references")).unwrap();
    std::fs::write(
        dir.path()
            .join("rich-list")
            .join("references")
            .join("doc.md"),
        "# Docs",
    )
    .unwrap();
    manager.rediscover(&path).await;
    let listed = run(&list, json!({})).await;
    assert!(listed.contains("rich-list"), "{listed}");
    assert!(listed.contains("v1"));
    assert!(listed.contains("1 file"));
}

#[tokio::test]
async fn version_bump_changelog_and_retire() {
    let dir = TempDir::new("version");
    let path = dir.path().display().to_string();
    let manager = SkillManager::new();
    manager.discover(vec![path.clone()]).await;
    let tool = SkillManageTool::new(manager.clone(), vec![path]);
    let _ = run(
        &tool,
        json!({"action": "create", "name": "versioned", "description": "Versioned skill"}),
    )
    .await;
    let updated = run(
        &tool,
        json!({
            "action": "edit",
            "name": "versioned",
            "content": "---\nname: versioned\ndescription: Updated skill\n---\n# Versioned\n\nNew content.",
            "reason": "Improved instructions"
        }),
    )
    .await;
    assert!(updated.contains("version 2"), "{updated}");
    let body = read_text(&dir.path().join("versioned").join("SKILL.md"));
    assert!(body.contains("version: 2"));
    assert!(body.contains("## Changelog"));
    assert!(body.contains("Improved instructions"));
    assert!(body.contains("**v2**"));

    let original = "---\nname: patchver\ndescription: Patchable\nversion: 1\n---\n# Patchable\n\nOriginal text.";
    let _ = run(
        &tool,
        json!({"action": "create", "name": "patchver", "content": original}),
    )
    .await;
    let patched = run(
        &tool,
        json!({
            "action": "patch",
            "name": "patchver",
            "content": "FIND: Original text.\nREPLACE: Better text.",
            "reason": "Fixed wording"
        }),
    )
    .await;
    assert!(patched.contains("version 2"), "{patched}");
    let body = read_text(&dir.path().join("patchver").join("SKILL.md"));
    assert!(body.contains("version: 2"));
    assert!(body.contains("## Changelog"));
    assert!(body.contains("Fixed wording"));
    assert!(body.contains("Better text."));
    assert!(!body.contains("Original text."));

    let _ = run(
        &tool,
        json!({"action": "create", "name": "multi-edit", "description": "Multi-edit test"}),
    )
    .await;
    let _ = run(
        &tool,
        json!({
            "action": "edit",
            "name": "multi-edit",
            "content": "---\nname: multi-edit\ndescription: V2\n---\n# Multi Edit\n\nVersion 2.",
            "reason": "First update"
        }),
    )
    .await;
    let after_v2 = read_text(&dir.path().join("multi-edit").join("SKILL.md"));
    let _ = run(
        &tool,
        json!({
            "action": "edit",
            "name": "multi-edit",
            "content": after_v2,
            "reason": "Second update"
        }),
    )
    .await;
    let final_body = read_text(&dir.path().join("multi-edit").join("SKILL.md"));
    assert!(final_body.contains("First update"));
    assert!(final_body.contains("Second update"));
    assert!(final_body.contains("**v3**"));

    let _ = run(
        &tool,
        json!({"action": "create", "name": "no-reason", "description": "No reason test"}),
    )
    .await;
    let _ = run(
        &tool,
        json!({
            "action": "edit",
            "name": "no-reason",
            "content": "---\nname: no-reason\ndescription: Updated\n---\n# No Reason\n\nNew."
        }),
    )
    .await;
    assert!(read_text(&dir.path().join("no-reason").join("SKILL.md")).contains("Updated"));

    let _ = run(
        &tool,
        json!({"action": "create", "name": "old-skill", "description": "Retiring this"}),
    )
    .await;
    let retired = run(
        &tool,
        json!({
            "action": "retire",
            "name": "old-skill",
            "reason": "Superseded by new-skill"
        }),
    )
    .await;
    assert!(retired.contains("retired"), "{retired}");
    assert!(retired.contains("Superseded by new-skill"));
    assert!(!dir.path().join("old-skill").exists());
    assert!(dir.path().join("retired").join("old-skill").is_dir());
    let meta: Value = serde_json::from_str(&read_text(
        &dir.path()
            .join("retired")
            .join("old-skill")
            .join("_meta.json"),
    ))
    .unwrap();
    assert!(!meta["retired_at"].as_str().unwrap().is_empty());
    assert_eq!(meta["retired_reason"], "Superseded by new-skill");

    let _ = run(
        &tool,
        json!({"action": "create", "name": "to-retire", "description": "Will retire"}),
    )
    .await;
    assert!(manager.list().iter().any(|skill| skill.name == "to-retire"));
    let _ = run(&tool, json!({"action": "retire", "name": "to-retire"})).await;
    assert!(manager.list().iter().all(|skill| skill.name != "to-retire"));
    let missing = run(&tool, json!({"action": "retire", "name": "nonexistent"})).await;
    assert!(missing.contains("not found"), "{missing}");
}

#[tokio::test]
async fn extended_frontmatter_fields() {
    let dir = TempDir::new("rich-fm");
    write_skill(
        dir.path(),
        "rich-fm",
        "---\nname: rich-fm\ndescription: Rich metadata\nversion: 3\ncategory: devops\ntags: docker, kubernetes, deploy\n---\n# Rich FM",
    );
    let manager = SkillManager::new();
    manager
        .discover(vec![dir.path().display().to_string()])
        .await;
    let skills = manager.list();
    assert_eq!(skills[0].version, Some(3));
    assert_eq!(skills[0].category.as_deref(), Some("devops"));
    assert_eq!(
        skills[0].tags.as_deref(),
        Some(
            [
                "docker".to_string(),
                "kubernetes".to_string(),
                "deploy".to_string()
            ]
            .as_slice()
        )
    );

    let minimal = TempDir::new("minimal");
    write_skill(
        minimal.path(),
        "minimal",
        "---\nname: minimal\ndescription: Minimal\n---",
    );
    let manager = SkillManager::new();
    manager
        .discover(vec![minimal.path().display().to_string()])
        .await;
    let skills = manager.list();
    assert_eq!(skills[0].version, None);
    assert_eq!(skills[0].category, None);
    assert_eq!(skills[0].tags, None);

    let parsed = parse_frontmatter(
        "---\nname: rich-fm\ndescription: Rich metadata\nversion: 3\ncategory: devops\ntags: docker, kubernetes, deploy\n---\n# Rich FM",
    );
    assert_eq!(parsed.version, Some(3));
    assert_eq!(parsed.category.as_deref(), Some("devops"));
}

#[test]
fn cosine_similarity_cases() {
    let vector = [1.0, 2.0, 3.0, 4.0, 5.0];
    assert!((cosine_similarity(&vector, &vector) - 1.0).abs() < 0.0001);
    assert!(cosine_similarity(&[1.0, 0.0, 0.0], &[0.0, 1.0, 0.0]).abs() < 0.0001);
    assert!((cosine_similarity(&[1.0, 2.0, 3.0], &[-1.0, -2.0, -3.0]) - -1.0).abs() < 0.0001);
    assert_eq!(cosine_similarity(&[], &[]), 0.0);
    assert_eq!(cosine_similarity(&[1.0, 2.0], &[1.0, 2.0, 3.0]), 0.0);
    assert_eq!(cosine_similarity(&[0.0, 0.0, 0.0], &[1.0, 2.0, 3.0]), 0.0);
    let expected = std::f64::consts::FRAC_1_SQRT_2;
    assert!((cosine_similarity(&[1.0, 0.0], &[1.0, 1.0]) - expected).abs() < 0.001);
}

#[test]
fn catalog_and_skill_dir_resolution() {
    assert!(catalog_text(&[]).is_none());
    let text = catalog_text(&[Skill {
        name: "Email".to_string(),
        description: "Send and read emails".to_string(),
        location: String::new(),
        triggers: Vec::new(),
        version: None,
        category: None,
        tags: None,
    }])
    .unwrap();
    assert!(text.contains("## Available skills"));
    assert!(text.contains("loadable skills"));
    assert!(text.contains("- **Email**: Send and read emails"));
    let explicit = vec!["/tmp/skills-a".to_string(), "/tmp/skills-b".to_string()];
    assert_eq!(resolve_skill_dirs(Some(&explicit)), explicit);
    let runtime = default_runtime_skill_dirs();
    assert_eq!(runtime.len(), 1);
    assert!(runtime[0].ends_with("/.rivetos/workspace/skills"));
}

#[tokio::test]
async fn sidecar_seed_create_list_and_read() {
    let dir = TempDir::new("sidecar");
    let name = "mcp-test-seed";
    let body = format!(
        "---\nname: {name}\ndescription: Seed skill used by the mcp-server skill-tools integration test.\ntriggers: [seed-trigger]\n---\n\n# Seed Skill\n\nThis skill exists to verify discovery works.\n"
    );
    write_skill(dir.path(), name, &body);
    let path = dir.path().display().to_string();
    let manager = SkillManager::new();
    manager.discover(vec![path.clone()]).await;
    let list = SkillListTool::new(manager.clone()).surface(ToolSurface::Sidecar);
    let manage = SkillManageTool::sidecar(manager, vec![path]);
    assert_eq!(list.name(), "skill_list");
    assert_eq!(manage.name(), "skill_manage");
    let listed = run(&list, json!({})).await;
    assert!(listed.contains(name), "{listed}");
    let created = run(
        &manage,
        json!({
            "action": "create",
            "name": "mcp-test-created",
            "description": "A skill created via MCP for the integration test.",
            "content": "# mcp-test-created\n\nCreated by skills.test.ts.\n",
            "force": true
        }),
    )
    .await;
    assert!(created.contains("created"), "{created}");
    let listed = run(&list, json!({})).await;
    assert!(listed.contains(name), "{listed}");
    assert!(listed.contains("mcp-test-created"), "{listed}");
    let read = run(&manage, json!({"action": "read", "name": name, "level": 1})).await;
    assert!(read.contains("Seed Skill"), "{read}");
}
