use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use workspace::{
    DAILY_CONTEXT_UTF16_UNITS, DEFAULT_HEARTBEAT, FILE_IO_TIMEOUT, PIN_MAX_BYTES,
    PIN_TOTAL_MAX_BYTES, WorkspaceLoader,
};

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("rr-6w-workspace-{}-{n}", std::process::id()));
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

fn write_rel(dir: &Path, rel: &str, body: &str) {
    let path = dir.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, body).unwrap();
}

fn loader(dir: &Path) -> WorkspaceLoader {
    WorkspaceLoader::new(dir.to_string_lossy().into_owned())
}

#[test]
fn pin_caps_match_the_typescript_limits() {
    assert_eq!(PIN_MAX_BYTES, 50 * 1024);
    assert_eq!(PIN_TOTAL_MAX_BYTES, 200 * 1024);
    assert_eq!(DAILY_CONTEXT_UTF16_UNITS, 2000);
    assert_eq!(FILE_IO_TIMEOUT, Duration::from_secs(30));
    assert!(DEFAULT_HEARTBEAT.starts_with("# HEARTBEAT.md — Background Task Checklist\n"));
    assert!(DEFAULT_HEARTBEAT.contains("reply `HEARTBEAT_OK`."));
    assert!(DEFAULT_HEARTBEAT.ends_with("```\n"));
    assert!(!DEFAULT_HEARTBEAT.ends_with("```\n\n"));
}

#[tokio::test]
async fn load_returns_only_agent_and_memory() {
    let dir = TempDir::new();
    write_rel(dir.path(), "AGENT.md", "# Agent");
    write_rel(dir.path(), "MEMORY.md", "# Memory");
    write_rel(dir.path(), "CORE.md", "# Core");
    write_rel(dir.path(), "USER.md", "# User");
    write_rel(dir.path(), "WORKSPACE.md", "# Workspace");
    write_rel(dir.path(), "CAPABILITIES.md", "# Capabilities");
    let files = loader(dir.path()).load().await;
    let names: Vec<&str> = files.iter().map(|file| file.name.as_str()).collect();
    assert_eq!(names, ["AGENT.md", "MEMORY.md"]);
    assert_eq!(
        files[0].path,
        format!("{}/AGENT.md", dir.path().to_string_lossy())
    );
}

#[tokio::test]
async fn load_skips_missing_and_empty_files() {
    let dir = TempDir::new();
    write_rel(dir.path(), "AGENT.md", "");
    write_rel(dir.path(), "MEMORY.md", "   ");
    let files = loader(dir.path()).load().await;
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].name, "MEMORY.md");

    let empty = TempDir::new();
    assert!(loader(empty.path()).load().await.is_empty());
}

#[tokio::test]
async fn read_caches_and_returns_null_when_missing() {
    let dir = TempDir::new();
    let loader = loader(dir.path());
    assert!(loader.read("nonexistent.md").await.is_none());
    write_rel(dir.path(), "cached.md", "version 1");
    assert_eq!(loader.read("cached.md").await.as_deref(), Some("version 1"));
    write_rel(dir.path(), "cached.md", "version 2");
    assert_eq!(loader.read("cached.md").await.as_deref(), Some("version 1"));
    loader.clear_cache();
    assert_eq!(loader.read("cached.md").await.as_deref(), Some("version 2"));
}

#[tokio::test]
async fn read_replaces_invalid_utf8_and_does_not_cache_misses() {
    let dir = TempDir::new();
    let loader = loader(dir.path());
    std::fs::write(dir.path().join("bad.md"), [0xff, 0xfe]).unwrap();
    assert_eq!(
        loader.read("bad.md").await.as_deref(),
        Some("\u{FFFD}\u{FFFD}")
    );
    assert!(loader.read("missing.md").await.is_none());
    write_rel(dir.path(), "missing.md", "now");
    assert_eq!(loader.read("missing.md").await.as_deref(), Some("now"));
}

