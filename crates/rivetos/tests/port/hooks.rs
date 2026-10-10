use crate::common;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rivetos::{
    DEFAULT_WORKER_DEADLINE_MS, DeadlineOptions, HookEventOptions, HookEventResult, HookIngestFn,
    WorkerDeps, arm_worker_deadline, claim_spool, hook_command, ingest_spool_file, install_hooks,
    is_direct_cli, spool_attempt, status_text, sweep_stale_spools, uninstall_hooks,
    with_spool_attempt, write_spool_payload,
};

fn prompt_payload() -> serde_json::Value {
    serde_json::json!({
        "hook_event_name": "UserPromptSubmit",
        "session_id": "sess-1",
        "prompt": "hello"
    })
}

fn write_spool(dir: &Path, name: &str, payload: &serde_json::Value) -> PathBuf {
    let file = dir.join(name);
    std::fs::write(&file, payload.to_string()).unwrap();
    file
}

fn success_hook() -> HookIngestFn {
    Arc::new(|_opts: HookEventOptions| {
        Box::pin(async {
            Ok(HookEventResult {
                session_key: "k".to_string(),
                conversation_id: "c".to_string(),
                created: true,
                inserted: 1,
                skipped: None,
            })
        })
    })
}

fn fail_hook(message: &'static str) -> HookIngestFn {
    Arc::new(move |_opts: HookEventOptions| {
        let detail = message.to_string();
        Box::pin(async move { Err(detail) })
    })
}

fn silent() -> WorkerDeps {
    WorkerDeps {
        log: Some(Arc::new(|_| {})),
        ..WorkerDeps::default()
    }
}

fn json_names(dir: &Path) -> Vec<String> {
    let mut names = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".json"))
        .collect::<Vec<_>>();
    names.sort();
    names
}

#[test]
fn spool_attempt_reads_and_bumps_the_counter() {
    assert_eq!(spool_attempt(Path::new("/tmp/x.a1.json")), 1);
    assert_eq!(spool_attempt(Path::new("/tmp/x.a3.json")), 3);
    assert_eq!(spool_attempt(Path::new("/tmp/legacy.json")), 1);
    assert_eq!(
        with_spool_attempt(Path::new("/tmp/x.a1.json"), 2),
        PathBuf::from("/tmp/x.a2.json")
    );
}

#[test]
fn spool_attempt_strips_a_claim_suffix() {
    assert_eq!(spool_attempt(Path::new("/tmp/x.a1.json.claim.12.ab9x")), 1);
    assert_eq!(
        with_spool_attempt(Path::new("/tmp/x.a1.json.claim.12.ab9x"), 2),
        PathBuf::from("/tmp/x.a2.json")
    );
}

#[tokio::test(start_paused = true)]
async fn deadline_invokes_exit_and_closes_clients() {
    let exit = Arc::new(AtomicBool::new(false));
    let close = Arc::new(AtomicBool::new(false));
    let logged = Arc::new(Mutex::new(String::new()));
    let exit_flag = exit.clone();
    let close_flag = close.clone();
    let log_slot = logged.clone();
    let _handle = arm_worker_deadline(DeadlineOptions {
        ms: DEFAULT_WORKER_DEADLINE_MS,
        exit: Arc::new(move |code| {
            assert_eq!(code, 1);
            exit_flag.store(true, Ordering::SeqCst);
        }),
        close: Arc::new(move || close_flag.store(true, Ordering::SeqCst)),
        log: Arc::new(move |message| {
            *log_slot.lock().unwrap() = message.to_string();
        }),
    });
    assert!(!exit.load(Ordering::SeqCst));
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(DEFAULT_WORKER_DEADLINE_MS)).await;
    tokio::task::yield_now().await;
    assert!(close.load(Ordering::SeqCst));
    assert!(exit.load(Ordering::SeqCst));
    assert_eq!(
        logged.lock().unwrap().as_str(),
        "worker: deadline exceeded (120000ms) — closing clients and exiting"
    );
}

#[tokio::test(start_paused = true)]
async fn deadline_does_not_exit_when_cancelled() {
    let exit = Arc::new(AtomicBool::new(false));
    let close = Arc::new(AtomicBool::new(false));
    let exit_flag = exit.clone();
    let close_flag = close.clone();
    let handle = arm_worker_deadline(DeadlineOptions {
        ms: 5_000,
        exit: Arc::new(move |_code| exit_flag.store(true, Ordering::SeqCst)),
        close: Arc::new(move || close_flag.store(true, Ordering::SeqCst)),
        log: Arc::new(|_| {}),
    });
    tokio::task::yield_now().await;
    handle.cancel();
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(10_000)).await;
    tokio::task::yield_now().await;
    assert!(!exit.load(Ordering::SeqCst));
    assert!(!close.load(Ordering::SeqCst));
}

