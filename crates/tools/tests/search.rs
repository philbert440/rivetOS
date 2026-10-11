use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
    std::fs::write(dir.join(".gitignore"), "secret\n").unwrap();
    std::fs::create_dir_all(dir.join(".hidden")).unwrap();
    std::fs::write(dir.join(".hidden").join("file.ts"), "export {};").unwrap();
    let star = run(&tool, json!({"pattern": "*"}), &ctx).await;
    assert!(star.contains("src"), "{star}");
    assert!(star.contains("README.md"), "{star}");
    assert!(!star.contains(".gitignore"), "{star}");
    assert!(!star.contains("index.ts"), "{star}");
    let just_src = run(&tool, json!({"pattern": "src"}), &ctx).await;
    assert!(
        just_src.contains("\nsrc\n") || just_src.ends_with("\nsrc") || just_src.contains("src\n"),
        "{just_src}"
    );
    assert!(!just_src.contains("index.ts"), "{just_src}");
    let dotted = run(&tool, json!({"pattern": ".*"}), &ctx).await;
    assert!(dotted.contains(".gitignore"), "{dotted}");
    let hidden = run(&tool, json!({"pattern": "**/*.ts"}), &ctx).await;
    assert!(!hidden.contains(".hidden"), "{hidden}");
    let outside = temp_dir("glob-outside");
    std::fs::write(outside.join("secret.txt"), "nope").unwrap();
    std::os::unix::fs::symlink(&outside, dir.join("link")).unwrap();
    let linked = run(&tool, json!({"pattern": "**/*.txt"}), &ctx).await;
    assert!(!linked.contains("secret.txt"), "{linked}");
    let link_name = run(&tool, json!({"pattern": "*"}), &ctx).await;
    assert!(link_name.contains("link"), "{link_name}");
    let started = std::time::Instant::now();
    let dotfile = run(&tool, json!({"pattern": "**/.gitignore"}), &ctx).await;
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{dotfile} elapsed {:?}",
        started.elapsed()
    );
    assert_eq!(dotfile, "Found 1 files:\n.gitignore");
    let missing_env = run(&tool, json!({"pattern": "**/.env"}), &ctx).await;
    assert!(
        missing_env.starts_with("No files matching"),
        "{missing_env}"
    );
    assert!(!missing_env.contains(".."), "{missing_env}");
    let dot_child = run(&tool, json!({"pattern": ".*/*"}), &ctx).await;
    assert_eq!(dot_child, "Found 1 files:\n.hidden/file.ts");
    let dotted_prefix = run(&tool, json!({"pattern": "./src/tools/*.ts"}), &ctx).await;
    assert_eq!(
        dotted_prefix,
        "Found 2 files:\nsrc/tools/shell.test.ts\nsrc/tools/shell.ts"
    );
    let dotted_middle = run(&tool, json!({"pattern": "src/./tools/*.ts"}), &ctx).await;
    assert_eq!(dotted_middle, dotted_prefix);
    let collapsed = run(&tool, json!({"pattern": "src/../README.md"}), &ctx).await;
    assert_eq!(collapsed, "Found 1 files:\nREADME.md");
    let absolute = format!("{}/src/tools/*.ts", dir.display());
    let absolute_found = run(&tool, json!({"pattern": absolute}), &ToolContext::default()).await;
    let root = dir.display();
    assert_eq!(
        absolute_found,
        format!("Found 2 files:\n{root}/src/tools/shell.test.ts\n{root}/src/tools/shell.ts")
    );
    let cancel = CancellationToken::new();
    cancel.cancel();
    let aborted = tool
        .execute(json!({"pattern": "**/*"}), &cancel, &ctx)
        .await;
    assert_eq!(result_text(&aborted), "Error: glob walk aborted");
    let expired = SearchGlobTool::new(SearchGlobConfig {
        walk_timeout: Duration::ZERO,
        ..SearchGlobConfig::default()
    });
    let timed = run(&expired, json!({"pattern": "**/*"}), &ctx).await;
    assert_eq!(timed, "Error: glob walk timed out");
    let project = temp_dir("glob-brace");
    std::fs::create_dir_all(project.join("src")).unwrap();
    std::fs::create_dir_all(project.join("tests")).unwrap();
    std::fs::create_dir_all(project.join("other")).unwrap();
    std::fs::write(project.join("src/main.ts"), "export {};").unwrap();
    std::fs::write(project.join("tests/main.ts"), "export {};").unwrap();
    std::fs::write(project.join("other/main.ts"), "export {};").unwrap();
    let pattern = format!("{}/{{src,tests}}/*.ts", project.display());
    let braced = run(&tool, json!({"pattern": pattern}), &ToolContext::default()).await;
    let shown = project.display();
    assert_eq!(
        braced,
        format!("Found 2 files:\n{shown}/src/main.ts\n{shown}/tests/main.ts"),
        "{braced}"
    );
    assert!(!braced.contains("other"), "{braced}");
    let relative = run(
        &tool,
        json!({"pattern": "{src,tests}/*.ts", "cwd": &project}),
        &ToolContext::default(),
    )
    .await;
    assert_eq!(relative, "Found 2 files:\nsrc/main.ts\ntests/main.ts");
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&outside);
    let _ = std::fs::remove_dir_all(&project);
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
    let slow = SearchGrepTool::new(SearchGrepConfig {
        timeout: Duration::from_millis(300),
        ..SearchGrepConfig::default()
    });
    let started = std::time::Instant::now();
    let timed = run(
        &slow,
        json!({"pattern": "zzzznotfound", "path": "/dev/zero"}),
        &ToolContext::default(),
    )
    .await;
    assert!(
        started.elapsed() < Duration::from_secs(8),
        "{timed} elapsed {:?}",
        started.elapsed()
    );
    assert!(!timed.contains("Command timed out"), "{timed}");
    assert!(timed.contains("No matches"), "{timed}");
    let _ = std::fs::remove_dir_all(&dir);
}
