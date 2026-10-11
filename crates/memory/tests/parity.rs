use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::path::PathBuf;

use chrono::{
    DateTime, Datelike, FixedOffset, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, Offset,
    TimeZone, Timelike, Utc,
};
use memory::columns::WidthMigrationDecision;
use memory::columns::decide_width_migration;
use memory::cowork_hash::{CoworkHookRow, cowork_content_hash, pick_cowork_hook_rewrite};
use memory::full::{
    extract_full_from_line, extract_opencode_from_part, extract_text, file_missing_message,
    file_missing_message_with, format_missing_jsonl_message, missing_pointer_message,
    truncation_hint,
};
use memory::names::{normalize_tag_value, parse_tag_literal};
use memory::prepare::{append_result_value, prepare_append, validate_ingest_messages};
use memory::rules::{
    MapFs, NodeFs, PROJECT_RULE_MAX_WALK, origin_url_from_config, plan_project_rule_tag,
    repo_name_from_remote, resolve_project_from_cwd, sanitize_remote,
};
use memory::spans::{apply_window_args, parse_js_date, resolve_window};
use memory::sql_report::{
    QueueRow, browse_sql, browse_tool_sql, en_us, format_embedding_queue, format_js_iso,
    format_queue_health, health_cached, memory_tool_parameters,
};
use memory::{
    CAPTURE_POOL_MAX, CaptureOptions, HistoryMessage, IDLE_IN_TRANSACTION_TIMEOUT, IngestInput,
    IngestOutput, MIGRATION_LOCK_TIMEOUT, MemoryEntry, MemoryStore, MigrateClient, MigrateFault,
    MigrateRows, PostgresMemory, RoutingMemory, STATEMENT_TIMEOUT, SearchOptions, StoreError,
    StoreHandle, append_event_id, apply_migration, apply_session_guards, capture_cap,
    capture_conversation_upsert_sql, capture_guard_statements, capture_message_insert_sql,
    embedded_as_migrations, ensure_migrations_table, ingest_event_id, list_migrations_dir,
    reset_session_guards, truncate_content, user_from_session_key, utf16_len,
};
use serde_json::{Map, Value, json};

fn sha(material: &str) -> String {
    protocol::digest::sha256_hex(material.as_bytes())
}

#[derive(Clone, Copy, Debug)]
struct Seg {
    start_utc_secs: i64,
    east: i32,
}

#[derive(Clone, Copy, Debug)]
struct ZoneOffset {
    east: i32,
    count: u8,
    segs: [Seg; 4],
}

impl fmt::Display for ZoneOffset {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let sign = if self.east >= 0 { '+' } else { '-' };
        let abs = self.east.unsigned_abs();
        write!(
            formatter,
            "{sign}{:02}:{:02}",
            abs / 3600,
            (abs % 3600) / 60
        )
    }
}

impl Offset for ZoneOffset {
    fn fix(&self) -> FixedOffset {
        FixedOffset::east_opt(self.east).expect("offset")
    }
}

#[derive(Clone, Copy, Debug)]
struct Zone {
    count: u8,
    segs: [Seg; 4],
}

impl Zone {
    fn new(parts: &[(i64, i32)]) -> Self {
        assert!(!parts.is_empty() && parts.len() <= 4);
        let mut segs = [Seg {
            start_utc_secs: i64::MIN,
            east: 0,
        }; 4];
        for (index, (start, east)) in parts.iter().copied().enumerate() {
            segs[index] = Seg {
                start_utc_secs: start,
                east,
            };
        }
        Self {
            count: parts.len() as u8,
            segs,
        }
    }

    fn offset_at(&self, east: i32) -> ZoneOffset {
        ZoneOffset {
            east,
            count: self.count,
            segs: self.segs,
        }
    }
}

impl TimeZone for Zone {
    type Offset = ZoneOffset;

    fn from_offset(offset: &Self::Offset) -> Self {
        Self {
            count: offset.count,
            segs: offset.segs,
        }
    }

    fn offset_from_local_date(&self, local: &NaiveDate) -> LocalResult<Self::Offset> {
        let Some(midnight) = local.and_hms_opt(0, 0, 0) else {
            return LocalResult::None;
        };
        self.offset_from_local_datetime(&midnight)
    }

    fn offset_from_local_datetime(&self, local: &NaiveDateTime) -> LocalResult<Self::Offset> {
        let mut hits = Vec::new();
        let count = self.count as usize;
        for index in 0..count {
            let start = self.segs[index].start_utc_secs;
            let end = if index + 1 < count {
                self.segs[index + 1].start_utc_secs
            } else {
                i64::MAX
            };
            let Some(utc) = local
                .and_utc()
                .timestamp()
                .checked_sub(i64::from(self.segs[index].east))
            else {
                continue;
            };
            if utc >= start && utc < end {
                hits.push((utc, self.segs[index].east));
            }
        }
        hits.sort_by_key(|(utc, _)| *utc);
        match hits.as_slice() {
            [] => LocalResult::None,
            [(_, east)] => LocalResult::Single(self.offset_at(*east)),
            many => {
                let earliest = many[0].1;
                let latest = many[many.len() - 1].1;
                LocalResult::Ambiguous(self.offset_at(earliest), self.offset_at(latest))
            }
        }
    }

    fn offset_from_utc_date(&self, utc: &NaiveDate) -> Self::Offset {
        let midnight = utc.and_hms_opt(0, 0, 0).expect("midnight");
        self.offset_from_utc_datetime(&midnight)
    }

    fn offset_from_utc_datetime(&self, utc: &NaiveDateTime) -> Self::Offset {
        let secs = utc.and_utc().timestamp();
        let mut east = self.segs[0].east;
        for seg in self.segs.iter().take(self.count as usize) {
            if seg.start_utc_secs <= secs {
                east = seg.east;
            }
        }
        self.offset_at(east)
    }
}

fn utc_secs(year: i32, month: u32, day: u32, hour: u32, min: u32, sec: u32) -> i64 {
    NaiveDate::from_ymd_opt(year, month, day)
        .expect("date")
        .and_hms_opt(hour, min, sec)
        .expect("time")
        .and_utc()
        .timestamp()
}