#[tokio::test]
async fn ingest_removes_the_spool_after_success() {
    let dir = tempfile::tempdir().unwrap();
    let file = write_spool(dir.path(), "ok.a1.json", &prompt_payload());
    let mut deps = silent();
    deps.ingest_hook = Some(success_hook());
    ingest_spool_file(&file, &deps).await.unwrap();
    assert!(!file.exists());
}

#[tokio::test]
async fn ingest_retains_the_spool_with_a_bumped_attempt() {
    let dir = tempfile::tempdir().unwrap();
    let file = write_spool(dir.path(), "fail.a1.json", &prompt_payload());
    let mut deps = silent();
    deps.ingest_hook = Some(fail_hook("db down"));
    deps.max_attempts = Some(5);
    ingest_spool_file(&file, &deps).await.unwrap();
    assert!(!file.exists());
    assert!(dir.path().join("fail.a2.json").exists());
}

#[tokio::test]
async fn ingest_drops_a_poison_spool_after_n_attempts() {
    let dir = tempfile::tempdir().unwrap();
    let file = write_spool(dir.path(), "poison.a2.json", &prompt_payload());
    let mut deps = silent();
    deps.ingest_hook = Some(fail_hook("still bad"));
    deps.max_attempts = Some(2);
    ingest_spool_file(&file, &deps).await.unwrap();
    assert!(!file.exists());
    assert!(json_names(dir.path()).is_empty());
}

#[tokio::test]
async fn sweep_retries_a_stale_spool_then_drops_it() {
    let dir = tempfile::tempdir().unwrap();
    let file = write_spool(dir.path(), "stale.a1.json", &prompt_payload());
    common::age_file(&file, 200);
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_hook = calls.clone();
    let ingest: HookIngestFn = Arc::new(move |_opts| {
        calls_hook.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Err("poison".to_string()) })
    });
    let mut deps = silent();
    deps.spool_dir = Some(dir.path().to_path_buf());
    deps.deadline_ms = Some(120_000);
    deps.max_attempts = Some(3);
    deps.ingest_hook = Some(ingest);
    sweep_stale_spools(&deps).await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(json_names(dir.path()), vec!["stale.a2.json".to_string()]);
    let next = dir.path().join("stale.a2.json");
    common::age_file(&next, 200);
    sweep_stale_spools(&deps).await.unwrap();
    let third = dir.path().join("stale.a3.json");
    common::age_file(&third, 200);
    sweep_stale_spools(&deps).await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    assert!(json_names(dir.path()).is_empty());
}

#[tokio::test]
async fn sweep_does_not_retry_a_fresh_spool() {
    let dir = tempfile::tempdir().unwrap();
    let file = write_spool(dir.path(), "fresh.a1.json", &prompt_payload());
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_hook = calls.clone();
    let ingest: HookIngestFn = Arc::new(move |_opts| {
        calls_hook.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {
            Ok(HookEventResult {
                session_key: "k".to_string(),
                conversation_id: "c".to_string(),
                created: true,
                inserted: 1,
                skipped: None,
            })
        })
    });
    let mut deps = silent();
    deps.spool_dir = Some(dir.path().to_path_buf());
    deps.deadline_ms = Some(120_000);
    deps.ingest_hook = Some(ingest);
    sweep_stale_spools(&deps).await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(file.exists());
}

#[tokio::test]
async fn run_worker_processes_the_assigned_spool_then_sweeps() {
    let dir = tempfile::tempdir().unwrap();
    let assigned = write_spool(dir.path(), "assigned.a1.json", &prompt_payload());
    let stale = write_spool(dir.path(), "old.a1.json", &prompt_payload());
    common::age_file(&stale, 200);
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_hook = calls.clone();
    let ingest: HookIngestFn = Arc::new(move |_opts| {
        calls_hook.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {
            Ok(HookEventResult {
                session_key: "k".to_string(),
                conversation_id: "c".to_string(),
                created: true,
                inserted: 1,
                skipped: None,
            })
        })
    });
    let mut deps = silent();
    deps.spool_dir = Some(dir.path().to_path_buf());
    deps.deadline_ms = Some(120_000);
    deps.ingest_hook = Some(ingest);
    rivetos::run_worker(&assigned, &deps).await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(!assigned.exists());
    assert!(!stale.exists());
}

#[test]
fn claim_renames_the_file_and_a_second_claim_loses() {
    let dir = tempfile::tempdir().unwrap();
    let file = write_spool(dir.path(), "x.a1.json", &prompt_payload());
    let claimed = claim_spool(&file).unwrap();
    assert!(!file.exists());
    assert!(claimed.exists());
    assert!(claim_spool(&file).is_none());
    assert_eq!(claim_spool(&claimed).as_ref(), Some(&claimed));
}

