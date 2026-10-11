use std::sync::Arc;
use std::time::{Duration, Instant};

use hooks::{
    FileWriter, FsFileWriter, HookContext, HookPipeline, OUTPUT_CAP, ProcessShell, SHELL_TIMEOUT,
    SessionHooksContext, ShellExecutor, ShellOutput, create_session_start_hook,
};

#[tokio::test]
async fn process_shell_stays_inside_temp_dirs() {
    assert_eq!(SHELL_TIMEOUT, Duration::from_secs(30));
    assert_eq!(OUTPUT_CAP, 1024 * 1024);
    let dir = super::common::make_temp().await;
    let shell = ProcessShell::new(&dir);
    let wrote = shell
        .exec("printf hi > marker.txt", None)
        .await
        .expect("write");
    assert_eq!(wrote.exit_code, 0);
    assert_eq!(wrote.stderr, "");
    let text = tokio::fs::read_to_string(dir.join("marker.txt"))
        .await
        .expect("marker");
    assert_eq!(text, "hi");
    let noisy = shell
        .exec("printf out; printf err >&2", None)
        .await
        .expect("noisy");
    assert_eq!(noisy.stdout, "out");
    assert_eq!(noisy.stderr, "");
    assert_eq!(noisy.exit_code, 0);
    let failed = shell
        .exec("printf err >&2; exit 3", None)
        .await
        .expect("failed");
    assert_eq!(failed.exit_code, 3);
    assert_eq!(failed.stderr, "err");
    assert_eq!(failed.stdout, "");
    let capped = ProcessShell::new(&dir).with_output_cap(4);
    let exact = capped.exec("printf 1234", None).await.expect("exact");
    assert_eq!(exact.stdout, "1234");
    assert_eq!(exact.stderr, "");
    assert_eq!(exact.exit_code, 0);
    let cut = ProcessShell::new(&dir)
        .with_output_cap(4)
        .exec("printf 123456789", None)
        .await
        .expect("cap");
    assert_eq!(cut.stdout, "1234");
    assert_eq!(cut.stderr, "");
    assert_eq!(cut.exit_code, 1);
    let err_cut = ProcessShell::new(&dir)
        .with_output_cap(4)
        .exec("printf 123456789 >&2", None)
        .await
        .expect("stderr cap");
    assert_eq!(err_cut.stderr, "1234");
    assert_eq!(err_cut.exit_code, 1);
    let mixed = ProcessShell::new(&dir)
        .with_output_cap(4)
        .exec("printf 123456789; printf xyz >&2; exit 0", None)
        .await
        .expect("mixed cap");
    assert_eq!(mixed.stdout, "1234");
    assert_eq!(mixed.stderr, "xyz");
    assert_eq!(mixed.exit_code, 1);
    let timed = ProcessShell::new(&dir).with_timeout(Duration::from_millis(200));
    let started = Instant::now();
    let timeout = timed.exec("sleep 30", None).await.expect("timeout");
    assert_eq!(timeout.exit_code, 1);
    assert!(started.elapsed() < Duration::from_secs(5));
    let started = Instant::now();
    let background = ProcessShell::new(&dir)
        .with_timeout(Duration::from_millis(300))
        .exec("sleep 30 &", None)
        .await
        .expect("background");
    assert_eq!(background.exit_code, 1);
    assert!(started.elapsed() < Duration::from_secs(5));
    let other = super::common::make_temp().await;
    let elsewhere = shell
        .exec(
            "printf there > marker.txt",
            Some(other.to_str().expect("utf8")),
        )
        .await
        .expect("cwd");
    assert_eq!(elsewhere.exit_code, 0);
    let moved = tokio::fs::read_to_string(other.join("marker.txt"))
        .await
        .expect("other");
    assert_eq!(moved, "there");
    let missing = dir.join("missing-dir");
    let rejected = shell
        .exec("printf hi", Some(missing.to_str().expect("utf8")))
        .await
        .expect("cwd");
    assert_eq!(
        rejected,
        ShellOutput {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: 1,
        }
    );
    let _ = tokio::fs::remove_dir_all(&dir).await;
    let _ = tokio::fs::remove_dir_all(&other).await;
}

#[tokio::test]
async fn file_writer_creates_parents_and_swallows_missing_reads() {
    let dir = super::common::make_temp().await;
    let writer = FsFileWriter;
    let path = dir.join("memory").join("note.md");
    let path_text = path.to_str().expect("utf8");
    writer.write(path_text, "hello").await.expect("write");
    writer.append(path_text, " world").await.expect("append");
    let read = writer.read(path_text).await.expect("read");
    assert_eq!(read.as_deref(), Some("hello world"));
    let missing = writer
        .read(dir.join("nope.md").to_str().expect("utf8"))
        .await
        .expect("missing");
    assert_eq!(missing, None);
    let invalid = dir.join("memory").join(format!("{}.md", hooks::utc_date()));
    let invalid_text = invalid.to_str().expect("utf8");
    tokio::fs::write(invalid_text, b"hello \xff world")
        .await
        .expect("bytes");
    let replaced = writer.read(invalid_text).await.expect("replaced");
    assert_eq!(replaced.as_deref(), Some("hello \u{FFFD} world"));
    let workspace = dir.to_str().expect("utf8").to_string();
    let pipeline = HookPipeline::new();
    pipeline.register(create_session_start_hook(SessionHooksContext {
        shell: None,
        file_writer: Some(Arc::new(FsFileWriter)),
        workspace_dir: Some(workspace),
    }));
    let mut ctx = HookContext::session_start();
    pipeline.run(&mut ctx).await;
    assert_eq!(
        ctx.metadata
            .get("dailyContext")
            .and_then(|value| value.as_str()),
        Some("hello \u{FFFD} world")
    );
    let _ = tokio::fs::remove_dir_all(&dir).await;
}

#[tokio::test]
async fn cancelling_a_shell_kills_the_process_group() {
    let dir = super::common::make_temp().await;
    let shell = ProcessShell::new(&dir).with_timeout(Duration::from_secs(30));
    let task = tokio::spawn(async move {
        shell
            .exec(
                "printf go > started; (sleep 3; printf leaked > leaked) & printf bg > bg; sleep 30",
                None,
            )
            .await
    });
    let bg = dir.join("bg");
    let mut saw_bg = false;
    for _ in 0..100 {
        if tokio::fs::metadata(&bg).await.is_ok() {
            saw_bg = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(saw_bg);
    task.abort();
    let _ = task.await;
    tokio::time::sleep(Duration::from_millis(3500)).await;
    assert!(tokio::fs::metadata(dir.join("leaked")).await.is_err());
    let _ = tokio::fs::remove_dir_all(&dir).await;
}
