use std::time::{Duration, Instant};

use hooks::{FileWriter, FsFileWriter, OUTPUT_CAP, ProcessShell, SHELL_TIMEOUT, ShellExecutor};

#[tokio::test]
async fn process_shell_stays_inside_temp_dirs() {
    assert_eq!(SHELL_TIMEOUT, Duration::from_secs(30));
    assert_eq!(OUTPUT_CAP, 8 * 1024 * 1024);
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
    let cut = capped.exec("printf 123456789", None).await.expect("cap");
    assert_eq!(cut.stdout, "1234");
    assert_eq!(cut.exit_code, 0);
    let timed = ProcessShell::new(&dir).with_timeout(Duration::from_millis(200));
    let started = Instant::now();
    let timeout = timed.exec("sleep 30", None).await.expect("timeout");
    assert_eq!(timeout.exit_code, 1);
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
        .await;
    assert!(rejected.is_err());
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
    let _ = tokio::fs::remove_dir_all(&dir).await;
}