#[tokio::test]
async fn ingest_does_not_run_when_the_file_is_already_claimed() {
    let dir = tempfile::tempdir().unwrap();
    let file = write_spool(dir.path(), "x.a1.json", &prompt_payload());
    let claimed = claim_spool(&file).unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_hook = calls.clone();
    let ingest: HookIngestFn = Arc::new(move |_opts| {
        calls_hook.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {
            Ok(HookEventResult {
                session_key: "k".to_string(),
                conversation_id: "c".to_string(),
                created: true,
                inserted: 1,
                skipped: None,
            })
        })
    });
    let mut deps = silent();
    deps.ingest_hook = Some(ingest);
    ingest_spool_file(&file, &deps).await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(claimed.exists());
}

#[tokio::test]
async fn retry_reuses_the_stored_event_id_after_the_transcript_grows() {
    let dir = tempfile::tempdir().unwrap();
    let transcript = dir.path().join("sess.jsonl");
    let user = |uuid: &str| {
        serde_json::json!({
            "type": "user",
            "sessionId": "sess-1",
            "uuid": uuid,
            "message": {"role": "user", "content": "continue"}
        })
        .to_string()
    };
    std::fs::write(&transcript, format!("{}\n", user("u1"))).unwrap();
    let file = write_spool(
        dir.path(),
        "retry.a1.json",
        &serde_json::json!({
            "hook_event_name": "UserPromptSubmit",
            "session_id": "sess-1",
            "prompt": "continue",
            "transcript_path": transcript
        }),
    );
    let calls = Arc::new(AtomicUsize::new(0));
    let bodies = Arc::new(Mutex::new(Vec::<String>::new()));
    let calls_exchange = calls.clone();
    let bodies_exchange = bodies.clone();
    let exchange: rivetos::HttpExchange = Arc::new(move |body| {
        let n = calls_exchange.fetch_add(1, Ordering::SeqCst);
        bodies_exchange.lock().unwrap().push(body.to_string());
        if n == 0 {
            Ok(rivetos::HttpReply {
                status: 400,
                body: "no".to_string(),
            })
        } else {
            Ok(rivetos::HttpReply {
                status: 200,
                body: r#"{"ok":true,"conversation_id":"c","inserted":1,"skipped":0}"#.to_string(),
            })
        }
    });
    let mut deps = silent();
    deps.env = Some(common::den_env());
    deps.exchange = Some(exchange);
    deps.capture_spool_dir = Some(dir.path().join("capture"));
    ingest_spool_file(&file, &deps).await.unwrap();
    let retained = dir.path().join("retry.a2.json");
    assert!(retained.exists());
    let stored: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&retained).unwrap()).unwrap();
    assert_eq!(stored["rivetos_event_id"], "claude-code:sess-1:u1");
    let grown = format!(
        "{}\n{}\n{}\n",
        user("u1"),
        serde_json::json!({
            "type": "assistant",
            "sessionId": "sess-1",
            "uuid": "a1",
            "message": {"role": "assistant", "content": "ok"}
        }),
        user("u2")
    );
    std::fs::write(&transcript, grown).unwrap();
    ingest_spool_file(&retained, &deps).await.unwrap();
    let posted: serde_json::Value =
        serde_json::from_str(bodies.lock().unwrap().last().unwrap()).unwrap();
    assert_eq!(posted["messages"][0]["event_id"], "claude-code:sess-1:u1");
    assert!(!retained.exists());
}

#[tokio::test]
async fn delayed_prompt_binds_the_user_uuid_when_the_assistant_is_present() {
    let dir = tempfile::tempdir().unwrap();
    let transcript = common::write_jsonl(
        dir.path(),
        "sess.jsonl",
        &[
            serde_json::json!({
                "type": "user",
                "sessionId": "sess-1",
                "uuid": "u-delayed",
                "message": {"role": "user", "content": "continue"}
            }),
            serde_json::json!({
                "type": "assistant",
                "sessionId": "sess-1",
                "uuid": "a-delayed",
                "message": {"role": "assistant", "content": "already here"}
            }),
        ],
    );
    let file = write_spool(
        dir.path(),
        "late.a1.json",
        &serde_json::json!({
            "hook_event_name": "UserPromptSubmit",
            "session_id": "sess-1",
            "prompt": "continue",
            "transcript_path": transcript
        }),
    );
    let bodies = Arc::new(Mutex::new(Vec::new()));
    let mut deps = silent();
    deps.env = Some(common::den_env());
    deps.exchange = Some(common::ok_exchange(bodies.clone()));
    deps.capture_spool_dir = Some(dir.path().join("capture"));
    deps.poll_ms = Some(20);
    deps.poll_for_ms = Some(80);
    ingest_spool_file(&file, &deps).await.unwrap();
    let posted: serde_json::Value = serde_json::from_str(&bodies.lock().unwrap()[0]).unwrap();
    let messages = common::msgs(&posted);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[0]["event_id"], "claude-code:sess-1:u-delayed");
    assert!(!file.exists());
}

