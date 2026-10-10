use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use tools::{
    CancellationToken, SearchGlobConfig, SearchGlobTool, SearchGrepConfig, SearchGrepTool, Tool,
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

#[tokio::test]
async fn search_glob_cases() {
    let dir = temp_dir("glob");
    std::fs::create_dir_all(dir.join("src/utils")).unwrap();
    std::fs::create_dir_all(dir.join("src/tools")).unwrap();
    std::fs::create_dir_all(dir.join("node_modules/dep")).unwrap();
    std::fs::write(dir.join("src/index.ts"), "export {};").unwrap();
    std::fs::write(dir.join("src/utils/helper.ts"), "export {};").unwrap();
    std::fs::write(dir.join("src/tools/shell.ts"), "export {};").unwrap();
    std::fs::write(dir.join("src/tools/shell.test.ts"), "test").unwrap();
    std::fs::write(dir.join("README.md"), "# test").unwrap();
    std::fs::write(
        dir.join("node_modules/dep/index.js"),
        "module.exports = {};",
    )
    .unwrap();
    let ctx = ToolContext::with_working_dir(&dir);
    let tool = SearchGlobTool::new(SearchGlobConfig::default());
    let found = run(&tool, json!({"pattern": "**/*.ts"}), &ctx).await;
    assert!(found.contains("index.ts"), "{found}");
    assert!(found.contains("helper.ts"));
    assert!(found.contains("shell.ts"));
    let js = run(&tool, json!({"pattern": "**/*.js"}), &ctx).await;
    assert!(!js.contains("node_modules"), "{js}");
    let none = run(&tool, json!({"pattern": "**/*.xyz"}), &ctx).await;
    assert!(none.contains("No files"), "{none}");
    let limited = SearchGlobTool::new(SearchGlobConfig {
        max_results: 2,
        ..SearchGlobConfig::default()
    });
    let capped = run(&limited, json!({"pattern": "**/*.ts"}), &ctx).await;
    assert!(capped.contains("2+"), "{capped}");
    let src = run(
        &tool,
        json!({"pattern": "*.ts", "cwd": dir.join("src")}),
        &ToolContext::default(),
    )
    .await;
    assert!(src.contains("index.ts"), "{src}");
    assert!(
        run(&tool, json!({"pattern": ""}), &ctx)
            .await
            .contains("Error")
    );
    assert_eq!(tool.name(), "search_glob");
    assert!(!tool.description().is_empty());
    assert!(required(&tool.parameters(), "pattern"));
    let sidecar = SearchGlobTool::sidecar(SearchGlobConfig::default());
    assert!(sidecar.description().contains("Mirrors"));
    assert!(
        sidecar.parameters()["properties"]["cwd"]["description"]
            .as_str()
            .unwrap()
            .contains("MCP server cwd")
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn search_grep_cases() {
    let dir = temp_dir("grep");
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::create_dir_all(dir.join("node_modules/dep")).unwrap();
    std::fs::write(
        dir.join("src/index.ts"),
        "const foo = \"hello\";\nconst bar = \"world\";\nexport { foo, bar };\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("src/utils.ts"),
        "export function greet() {\n  return \"hello world\";\n}\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("README.md"),
        "# Hello World\n\nThis is a test project.\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("node_modules/dep/index.js"),
        "const hello = \"should be excluded\";\n",
    )
    .unwrap();
    let ctx = ToolContext::with_working_dir(&dir);
    let tool = SearchGrepTool::new(SearchGrepConfig::default());
    let found = run(&tool, json!({"pattern": "hello"}), &ctx).await;
    assert!(found.contains("hello"), "{found}");
    assert!(found.contains("index.ts"));
    assert!(!found.contains("node_modules"), "{found}");
    let none = run(&tool, json!({"pattern": "zzzznotfound"}), &ctx).await;
    assert!(none.contains("No matches"), "{none}");
    let insensitive = run(
        &tool,
        json!({"pattern": "HELLO", "case_insensitive": true}),
        &ctx,
    )
    .await;
    assert!(
        insensitive.contains("hello") || insensitive.contains("Hello"),
        "{insensitive}"
    );
    let fixed = run(
        &tool,
        json!({"pattern": "foo, bar", "fixed_strings": true}),
        &ctx,
    )
    .await;
    assert!(fixed.contains("foo, bar"), "{fixed}");
    let included = run(&tool, json!({"pattern": "hello", "include": "*.ts"}), &ctx).await;
    assert!(included.contains(".ts"), "{included}");
    assert!(!included.contains("README"), "{included}");
    let file = run(
        &tool,
        json!({"pattern": "Hello", "path": dir.join("README.md")}),
        &ToolContext::default(),
    )
    .await;
    assert!(file.contains("Hello"), "{file}");
    assert!(
        run(&tool, json!({"pattern": ""}), &ctx)
            .await
            .contains("Error")
    );
    assert_eq!(tool.name(), "search_grep");
    assert!(!tool.description().is_empty());
    assert!(required(&tool.parameters(), "pattern"));
    let sidecar = SearchGrepTool::sidecar(SearchGrepConfig::default());
    assert!(sidecar.description().contains("Mirrors"));
    assert!(
        sidecar.parameters()["properties"]["path"]["description"]
            .as_str()
            .unwrap()
            .contains("MCP server cwd")
    );
    let _ = std::fs::remove_dir_all(&dir);
}