fn zone_at(
    zone: Zone,
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    min: u32,
    sec: u32,
) -> DateTime<Zone> {
    let naive = NaiveDate::from_ymd_opt(year, month, day)
        .expect("date")
        .and_hms_opt(hour, min, sec)
        .expect("time");
    match zone.from_local_datetime(&naive) {
        LocalResult::Single(dt) => dt,
        LocalResult::Ambiguous(earliest, _) => earliest,
        LocalResult::None => panic!("local time {naive} is in a gap"),
    }
}

fn us_eastern() -> Zone {
    Zone::new(&[
        (utc_secs(1900, 1, 1, 0, 0, 0), -5 * 3600),
        (utc_secs(2026, 3, 8, 7, 0, 0), -4 * 3600),
        (utc_secs(2026, 11, 1, 6, 0, 0), -5 * 3600),
    ])
}

fn sydney() -> Zone {
    Zone::new(&[
        (utc_secs(1900, 1, 1, 0, 0, 0), 11 * 3600),
        (utc_secs(2026, 4, 4, 16, 0, 0), 10 * 3600),
        (utc_secs(2026, 10, 3, 16, 0, 0), 11 * 3600),
    ])
}

fn weekday_gap() -> Zone {
    Zone::new(&[
        (utc_secs(1900, 1, 1, 0, 0, 0), -5 * 3600),
        (utc_secs(2026, 3, 11, 7, 0, 0), -4 * 3600),
        (utc_secs(2026, 11, 4, 6, 0, 0), -5 * 3600),
    ])
}

fn assert_window<Tz: TimeZone>(now: DateTime<Tz>, window: &str, since: &str, before: Option<&str>) {
    let (got_since, got_before) = resolve_window(window, now).expect(window);
    assert_eq!(got_since.as_deref(), Some(since), "{window} since");
    assert_eq!(got_before.as_deref(), before, "{window} before");
}

fn hours_between(since: &str, before: &str) -> i64 {
    let since = DateTime::parse_from_rfc3339(since).expect("since");
    let before = DateTime::parse_from_rfc3339(before).expect("before");
    (before - since).num_hours()
}

fn fixture(path: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(path)
}

struct FakeMigrate {
    sqls: Vec<String>,
    begins: usize,
    regclass: Option<String>,
}

impl MigrateClient for FakeMigrate {
    async fn query(&mut self, sql: &str) -> Result<MigrateRows, MigrateFault> {
        self.sqls.push(sql.to_string());
        if sql == "BEGIN" {
            self.begins += 1;
        }
        if sql.contains("to_regclass") {
            return Ok(MigrateRows {
                rows: vec![vec![self.regclass.clone()]],
            });
        }
        if sql == "some ddl" && self.begins == 1 && self.regclass.as_deref() == Some("55P03") {
            return Err(MigrateFault::coded("lock timeout", "55P03"));
        }
        if sql == "some ddl" && self.regclass.as_deref() == Some("42601") {
            return Err(MigrateFault::coded("syntax", "42601"));
        }
        Ok(MigrateRows::default())
    }

    async fn query_bind(&mut self, sql: &str, param: &str) -> Result<MigrateRows, MigrateFault> {
        self.sqls.push(format!("{sql} [{param}]"));
        Ok(MigrateRows::default())
    }
}

#[tokio::test]
async fn migration_ordering_retry_and_lock_literal() {
    let dir = fixture("tests/fixtures/migrations");
    let listed = list_migrations_dir(&dir).expect("list");
    assert_eq!(
        listed.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(),
        ["0001_aaa.sql", "0002_zzz.sql"]
    );
    assert_eq!(listed[0].sql, "-- first\n");
    let lossy = std::env::temp_dir().join(format!("rr2a-mig-lossy-{}", std::process::id()));
    let _ = fs::remove_dir_all(&lossy);
    fs::create_dir_all(&lossy).expect("dir");
    let mut latin = b"-- caf".to_vec();
    latin.push(0xE9);
    latin.extend_from_slice(b"\n");
    fs::write(lossy.join("0001_latin1.sql"), &latin).expect("write");
    let listed_lossy = list_migrations_dir(&lossy).expect("lossy list");
    assert_eq!(listed_lossy.len(), 1);
    assert_eq!(listed_lossy[0].sql, "-- caf\u{FFFD}\n");
    let _ = fs::remove_dir_all(&lossy);
    let embedded = embedded_as_migrations();
    assert!(embedded.len() >= 20);
    assert_eq!(embedded[0].name, "0001_baseline.sql");
    assert!(embedded[0].sql.contains("ros_messages"));
    let defer = embedded
        .iter()
        .find(|m| m.name == "0016_defer_embed_enqueue.sql")
        .expect("0016");
    assert!(
        defer
            .sql
            .contains("current_setting('rivet.defer_embed_enqueue', true) = 'on'")
    );
    assert!(embedded.iter().any(|m| m.name == "0020_tag_removals.sql"));

    let mut guards = FakeMigrate {
        sqls: Vec::new(),
        begins: 0,
        regclass: None,
    };
    apply_session_guards(&mut guards, MIGRATION_LOCK_TIMEOUT)
        .await
        .expect("guards");
    reset_session_guards(&mut guards).await.expect("reset");
    assert!(guards.sqls[0].contains(&format!("SET lock_timeout = '{MIGRATION_LOCK_TIMEOUT}'")));
    assert!(
        guards.sqls[1]
            .to_ascii_lowercase()
            .contains("reset lock_timeout")
    );

    let mut present = FakeMigrate {
        sqls: Vec::new(),
        begins: 0,
        regclass: Some("_rivetos_migrations".to_string()),
    };
    ensure_migrations_table(&mut present)
        .await
        .expect("present");
    assert!(present.sqls.iter().any(|sql| sql.contains("to_regclass")));
    assert!(present.sqls.iter().all(|sql| !sql.contains("CREATE TABLE")));

    let mut missing = FakeMigrate {
        sqls: Vec::new(),
        begins: 0,
        regclass: None,
    };
    ensure_migrations_table(&mut missing)
        .await
        .expect("missing");
    assert!(missing.sqls.iter().any(|sql| sql.contains("CREATE TABLE")));

    let mut retry = FakeMigrate {
        sqls: Vec::new(),
        begins: 0,
        regclass: Some("55P03".to_string()),
    };
    apply_migration(
        &mut retry,
        &memory::Migration {
            name: "0001_x.sql".to_string(),
            path: "/x".to_string(),
            sql: "some ddl".to_string(),
        },
        |_ms| async {},
        &[0, 1],
    )
    .await
    .expect("retry");
    assert_eq!(retry.begins, 2);
    assert_eq!(
        retry
            .sqls
            .iter()
            .filter(|sql| sql.as_str() == "COMMIT")
            .count(),
        1
    );

    let mut syntax = FakeMigrate {
        sqls: Vec::new(),
        begins: 0,
        regclass: Some("42601".to_string()),
    };
    let err = apply_migration(
        &mut syntax,
        &memory::Migration {
            name: "0001_x.sql".to_string(),
            path: "/x".to_string(),
            sql: "some ddl".to_string(),
        },
        |_ms| async {},
        &[0, 1],
    )
    .await
    .expect_err("syntax");
    assert_eq!(err.message, "syntax");
    assert_eq!(syntax.begins, 1);

    let mut bad = FakeMigrate {
        sqls: Vec::new(),
        begins: 0,
        regclass: None,
    };
    let err = apply_session_guards(&mut bad, "3s'; DROP TABLE x; --")
        .await
        .expect_err("lock");
    assert!(err.message.contains("invalid lock_timeout"));
    assert!(bad.sqls.is_empty());
}

