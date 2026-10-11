#[path = "common/mod.rs"]
mod common;

use std::path::PathBuf;

use transcripts::{Roots, Store, TranscriptWatch};

use common::{Tmp, sqlite, touch, write};

fn user_line(text: &str) -> String {
    format!(
        "{}\n",
        serde_json::json!({"type":"user","message":{"content": text}})
    )
}

fn assistant_line(text: &str) -> String {
    format!(
        "{}\n",
        serde_json::json!({"type":"assistant","message":{"content":[{"type":"text","text": text}]}})
    )
}

fn claude_store(tmp: &Tmp) -> (Store, PathBuf) {
    let dir = tmp.path().join("projects/-home-rivet");
    let mut roots = tmp.roots();
    roots.set_env("CLAUDE_CONFIG_DIR", tmp.path().to_string_lossy());
    roots.set_env("GROK_HOME", tmp.path().join("no-grok").to_string_lossy());
    roots.set_env(
        "HERMES_HOME",
        tmp.path().join("no-hermes").to_string_lossy(),
    );
    (Store::new(roots), dir)
}

fn texts(frame: &transcripts::WatchFrame) -> Vec<&str> {
    frame.turns.iter().map(|turn| turn.text.as_str()).collect()
}

#[test]
fn watch_emits_a_snapshot_then_a_delta() {
    let tmp = Tmp::new("watch-grow");
    let (store, dir) = claude_store(&tmp);
    let id = "aaaaaaaa-0000-0000-0000-000000000001";
    let file = dir.join(format!("{id}.jsonl"));
    write(
        &file,
        &format!("{}{}", user_line("hello"), assistant_line("hi")),
    );
    let mut watch = TranscriptWatch::new();
    let snap = &watch.watch(&store, id)[0];
    assert_eq!(snap.kind, "transcript");
    assert_eq!(snap.command, "claude");
    assert_eq!(snap.total, 2);
    assert_eq!(texts(snap), ["hello", "hi"]);
    let rev = snap.rev;
    std::fs::write(
        &file,
        format!(
            "{}{}{}",
            user_line("hello"),
            assistant_line("hi"),
            user_line("second question")
        ),
    )
    .unwrap();
    let delta = &watch.poll(&store, id)[0];
    assert_eq!(delta.rev, rev + 1);
    assert_eq!(delta.from, 2);
    assert_eq!(texts(delta), ["second question"]);
    assert_eq!(delta.total, 3);
}

#[test]
fn watch_echoes_the_canonical_session_id() {
    let tmp = Tmp::new("watch-canon");
    let (store, dir) = claude_store(&tmp);
    let native = "aaaaaaaa-0000-0000-0000-00000000000c";
    let canonical = format!("claude-code:{native}");
    let file = dir.join(format!("{native}.jsonl"));
    write(&file, &user_line("hello"));
    let mut watch = TranscriptWatch::new();
    let snap = &watch.watch(&store, &canonical)[0];
    assert_eq!(snap.session, canonical);
    assert_eq!(snap.command, "claude");
    assert_eq!(texts(snap), ["hello"]);
    std::fs::write(
        &file,
        format!("{}{}", user_line("hello"), assistant_line("hi")),
    )
    .unwrap();
    let delta = &watch.poll(&store, &canonical)[0];
    assert_eq!(delta.session, canonical);
    assert_eq!(texts(delta), ["hi"]);
}

#[test]
fn watch_accepts_a_claude_path_fallback_key() {
    let tmp = Tmp::new("watch-path");
    let (store, dir) = claude_store(&tmp);
    let native = "aaaaaaaa-0000-0000-0000-00000000000d";
    let path_form = format!("claude-code:-home-rivet/{native}");
    write(
        &dir.join(format!("{native}.jsonl")),
        &user_line("path form"),
    );
    let mut watch = TranscriptWatch::new();
    let snap = &watch.watch(&store, &path_form)[0];
    assert_eq!(snap.session, path_form);
    assert_eq!(snap.command, "claude");
    assert_eq!(texts(snap), ["path form"]);
}

