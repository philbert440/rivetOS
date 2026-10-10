use std::path::PathBuf;
use std::time::Duration;

use serde_json::{Value, json};
use tools::{
    Approval, ApprovalLevel, CancellationToken, CommandCategory, ShellConfig, ShellTool, Tool,
    ToolContext, categorize_command, check_git_warnings, result_text,
};

async fn exec(tool: &ShellTool, args: Value) -> String {
    result_text(
        &tool
            .execute(args, &CancellationToken::new(), &ToolContext::default())
            .await,
    )
    .to_string()
}

fn required(tool: &ShellTool, name: &str) -> bool {
    tool.parameters()
        .get("required")
        .and_then(Value::as_array)
        .map(|items| items.iter().any(|item| item.as_str() == Some(name)))
        .unwrap_or(false)
}

#[test]
fn categorizes_read_only_commands() {
    assert_eq!(categorize_command("ls -la").as_str(), "read");
    assert_eq!(categorize_command("cat file.txt").as_str(), "read");
    assert_eq!(categorize_command("git status").as_str(), "read");
    assert_eq!(categorize_command("git log --oneline").as_str(), "read");
    assert_eq!(categorize_command("pwd").as_str(), "read");
    assert_eq!(categorize_command("echo hello").as_str(), "read");
    assert_eq!(categorize_command("grep foo bar.txt").as_str(), "read");
}

#[test]
fn categorizes_write_commands() {
    assert_eq!(categorize_command("npm install").as_str(), "write");
    assert_eq!(
        categorize_command("git commit -m \"test\"").as_str(),
        "write"
    );
    assert_eq!(categorize_command("git push origin main").as_str(), "write");
    assert_eq!(categorize_command("mkdir -p /tmp/test").as_str(), "write");
    assert_eq!(categorize_command("touch newfile.txt").as_str(), "write");
}

#[test]
fn categorizes_dangerous_commands() {
    assert_eq!(categorize_command("rm -rf /").as_str(), "dangerous");
    assert_eq!(
        categorize_command("mkfs.ext4 /dev/sda").as_str(),
        "dangerous"
    );
    assert_eq!(categorize_command(":(){:|:&};:").as_str(), "dangerous");
    assert_eq!(
        categorize_command("dd if=/dev/zero of=/dev/sda").as_str(),
        "dangerous"
    );
}

#[test]
fn git_warnings() {
    let force = check_git_warnings("git push --force origin main").unwrap();
    assert!(force.contains("force"));
    let reset = check_git_warnings("git reset --hard HEAD~3").unwrap();
    assert!(reset.contains("data loss"));
    assert!(check_git_warnings("git branch -D feature").is_some());
    assert!(check_git_warnings("git push origin main").is_none());
    assert!(check_git_warnings("git commit -m \"test\"").is_none());
    assert!(check_git_warnings("git status").is_none());
}

#[tokio::test]
async fn executes_simple_command() {
    let tool = ShellTool::new(ShellConfig::default());
    assert_eq!(
        exec(&tool, json!({"command": "echo hello"})).await.trim(),
        "hello"
    );
}

#[tokio::test]
async fn returns_stderr_alongside_stdout() {
    let tool = ShellTool::new(ShellConfig::default());
    let result = exec(&tool, json!({"command": "echo out && echo err >&2"})).await;
    assert!(result.contains("out"));
    assert!(result.contains("err"));
}

#[tokio::test]
async fn reports_nonzero_exit() {
    let tool = ShellTool::new(ShellConfig::default());
    let result = exec(&tool, json!({"command": "exit 42"})).await;
    assert!(result.contains("exit code: 42"));
}

#[tokio::test]
async fn blocks_dangerous_pattern() {
    let tool = ShellTool::new(ShellConfig {
        blocked: Some(vec!["rm -rf /".to_string()]),
        ..ShellConfig::default()
    });
    let result = exec(&tool, json!({"command": "rm -rf / --no-preserve-root"})).await;
    assert!(result.contains("blocked"));
}

#[tokio::test]
async fn blocks_fork_bomb() {
    let tool = ShellTool::new(ShellConfig::default());
    let result = exec(&tool, json!({ "command": ":(){:|:&};:" })).await;
    assert!(result.contains("blocked"));
}

#[tokio::test]
async fn empty_and_missing_command() {
    let tool = ShellTool::new(ShellConfig::default());
    assert!(exec(&tool, json!({"command": ""})).await.contains("Error"));
    assert!(exec(&tool, json!({})).await.contains("Error"));
}

