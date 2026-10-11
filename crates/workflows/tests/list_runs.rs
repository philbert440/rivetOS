use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::Mutex;

use serde_json::json;
use workflows::{ListRunsOptions, list_child_runs, list_runs, list_workflow_defs};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_root(label: &str) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("wf-{label}-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_case(dir: &std::path::Path, id: &str, workflow_id: &str, started_at: &str) {
    std::fs::create_dir_all(dir).unwrap();
    let body = json!({
        "run": {
            "id": id,
            "workflowId": workflow_id,
            "version": "1.0.0",
            "startedBy": {"type": "human"},
            "caseDir": dir.display().to_string(),
            "status": "done",
            "startedAt": started_at
        },
        "fields": {}
    });
    std::fs::write(
        dir.join("case.json"),
        format!("{}\n", serde_json::to_string_pretty(&body).unwrap()),
    )
    .unwrap();
}

#[tokio::test]
async fn returns_newest_first_and_skips_garbage() {
    let root = temp_root("list");
    write_case(
        &root.join("run-a"),
        "run-a",
        "wf",
        "2026-01-02T00:00:00.000Z",
    );
    write_case(
        &root.join("run-b"),
        "run-b",
        "wf",
        "2026-01-03T00:00:00.000Z",
    );
    std::fs::create_dir_all(root.join("junk")).unwrap();
    std::fs::write(root.join("junk").join("case.json"), "{not json").unwrap();
    std::fs::create_dir_all(root.join("empty")).unwrap();
    let warns = Mutex::new(Vec::new());
    let runs = list_runs(
        &root,
        ListRunsOptions {
            limit: Some(10),
            depth: None,
        },
        &|message| warns.lock().push(message.to_string()),
    )
    .await
    .unwrap();
    assert_eq!(
        runs.iter().map(|run| run.id.as_str()).collect::<Vec<_>>(),
        vec!["run-b", "run-a"]
    );
    assert!(warns.lock().iter().any(|item| item.contains("junk")));
}

#[tokio::test]
async fn lists_nested_children() {
    let root = temp_root("list-child");
    let parent = root.join("parent");
    write_case(&parent, "parent", "wf", "2026-01-01T00:00:00.000Z");
    write_case(
        &parent.join("child-1"),
        "child-1",
        "child-wf",
        "2026-01-04T00:00:00.000Z",
    );
    let children = list_child_runs(&parent, &|_message| {}).await.unwrap();
    assert_eq!(children.len(), 1);
    assert_eq!(children[0].id, "child-1");
    assert!(children[0].nested);
    assert_eq!(children[0].parent_run_id.as_deref(), Some("parent"));
}

#[tokio::test]
async fn empty_and_missing_roots_are_empty() {
    let root = temp_root("list-empty");
    let missing = root.join("nope");
    let runs = list_runs(&missing, ListRunsOptions::default(), &|_message| {})
        .await
        .unwrap();
    assert!(runs.is_empty());
    let empty = root.join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    let runs = list_runs(&empty, ListRunsOptions::default(), &|_message| {})
        .await
        .unwrap();
    assert!(runs.is_empty());
}

#[tokio::test]
async fn loads_valid_defs_and_skips_broken() {
    let root = temp_root("defs");
    let defs = root.join("defs");
    let good = defs.join("hello");
    std::fs::create_dir_all(good.join("agents")).unwrap();
    std::fs::write(
        good.join("workflow.yaml"),
        "id: hello\nversion: \"0.1.0\"\nname: Hello\ninput: []\noutput: []\n",
    )
    .unwrap();
    std::fs::write(
        good.join("run.ts"),
        "export default async function run() {}\n",
    )
    .unwrap();
    let bad = defs.join("broken");
    std::fs::create_dir_all(&bad).unwrap();
    std::fs::write(bad.join("workflow.yaml"), "id: only\n").unwrap();
    let warns = Mutex::new(Vec::new());
    let loaded = list_workflow_defs(&[defs], &|message| {
        warns.lock().push(message.to_string());
    })
    .await
    .unwrap();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].manifest.id, "hello");
    assert!(warns.lock().iter().any(|item| item.contains("broken")));
}

#[tokio::test]
async fn runs_sort_started_at_with_locale_compare() {
    let root = temp_root("locale-runs");
    write_case(&root.join("run-lower"), "run-lower", "wf", "readme.md");
    write_case(&root.join("run-upper"), "run-upper", "wf", "README.md");
    let runs = list_runs(&root, ListRunsOptions::default(), &|_message| {})
        .await
        .unwrap();
    assert_eq!(
        runs.iter().map(|run| run.id.as_str()).collect::<Vec<_>>(),
        vec!["run-upper", "run-lower"]
    );
}

#[tokio::test]
async fn defs_sort_names_with_locale_compare() {
    let root = temp_root("locale-defs");
    let defs = root.join("defs");
    write_def(&defs.join("upper"), "upper", "README.md");
    write_def(&defs.join("zebra"), "zebra", "Zebra");
    write_def(&defs.join("apple"), "apple", "apple");
    write_def(&defs.join("lower"), "lower", "readme.md");
    let loaded = list_workflow_defs(&[defs], &|_message| {}).await.unwrap();
    let names: Vec<_> = loaded
        .iter()
        .map(|item| item.manifest.name.as_str())
        .collect();
    assert_eq!(names, vec!["apple", "readme.md", "README.md", "Zebra"]);
}

fn write_def(dir: &std::path::Path, id: &str, name: &str) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(
        dir.join("workflow.yaml"),
        format!("id: {id}\nversion: \"0.1.0\"\nname: \"{name}\"\ninput: []\noutput: []\n"),
    )
    .unwrap();
    std::fs::write(
        dir.join("run.ts"),
        "export default async function run() {}\n",
    )
    .unwrap();
}