#[test]
fn watch_refuses_a_traversal_in_the_resolved_native_id() {
    let tmp = Tmp::new("watch-trav");
    let (store, _) = claude_store(&tmp);
    let mut watch = TranscriptWatch::new();
    assert!(
        watch
            .watch(&store, "claude-code:../../etc/passwd")
            .is_empty()
    );
    assert!(watch.watch(&store, "../../etc/passwd").is_empty());
    assert!(
        watch
            .poll(&store, "claude-code:../../etc/passwd")
            .is_empty()
    );
}

#[test]
fn mid_turn_growth_restates_the_assistant_turn() {
    let tmp = Tmp::new("watch-mid");
    let (store, dir) = claude_store(&tmp);
    let id = "aaaaaaaa-0000-0000-0000-000000000002";
    let file = dir.join(format!("{id}.jsonl"));
    write(
        &file,
        &format!(
            "{}{}",
            user_line("do a thing"),
            assistant_line("working on it")
        ),
    );
    let mut watch = TranscriptWatch::new();
    let snap = watch.watch(&store, id);
    assert_eq!(snap[0].from, 0);
    std::fs::write(
        &file,
        format!(
            "{}{}{}",
            user_line("do a thing"),
            assistant_line("working on it"),
            assistant_line("done, here is the result")
        ),
    )
    .unwrap();
    let delta = &watch.poll(&store, id)[0];
    assert_eq!(delta.from, 1);
    assert_eq!(delta.turns.len(), 1);
    assert_eq!(
        delta.turns[0].text,
        "working on it\n\ndone, here is the result"
    );
}

#[test]
fn empty_snapshot_until_the_store_file_appears() {
    let tmp = Tmp::new("watch-fresh");
    let (store, dir) = claude_store(&tmp);
    let id = "aaaaaaaa-0000-0000-0000-000000000003";
    let mut watch = TranscriptWatch::new();
    let empty = &watch.watch(&store, id)[0];
    assert_eq!(empty.command, "");
    assert_eq!(empty.total, 0);
    write(
        &dir.join(format!("{id}.jsonl")),
        &user_line("first ever turn"),
    );
    let real = &watch.poll(&store, id)[0];
    assert_eq!(real.command, "claude");
    assert_eq!(texts(real), ["first ever turn"]);
}

#[test]
fn sync_reemits_and_unwatch_stops_the_flow() {
    let tmp = Tmp::new("watch-sync");
    let (store, dir) = claude_store(&tmp);
    let id = "aaaaaaaa-0000-0000-0000-000000000004";
    let file = dir.join(format!("{id}.jsonl"));
    write(&file, &user_line("hello"));
    let mut watch = TranscriptWatch::new();
    let snap = &watch.watch(&store, id)[0];
    let rev = snap.rev;
    let resnap = &watch.sync(&store, id)[0];
    assert!(resnap.rev > rev);
    assert_eq!(resnap.from, 0);
    assert_eq!(texts(resnap), ["hello"]);
    watch.unwatch(id);
    std::fs::write(
        &file,
        format!("{}{}", user_line("hello"), user_line("into the void")),
    )
    .unwrap();
    assert!(watch.poll(&store, id).is_empty());
}

#[test]
fn rotation_reresolves_a_deleted_store() {
    let tmp = Tmp::new("watch-rot");
    let (store, dir) = claude_store(&tmp);
    let id = "aaaaaaaa-0000-0000-0000-000000000006";
    let file = dir.join(format!("{id}.jsonl"));
    write(&file, &user_line("before rotation"));
    let mut watch = TranscriptWatch::new();
    let snap = &watch.watch(&store, id)[0];
    assert_eq!(snap.command, "claude");
    let rev = snap.rev;
    std::fs::remove_file(&file).unwrap();
    assert!(watch.poll(&store, id).is_empty());
    write(
        &file,
        &format!(
            "{}{}",
            user_line("after rotation"),
            assistant_line("recovered")
        ),
    );
    let recovered = &watch.poll(&store, id)[0];
    assert!(recovered.rev > rev);
    assert!(
        texts(recovered)
            .iter()
            .any(|text| *text == "after rotation" || *text == "recovered")
    );
}