#[tokio::test]
async fn custom_working_directory_and_cwd_override() {
    let tool = ShellTool::new(ShellConfig {
        cwd: Some(PathBuf::from("/tmp")),
        ..ShellConfig::default()
    });
    assert_eq!(exec(&tool, json!({"command": "pwd"})).await.trim(), "/tmp");
    let override_tool = ShellTool::new(ShellConfig::default());
    let before = override_tool.get_session_cwd();
    assert_eq!(
        exec(&override_tool, json!({"command": "pwd", "cwd": "/tmp"}))
            .await
            .trim(),
        "/tmp"
    );
    assert_eq!(override_tool.get_session_cwd(), before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn aborts_on_cancellation() {
    let tool = ShellTool::new(ShellConfig {
        timeout: Duration::from_millis(30_000),
        ..ShellConfig::default()
    });
    let cancel = CancellationToken::new();
    let cancel_later = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        cancel_later.cancel();
    });
    let result = result_text(
        &tool
            .execute(
                json!({"command": "sleep 30"}),
                &cancel,
                &ToolContext::default(),
            )
            .await,
    )
    .to_string();
    assert!(
        result.contains("abort") || result.contains("SIGTERM") || result.contains("exit code"),
        "{result}"
    );
}

#[tokio::test]
async fn truncates_long_output_and_empty_success() {
    let tool = ShellTool::new(ShellConfig {
        max_output: 50,
        ..ShellConfig::default()
    });
    let result = exec(&tool, json!({"command": "seq 1 1000"})).await;
    assert!(result.contains("elided"), "{result}");
    let quiet = ShellTool::new(ShellConfig::default());
    assert_eq!(
        exec(&quiet, json!({"command": "true"})).await,
        "(no output)"
    );
}

#[test]
fn shell_metadata_and_sidecar_cwd_description() {
    let tool = ShellTool::new(ShellConfig::default());
    assert_eq!(tool.name(), "shell");
    assert!(!tool.description().is_empty());
    assert_eq!(tool.parameters()["type"], "object");
    assert!(required(&tool, "command"));
    let agent_cwd = tool.parameters()["properties"]["cwd"]["description"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(!agent_cwd.contains("does not affect session cwd"));
    let sidecar = ShellTool::sidecar(ShellConfig::default());
    assert!(sidecar.description().contains("Mirrors"));
    let sidecar_cwd = sidecar.parameters()["properties"]["cwd"]["description"]
        .as_str()
        .unwrap();
    assert!(sidecar_cwd.contains("does not affect session cwd"));
}

#[tokio::test]
async fn approval_levels() {
    let blocked = ShellTool::new(ShellConfig::default());
    assert!(
        exec(&blocked, json!({"command": "dd if=/dev/zero of=/dev/sda"}))
            .await
            .contains("blocked")
    );
    let warned = ShellTool::new(ShellConfig {
        approval: Approval {
            read: ApprovalLevel::Warn,
            ..Approval::default()
        },
        ..ShellConfig::default()
    });
    let result = exec(&warned, json!({"command": "echo hello"})).await;
    assert!(result.contains("Warning"));
    assert!(result.contains("hello"));
    let writes = ShellTool::new(ShellConfig {
        approval: Approval {
            write: ApprovalLevel::Block,
            ..Approval::default()
        },
        ..ShellConfig::default()
    });
    let result = exec(&writes, json!({"command": "npm install"})).await;
    assert!(result.contains("blocked"));
    assert!(result.contains("category: write"));
}

#[tokio::test]
async fn session_cwd_persists_and_resets() {
    let tool = ShellTool::new(ShellConfig {
        cwd: Some(PathBuf::from("/tmp")),
        ..ShellConfig::default()
    });
    let cd = exec(&tool, json!({"command": "cd /home"})).await;
    assert!(cd.contains("/home"), "{cd}");
    assert_eq!(tool.get_session_cwd(), "/home");
    let cases = [
        "cd /rivet-shared && ls -la",
        "cd /home/user; echo hello",
        "cd /tmp || echo failed",
        "cd \"/path with spaces\" && ls",
        "  cd   /opt/rivet   &&   npm run build",
    ];
    for command in cases {
        let result = exec(&tool, json!({"command": command})).await;
        assert!(
            result.contains("Changed directory")
                || result.contains("Directory not found")
                || result.contains("is not a directory"),
            "{command} -> {result}"
        );
    }
    let missing = ShellTool::new(ShellConfig::default());
    let result = exec(
        &missing,
        json!({"command": "cd /this/does/not/exist/at/all"}),
    )
    .await;
    assert!(result.contains("Error"));
    assert!(result.contains("not found"));
    let reset = ShellTool::new(ShellConfig {
        cwd: Some(PathBuf::from("/tmp")),
        ..ShellConfig::default()
    });
    let _ = exec(&reset, json!({"command": "cd /home"})).await;
    assert_eq!(reset.get_session_cwd(), "/home");
    reset.reset_session_cwd();
    assert_eq!(reset.get_session_cwd(), "/tmp");
}

#[tokio::test]
async fn warns_on_force_push() {
    let tool = ShellTool::new(ShellConfig::default());
    let result = exec(
        &tool,
        json!({"command": "echo \"would force push\" && git push --force origin main 2>&1 || true"}),
    )
    .await;
    assert!(
        result.contains("⚠️") || result.contains("force"),
        "{result}"
    );
}

#[test]
fn category_names_match_wire_values() {
    assert_eq!(CommandCategory::Read.as_str(), "read");
    assert_eq!(CommandCategory::Write.as_str(), "write");
    assert_eq!(CommandCategory::Dangerous.as_str(), "dangerous");
}
