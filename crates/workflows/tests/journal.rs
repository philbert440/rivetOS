use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Map, Value, json};
use workflows::{
    CacheSource, CachedStep, JournalEntry, StartedBy, StartedByType, StepKind, WorkflowError,
    append_journal, find_cached_step_result, is_open_gate, journal_path, max_seq_for_label,
    parse_journal, read_journal,
};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_root(label: &str) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("wf-{label}-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn started_by() -> StartedBy {
    StartedBy::new(StartedByType::Human)
}

fn sample_entries() -> (JournalEntry, JournalEntry) {
    let started = JournalEntry::RunStarted {
        ts: "2026-01-01T00:00:00.000Z".to_string(),
        run_id: "r1".to_string(),
        workflow_id: "w".to_string(),
        version: "1".to_string(),
        input: Map::new(),
        started_by: started_by(),
        parent: None,
    };
    let finished = JournalEntry::StepFinished {
        ts: "2026-01-01T00:00:01.000Z".to_string(),
        step_id: "a#1".to_string(),
        label: "a".to_string(),
        seq: 1,
        kind: StepKind::Agent,
        result: json!({"x": 1}),
        usage: None,
    };
    (started, finished)
}

#[tokio::test]
async fn appends_and_reads_jsonl_entries() {
    let dir = temp_root("journal");
    let (started, finished) = sample_entries();
    append_journal(&dir, &started).await.unwrap();
    append_journal(&dir, &finished).await.unwrap();
    let all = read_journal(&dir).await.unwrap();
    assert_eq!(all.len(), 2);
    match &all[1] {
        JournalEntry::StepFinished { result, .. } => assert_eq!(result, &json!({"x": 1})),
        other => panic!("unexpected {other:?}"),
    }
    let raw = std::fs::read_to_string(journal_path(&dir)).unwrap();
    let expected = include_str!("fixtures/journal/sample.jsonl");
    assert_eq!(raw, expected);
    let parsed = parse_journal(expected).unwrap();
    assert_eq!(parsed, all);
}

#[test]
fn find_cached_step_result_prefers_finished_and_resolved() {
    let entries = vec![
        JournalEntry::StepFinished {
            ts: "t".to_string(),
            step_id: "a#1".to_string(),
            label: "a".to_string(),
            seq: 1,
            kind: StepKind::Run,
            result: json!(42),
            usage: None,
        },
        JournalEntry::GateResolved {
            ts: "t".to_string(),
            step_id: "g#1".to_string(),
            label: "g".to_string(),
            seq: 1,
            values: {
                let mut values = Map::new();
                values.insert("ok".to_string(), Value::Bool(true));
                values
            },
        },
    ];
    match find_cached_step_result(&entries, "a", 1, None).unwrap() {
        CachedStep::Hit { result, from } => {
            assert_eq!(result, json!(42));
            assert_eq!(from, CacheSource::StepFinished);
        }
        CachedStep::Miss => panic!("expected hit"),
    }
    match find_cached_step_result(&entries, "g", 1, None).unwrap() {
        CachedStep::Hit { result, from } => {
            assert_eq!(result, json!({"ok": true}));
            assert_eq!(from, CacheSource::GateResolved);
        }
        CachedStep::Miss => panic!("expected hit"),
    }
    assert!(
        !find_cached_step_result(&entries, "a", 2, None)
            .unwrap()
            .hit()
    );
}

#[test]
fn max_seq_and_open_gate() {
    let mut entries = vec![
        JournalEntry::GateOpened {
            ts: "t".to_string(),
            step_id: "g#1".to_string(),
            label: "g".to_string(),
            seq: 1,
            prompt: None,
            fields: vec!["a".to_string()],
        },
        JournalEntry::StepFinished {
            ts: "t".to_string(),
            step_id: "x#2".to_string(),
            label: "x".to_string(),
            seq: 2,
            kind: StepKind::Run,
            result: Value::Null,
            usage: None,
        },
    ];
    assert_eq!(max_seq_for_label(&entries, "g"), 1);
    assert_eq!(max_seq_for_label(&entries, "x"), 2);
    assert!(is_open_gate(&entries, "g", 1));
    entries.push(JournalEntry::GateResolved {
        ts: "t".to_string(),
        step_id: "g#1".to_string(),
        label: "g".to_string(),
        seq: 1,
        values: Map::new(),
    });
    assert!(!is_open_gate(&entries, "g", 1));
}

#[test]
fn kind_mismatch_both_variants() {
    let finished = vec![JournalEntry::StepFinished {
        ts: "now".to_string(),
        step_id: "x#1".to_string(),
        label: "x".to_string(),
        seq: 1,
        kind: StepKind::Run,
        result: json!({"ok": true}),
        usage: None,
    }];
    assert!(
        find_cached_step_result(&finished, "x", 1, Some("run"))
            .unwrap()
            .hit()
    );
    let err = find_cached_step_result(&finished, "x", 1, Some("agent")).unwrap_err();
    let text = err.to_string();
    assert!(text.contains("kind mismatch"), "{text}");
    assert!(text.contains("journaled as \"run\""), "{text}");
    assert!(text.contains("declares \"agent\""), "{text}");

    let mut values = Map::new();
    values.insert("ok".to_string(), Value::Bool(true));
    let gate = vec![JournalEntry::GateResolved {
        ts: "now".to_string(),
        step_id: "x#1".to_string(),
        label: "x".to_string(),
        seq: 1,
        values,
    }];
    let err = find_cached_step_result(&gate, "x", 1, Some("agent")).unwrap_err();
    let text = err.to_string();
    assert!(text.contains("human gate"), "{text}");
    assert!(text.contains("declares \"agent\""), "{text}");
    assert!(matches!(err, WorkflowError::Message(_)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn serializes_concurrent_appends() {
    let dir = temp_root("journal-race");
    let mut tasks = Vec::new();
    for index in 0..40 {
        let dir = dir.clone();
        tasks.push(tokio::spawn(async move {
            append_journal(
                &dir,
                &JournalEntry::StepFinished {
                    ts: format!("t-{index}"),
                    step_id: format!("s#{index}"),
                    label: "s".to_string(),
                    seq: index,
                    kind: StepKind::Run,
                    result: json!({"i": index, "pad": "xxxxxxxxxxxxxxxxxxxx"}),
                    usage: None,
                },
            )
            .await
        }));
    }
    for task in tasks {
        task.await.unwrap().unwrap();
    }
    let all = read_journal(&dir).await.unwrap();
    assert_eq!(all.len(), 40);
    for entry in all {
        assert_eq!(entry.entry_type(), "step_finished");
    }
}