#[test]
fn truncated_window_pins_earlier_turns() {
    let tmp = Tmp::new("watch-pin");
    let dir = tmp.path().join("projects/-home-rivet");
    let prefix = format!("{}{}", user_line("keep-me"), assistant_line("also-keep"));
    let fat = format!(
        "{}{}",
        user_line(&format!("later-{}", "x".repeat(40))),
        assistant_line(&format!("tail-{}", "x".repeat(40)))
    );
    let max_bytes =
        fat.len() as u64 + prefix.len() as u64 - (user_line("keep-me").len() as u64) / 2;
    let mut roots = Roots::isolated(tmp.path());
    roots.max_bytes = max_bytes;
    roots.set_env("CLAUDE_CONFIG_DIR", tmp.path().to_string_lossy());
    roots.set_env("GROK_HOME", tmp.path().join("no-grok").to_string_lossy());
    roots.set_env(
        "HERMES_HOME",
        tmp.path().join("no-hermes").to_string_lossy(),
    );
    let store = Store::new(roots);
    let id = "aaaaaaaa-0000-0000-0000-000000000007";
    let file = dir.join(format!("{id}.jsonl"));
    write(&file, &prefix);
    let mut watch = TranscriptWatch::new();
    let snap = watch.watch(&store, id);
    assert_eq!(texts(&snap[0]), ["keep-me", "also-keep"]);
    assert!(!snap[0].truncated_before);
    let rev = snap[0].rev;
    let kept = snap[0].turns.clone();
    std::fs::write(&file, format!("{prefix}{fat}")).unwrap();
    let delta = &watch.poll(&store, id)[0];
    assert_eq!(delta.rev, rev + 1);
    assert!(delta.truncated_before);
    let mut visible = kept[..delta.from].to_vec();
    visible.extend(delta.turns.clone());
    assert_eq!(visible[0].text, "keep-me");
    assert!(visible.iter().any(|turn| turn.text.starts_with("tail-")));
    assert!(visible.len() >= 3);
}

#[test]
fn sessions_dirty_is_an_explicit_frame() {
    let tmp = Tmp::new("watch-dirty");
    let (store, dir) = claude_store(&tmp);
    write(
        &dir.join("bbbbbbbb-0000-0000-0000-000000000005.jsonl"),
        &user_line("new session"),
    );
    assert!(
        store
            .store_dirs()
            .iter()
            .any(|path| path.contains("projects"))
    );
    let frame = TranscriptWatch::new().note_sessions_dirty();
    assert_eq!(frame.kind, "sessions-dirty");
    assert!(frame.session.is_empty());
}

