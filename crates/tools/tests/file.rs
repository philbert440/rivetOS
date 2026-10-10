use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use tools::{
    CancellationToken, FileEditTool, FileReadConfig, FileReadTool, FileWriteTool, Tool,
    ToolContext, result_text,
};

fn temp_dir(label: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("rr5a-{label}-{}-{n}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn run(tool: &impl Tool, args: Value, ctx: &ToolContext) -> String {
    result_text(&tool.execute(args, &CancellationToken::new(), ctx).await).to_string()
}

fn required(schema: &Value, name: &str) -> bool {
    schema
        .get("required")
        .and_then(Value::as_array)
        .map(|items| items.iter().any(|item| item.as_str() == Some(name)))
        .unwrap_or(false)
}

fn read_fixture() -> PathBuf {
    let dir = temp_dir("file-read");
    std::fs::write(
        dir.join("hello.txt"),
        "line one\nline two\nline three\nline four\nline five\n",
    )
    .unwrap();
    std::fs::write(dir.join("empty.txt"), "").unwrap();
    std::fs::write(dir.join("no-trailing-newline.txt"), "hello\nworld").unwrap();
    let mut bin = vec![0u8; 100];
    let prefix = b"not all text";
    bin[..prefix.len()].copy_from_slice(prefix);
    bin[50] = 0;
    std::fs::write(dir.join("binary.bin"), bin).unwrap();
    dir
}

#[tokio::test]
async fn file_read_cases() {
    let dir = read_fixture();
    let ctx = ToolContext::default();
    let tool = FileReadTool::new(FileReadConfig::default());
    let hello = dir.join("hello.txt");
    let numbered = run(&tool, json!({"path": hello}), &ctx).await;
    assert!(numbered.contains("1 | line one"));
    assert!(numbered.contains("5 | line five"));
    let plain = run(&tool, json!({"path": hello, "line_numbers": false}), &ctx).await;
    assert!(!plain.contains(" | "));
    assert!(plain.contains("line one"));
    let range = run(
        &tool,
        json!({"path": hello, "start_line": 2, "end_line": 4}),
        &ctx,
    )
    .await;
    assert!(range.contains("line two"));
    assert!(range.contains("line four"));
    assert!(!range.contains("line one"));
    assert!(!range.contains("line five"));
    let binary = run(&tool, json!({"path": dir.join("binary.bin")}), &ctx).await;
    assert!(binary.contains("Binary file"));
    let missing = run(&tool, json!({"path": dir.join("nope.txt")}), &ctx).await;
    assert!(missing.contains("Error"));
    assert!(missing.contains("not found"));
    let limited = FileReadTool::new(FileReadConfig {
        max_file_size: 10,
        ..FileReadConfig::default()
    });
    let too_big = run(&limited, json!({"path": hello}), &ctx).await;
    assert!(too_big.contains("Error"));
    assert!(too_big.contains("exceeds"));
    assert_eq!(
        run(&tool, json!({"path": dir.join("empty.txt")}), &ctx).await,
        ""
    );
    let no_nl = run(
        &tool,
        json!({"path": dir.join("no-trailing-newline.txt")}),
        &ctx,
    )
    .await;
    assert!(no_nl.contains("hello"));
    assert!(no_nl.contains("world"));
    let relative = run(
        &tool,
        json!({"path": "hello.txt"}),
        &ToolContext::with_working_dir(&dir),
    )
    .await;
    assert!(relative.contains("line one"));
    let beyond = run(&tool, json!({"path": hello, "start_line": 100}), &ctx).await;
    assert!(beyond.contains("Error"));
    assert!(beyond.contains("exceeds"));
    assert!(
        run(&tool, json!({"path": ""}), &ctx)
            .await
            .contains("Error")
    );
    assert_eq!(tool.name(), "file_read");
    assert!(!tool.description().is_empty());
    assert_eq!(tool.parameters()["type"], "object");
    assert!(required(&tool.parameters(), "path"));
    let sidecar = FileReadTool::sidecar(FileReadConfig::default());
    assert!(sidecar.description().contains("Mirrors"));
    assert!(
        sidecar.parameters()["properties"]["path"]["description"]
            .as_str()
            .unwrap()
            .contains("MCP server cwd")
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn file_write_cases() {
    let dir = temp_dir("file-write");
    let ctx = ToolContext::default();
    let tool = FileWriteTool::new();
    let created = dir.join("new.txt");
    let result = run(
        &tool,
        json!({"path": created, "content": "hello world"}),
        &ctx,
    )
    .await;
    assert!(result.contains("Created"));
    assert!(result.contains("11 bytes"));
    assert_eq!(std::fs::read_to_string(&created).unwrap(), "hello world");
    let overwrite = dir.join("overwrite.txt");
    std::fs::write(&overwrite, "old content").unwrap();
    let result = run(
        &tool,
        json!({"path": overwrite, "content": "new content"}),
        &ctx,
    )
    .await;
    assert!(result.contains("Updated"));
    assert_eq!(std::fs::read_to_string(&overwrite).unwrap(), "new content");
    let backup = dir.join("backup.txt");
    std::fs::write(&backup, "original").unwrap();
    let result = run(
        &tool,
        json!({"path": backup, "content": "replaced", "backup": true}),
        &ctx,
    )
    .await;
    assert!(result.contains("backup"));
    assert_eq!(std::fs::read_to_string(&backup).unwrap(), "replaced");
    assert_eq!(
        std::fs::read_to_string(Path::new(&format!("{}.bak", backup.display()))).unwrap(),
        "original"
    );
    let nested = dir.join("deep").join("nested").join("dir").join("file.txt");
    let result = run(&tool, json!({"path": nested, "content": "deep"}), &ctx).await;
    assert!(result.contains("Created"));
    assert_eq!(std::fs::read_to_string(&nested).unwrap(), "deep");
    let unicode = dir.join("unicode.txt");
    let content = "你好世界 🌍 café";
    let _ = run(&tool, json!({"path": unicode, "content": content}), &ctx).await;
    assert_eq!(std::fs::read_to_string(&unicode).unwrap(), content);
    let result = run(
        &tool,
        json!({"path": "relative.txt", "content": "test"}),
        &ToolContext::with_working_dir(&dir),
    )
    .await;
    assert!(result.contains("Created"));
    assert!(dir.join("relative.txt").is_file());
    assert!(
        run(&tool, json!({"path": "", "content": "nope"}), &ctx)
            .await
            .contains("Error")
    );
    assert_eq!(tool.name(), "file_write");
    assert!(!tool.description().is_empty());
    assert!(required(&tool.parameters(), "path"));
    assert!(required(&tool.parameters(), "content"));
    assert_ne!(tool.description(), FileWriteTool::sidecar().description());
    assert_eq!(FileWriteTool::sidecar().name(), "file_write");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn file_edit_cases() {
    let dir = temp_dir("file-edit");
    let ctx = ToolContext::default();
    let tool = FileEditTool::new();
    let edit1 = dir.join("edit1.txt");
    std::fs::write(&edit1, "hello world\nfoo bar\nbaz qux\n").unwrap();
    let result = run(
        &tool,
        json!({"path": edit1, "old_string": "foo bar", "new_string": "foo replaced"}),
        &ctx,
    )
    .await;
    assert!(result.contains("Edited"));
    assert_eq!(
        std::fs::read_to_string(&edit1).unwrap(),
        "hello world\nfoo replaced\nbaz qux\n"
    );
    let context_file = dir.join("edit-context.txt");
    std::fs::write(
        &context_file,
        "line1\nline2\nline3\nline4\nline5\nline6\nline7\n",
    )
    .unwrap();
    let result = run(
        &tool,
        json!({"path": context_file, "old_string": "line4", "new_string": "REPLACED"}),
        &ctx,
    )
    .await;
    assert!(result.contains("REPLACED"));
    assert!(result.contains("line"));
    let miss = dir.join("edit-miss.txt");
    std::fs::write(&miss, "hello world\n").unwrap();
    let result = run(
        &tool,
        json!({"path": miss, "old_string": "not here", "new_string": "nope"}),
        &ctx,
    )
    .await;
    assert!(result.contains("Error"));
    assert!(result.contains("not found"));
    assert_eq!(std::fs::read_to_string(&miss).unwrap(), "hello world\n");
    let ambiguous = dir.join("edit-ambiguous.txt");
    std::fs::write(&ambiguous, "foo\nbar\nfoo\nbaz\n").unwrap();
    let result = run(
        &tool,
        json!({"path": ambiguous, "old_string": "foo", "new_string": "qux"}),
        &ctx,
    )
    .await;
    assert!(result.contains("Error"));
    assert!(result.contains("2 times"));
    assert_eq!(
        std::fs::read_to_string(&ambiguous).unwrap(),
        "foo\nbar\nfoo\nbaz\n"
    );
    let missing = run(
        &tool,
        json!({"path": dir.join("nope.txt"), "old_string": "a", "new_string": "b"}),
        &ctx,
    )
    .await;
    assert!(missing.contains("Error"));
    assert!(missing.contains("not found"));
    let empty = dir.join("edit-empty.txt");
    std::fs::write(&empty, "content\n").unwrap();
    let result = run(
        &tool,
        json!({"path": empty, "old_string": "", "new_string": "new"}),
        &ctx,
    )
    .await;
    assert!(result.contains("Error"));
    assert!(result.contains("empty"));
    let multi = dir.join("edit-multi.txt");
    std::fs::write(&multi, "start\nold line 1\nold line 2\nend\n").unwrap();
    let result = run(
        &tool,
        json!({
            "path": multi,
            "old_string": "old line 1\nold line 2",
            "new_string": "new line 1\nnew line 2\nnew line 3"
        }),
        &ctx,
    )
    .await;
    assert!(result.contains("Edited"));
    assert_eq!(
        std::fs::read_to_string(&multi).unwrap(),
        "start\nnew line 1\nnew line 2\nnew line 3\nend\n"
    );
    let relative = dir.join("edit-rel.txt");
    std::fs::write(&relative, "before\n").unwrap();
    let result = run(
        &tool,
        json!({"path": "edit-rel.txt", "old_string": "before", "new_string": "after"}),
        &ToolContext::with_working_dir(&dir),
    )
    .await;
    assert!(result.contains("Edited"));
    assert_eq!(std::fs::read_to_string(&relative).unwrap(), "after\n");
    assert_eq!(tool.name(), "file_edit");
    assert!(!tool.description().is_empty());
    assert!(required(&tool.parameters(), "path"));
    assert!(required(&tool.parameters(), "old_string"));
    assert!(required(&tool.parameters(), "new_string"));
    let sidecar = FileEditTool::sidecar();
    assert!(
        sidecar.parameters()["properties"]["old_string"]["description"]
            .as_str()
            .unwrap()
            .contains("must match exactly once")
    );
    let _ = std::fs::remove_dir_all(&dir);
}