#[test]
fn width_decision_matches_probe_cases() {
    assert_eq!(
        decide_width_migration(None, 4, 128),
        WidthMigrationDecision::Skip
    );
    assert_eq!(
        decide_width_migration(Some(128), 4, 128),
        WidthMigrationDecision::Skip
    );
    assert_eq!(
        decide_width_migration(Some(64), 1, 128),
        WidthMigrationDecision::Refuse
    );
    assert_eq!(
        decide_width_migration(Some(64), 0, 128),
        WidthMigrationDecision::Alter
    );
}

#[test]
fn hashes_caps_and_surrogate_boundary() {
    assert_eq!(
        append_event_id("s", "a", "user", "hi", None),
        sha("append\0s\0a\0user\0hi\0")
    );
    assert_eq!(
        ingest_event_id("s", "a", "user", "hi", 3, Some("Bash")),
        sha("s\0a\0user\0hi\x003\0Bash")
    );
    assert_eq!(cowork_content_hash("user", "hello"), sha("user\0hello\0\0"));
    let long = format!("{}😀tail", "x".repeat(15999));
    assert_eq!(utf16_len(&long), 16005);
    let mut meta = Map::new();
    let capped = capture_cap(&long, &mut meta, "content");
    assert_eq!(utf16_len(&capped), 15999);
    assert!(!capped.contains('\u{2026}'));
    assert_eq!(capped, "x".repeat(15999));
    assert_eq!(meta.get("truncated"), Some(&Value::Bool(true)));
    assert_eq!(
        meta.get("full_content_length").and_then(Value::as_u64),
        Some(16005)
    );
    let mut marked = Map::new();
    let truncated = truncate_content(&long, &mut marked, "");
    assert!(truncated.ends_with("\n…[truncated]"));
    let fixture =
        std::fs::read_to_string(fixture("tests/fixtures/capture-batches.json")).expect("fixture");
    let parsed: Value = serde_json::from_str(&fixture).expect("json");
    let over = parsed["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|case| case["name"] == "over-cap-surrogate-boundary")
        .expect("case");
    assert_eq!(over["expect_content_len"], 15999);
    assert_eq!(over["expect_full_len"], 16005);
    assert_eq!(over["expect_marker"], false);
}

#[test]
fn windows_slug_and_project_rule() {
    let now = Utc.with_ymd_and_hms(2026, 10, 10, 15, 0, 0).unwrap();
    let err = resolve_window("", now).expect_err("empty");
    assert!(err.contains("Invalid window=\"\""));
    let (since, before) = resolve_window("today", now).expect("today");
    assert_eq!(since.as_deref(), Some("2026-10-10T00:00:00.000Z"));
    assert!(before.is_none());
    let (since, before) =
        apply_window_args(Some("yesterday"), Some("2026-01-01T00:00:00Z"), None, now)
            .expect("explicit");
    assert_eq!(since.as_deref(), Some("2026-01-01T00:00:00Z"));
    assert!(before.is_none());
    assert_eq!(normalize_tag_value("AcmeKit"), "acmekit");
    assert_eq!(normalize_tag_value("My Repo"), "my-repo");
    assert_eq!(
        parse_tag_literal("project:demo"),
        Some(("project".to_string(), "demo".to_string()))
    );
    assert_eq!(
        repo_name_from_remote("git@github.com:philbert440/rivetOS.git").as_deref(),
        Some("rivetOS")
    );
    assert_eq!(
        sanitize_remote("git@github.com:philbert440/rivetOS.git").as_deref(),
        Some("github.com/philbert440/rivetOS")
    );
    assert!(sanitize_remote("FILE:/tmp/repo").is_none());
    let config = "[REMOTE \"origin\"]\n\turl = git@github.com:philbert440/rivetOS.git\n";
    assert!(origin_url_from_config(config).is_some());
    assert!(
        origin_url_from_config("[remote \"Origin\"]\n\turl = git@github.com:org/rivetOS.git\n")
            .is_none()
    );
    let mut fs = MapFs::default();
    fs.dirs.insert("/srv/code/rivetos".to_string());
    fs.dirs.insert("/srv/code/rivetos/.git".to_string());
    fs.files.insert(
        "/srv/code/rivetos/.git/config".to_string(),
        "[remote \"origin\"]\n\turl = git@github.com:philbert440/rivetOS.git\n".to_string(),
    );
    let hit = resolve_project_from_cwd("/srv/code/rivetos", &fs).expect("hit");
    assert_eq!(hit.value, "rivetos");
    assert_eq!(hit.display, "rivetOS");
    assert_eq!(hit.rule, "git-remote");
    assert_eq!(hit.reason, "git-remote: github.com/philbert440/rivetOS");
    let mut bare = MapFs::default();
    bare.dirs.insert("/srv/code/My Repo".to_string());
    bare.dirs.insert("/srv/code/My Repo/.git".to_string());
    bare.files.insert(
        "/srv/code/My Repo/.git/config".to_string(),
        "[core]\n\tbare = false\n".to_string(),
    );
    let root = resolve_project_from_cwd("/srv/code/My Repo", &bare).expect("root");
    assert_eq!(root.value, "my-repo");
    assert_eq!(root.display, "My Repo");
    assert_eq!(root.rule, "git-root");
    let mut deep = MapFs::default();
    let mut path = String::new();
    for index in 0..40 {
        path.push_str(&format!("/x{index}"));
        deep.dirs.insert(path.clone());
    }
    let leaf = format!("{path}/leaf");
    deep.dirs.insert(leaf.clone());
    let walked = resolve_project_from_cwd(&leaf, &deep).expect("basename");
    assert_eq!(walked.rule, "cwd-basename");
    assert_eq!(PROJECT_RULE_MAX_WALK, 16);
    let lossy_root = std::env::temp_dir().join(format!("rr2a-proj-{}", std::process::id()));
    let checkout = lossy_root.join("checkout");
    let git_dir = checkout.join(".git");
    std::fs::create_dir_all(&git_dir).expect("git dir");
    let mut config_bytes = b"# caf".to_vec();
    config_bytes.push(0xE9);
    config_bytes.extend_from_slice(
        b"\n[remote \"origin\"]\n\turl = https://github.com/acme/ActualApp.git\n",
    );
    std::fs::write(git_dir.join("config"), &config_bytes).expect("config");
    let cwd = checkout.to_string_lossy().to_string();
    let lossy = resolve_project_from_cwd(&cwd, &NodeFs).expect("lossy origin");
    assert_eq!(lossy.value, "actualapp");
    assert_eq!(lossy.display, "ActualApp");
    assert_eq!(lossy.rule, "git-remote");
    drop(std::fs::remove_dir_all(&lossy_root));
    let mut settings = Map::new();
    settings.insert(
        "cwd".to_string(),
        Value::String("/home/user/work/AcmeKit".to_string()),
    );
    let planned = plan_project_rule_tag(Some(&settings), false, false, None).expect("plan");
    assert_eq!(planned.value, "acmekit");
    assert_eq!(planned.display, "AcmeKit");
    let labels = memory::conversation_tag_labels(&[
        (
            "project".to_string(),
            "acme".to_string(),
            "Acme".to_string(),
        ),
        (
            "project".to_string(),
            "acme".to_string(),
            "acme".to_string(),
        ),
    ]);
    assert_eq!(labels, vec!["project:Acme".to_string()]);
    assert!(plan_project_rule_tag(Some(&settings), true, true, None).is_none());
}

#[test]
fn write_tool_validation_and_sql_shapes() {
    let env = BTreeMap::new();
    let err = prepare_append(&Map::new(), &env).expect_err("session");
    assert_eq!(err, "memory_append: session_id is required");
    let mut args = Map::new();
    args.insert("session_id".to_string(), Value::String("s".to_string()));
    args.insert("role".to_string(), Value::String("nope".to_string()));
    args.insert("content".to_string(), Value::String("hi".to_string()));
    assert_eq!(
        prepare_append(&args, &env).expect_err("role"),
        "memory_append: role must be user|assistant|system|tool"
    );
    args.insert("role".to_string(), Value::String("assistant".to_string()));
    args.insert("content".to_string(), Value::String(String::new()));
    args.insert("tool_name".to_string(), Value::String(String::new()));
    assert_eq!(
        prepare_append(&args, &env).expect_err("empty tool"),
        "memory_append: content is required (or provide tool_name for tool-call messages)"
    );
    args.insert("tool_name".to_string(), Value::String(" ".to_string()));
    let blank_tool = prepare_append(&args, &env).expect("whitespace tool");
    assert_eq!(blank_tool.tool_name.as_deref(), Some(" "));
    args.insert("content".to_string(), Value::String("hello".to_string()));
    args.insert("tool_name".to_string(), Value::String(String::new()));
    args.insert("tool_result".to_string(), Value::String(String::new()));
    let empty_fields = prepare_append(&args, &env).expect("empty optional fields");
    assert_eq!(empty_fields.tool_name.as_deref(), Some(""));
    assert_eq!(empty_fields.tool_result, None);
    args.insert("tool_result".to_string(), Value::String(" ".to_string()));
    let spaced_result = prepare_append(&args, &env).expect("spaced tool result");
    assert_eq!(spaced_result.tool_result.as_deref(), Some(" "));
    args.insert("content".to_string(), Value::String("hi".to_string()));
    args.insert("tool_name".to_string(), Value::String("read".to_string()));
    args.insert("role".to_string(), Value::String("user".to_string()));
    args.insert(
        "event_id".to_string(),
        Value::String("\u{00A0}id\u{00A0}".to_string()),
    );
    let nbsp = prepare_append(&args, &env).expect("nbsp event");
    assert_eq!(nbsp.event_id, "id");
    args.insert(
        "event_id".to_string(),
        Value::String(" \u{00A0} ".to_string()),
    );
    let generated = prepare_append(&args, &env).expect("blank event");
    assert_eq!(
        generated.event_id,
        memory::append_event_id("s", "mcp", "user", "hi", Some("read"))
    );
    args.remove("event_id");
    args.remove("tool_name");
    let prepared = prepare_append(&args, &env).expect("ok");
    let value = append_result_value(&prepared, "id-1", false);
    assert_eq!(value.get("id").and_then(Value::as_str), Some("id-1"));
    assert_eq!(value.get("channel").and_then(Value::as_str), Some("mcp"));
    assert_eq!(
        validate_ingest_messages(&Value::Array(vec![])).expect_err("empty"),
        "memory_ingest_session: messages must be a non-empty array"
    );
    let blank_created = validate_ingest_messages(&json!([{
        "role": "user",
        "content": "hello",
        "created_at": ""
    }]))
    .expect("blank created_at");
    assert!(blank_created[0].created_at.is_none());
    let spaced_created = validate_ingest_messages(&json!([{
        "role": "user",
        "content": "hello",
        "created_at": " "
    }]))
    .expect("spaced created_at");
    assert_eq!(spaced_created[0].created_at.as_deref(), Some(" "));
    let epoch_created = validate_ingest_messages(&json!([{
        "role": "user",
        "content": "hello",
        "created_at": 1_791_590_400_000_i64
    }]))
    .expect("epoch created_at");
    assert_eq!(
        epoch_created[0].created_at.as_deref(),
        Some("2026-10-10T00:00:00.000Z")
    );
    let zero_created = validate_ingest_messages(&json!([{
        "role": "user",
        "content": "hello",
        "created_at": 0
    }]))
    .expect("zero created_at");
    assert!(zero_created[0].created_at.is_none());
    let sql = capture_conversation_upsert_sql(true);
    assert!(sql.contains("$6::uuid"));
    assert!(sql.contains("ON CONFLICT (session_key, agent) DO UPDATE"));
    assert!(sql.contains(
        "owner_user_id = COALESCE(ros_conversations.owner_user_id, EXCLUDED.owner_user_id)"
    ));
    assert!(!sql.contains("active = true") && !sql.contains("active=true"));
    let plain = capture_conversation_upsert_sql(false);
    assert!(!plain.contains("owner_user_id"));
    let insert = capture_message_insert_sql(false);
    assert!(insert.contains("$7::jsonb"));
    assert!(insert.contains("COALESCE($10::timestamptz, now())"));
    assert_eq!(
        capture_guard_statements()[0],
        "SET idle_in_transaction_session_timeout = '30s'"
    );
    assert_eq!(
        capture_guard_statements()[1],
        "SET statement_timeout = '60s'"
    );
    assert_eq!(IDLE_IN_TRANSACTION_TIMEOUT, "30s");
    assert_eq!(STATEMENT_TIMEOUT, "60s");
    assert_eq!(CAPTURE_POOL_MAX, 1);
    let filter = memory::BrowseFilter {
        since: None,
        before: None,
        window: None,
        ..memory::BrowseFilter::default()
    };
    let browse = browse_sql(&filter, Some("2026-01-01T00:00:00Z"), None).expect("browse");
    assert!(browse.sql.contains("::timestamptz"));
    assert!(browse.sql.contains("LIMIT 50"));
    assert!(!browse.sql.contains("LIMIT $"));
    let now = chrono::Local
        .with_ymd_and_hms(2026, 10, 11, 15, 0, 0)
        .single()
        .expect("now");
    let mut tool_args = Map::new();
    tool_args.insert(
        "conversation_id".to_string(),
        Value::String("11111111-1111-4111-8111-111111111111".to_string()),
    );
    tool_args.insert("order".to_string(), Value::String("asc".to_string()));
    tool_args.insert("include_tools".to_string(), Value::Bool(false));
    tool_args.insert("tag".to_string(), Value::String("project:demo".to_string()));
    tool_args.insert("limit".to_string(), json!(10));
    let tool = browse_tool_sql(&tool_args, now).expect("tool browse");
    assert!(tool.sql.contains("m.role <> 'tool'"));
    assert!(tool.sql.contains("ORDER BY m.created_at ASC"));
    assert!(tool.sql.contains("$1::uuid"));
    assert!(tool.sql.contains("m.tool_result"));
    assert!(tool.sql.contains("m.metadata"));
    assert!(!tool.sql.contains("session_key"));
    assert!(tool.sql.contains("LIMIT 10"));
    assert!(!tool.sql.contains("LIMIT $"));
    tool_args.insert("tag".to_string(), Value::String("not a tag".to_string()));
    let err = browse_tool_sql(&tool_args, now).expect_err("tag");
    assert_eq!(
        err,
        "Browse failed: tag must be key:value (got \"not a tag\")"
    );
    let browse_schema = memory_tool_parameters("memory_browse");
    let keys: Vec<_> = browse_schema["properties"]
        .as_object()
        .expect("props")
        .keys()
        .cloned()
        .collect();
    assert_eq!(
        keys,
        [
            "conversation_id",
            "since",
            "before",
            "window",
            "agent",
            "tag",
            "include_tools",
            "limit",
            "order"
        ]
    );
    assert_eq!(
        browse_schema["properties"]["order"]["description"],
        json!("Chronological order — asc (oldest first) or desc (newest first, default)")
    );
    assert_eq!(
        memory_tool_parameters("memory_get_full")["required"],
        json!(["id"])
    );
    assert_eq!(
        memory_tool_parameters("memory_stats")["properties"]["agent"]["description"],
        json!("Filter stats to a specific agent (optional)")
    );
    assert_eq!(memory_tool_parameters("memory_append"), json!({}));
    assert_eq!(memory_tool_parameters("memory_ingest_session"), json!({}));
}

#[test]
fn calendar_windows_follow_the_injected_zone() {
    let midnight = NaiveTime::from_hms_opt(0, 0, 0).expect("midnight");
    let utc = Utc.with_ymd_and_hms(2026, 3, 9, 15, 0, 0).unwrap();
    assert_window(
        utc,
        "yesterday",
        "2026-03-08T00:00:00.000Z",
        Some("2026-03-09T00:00:00.000Z"),
    );
    assert_eq!(
        hours_between("2026-03-08T00:00:00.000Z", "2026-03-09T00:00:00.000Z"),
        24
    );
    assert_window(utc, "this_week", "2026-03-09T00:00:00.000Z", None);
    assert_window(utc, "today", "2026-03-09T00:00:00.000Z", None);
    assert_window(utc, "last_24h", "2026-03-08T15:00:00.000Z", None);
    assert_window(utc, "last_7d", "2026-03-02T15:00:00.000Z", None);
    let tokyo = FixedOffset::east_opt(9 * 3600)
        .expect("tokyo")
        .with_ymd_and_hms(2026, 3, 9, 15, 0, 0)
        .unwrap();
    assert_window(
        tokyo,
        "yesterday",
        "2026-03-07T15:00:00.000Z",
        Some("2026-03-08T15:00:00.000Z"),
    );
    assert_eq!(
        hours_between("2026-03-07T15:00:00.000Z", "2026-03-08T15:00:00.000Z"),
        24
    );
    assert_window(tokyo, "this_week", "2026-03-08T15:00:00.000Z", None);
    let eastern = us_eastern();
    assert_window(
        zone_at(eastern, 2026, 3, 9, 15, 0, 0),
        "yesterday",
        "2026-03-08T05:00:00.000Z",
        Some("2026-03-09T04:00:00.000Z"),
    );
    assert_eq!(
        hours_between("2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"),
        23
    );
    let spring = DateTime::parse_from_rfc3339("2026-03-08T05:00:00.000Z")
        .expect("spring")
        .with_timezone(&eastern);
    assert_eq!(spring.time(), midnight);
    assert_eq!(
        spring.date_naive(),
        NaiveDate::from_ymd_opt(2026, 3, 8).expect("march 8")
    );
    assert_window(
        zone_at(eastern, 2026, 3, 9, 15, 0, 0),
        "this_week",
        "2026-03-09T04:00:00.000Z",
        None,
    );
    assert_window(
        zone_at(eastern, 2026, 3, 9, 15, 0, 0),
        "last_24h",
        "2026-03-08T19:00:00.000Z",
        None,
    );
    assert_window(
        zone_at(eastern, 2026, 11, 2, 15, 0, 0),
        "yesterday",
        "2026-11-01T04:00:00.000Z",
        Some("2026-11-02T05:00:00.000Z"),
    );
    assert_eq!(
        hours_between("2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"),
        25
    );
    let fall = DateTime::parse_from_rfc3339("2026-11-01T04:00:00.000Z")
        .expect("fall")
        .with_timezone(&eastern);
    assert_eq!(fall.time(), midnight);
    assert_eq!(fall.weekday(), chrono::Weekday::Sun);
    assert_window(
        zone_at(eastern, 2026, 10, 11, 15, 0, 0),
        "yesterday",
        "2026-10-10T04:00:00.000Z",
        Some("2026-10-11T04:00:00.000Z"),
    );
    assert_eq!(
        hours_between("2026-10-10T04:00:00.000Z", "2026-10-11T04:00:00.000Z"),
        24
    );
    assert_window(
        zone_at(eastern, 2026, 10, 11, 15, 0, 0),
        "this_week",
        "2026-10-05T04:00:00.000Z",
        None,
    );
    let au = sydney();
    assert_window(
        zone_at(au, 2026, 10, 5, 15, 0, 0),
        "yesterday",
        "2026-10-03T14:00:00.000Z",
        Some("2026-10-04T13:00:00.000Z"),
    );
    assert_eq!(
        hours_between("2026-10-03T14:00:00.000Z", "2026-10-04T13:00:00.000Z"),
        23
    );
    assert_window(
        zone_at(au, 2026, 4, 6, 15, 0, 0),
        "yesterday",
        "2026-04-04T13:00:00.000Z",
        Some("2026-04-05T14:00:00.000Z"),
    );
    assert_eq!(
        hours_between("2026-04-04T13:00:00.000Z", "2026-04-05T14:00:00.000Z"),
        25
    );
    let split = weekday_gap();
    assert_window(
        zone_at(split, 2026, 3, 12, 15, 0, 0),
        "yesterday",
        "2026-03-11T05:00:00.000Z",
        Some("2026-03-12T04:00:00.000Z"),
    );
    assert_eq!(
        hours_between("2026-03-11T05:00:00.000Z", "2026-03-12T04:00:00.000Z"),
        23
    );
    assert_window(
        zone_at(split, 2026, 3, 12, 15, 0, 0),
        "this_week",
        "2026-03-09T05:00:00.000Z",
        None,
    );
    assert_window(
        zone_at(split, 2026, 11, 5, 15, 0, 0),
        "yesterday",
        "2026-11-04T04:00:00.000Z",
        Some("2026-11-05T05:00:00.000Z"),
    );
    assert_eq!(
        hours_between("2026-11-04T04:00:00.000Z", "2026-11-05T05:00:00.000Z"),
        25
    );
    assert_window(
        zone_at(split, 2026, 11, 6, 15, 0, 0),
        "this_week",
        "2026-11-02T04:00:00.000Z",
        None,
    );
}

#[test]
fn js_dates_keep_the_recorded_forms() {
    let utc = |raw: &str| {
        chrono::DateTime::parse_from_rfc3339(raw)
            .expect(raw)
            .with_timezone(&chrono::Utc)
    };
    assert_eq!(
        parse_js_date("2026-10-11T12:00:00Z"),
        Some(utc("2026-10-11T12:00:00Z"))
    );
    assert_eq!(
        parse_js_date("2026-10-11 12:00:00Z"),
        Some(utc("2026-10-11T12:00:00Z"))
    );
    assert_eq!(
        parse_js_date("2026-10-11"),
        Some(utc("2026-10-11T00:00:00Z"))
    );
    assert!(parse_js_date("not-a-date").is_none());
    assert!(parse_js_date("2026-10-11T12:00:00Z trailing").is_none());
    let local = chrono::Local
        .with_ymd_and_hms(2026, 10, 11, 15, 4, 5)
        .single()
        .expect("local");
    assert_eq!(
        parse_js_date("2026-10-11T15:04:05"),
        Some(local.with_timezone(&chrono::Utc))
    );
    let noon = chrono::Local
        .with_ymd_and_hms(2026, 10, 11, 12, 0, 0)
        .single()
        .expect("noon");
    assert_eq!(
        parse_js_date("2026-10-11 12:00:00"),
        Some(noon.with_timezone(&chrono::Utc))
    );
}

#[test]
fn opencode_json_matches_javascript_stringify() {
    let raw = r#"{"type":"tool","tool":"sample","state":{"input":{"n":1.0,"0":"idx","b":2,"samples":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]}}}"#;
    let value: Value = serde_json::from_str(raw).expect("part");
    let extracted = extract_opencode_from_part(&value);
    assert_eq!(
        extracted.tool_args.as_deref(),
        Some(r#"{"0":"idx","n":1,"b":2,"samples":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]}"#)
    );
    let line = r#"{"params":{"update":{"rawOutput":{"type":"MCP","server_name":"s","tool_name":"t","output":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]}}}}"#;
    let full = extract_full_from_line(line, None);
    let tool_result = full.tool_result.expect("mcp");
    assert!(!tool_result.contains("[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]"));
    assert!(tool_result.contains("\\u0000"));
    let mut stdout = vec![b'a'; 19];
    stdout.push(0xff);
    let bytes = stdout
        .iter()
        .map(|byte| byte.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let grep = format!(
        r#"{{"params":{{"update":{{"rawOutput":{{"type":"GrepSearch","stdout":[{bytes}]}}}}}}}}"#
    );
    let recovered = extract_full_from_line(&grep, None);
    assert_eq!(
        recovered.tool_result.as_deref(),
        Some("aaaaaaaaaaaaaaaaaaa\u{FFFD}")
    );
    let clipped = extract_full_from_line(
        r#"{"params":{"update":{"rawOutput":{"type":"GrepSearch","stdout":[72,256,-1,105]}}}}"#,
        None,
    );
    assert_eq!(clipped.tool_result.as_deref(), Some("H\u{0}\u{FFFD}i"));
    let mcp = extract_full_from_line(
        r#"{"params":{"update":{"rawOutput":{"type":"MCP","server_name":"s","tool_name":"t","output":[104,101,108,108,111,255,33,0,1,2,3,4,5,6,7,8]}}}}"#,
        None,
    );
    let mcp_text = mcp.tool_result.expect("mcp lossy");
    assert!(!mcp_text.contains("[16 bytes]"));
    assert!(mcp_text.contains("hello\u{FFFD}!"));
}

#[test]
fn report_formatters_and_get_full_strings() {
    assert_eq!(en_us(1000), "1,000");
    assert_eq!(en_us(0), "0");
    let iso = format_js_iso(
        chrono::Utc
            .with_ymd_and_hms(2026, 10, 10, 19, 4, 6)
            .unwrap()
            .with_nanosecond(92_000_000)
            .unwrap(),
    );
    assert_eq!(iso, "2026-10-10T19:04:06.092Z");
    assert!(health_cached(10_000, 0, true).is_none());
    assert_eq!(health_cached(20_000, 10_000, true), Some(true));
    let empty = format_queue_health(&[]);
    assert!(empty.contains("(empty)"));
    let line = format_queue_health(&[QueueRow {
        task: "embed-target".to_string(),
        pending: 1,
        dead: 0,
        running: Some(0),
        scheduled: Some(0),
        oldest_pending_age_min: None,
        last_error: None,
        recent_dead: 0,
    }]);
    assert!(line.contains(", 0 dead"));
    let embed = format_embedding_queue(1, 2, 3, 0);
    assert!(embed.contains("Messages awaiting embedding: 1"));
    assert!(embed.contains("Unembeddable (excluded by design): 3"));
    assert_eq!(extract_text(&Value::String("hello".to_string())), "hello");
    assert!(missing_pointer_message().contains("pre-#196"));
    let mut meta = Map::new();
    meta.insert("truncated".to_string(), Value::Bool(true));
    meta.insert("full_content_length".to_string(), json!(10));
    assert!(truncation_hint(Some(&meta), "row-9").contains("memory_get_full id=row-9"));
    assert!(
        file_missing_message("/tmp/missing.jsonl", Some("grok")).contains("/tmp/missing.jsonl")
    );
    let unset = protocol::host::MapEnv::new();
    let root_session = "/root/.codex/sessions/session.jsonl";
    let unset_message = file_missing_message_with(root_session, None, &unset);
    assert!(
        unset_message.contains("Path looks like a per-host harness session store"),
        "{unset_message}"
    );
    let mut rooted = protocol::host::MapEnv::new();
    rooted.set("HOME", "/root");
    let desk_message = file_missing_message_with(root_session, None, &rooted);
    assert!(
        desk_message.contains("Path is a desk/user home directory"),
        "{desk_message}"
    );
    let passwd = protocol::host::home_dir(&protocol::host::MapEnv::new()).unwrap_or_default();
    if !passwd.is_empty() {
        let under_passwd = format!(
            "{}/.codex/sessions/session.jsonl",
            passwd.trim_end_matches('/')
        );
        assert_eq!(
            file_missing_message_with(&under_passwd, None, &unset),
            format_missing_jsonl_message(&under_passwd, None, ""),
            "HOME unset must not fall back to the passwd directory {passwd}"
        );
    }
    let row = CoworkHookRow {
        id: "1".to_string(),
        role: "user".to_string(),
        content: "hello".to_string(),
        event_id: "h1".to_string(),
    };
    let picked = pick_cowork_hook_rewrite(
        "user",
        "hello",
        Some("cowork-transcript"),
        None,
        std::slice::from_ref(&row),
        &[],
    );
    assert_eq!(picked.unwrap().id, "1");
    assert!(pick_cowork_hook_rewrite("user", "hello", Some("other"), None, &[row], &[]).is_none());
}

struct Stub(&'static str);

impl MemoryStore for Stub {
    async fn append(&self, _entry: &MemoryEntry) -> Result<String, StoreError> {
        Ok(self.0.to_string())
    }
    async fn search(&self, _query: &str, _options: &SearchOptions) -> Result<Value, StoreError> {
        Ok(Value::String(self.0.to_string()))
    }
    async fn get_context_for_turn(
        &self,
        _query: &str,
        _agent: &str,
        _user_id: Option<&str>,
    ) -> Result<String, StoreError> {
        Ok(self.0.to_string())
    }
    async fn get_session_history(
        &self,
        _session_id: &str,
        _limit: Option<i64>,
    ) -> Result<Vec<HistoryMessage>, StoreError> {
        Ok(vec![HistoryMessage {
            role: self.0.to_string(),
            content: String::new(),
        }])
    }
    async fn get_task_history(
        &self,
        _task_id: &str,
        _limit: Option<i64>,
    ) -> Result<Vec<HistoryMessage>, StoreError> {
        Ok(vec![HistoryMessage {
            role: self.0.to_string(),
            content: String::new(),
        }])
    }
    async fn save_session_settings(
        &self,
        _session_id: &str,
        _settings: &Map<String, Value>,
    ) -> Result<(), StoreError> {
        Ok(())
    }
    async fn load_session_settings(&self, _session_id: &str) -> Result<Option<Value>, StoreError> {
        Ok(None)
    }
    async fn call_tool(&self, _name: &str, _args: &Value) -> Result<String, StoreError> {
        Ok(self.0.to_string())
    }
    async fn capture(
        &self,
        _batch: &memory::CaptureBatch,
        _options: &CaptureOptions,
    ) -> Result<memory::CaptureResult, StoreError> {
        Ok(memory::CaptureResult {
            ok: true,
            conversation_id: self.0.to_string(),
            inserted: 0,
            skipped: 0,
        })
    }
    async fn browse(&self, _filter: &memory::BrowseFilter) -> Result<Value, StoreError> {
        Ok(Value::String(self.0.to_string()))
    }
    async fn stats(&self) -> Result<memory::StatsReport, StoreError> {
        Ok(memory::StatsReport {
            dashboard: Value::Null,
            markdown: self.0.to_string(),
        })
    }
    async fn health(&self, _owner: bool) -> Result<memory::HealthReport, StoreError> {
        Ok(memory::HealthReport {
            body: Value::String(self.0.to_string()),
        })
    }
    fn tools(&self) -> Vec<memory::ToolDescriptor> {
        Vec::new()
    }
    async fn tags(&self) -> Result<(), StoreError> {
        Err(StoreError::NotYetImplemented("tags"))
    }
    fn wiki(&self) -> Option<String> {
        None
    }
    async fn ingest_session(&self, _input: &IngestInput) -> Result<IngestOutput, StoreError> {
        Ok(IngestOutput {
            session_id: self.0.to_string(),
            ingested: 0,
            skipped: 0,
            ids: Vec::new(),
            source: String::new(),
            agent: String::new(),
            channel: String::new(),
            persona: None,
            truncated: false,
            full_content_length: None,
        })
    }
    async fn get_full(&self, _id: &str) -> Result<String, StoreError> {
        Ok(self.0.to_string())
    }
}

#[tokio::test]
async fn routing_follows_session_suffix_and_blocks() {
    assert_eq!(user_from_session_key("claude-code:phil"), Some("phil"));
    assert_eq!(user_from_session_key("task:abc"), None);
    assert_eq!(user_from_session_key("noseparator"), None);
    assert_eq!(user_from_session_key("ends:"), None);
    let routed = RoutingMemory {
        main: StoreHandle::Live(Stub("main")),
        by_user: vec![
            ("phil".to_string(), StoreHandle::Live(Stub("phil"))),
            (
                "blocked".to_string(),
                StoreHandle::Blocked("blocked".to_string()),
            ),
        ],
    };
    assert_eq!(
        routed.append(&entry("claude-code:phil")).await.unwrap(),
        "phil"
    );
    assert_eq!(
        routed.append(&entry("claude-code:other")).await.unwrap(),
        "main"
    );
    assert_eq!(routed.append(&entry("task:abc")).await.unwrap(), "main");
    let err = routed
        .append(&entry("claude-code:blocked"))
        .await
        .expect_err("blocked");
    assert_eq!(
        err.to_string(),
        "memory for user \"blocked\" is unavailable (store failed to initialize)"
    );
    let blocked_main = RoutingMemory {
        main: StoreHandle::<Stub>::Blocked("owner".to_string()),
        by_user: Vec::new(),
    };
    assert!(
        blocked_main
            .get_task_history("abc", None)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        routed
            .ingest_session(&ingest("codex:phil"))
            .await
            .unwrap()
            .session_id,
        "phil"
    );
    assert_eq!(routed.get_full("id").await.unwrap(), "main");
    assert!(
        routed
            .tags()
            .await
            .unwrap_err()
            .to_string()
            .contains("tags")
    );
    assert!(routed.wiki().is_none());
}

fn entry(session_id: &str) -> MemoryEntry {
    MemoryEntry {
        session_id: session_id.to_string(),
        agent: "rivet".to_string(),
        channel: "test".to_string(),
        role: "user".to_string(),
        content: "hi".to_string(),
        tool_name: None,
        tool_args: None,
        tool_result: None,
        metadata: None,
        created_at: None,
    }
}

fn ingest(session_id: &str) -> IngestInput {
    IngestInput {
        session_id: session_id.to_string(),
        messages: vec![memory::IngestMessage {
            role: "user".to_string(),
            content: "hi".to_string(),
            created_at: None,
            tool_calls: Vec::new(),
        }],
        source: None,
        agent: None,
        persona: None,
        channel: None,
        env: BTreeMap::new(),
    }
}

#[tokio::test]
async fn deferred_methods_do_not_open_a_database() {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://127.0.0.1/rivetos_rr2a")
        .expect("lazy");
    let store = PostgresMemory::from_pool(pool, true);
    let err = store
        .search("q", &SearchOptions::default())
        .await
        .expect_err("search");
    assert!(err.to_string().contains("search"));
    let err = store
        .get_context_for_turn("q", "rivet", None)
        .await
        .expect_err("context");
    assert!(err.to_string().contains("getContextForTurn"));
    assert!(
        store
            .tags()
            .await
            .expect_err("tags")
            .to_string()
            .contains("tags")
    );
    assert!(store.wiki().is_none());
    let err = store
        .call_tool("memory_nope", &json!({}))
        .await
        .expect_err("unknown");
    assert!(err.to_string().contains("unknown tool: memory_nope"));
    let names: Vec<_> = store.tools().into_iter().map(|tool| tool.name).collect();
    assert_eq!(
        names,
        [
            "memory_browse",
            "memory_stats",
            "memory_get_full",
            "memory_append",
            "memory_ingest_session"
        ]
    );
}
