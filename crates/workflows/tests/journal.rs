use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Map, Value, json};
use workflows::{
    CacheSource, CachedStep, JournalEntry, StartedBy, StartedByType, StepKind, WireJson,
    WorkflowError, append_journal, ensure_journal, find_cached_step_result, is_open_gate,
    journal_path, max_seq_for_label, parse_journal, read_journal,
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

fn wire(value: Value) -> WireJson {
    WireJson::from_value(&value).unwrap()
}

fn sample_entries() -> (JournalEntry, JournalEntry) {
    let started = JournalEntry::RunStarted {
        ts: "2026-01-01T00:00:00.000Z".to_string(),
        run_id: "r1".to_string(),
        workflow_id: "w".to_string(),
        version: "1".to_string(),
        input: wire(Value::Object(Map::new())),
        started_by: started_by(),
        parent: None,
    };
    let finished = JournalEntry::StepFinished {
        ts: "2026-01-01T00:00:01.000Z".to_string(),
        step_id: "a#1".to_string(),
        label: "a".to_string(),
        seq: 1,
        kind: StepKind::Agent,
        result: Some(wire(json!({"x": 1}))),
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
        JournalEntry::StepFinished { result, .. } => {
            assert_eq!(
                result.as_ref().map(WireJson::to_value),
                Some(json!({"x": 1}))
            )
        }
        other => panic!("unexpected {other:?}"),
    }
    let raw = std::fs::read_to_string(journal_path(&dir)).unwrap();
    let expected = include_str!("fixtures/journal/sample.jsonl");
    assert_eq!(raw, expected);
    let parsed = parse_journal(expected).unwrap();
    assert_eq!(parsed, all);
}

#[tokio::test]
async fn ensure_journal_does_not_truncate_existing_lines() {
    let dir = temp_root("ensure-keep");
    let (started, finished) = sample_entries();
    append_journal(&dir, &started).await.unwrap();
    append_journal(&dir, &finished).await.unwrap();
    let before = std::fs::read(journal_path(&dir)).unwrap();
    assert!(before.len() > 1, "{}", before.len());
    ensure_journal(&dir).await.unwrap();
    assert_eq!(std::fs::read(journal_path(&dir)).unwrap(), before);
    let empty = temp_root("ensure-empty");
    ensure_journal(&empty).await.unwrap();
    assert_eq!(std::fs::read(journal_path(&empty)).unwrap(), b"");
    ensure_journal(&empty).await.unwrap();
    assert_eq!(std::fs::read(journal_path(&empty)).unwrap(), b"");
    let raced = temp_root("ensure-race");
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let raced = raced.clone();
        let started = started.clone();
        tasks.push(tokio::spawn(async move {
            ensure_journal(&raced).await.unwrap();
            append_journal(&raced, &started).await.unwrap();
        }));
    }
    for task in tasks {
        task.await.unwrap();
    }
    let raw = std::fs::read(journal_path(&raced)).unwrap();
    let text = String::from_utf8(raw).unwrap();
    assert_eq!(parse_journal(&text).unwrap().len(), 8, "{text}");
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
            result: Some(wire(json!(42))),
            usage: None,
        },
        JournalEntry::GateResolved {
            ts: "t".to_string(),
            step_id: "g#1".to_string(),
            label: "g".to_string(),
            seq: 1,
            values: wire(json!({"ok": true})),
        },
    ];
    match find_cached_step_result(&entries, "a", 1, None).unwrap() {
        CachedStep::Hit { result, from } => {
            assert_eq!(result.as_ref().map(WireJson::to_value), Some(json!(42)));
            assert_eq!(from, CacheSource::StepFinished);
        }
        CachedStep::Miss => panic!("expected hit"),
    }
    match find_cached_step_result(&entries, "g", 1, None).unwrap() {
        CachedStep::Hit { result, from } => {
            assert_eq!(
                result.as_ref().map(WireJson::to_value),
                Some(json!({"ok": true}))
            );
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
            result: Some(wire(Value::Null)),
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
        values: wire(Value::Object(Map::new())),
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
        result: Some(wire(json!({"ok": true}))),
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

    let gate = vec![JournalEntry::GateResolved {
        ts: "now".to_string(),
        step_id: "x#1".to_string(),
        label: "x".to_string(),
        seq: 1,
        values: wire(json!({"ok": true})),
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
                    result: Some(wire(json!({"i": index, "pad": "xxxxxxxxxxxxxxxxxxxx"}))),
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

#[test]
fn torn_final_line_is_skipped_and_a_valid_line_without_newline_is_kept() {
    let good = r#"{"type":"step_finished","ts":"t","stepId":"a#1","label":"a","seq":1,"kind":"run","result":1}"#;
    let torn = format!("{good}\n{{\"type\":\"step_fin");
    assert_eq!(parse_journal(&torn).unwrap().len(), 1);
    assert_eq!(parse_journal(good).unwrap().len(), 1);
    let middle = format!("{good}\nnot-json\n{good}\n");
    let err = parse_journal(&middle).unwrap_err();
    assert!(
        err.to_string().starts_with("failed to parse journal line"),
        "{err}"
    );
}

#[tokio::test]
async fn torn_tail_is_truncated_before_the_next_append() {
    let dir = temp_root("torn-repair");
    let path = journal_path(&dir);
    let good = r#"{"type":"step_finished","ts":"t","stepId":"a#1","label":"a","seq":1,"kind":"run","result":1}"#;
    std::fs::write(&path, format!("{good}\n{{\"type\":\"step_fin")).unwrap();
    assert_eq!(read_journal(&dir).await.unwrap().len(), 1);
    append_journal(
        &dir,
        &JournalEntry::StepStarted {
            ts: "t2".to_string(),
            step_id: "b#1".to_string(),
            label: "b".to_string(),
            seq: 1,
            kind: StepKind::Run,
        },
    )
    .await
    .unwrap();
    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(raw.ends_with('\n'), "{raw}");
    assert!(!raw.contains("step_fin{"), "{raw}");
    let again = read_journal(&dir).await.unwrap();
    assert_eq!(again.len(), 2);
    assert_eq!(again[0].entry_type(), "step_finished");
    assert_eq!(again[1].entry_type(), "step_started");
    let glued = format!("{good}\n{{\"type\":\"step_fin{{\"type\":\"step_started\"}}\n");
    assert!(parse_journal(&glued).is_err());
}

#[tokio::test]
async fn valid_final_record_without_newline_is_kept_on_append() {
    let single = temp_root("valid-tail-one");
    let single_path = journal_path(&single);
    let good = r#"{"type":"step_finished","ts":"t","stepId":"a#1","label":"a","seq":1,"kind":"run","result":1}"#;
    std::fs::write(&single_path, good).unwrap();
    assert_eq!(read_journal(&single).await.unwrap().len(), 1);
    append_started(&single).await;
    let raw = std::fs::read_to_string(&single_path).unwrap();
    assert!(raw.ends_with('\n'), "{raw}");
    assert!(raw.contains("a#1"), "{raw}");
    assert!(!raw.contains("step_fin{"), "{raw}");
    let again = read_journal(&single).await.unwrap();
    assert_eq!(again.len(), 2);
    assert_eq!(again[0].entry_type(), "step_finished");
    assert_eq!(again[1].entry_type(), "step_started");

    let multi = temp_root("valid-tail-two");
    let multi_path = journal_path(&multi);
    let second = r#"{"type":"step_finished","ts":"t2","stepId":"b#1","label":"b","seq":1,"kind":"run","result":2}"#;
    std::fs::write(&multi_path, format!("{good}\n{second}")).unwrap();
    assert_eq!(read_journal(&multi).await.unwrap().len(), 2);
    append_started(&multi).await;
    let raw = std::fs::read_to_string(&multi_path).unwrap();
    assert!(raw.ends_with('\n'), "{raw}");
    assert!(raw.contains("a#1"), "{raw}");
    assert!(raw.contains("b#1"), "{raw}");
    let again = read_journal(&multi).await.unwrap();
    assert_eq!(again.len(), 3);
    assert_eq!(again[0].entry_type(), "step_finished");
    assert_eq!(again[1].entry_type(), "step_finished");
    assert_eq!(again[2].entry_type(), "step_started");
}

#[tokio::test]
async fn truncated_utf8_tail_is_recovered_on_read_and_append() {
    let good = "{\"type\":\"step_finished\",\"ts\":\"t\",\"stepId\":\"a#1\",\"label\":\"a\",\"seq\":1,\"kind\":\"run\",\"result\":\"\u{1F600}\"}";
    let kept = temp_root("utf8-kept");
    let kept_path = journal_path(&kept);
    std::fs::write(&kept_path, good.as_bytes()).unwrap();
    assert_eq!(read_journal(&kept).await.unwrap().len(), 1);
    append_started(&kept).await;
    let kept_bytes = std::fs::read(&kept_path).unwrap();
    let kept_text = std::str::from_utf8(&kept_bytes).unwrap();
    assert!(kept_bytes.ends_with(b"\n"));
    assert!(kept_text.contains('\u{1F600}'));
    let kept_again = read_journal(&kept).await.unwrap();
    assert_eq!(kept_again.len(), 2);
    assert_eq!(kept_again[0].entry_type(), "step_finished");

    let dir = temp_root("utf8-torn");
    let path = journal_path(&dir);
    let mut torn = good.as_bytes().to_vec();
    torn.push(b'\n');
    torn.extend_from_slice(
        br#"{"type":"step_finished","ts":"t2","stepId":"b#1","label":"b","seq":1,"kind":"run","result":""#,
    );
    torn.extend_from_slice(&[0xF0, 0x9F]);
    std::fs::write(&path, &torn).unwrap();
    let first = read_journal(&dir).await.unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].entry_type(), "step_finished");
    append_started(&dir).await;
    let raw = std::fs::read(&path).unwrap();
    let text = std::str::from_utf8(&raw).unwrap();
    assert!(raw.ends_with(b"\n"));
    assert!(text.contains('\u{1F600}'));
    assert!(!text.contains("b#1"));
    let again = read_journal(&dir).await.unwrap();
    assert_eq!(again.len(), 2);
    assert_eq!(again[0].entry_type(), "step_finished");
    assert_eq!(again[1].entry_type(), "step_started");

    let interior = temp_root("utf8-interior");
    let interior_path = journal_path(&interior);
    let mut broken = good.as_bytes().to_vec();
    broken.push(b'\n');
    broken.extend_from_slice(&[0xF0, 0x9F]);
    broken.push(b'\n');
    broken.extend_from_slice(good.as_bytes());
    broken.push(b'\n');
    std::fs::write(&interior_path, &broken).unwrap();
    let err = read_journal(&interior).await.unwrap_err();
    assert!(
        err.to_string().starts_with("failed to parse journal line"),
        "{err}"
    );
}

#[tokio::test]
async fn complete_line_keeps_an_invalid_byte_the_way_node_reads_it() {
    let dir = temp_root("journal-lossy");
    let path = journal_path(&dir);
    let mut bytes =
        br#"{"type":"step_finished","ts":"t","stepId":"a#1","label":"a","seq":1,"kind":"run","result":"x"#
            .to_vec();
    bytes.extend_from_slice(&[0xff, 0xe2, 0x28, 0xa1]);
    bytes.extend_from_slice(br#""}"#);
    bytes.push(b'\n');
    std::fs::write(&path, &bytes).unwrap();
    let all = read_journal(&dir).await.unwrap();
    assert_eq!(all.len(), 1);
    match &all[0] {
        JournalEntry::StepFinished { result, .. } => {
            assert_eq!(
                result.as_ref().unwrap().to_value().as_str(),
                Some("x\u{FFFD}\u{FFFD}(\u{FFFD}")
            );
        }
        other => panic!("{other:?}"),
    }
    let mut torn = bytes;
    torn.extend_from_slice(
        br#"{"type":"step_finished","ts":"t2","stepId":"b#1","label":"b","seq":1,"kind":"run","result":"torn"#,
    );
    torn.push(0xff);
    torn.extend_from_slice(br#""}"#);
    std::fs::write(&path, &torn).unwrap();
    assert_eq!(read_journal(&dir).await.unwrap().len(), 1);
}

async fn append_started(dir: &std::path::Path) {
    append_journal(
        dir,
        &JournalEntry::StepStarted {
            ts: "t3".to_string(),
            step_id: "c#1".to_string(),
            label: "c".to_string(),
            seq: 1,
            kind: StepKind::Run,
        },
    )
    .await
    .unwrap();
}

#[test]
fn absent_result_is_not_null() {
    let absent =
        r#"{"type":"step_finished","ts":"t","stepId":"a#1","label":"a","seq":1,"kind":"run"}"#;
    let parsed = parse_journal(absent).unwrap();
    match &parsed[0] {
        JournalEntry::StepFinished { result, .. } => {
            assert!(result.is_none());
            assert!(!parsed[0].to_json_line().unwrap().contains("result"));
        }
        other => panic!("unexpected {other:?}"),
    }
    let present = r#"{"type":"step_finished","ts":"t","stepId":"a#1","label":"a","seq":1,"kind":"run","result":null}"#;
    let parsed = parse_journal(present).unwrap();
    match &parsed[0] {
        JournalEntry::StepFinished { result, .. } => {
            assert_eq!(result.as_ref().map(WireJson::raw), Some("null"));
            assert!(
                parsed[0]
                    .to_json_line()
                    .unwrap()
                    .contains("\"result\":null")
            );
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn surrogate_escape_roundtrips_in_the_journal_and_case() {
    let raw = "{\"type\":\"step_finished\",\"ts\":\"t\",\"stepId\":\"a#1\",\"label\":\"a\",\"seq\":1,\"kind\":\"run\",\"result\":\"\\ud800\"}\n";
    let parsed = parse_journal(raw).unwrap();
    let line = parsed[0].to_json_line().unwrap();
    assert!(line.contains("\\ud800"), "{line}");
    let again = parse_journal(&format!("{line}\n")).unwrap();
    assert_eq!(again[0].to_json_line().unwrap(), line);
    let case_raw = "{\"run\":{\"id\":\"r\",\"workflowId\":\"w\",\"version\":\"1\",\"status\":\"running\",\"startedBy\":{\"type\":\"human\"},\"caseDir\":\"/tmp/r\"},\"fields\":{\"note\":\"\\ud800\"}}\n";
    let state = workflows::parse_case(case_raw).unwrap();
    assert!(
        state.document.raw().contains("\\ud800"),
        "{}",
        state.document.raw()
    );
}
