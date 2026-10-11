use std::os::unix::fs::PermissionsExt;

use capture::{CaptureBatch, spool_batch, spool_files};

fn batch() -> CaptureBatch {
    CaptureBatch {
        session_key: "s".to_string(),
        agent: "a".to_string(),
        channel: None,
        title: None,
        settings: None,
        task_id: None,
        finalize: None,
        created_at: None,
        updated_at: None,
        messages: Vec::new(),
    }
}

fn mode(path: &std::path::Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[tokio::test]
async fn creates_the_directory_and_ignores_temp_files_and_dead_letters() {
    let dir = tempfile::tempdir().unwrap();
    let nested = dir.path().join("new");
    assert!(spool_files(&nested).await.unwrap().is_empty());
    spool_batch(&nested, &batch(), 10).await.unwrap();
    std::fs::write(nested.join("1-old.json.tmp"), "partial").unwrap();
    std::fs::create_dir(nested.join("dead")).unwrap();
    std::fs::write(nested.join("dead").join("2-rejected.json"), "{}").unwrap();
    let files = spool_files(&nested).await.unwrap();
    assert_eq!(files.len(), 1);
    assert!(
        !files
            .iter()
            .any(|name| name == "2-rejected.json" || name.contains("dead/"))
    );
    let listed = std::fs::read_dir(&nested).unwrap().count();
    assert_eq!(listed, 3);
    assert_eq!(mode(&nested), 0o700);
    let spooled = nested.join(&files[0]);
    assert_eq!(mode(&spooled), 0o600);
}

#[tokio::test]
async fn a_file_spool_dir_reports_the_node_open_error() {
    let dir = tempfile::tempdir().unwrap();
    let blocked = dir.path().join("not-a-directory");
    std::fs::write(&blocked, "blocked").unwrap();
    let error = spool_batch(&blocked, &batch(), 10).await.unwrap_err();
    let text = error.to_string();
    assert!(text.starts_with("ENOTDIR: not a directory, open '"));
    assert!(text.contains(&blocked.display().to_string()));
    assert!(text.contains(".json.tmp'"));
}