#[test]
fn a_second_watch_shares_one_parse_until_both_unwatch() {
    let tmp = Tmp::new("watch-refs");
    let (store, dir) = claude_store(&tmp);
    let id = "aaaaaaaa-0000-0000-0000-0000000000a2";
    let file = dir.join(format!("{id}.jsonl"));
    write(&file, &user_line("hello"));
    let mut watch = TranscriptWatch::new();
    let first = &watch.watch(&store, id)[0];
    assert_eq!(texts(first), ["hello"]);
    let second = &watch.watch(&store, id)[0];
    assert_eq!(texts(second), ["hello"]);
    assert_eq!(second.rev, first.rev + 1);
    std::fs::write(
        &file,
        format!("{}{}", user_line("hello"), assistant_line("shared")),
    )
    .unwrap();
    let delta = &watch.poll(&store, id)[0];
    assert_eq!(texts(delta), ["shared"]);
    let shared_rev = delta.rev;
    watch.unwatch(id);
    std::fs::write(
        &file,
        format!(
            "{}{}{}",
            user_line("hello"),
            assistant_line("shared"),
            assistant_line("still here")
        ),
    )
    .unwrap();
    let still = &watch.poll(&store, id)[0];
    assert!(still.rev > shared_rev);
    assert!(
        still
            .turns
            .iter()
            .any(|turn| turn.text.contains("still here"))
    );
    watch.unwatch(id);
    watch.unwatch(id);
    std::fs::write(
        &file,
        format!(
            "{}{}{}",
            user_line("hello"),
            assistant_line("shared"),
            assistant_line("into the void")
        ),
    )
    .unwrap();
    assert!(watch.poll(&store, id).is_empty());
}

#[test]
fn opencode_wal_growth_polls_without_the_main_db_changing() {
    let tmp = Tmp::new("watch-wal");
    let db = tmp.path().join(".local/share/opencode/opencode.db");
    if let Some(parent) = db.parent() {
        std::fs::create_dir_all(parent).expect("db dir");
    }
    let conn = rusqlite::Connection::open(&db).expect("db");
    conn.pragma_update(None, "journal_mode", "WAL")
        .expect("wal");
    conn.pragma_update(None, "wal_autocheckpoint", 0_i64)
        .expect("checkpoint");
    let id = "ses_walwatch0000000000000001";
    conn.execute_batch(&format!(
        "CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, model TEXT, time_created INTEGER, time_updated INTEGER);
         CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
         CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
         INSERT INTO session VALUES ('{id}', 'wal', '/work', NULL, 1, 2);
         INSERT INTO message VALUES ('m1', '{id}', 10, 10, '{{\"role\":\"user\"}}');
         INSERT INTO part VALUES ('p1', 'm1', '{id}', 11, '{{\"type\":\"text\",\"text\":\"first line\"}}');"
    ))
    .expect("schema");
    let store = Store::new(tmp.roots());
    let mut watch = TranscriptWatch::new();
    let session = format!("opencode:{id}");
    let opened = watch.watch(&store, &session);
    assert!(
        opened
            .iter()
            .any(|frame| texts(frame).contains(&"first line")),
        "{opened:?}"
    );
    let main_before = std::fs::metadata(&db).expect("main").len();
    conn.execute_batch(
        "INSERT INTO message VALUES ('m2', 'ses_walwatch0000000000000001', 20, 20, '{\"role\":\"assistant\"}');
         INSERT INTO part VALUES ('p2', 'm2', 'ses_walwatch0000000000000001', 21, '{\"type\":\"text\",\"text\":\"second line\"}');",
    )
    .expect("append");
    let wal = db.with_file_name("opencode.db-wal");
    assert!(wal.is_file(), "wal missing");
    assert!(std::fs::metadata(&wal).expect("wal meta").len() > 0);
    assert_eq!(
        std::fs::metadata(&db).expect("main after").len(),
        main_before
    );
    let frames = watch.poll(&store, &session);
    assert!(
        frames
            .iter()
            .any(|frame| texts(frame).contains(&"second line")),
        "{frames:?}"
    );
}

#[test]
fn helper_touch_and_sqlite_round_trip() {
    let tmp = Tmp::new("watch-helpers");
    let file = tmp.path().join("stamp.txt");
    write(&file, "x");
    touch(&file, 1_700_000_000_000);
    let db = tmp.path().join("t.db");
    sqlite(&db, "create table t(id integer); insert into t values (1);");
    assert!(file.is_file());
    assert!(db.is_file());
    let conn = rusqlite::Connection::open(&db).expect("open");
    let n: i64 = conn
        .query_row("select id from t", [], |row| row.get(0))
        .expect("row");
    assert_eq!(n, 1);
}