#[tokio::test]
async fn read_joins_absolute_names_under_the_workspace() {
    let dir = TempDir::new();
    let loader = loader(dir.path());
    assert!(loader.read("/etc/passwd").await.is_none());
    write_rel(dir.path(), "etc/passwd", "marker");
    assert_eq!(loader.read("/etc/passwd").await.as_deref(), Some("marker"));
}

#[tokio::test]
async fn read_resolves_parent_segments_like_node() {
    let root = TempDir::new();
    let nested = root.path().join("ws");
    std::fs::create_dir_all(&nested).unwrap();
    std::fs::write(root.path().join("outside.md"), "outside").unwrap();
    let loader = loader(&nested);
    assert_eq!(
        loader.read("../outside.md").await.as_deref(),
        Some("outside")
    );
}

#[tokio::test]
async fn write_creates_parents_and_updates_the_cache() {
    let dir = TempDir::new();
    let loader = loader(dir.path());
    loader.write("new-file.md", "new content").await.unwrap();
    assert_eq!(
        loader.read("new-file.md").await.as_deref(),
        Some("new content")
    );
    let on_disk = std::fs::read_to_string(dir.path().join("new-file.md")).unwrap();
    assert_eq!(on_disk, "new content");

    loader
        .write("deep/nested/file.md", "deep content")
        .await
        .unwrap();
    let nested = std::fs::read_to_string(dir.path().join("deep/nested/file.md")).unwrap();
    assert_eq!(nested, "deep content");
}