#[tokio::test]
async fn spool_stem_is_the_idempotency_key() {
    let dir = tempfile::tempdir().unwrap();
    let file = write_spool(dir.path(), "abc123.a1.json", &prompt_payload());
    let seen = Arc::new(Mutex::new(None));
    let slot = seen.clone();
    let ingest: HookIngestFn = Arc::new(move |opts| {
        *slot.lock().unwrap() = opts.idempotency_key.clone();
        Box::pin(async {
            Ok(HookEventResult {
                session_key: "k".to_string(),
                conversation_id: "c".to_string(),
                created: true,
                inserted: 1,
                skipped: None,
            })
        })
    });
    let mut deps = silent();
    deps.ingest_hook = Some(ingest);
    ingest_spool_file(&file, &deps).await.unwrap();
    assert_eq!(seen.lock().unwrap().as_deref(), Some("abc123"));
}

#[test]
fn write_spool_payload_uses_private_permissions() {
    let dir = tempfile::tempdir().unwrap();
    let nested = dir.path().join("spool");
    let file = write_spool_payload(&prompt_payload(), &nested).unwrap();
    let dir_mode = std::fs::metadata(&nested).unwrap().permissions().mode() & 0o777;
    let file_mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
    assert_eq!(dir_mode, 0o700);
    assert_eq!(file_mode, 0o600);
    assert!(file.exists());
}

#[test]
fn is_direct_cli_follows_a_symlink_and_rejects_other_paths() {
    let dir = tempfile::tempdir().unwrap();
    let entry = dir.path().join("hooks-entry");
    std::fs::write(&entry, b"entry").unwrap();
    let link = dir.path().join("rivetos-claude-capture");
    std::os::unix::fs::symlink(&entry, &link).unwrap();
    assert!(is_direct_cli(Some(&link), &entry));
    assert!(is_direct_cli(Some(&entry), &entry));
    assert!(!is_direct_cli(None, &entry));
    let other = dir.path().join("other.js");
    std::fs::write(&other, b"").unwrap();
    assert!(!is_direct_cli(Some(&other), &entry));
    let missing = dir.path().join("gone.js");
    assert!(is_direct_cli(Some(&missing), &missing));
    assert!(!is_direct_cli(Some(&missing), &entry));
}

#[test]
fn importing_the_library_does_not_run_main() {
    let dir = tempfile::tempdir().unwrap();
    let settings = dir.path().join("settings.json");
    let text = status_text(&settings);
    assert!(text.contains("installed") || text.to_ascii_lowercase().contains("capture"));
    assert!(text.contains("not installed"));
    assert!(text.contains("Capture incomplete."));
    assert!(!is_direct_cli(None, &settings));
}

#[test]
fn install_status_and_uninstall_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let settings = dir.path().join("settings.json");
    let log = dir.path().join("claude-capture.log");
    let command = hook_command(Path::new("/usr/bin/rivetos"));
    let installed = install_hooks(&settings, &command, &log);
    assert_eq!(
        installed,
        format!(
            "Installed RivetOS capture hooks for: Stop, SubagentStop, SessionEnd, UserPromptSubmit, PostToolUse\n  settings: {}\n  command:  {command}\n  log:      {}",
            settings.display(),
            log.display()
        )
    );
    assert!(status_text(&settings).contains("Capture hooks active."));
    assert_eq!(uninstall_hooks(&settings), "Removed RivetOS capture hooks.");
    assert!(status_text(&settings).contains("Capture incomplete."));
    assert_eq!(
        uninstall_hooks(&settings),
        "No hooks configured — nothing to remove."
    );
}

#[test]
fn status_recognizes_the_legacy_hook_marker() {
    let dir = tempfile::tempdir().unwrap();
    let settings = dir.path().join("settings.json");
    let command = "node \"/opt/claude-cli/dist/hooks.js\"";
    let mut hooks = serde_json::Map::new();
    for event in [
        "Stop",
        "SubagentStop",
        "SessionEnd",
        "UserPromptSubmit",
        "PostToolUse",
    ] {
        hooks.insert(
            event.to_string(),
            serde_json::json!([{ "hooks": [{ "type": "command", "command": command, "timeout": 10 }] }]),
        );
    }
    let root = serde_json::json!({ "hooks": hooks });
    std::fs::write(
        &settings,
        format!("{}\n", serde_json::to_string_pretty(&root).unwrap()),
    )
    .unwrap();
    assert!(status_text(&settings).contains("Capture hooks active."));
}

use std::os::unix::fs::PermissionsExt;