#[tokio::test]
async fn system_prompt_orders_core_profile_pins_runtime_and_catalog() {
    let dir = TempDir::new();
    write_rel(dir.path(), "AGENT.md", "agent identity");
    write_rel(dir.path(), "MEMORY.md", "memory index");
    write_rel(dir.path(), "users/profiles.json", r#"{"alice":"alice"}"#);
    write_rel(dir.path(), "users/alice.md", "Alice is a guest");
    write_rel(dir.path(), "src/index.ts", "export default {}");
    let loader = WorkspaceLoader::with_unix_seconds(dir.path().to_string_lossy(), 1_791_647_112);
    loader.pin_file("src/index.ts").await.unwrap();
    loader.set_skill_catalog("  ## Available skills\n- **weather**: Check  ");

    let prompt = loader
        .build_system_prompt(Some("opus"), Some("alice"))
        .await;
    let agent = prompt.find("## AGENT.md").unwrap();
    let memory = prompt.find("## MEMORY.md").unwrap();
    let user = prompt.find("## USER.md (alice)").unwrap();
    let pinned = prompt.find("## Pinned: src/index.ts").unwrap();
    let runtime = prompt.find("## Runtime").unwrap();
    let skills = prompt.find("## Available skills").unwrap();
    assert!(
        agent < memory && memory < user && user < pinned && pinned < runtime && runtime < skills
    );
    assert!(prompt.contains("Agent: opus | Time: 10/10/2026, 11:45:12\u{202f}AM"));
    assert!(prompt.contains("Alice is a guest"));
    assert!(prompt.contains("export default {}"));
    assert!(!prompt.starts_with('\n'));
    assert!(!prompt.ends_with('\n'));
}

#[tokio::test]
async fn system_prompt_omits_runtime_without_an_agent_id() {
    let dir = TempDir::new();
    let prompt = loader(dir.path()).build_system_prompt(None, None).await;
    assert!(!prompt.contains("## Runtime"));
    assert!(
        loader(dir.path())
            .build_system_prompt(Some(""), None)
            .await
            .is_empty()
    );
}

#[tokio::test]
async fn profile_section_follows_the_typescript_truthiness_rules() {
    let dir = TempDir::new();
    write_rel(dir.path(), "AGENT.md", "agent identity");
    write_rel(
        dir.path(),
        "users/profiles.json",
        r#"{"alice":"alice","zero":0,"no":false,"blank":"","num":1,"obj":{"a":1},"list":[]}"#,
    );
    write_rel(dir.path(), "users/alice.md", "Alice is a guest");
    write_rel(dir.path(), "users/1.md", "numeric");
    write_rel(dir.path(), "users/[object Object].md", "object");
    write_rel(dir.path(), "users/.md", "empty-array");
    let loader = loader(dir.path());

    let unknown = loader
        .build_system_prompt(Some("opus"), Some("unknown-user"))
        .await;
    assert!(!unknown.contains("## USER.md"));
    assert!(!unknown.contains("Alice is a guest"));

    let omitted = loader.build_system_prompt(Some("opus"), None).await;
    assert!(!omitted.contains("## USER.md"));
    assert!(
        !loader
            .build_system_prompt(Some("opus"), Some(""))
            .await
            .contains("## USER.md")
    );

    assert!(
        loader
            .build_system_prompt(Some("opus"), Some("alice"))
            .await
            .contains("## USER.md (alice)")
    );
    assert!(
        !loader
            .build_system_prompt(Some("opus"), Some("zero"))
            .await
            .contains("## USER.md")
    );
    assert!(
        !loader
            .build_system_prompt(Some("opus"), Some("no"))
            .await
            .contains("## USER.md")
    );
    assert!(
        !loader
            .build_system_prompt(Some("opus"), Some("blank"))
            .await
            .contains("## USER.md")
    );
    assert!(
        loader
            .build_system_prompt(Some("opus"), Some("num"))
            .await
            .contains("## USER.md (1)\nnumeric")
    );
    assert!(
        loader
            .build_system_prompt(Some("opus"), Some("obj"))
            .await
            .contains("## USER.md ([object Object])\nobject")
    );
    assert!(
        loader
            .build_system_prompt(Some("opus"), Some("list"))
            .await
            .contains("## USER.md ()\nempty-array")
    );
}

#[tokio::test]
async fn malformed_or_non_object_profiles_add_nothing() {
    let dir = TempDir::new();
    write_rel(dir.path(), "AGENT.md", "agent identity");
    write_rel(dir.path(), "users/profiles.json", "{not json");
    write_rel(dir.path(), "users/alice.md", "Alice is a guest");
    let loader = loader(dir.path());
    let prompt = loader
        .build_system_prompt(Some("opus"), Some("alice"))
        .await;
    assert!(!prompt.contains("## USER.md"));
    assert!(!prompt.contains("Alice is a guest"));

    loader
        .write("users/profiles.json", r#"["alice"]"#)
        .await
        .unwrap();
    loader.clear_cache();
    let prompt = loader
        .build_system_prompt(Some("opus"), Some("alice"))
        .await;
    assert!(!prompt.contains("## USER.md"));
    let prompt = loader.build_system_prompt(Some("opus"), Some("0")).await;
    assert!(!prompt.contains("## USER.md"));
}

#[tokio::test]
async fn heartbeat_uses_the_file_or_the_default_template() {
    let dir = TempDir::new();
    write_rel(dir.path(), "AGENT.md", "core");
    let loader = WorkspaceLoader::with_unix_seconds(dir.path().to_string_lossy(), 1_791_647_112);
    let base = loader.build_system_prompt(Some("opus"), None).await;
    let missing = loader.build_heartbeat_prompt(Some("opus")).await;
    assert_eq!(
        missing,
        format!("{base}\n\n## HEARTBEAT.md\n{DEFAULT_HEARTBEAT}")
    );
    assert!(missing.contains("HEARTBEAT_OK"));
    assert!(missing.contains("Background Task Checklist"));

    write_rel(dir.path(), "HEARTBEAT.md", "");
    let empty = loader.build_heartbeat_prompt(Some("opus")).await;
    assert!(empty.contains("HEARTBEAT_OK"));

    loader.clear_cache();
    write_rel(dir.path(), "HEARTBEAT.md", " ");
    let blank = loader.build_heartbeat_prompt(Some("opus")).await;
    assert!(blank.contains("## HEARTBEAT.md\n "));
    assert!(!blank.contains("HEARTBEAT_OK"));

    loader.clear_cache();
    write_rel(dir.path(), "HEARTBEAT.md", "Check email and calendar");
    let custom = loader.build_heartbeat_prompt(Some("opus")).await;
    assert!(custom.contains("## HEARTBEAT.md"));
    assert!(custom.contains("Check email and calendar"));
    assert!(!custom.contains("HEARTBEAT_OK"));
}

#[tokio::test]
async fn clear_cache_also_clears_pins() {
    let dir = TempDir::new();
    write_rel(dir.path(), "pin.ts", "pinned content");
    let loader = loader(dir.path());
    loader.pin_file("pin.ts").await.unwrap();
    assert_eq!(loader.pinned_files().len(), 1);
    loader.clear_cache();
    assert!(loader.pinned_files().is_empty());
}

#[tokio::test]
async fn pin_file_reports_size_order_and_the_typescript_errors() {
    let dir = TempDir::new();
    write_rel(dir.path(), "src/app.ts", "const x = 1;");
    let loader = loader(dir.path());
    let pinned = loader.pin_file("src/app.ts").await.unwrap();
    assert_eq!(pinned.name, "src/app.ts");
    assert_eq!(pinned.size, "const x = 1;".len());
    assert_eq!(loader.pinned_files()[0].name, "src/app.ts");

    let missing = loader.pin_file("nonexistent.ts").await.unwrap_err();
    assert_eq!(missing.message, "File not found: nonexistent.ts");

    write_rel(dir.path(), "big.txt", &"x".repeat(51 * 1024));
    let too_big = loader.pin_file("big.txt").await.unwrap_err();
    assert_eq!(
        too_big.message,
        "File too large: big.txt is 51.0KB (max 50KB)"
    );

    write_rel(dir.path(), "exact.txt", &"x".repeat(50 * 1024));
    let exact = loader.pin_file("exact.txt").await.unwrap();
    assert_eq!(exact.size, 50 * 1024);

    assert!(loader.unpin_file("src/app.ts"));
    assert!(!loader.unpin_file("not-pinned.ts"));
    assert_eq!(loader.clear_pinned_files(), 1);
    assert_eq!(loader.clear_pinned_files(), 0);
}

#[tokio::test]
async fn pin_total_allows_200kb_and_replaces_in_place() {
    let dir = TempDir::new();
    let loader = loader(dir.path());
    for index in 0..4 {
        let name = format!("file{index}.txt");
        write_rel(dir.path(), &name, &"x".repeat(45 * 1024));
        loader.pin_file(&name).await.unwrap();
    }
    write_rel(dir.path(), "file4.txt", &"x".repeat(45 * 1024));
    let overflow = loader.pin_file("file4.txt").await.unwrap_err();
    assert_eq!(
        overflow.message,
        "Total pinned context would exceed 200KB limit. Unpin some files first."
    );
    loader.clear_pinned_files();

    for index in 0..4 {
        let name = format!("full{index}.txt");
        write_rel(dir.path(), &name, &"y".repeat(50 * 1024));
        loader.pin_file(&name).await.unwrap();
    }
    write_rel(dir.path(), "more.txt", "z");
    assert!(loader.pin_file("more.txt").await.is_err());
    loader.pin_file("full0.txt").await.unwrap();
    let names: Vec<String> = loader
        .pinned_files()
        .into_iter()
        .map(|pin| pin.name)
        .collect();
    assert_eq!(names, ["full0.txt", "full1.txt", "full2.txt", "full3.txt"]);

    loader.clear_pinned_files();
    write_rel(dir.path(), "update.ts", "version 1");
    loader.pin_file("update.ts").await.unwrap();
    write_rel(dir.path(), "a.ts", "aaa");
    loader.pin_file("a.ts").await.unwrap();
    write_rel(dir.path(), "update.ts", "version 2 with more bytes");
    loader.pin_file("update.ts").await.unwrap();
    let names: Vec<String> = loader
        .pinned_files()
        .into_iter()
        .map(|pin| pin.name)
        .collect();
    assert_eq!(names, ["update.ts", "a.ts"]);
}

#[tokio::test]
async fn absolute_pin_names_use_the_basename() {
    let dir = TempDir::new();
    let file = dir.path().join("note.txt");
    std::fs::write(&file, "note").unwrap();
    let loader = loader(dir.path());
    let path = file.to_string_lossy().into_owned();
    let pinned = loader.pin_file(&path).await.unwrap();
    assert_eq!(pinned.name, "note.txt");
    assert!(loader.unpin_file(&path));
    assert!(loader.pinned_files().is_empty());
}

#[tokio::test]
async fn pinned_section_sits_between_workspace_files_and_runtime() {
    let dir = TempDir::new();
    write_rel(dir.path(), "AGENT.md", "# Agent");
    write_rel(dir.path(), "src/index.ts", "export default {}");
    let loader = loader(dir.path());
    loader.pin_file("src/index.ts").await.unwrap();
    let prompt = loader.build_system_prompt(Some("opus"), None).await;
    let agent = prompt.find("## AGENT.md").unwrap();
    let pinned = prompt.find("## Pinned:").unwrap();
    let runtime = prompt.find("## Runtime").unwrap();
    assert!(agent < pinned && pinned < runtime);

    let bare = TempDir::new();
    write_rel(bare.path(), "AGENT.md", "# Agent");
    let bare_loader = WorkspaceLoader::new(bare.path().to_string_lossy().into_owned());
    let prompt = bare_loader.build_system_prompt(Some("opus"), None).await;
    assert!(!prompt.contains("## Pinned:"));
}

#[tokio::test]
async fn daily_context_uses_the_utc_day_bypasses_cache_and_caps_utf16() {
    let dir = TempDir::new();
    let loader = WorkspaceLoader::with_unix_seconds(dir.path().to_string_lossy(), 1_791_647_112);
    assert!(loader.read_daily_context().await.is_none());
    write_rel(dir.path(), "memory/2026-10-10.md", "");
    assert!(loader.read_daily_context().await.is_none());
    write_rel(dir.path(), "memory/2026-10-10.md", "one");
    let first = loader.read_daily_context().await.unwrap();
    assert_eq!(first.date, "2026-10-10");
    assert_eq!(first.content, "one");
    write_rel(dir.path(), "memory/2026-10-10.md", "two");
    assert_eq!(loader.read_daily_context().await.unwrap().content, "two");
    assert_eq!(
        loader.read("memory/2026-10-10.md").await.as_deref(),
        Some("two")
    );
    write_rel(dir.path(), "memory/2026-10-10.md", "three");
    assert_eq!(
        loader.read("memory/2026-10-10.md").await.as_deref(),
        Some("two")
    );
    assert_eq!(loader.read_daily_context().await.unwrap().content, "three");

    let text = format!("{}😀z", "a".repeat(1999));
    write_rel(dir.path(), "memory/2026-10-10.md", &text);
    loader.clear_cache();
    assert_eq!(
        loader.read_daily_context().await.unwrap().content,
        "a".repeat(1999)
    );

    let winter = WorkspaceLoader::with_unix_seconds(dir.path().to_string_lossy(), 1_768_446_000);
    write_rel(dir.path(), "memory/2026-01-15.md", "utc-day");
    write_rel(dir.path(), "memory/2026-01-14.md", "ny-day");
    let daily = winter.read_daily_context().await.unwrap();
    assert_eq!(daily.date, "2026-01-15");
    assert_eq!(daily.content, "utc-day");
}

#[tokio::test]
async fn whitespace_only_catalog_is_omitted() {
    let dir = TempDir::new();
    write_rel(dir.path(), "AGENT.md", "core");
    let loader = loader(dir.path());
    loader.set_skill_catalog(" \n\t ");
    let prompt = loader.build_system_prompt(Some("opus"), None).await;
    assert!(!prompt.contains("## Available"));
    assert!(prompt.contains("## AGENT.md\ncore"));
}
