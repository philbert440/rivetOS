use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime};

use capture::{
    BeforeReaddir, FileLockOptions, ReadFault, hex_host, pid_dead, system_hostname, with_file_lock,
};
use tokio::sync::watch;

fn lock_path() -> PathBuf {
    tempfile::tempdir().unwrap().keep().join("state.json.lock")
}

fn dead_pid() -> u64 {
    for pid in (4_194_254u64..4_194_304).rev() {
        if pid_dead(pid) {
            return pid;
        }
    }
    panic!("no unused pid");
}

fn host_token(pid: u64, label: &str, host: &str) -> String {
    format!("{}.{pid}.1.{label}", hex_host(host))
}

fn holder_names(lock_dir: &Path) -> Vec<String> {
    let mut names = std::fs::read_dir(lock_dir)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("holder."))
        .collect::<Vec<_>>();
    names.sort();
    names
}

fn write_owner(lock_dir: &Path, pid: u64, host: &str, token: &str) -> PathBuf {
    std::fs::create_dir_all(lock_dir).unwrap();
    let full = lock_dir.join(format!("holder.{token}"));
    let body = serde_json::json!({
        "pid": pid,
        "host": host,
        "ts": "2020-01-01T00:00:00.000Z",
        "token": token,
    });
    std::fs::write(&full, body.to_string()).unwrap();
    full
}

fn opts(wait_ms: u64, poll_ms: u64) -> FileLockOptions {
    FileLockOptions {
        wait_ms: Some(wait_ms),
        poll_ms: Some(poll_ms),
        stale_ms: Some(60_000),
        ..FileLockOptions::default()
    }
}

fn decode_hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&text[index..index + 2], 16).unwrap())
        .collect()
}

fn touch_old(path: &Path, age: Duration) {
    let when = SystemTime::now() - age;
    let file = std::fs::File::options().write(true).open(path).unwrap();
    let times = std::fs::FileTimes::new()
        .set_accessed(when)
        .set_modified(when);
    file.set_times(times).unwrap();
}

#[tokio::test]
async fn runs_two_contenders_one_at_a_time() {
    let lock_dir = lock_path();
    let inside = Arc::new(AtomicUsize::new(0));
    let max_inside = Arc::new(AtomicUsize::new(0));
    let run = |who: &'static str,
               inside: Arc<AtomicUsize>,
               max_inside: Arc<AtomicUsize>,
               lock_dir: PathBuf| {
        tokio::spawn(async move {
            with_file_lock(lock_dir, opts(3_000, 10), move || {
                let inside = inside.clone();
                let max_inside = max_inside.clone();
                async move {
                    let now = inside.fetch_add(1, Ordering::SeqCst) + 1;
                    max_inside.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(40)).await;
                    inside.fetch_sub(1, Ordering::SeqCst);
                    who
                }
            })
            .await
            .unwrap()
        })
    };
    let left = run("a", inside.clone(), max_inside.clone(), lock_dir.clone());
    let right = run("b", inside, max_inside.clone(), lock_dir.clone());
    let mut results = vec![left.await.unwrap(), right.await.unwrap()];
    results.sort();
    assert_eq!(results, ["a", "b"]);
    assert_eq!(max_inside.load(Ordering::SeqCst), 1);
    assert!(lock_dir.is_dir());
    assert!(holder_names(&lock_dir).is_empty());
}

#[tokio::test]
async fn pauses_one_contender_before_readdir() {
    let lock_dir = lock_path();
    let inside = Arc::new(AtomicUsize::new(0));
    let max_inside = Arc::new(AtomicUsize::new(0));
    let (tx, rx) = watch::channel(false);
    let paused = Arc::new(AtomicBool::new(false));
    let used = Arc::new(AtomicBool::new(false));
    let before: BeforeReaddir = {
        let paused = paused.clone();
        let used = used.clone();
        let rx = rx.clone();
        Arc::new(move || {
            let paused = paused.clone();
            let used = used.clone();
            let mut rx = rx.clone();
            Box::pin(async move {
                if used.swap(true, Ordering::SeqCst) {
                    return;
                }
                paused.store(true, Ordering::SeqCst);
                while !*rx.borrow() {
                    if rx.changed().await.is_err() {
                        break;
                    }
                }
            })
        })
    };
    let track = |who: &'static str, before: Option<BeforeReaddir>| {
        let inside = inside.clone();
        let max_inside = max_inside.clone();
        let lock_dir = lock_dir.clone();
        tokio::spawn(async move {
            let mut options = opts(4_000, 10);
            options.before_readdir = before;
            with_file_lock(lock_dir, options, move || {
                let inside = inside.clone();
                let max_inside = max_inside.clone();
                async move {
                    let now = inside.fetch_add(1, Ordering::SeqCst) + 1;
                    max_inside.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(30)).await;
                    inside.fetch_sub(1, Ordering::SeqCst);
                    who
                }
            })
            .await
            .unwrap()
        })
    };
    let delayed = track("delayed", Some(before));
    let started = std::time::Instant::now();
    while !paused.load(Ordering::SeqCst) && started.elapsed() < Duration::from_secs(1) {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(paused.load(Ordering::SeqCst));
    let left = track("a", None);
    let right = track("b", None);
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert!(max_inside.load(Ordering::SeqCst) <= 1);
    tx.send(true).unwrap();
    let mut results = vec![
        delayed.await.unwrap(),
        left.await.unwrap(),
        right.await.unwrap(),
    ];
    results.sort();
    assert_eq!(results, ["a", "b", "delayed"]);
    assert_eq!(max_inside.load(Ordering::SeqCst), 1);
    assert_eq!(inside.load(Ordering::SeqCst), 0);
    assert!(holder_names(&lock_dir).is_empty());
}

#[tokio::test]
async fn acquires_when_the_only_other_owner_is_dead() {
    let lock_dir = lock_path();
    let host = system_hostname();
    let pid = dead_pid();
    let token = host_token(pid, "dead", &host);
    let dead = write_owner(&lock_dir, pid, &host, &token);
    let saw = Arc::new(AtomicBool::new(true));
    let flag = saw.clone();
    let dead_check = dead.clone();
    let lock_check = lock_dir.clone();
    let host_check = host.clone();
    let started = std::time::Instant::now();
    with_file_lock(lock_dir.clone(), opts(1_000, 20), move || {
        let flag = flag.clone();
        let dead_check = dead_check.clone();
        let lock_check = lock_check.clone();
        let host_check = host_check.clone();
        async move {
            flag.store(dead_check.exists(), Ordering::SeqCst);
            let names = holder_names(&lock_check);
            assert_eq!(names.len(), 1);
            let body: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(lock_check.join(&names[0])).unwrap())
                    .unwrap();
            assert_eq!(body["pid"], std::process::id());
            assert_eq!(body["host"], host_check);
            assert_eq!(
                names[0],
                format!("holder.{}", body["token"].as_str().unwrap())
            );
            assert!(!body["ts"].as_str().unwrap().is_empty());
        }
    })
    .await
    .unwrap();
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(!saw.load(Ordering::SeqCst));
    assert!(!dead.exists());
    assert!(holder_names(&lock_dir).is_empty());
}

#[tokio::test]
async fn times_out_on_a_live_owner() {
    let lock_dir = lock_path();
    let host = system_hostname();
    let token = host_token(u64::from(std::process::id()), "other", &host);
    let live = write_owner(&lock_dir, u64::from(std::process::id()), &host, &token);
    let entered = Arc::new(AtomicBool::new(false));
    let flag = entered.clone();
    let error = with_file_lock(lock_dir.clone(), opts(250, 20), move || {
        let flag = flag.clone();
        async move {
            flag.store(true, Ordering::SeqCst);
        }
    })
    .await
    .unwrap_err();
    assert!(error.is_timeout());
    assert!(!entered.load(Ordering::SeqCst));
    assert!(live.exists());
    let body = std::fs::read_to_string(&live).unwrap();
    assert!(body.contains(&format!("\"pid\":{}", std::process::id())));
    assert_eq!(holder_names(&lock_dir), vec![format!("holder.{token}")]);
}

#[tokio::test]
async fn times_out_on_a_foreign_host_however_old() {
    let foreign = "remote-host";
    let fresh_dir = lock_path();
    let fresh_token = format!("{}.99.1.fresh", hex_host(foreign));
    let fresh = write_owner(&fresh_dir, 99, foreign, &fresh_token);
    let fresh_bytes = std::fs::read(&fresh).unwrap();
    let error = with_file_lock(fresh_dir.clone(), opts(200, 20), || async {})
        .await
        .unwrap_err();
    assert!(error.is_timeout());
    assert_eq!(std::fs::read(&fresh).unwrap(), fresh_bytes);
    assert_eq!(
        holder_names(&fresh_dir),
        vec![format!("holder.{fresh_token}")]
    );

    let ancient_dir = lock_path();
    let ancient_token = format!("{}.99.1.ancient", hex_host(foreign));
    std::fs::create_dir_all(&ancient_dir).unwrap();
    let ancient = ancient_dir.join(format!("holder.{ancient_token}"));
    std::fs::write(&ancient, "").unwrap();
    let ancient_bytes = std::fs::read(&ancient).unwrap();
    touch_old(&ancient, Duration::from_secs(86_400));
    let mut options = opts(200, 20);
    options.stale_ms = Some(1_000);
    let error = with_file_lock(ancient_dir.clone(), options, || async {})
        .await
        .unwrap_err();
    assert!(error.is_timeout());
    assert_eq!(std::fs::read(&ancient).unwrap(), ancient_bytes);
    let modified = std::fs::metadata(&ancient).unwrap().modified().unwrap();
    assert!(modified.elapsed().unwrap() > Duration::from_secs(60));
    assert_eq!(
        holder_names(&ancient_dir),
        vec![format!("holder.{ancient_token}")]
    );
}

#[tokio::test]
async fn does_not_take_a_lossy_host_collision() {
    let pairs = [("node_a", "node/a"), ("node/a", "node_a")];
    for (local, foreign) in pairs {
        for empty in [false, true] {
            let lock_dir = lock_path();
            let pid = dead_pid();
            let token = host_token(pid, if empty { "empty" } else { "record" }, foreign);
            let full = if empty {
                std::fs::create_dir_all(&lock_dir).unwrap();
                let path = lock_dir.join(format!("holder.{token}"));
                std::fs::write(&path, "").unwrap();
                path
            } else {
                write_owner(&lock_dir, pid, foreign, &token)
            };
            let publish = lock_dir.join(format!(".holderpub.{}", host_token(pid, "pub", foreign)));
            std::fs::write(&publish, "").unwrap();
            let bytes = std::fs::read(&full).unwrap();
            let mut options = opts(200, 20);
            options.host = Some(local.to_string());
            let error = with_file_lock(lock_dir.clone(), options, || async {})
                .await
                .unwrap_err();
            assert!(error.is_timeout());
            assert_eq!(std::fs::read(&full).unwrap(), bytes);
            assert_eq!(std::fs::read_to_string(&publish).unwrap(), "");
            assert_eq!(holder_names(&lock_dir), vec![format!("holder.{token}")]);
        }
    }
}

#[tokio::test]
async fn legacy_owner_blocks_and_is_not_removed() {
    let lock_dir = lock_path();
    let pid = dead_pid();
    let token = format!("node_a.{pid}.1.legacy");
    std::fs::create_dir_all(&lock_dir).unwrap();
    let file = lock_dir.join(format!("owner.{token}"));
    let body = serde_json::json!({ "pid": pid, "host": "node_a", "ts": "2020-01-01T00:00:00.000Z", "token": token }).to_string();
    std::fs::write(&file, &body).unwrap();
    let bytes = std::fs::read(&file).unwrap();
    let publish = lock_dir.join(format!(".publish.{token}"));
    std::fs::write(&publish, "old").unwrap();
    let mut options = opts(200, 20);
    options.host = Some("node_a".to_string());
    let error = with_file_lock(lock_dir.clone(), options, || async {})
        .await
        .unwrap_err();
    assert!(error.is_timeout());
    assert_eq!(std::fs::read(&file).unwrap(), bytes);
    assert_eq!(std::fs::read_to_string(&publish).unwrap(), "old");
    assert!(holder_names(&lock_dir).is_empty());
}

#[tokio::test]
async fn does_not_reclaim_a_legacy_hex_host_token() {
    assert_eq!(hex_host("node_a"), "6e6f64655f61");
    let dead = dead_pid();
    for empty in [false, true] {
        let lock_dir = lock_path();
        std::fs::create_dir_all(&lock_dir).unwrap();
        let tokens = [
            "6e6f64655f61.99.1.x".to_string(),
            format!("6e6f64655f61.{dead}.1.x"),
        ];
        let mut files = Vec::new();
        for token in &tokens {
            let pid: u64 = token.split('.').nth(1).unwrap().parse().unwrap();
            let full = lock_dir.join(format!("owner.{token}"));
            let text = if empty {
                String::new()
            } else {
                serde_json::json!({ "pid": pid, "host": "node_a", "ts": "2020-01-01T00:00:00.000Z", "token": token }).to_string()
            };
            std::fs::write(&full, text).unwrap();
            let publish = lock_dir.join(format!(".publish.{token}"));
            std::fs::write(&publish, "old").unwrap();
            files.push(full);
            files.push(publish);
        }
        let before: Vec<Vec<u8>> = files
            .iter()
            .map(|file| std::fs::read(file).unwrap())
            .collect();
        let mut options = opts(200, 20);
        options.host = Some("node_a".to_string());
        let error = with_file_lock(lock_dir.clone(), options, || async {})
            .await
            .unwrap_err();
        assert!(error.is_timeout());
        for (file, prior) in files.iter().zip(before) {
            assert_eq!(std::fs::read(file).unwrap(), prior);
        }
        assert!(holder_names(&lock_dir).is_empty());
    }
}

#[tokio::test]
async fn unreadable_same_host_body_stays_live() {
    let lock_dir = lock_path();
    let host = system_hostname();
    let pid = dead_pid();
    let token = host_token(pid, "eacces", &host);
    let file = write_owner(&lock_dir, pid, &host, &token);
    let bytes = std::fs::read(&file).unwrap();
    let fault = Arc::new(std::sync::Mutex::new(Some(ReadFault {
        path: file.clone(),
        code: "EACCES".to_string(),
    })));
    let mut options = opts(200, 20);
    options.read_fault = Some(fault);
    let error = with_file_lock(lock_dir.clone(), options, || async {})
        .await
        .unwrap_err();
    assert!(error.is_timeout());
    assert_eq!(std::fs::read(&file).unwrap(), bytes);
    assert_eq!(holder_names(&lock_dir), vec![format!("holder.{token}")]);
}

#[tokio::test]
async fn enoent_body_is_already_released() {
    let lock_dir = lock_path();
    let host = system_hostname();
    let pid = dead_pid();
    let token = host_token(pid, "gone", &host);
    let file = write_owner(&lock_dir, pid, &host, &token);
    let fault = Arc::new(std::sync::Mutex::new(Some(ReadFault {
        path: file.clone(),
        code: "ENOENT".to_string(),
    })));
    let mut options = opts(1_000, 20);
    options.read_fault = Some(fault);
    let flag = Arc::new(AtomicBool::new(false));
    let seen = flag.clone();
    let probe = file.clone();
    with_file_lock(lock_dir, options, move || {
        let seen = seen.clone();
        let probe = probe.clone();
        async move {
            seen.store(!probe.exists(), Ordering::SeqCst);
        }
    })
    .await
    .unwrap();
    assert!(flag.load(Ordering::SeqCst));
    assert!(!file.exists());
}

#[tokio::test]
async fn wrong_field_count_is_never_deleted() {
    let host = system_hostname();
    let hex = hex_host(&host);
    let pid = dead_pid();
    let names = [
        format!("holder.v2.{hex}.{pid}.1.x"),
        format!("holder.{hex}.{pid}.x"),
        format!("holder.{hex}.{pid}.1.x.extra"),
        format!("holder.{hex}"),
    ];
    for name in names {
        for empty in [false, true] {
            let lock_dir = lock_path();
            std::fs::create_dir_all(&lock_dir).unwrap();
            let full = lock_dir.join(&name);
            let text = if empty {
                String::new()
            } else {
                serde_json::json!({
                    "pid": pid,
                    "host": host,
                    "ts": "2020-01-01T00:00:00.000Z",
                    "token": name.trim_start_matches("holder."),
                })
                .to_string()
            };
            std::fs::write(&full, text).unwrap();
            let bytes = std::fs::read(&full).unwrap();
            let error = with_file_lock(lock_dir.clone(), opts(200, 20), || async {})
                .await
                .unwrap_err();
            assert!(error.is_timeout());
            assert_eq!(std::fs::read(&full).unwrap(), bytes);
            assert_eq!(holder_names(&lock_dir), vec![name.clone()]);
        }
    }
}

#[tokio::test]
async fn legacy_dotted_name_blocks() {
    assert!(pid_dead(99));
    assert_eq!(hex_host("node_a"), "6e6f64655f61");
    let real = serde_json::json!({
        "pid": 99,
        "host": "node_a",
        "ts": "2020-01-01T00:00:00.000Z",
        "token": "v2.6e6f64655f61.99.1.x",
    })
    .to_string();
    let cases = [
        ("owner.v2.6e6f64655f61.99.1.x", vec!["", "{", real.as_str()]),
        (
            ".publish.v2.6e6f64655f61.99.1.x",
            vec!["", "{", real.as_str()],
        ),
        ("notes.txt", vec!["leftover"]),
    ];
    for (name, bodies) in cases {
        for body in bodies {
            let lock_dir = lock_path();
            std::fs::create_dir_all(&lock_dir).unwrap();
            let full = lock_dir.join(name);
            std::fs::write(&full, body).unwrap();
            let bytes = std::fs::read(&full).unwrap();
            let mut options = opts(200, 20);
            options.host = Some("node_a".to_string());
            let error = with_file_lock(lock_dir, options, || async {})
                .await
                .unwrap_err();
            assert!(error.is_timeout());
            assert_eq!(std::fs::read(&full).unwrap(), bytes);
        }
    }
}

#[tokio::test]
async fn hostname_round_trips_through_hex() {
    let host = "a.b-c/d\u{00e9}";
    let lock_dir = lock_path();
    let mut options = opts(1_000, 20);
    options.host = Some(host.to_string());
    let probe = lock_dir.clone();
    with_file_lock(lock_dir, options, move || {
        let probe = probe.clone();
        async move {
            let names = holder_names(&probe);
            let token = names[0].trim_start_matches("holder.").to_string();
            let parts: Vec<&str> = token.split('.').collect();
            assert_eq!(parts.len(), 4);
            assert_eq!(parts[0], hex_host(host));
            let bytes = decode_hex(parts[0]);
            assert_eq!(String::from_utf8(bytes).unwrap(), host);
            let body: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(probe.join(&names[0])).unwrap())
                    .unwrap();
            assert_eq!(body["host"], host);
            assert_eq!(body["token"], token);
            assert_eq!(parts[1], std::process::id().to_string());
        }
    })
    .await
    .unwrap();

    let dead_dir = lock_path();
    let pid = dead_pid();
    let dead_token = host_token(pid, "round", host);
    let dead = write_owner(&dead_dir, pid, host, &dead_token);
    let mut options = opts(1_000, 20);
    options.host = Some(host.to_string());
    let probe = dead.clone();
    with_file_lock(dead_dir, options, move || {
        let probe = probe.clone();
        async move {
            assert!(!probe.exists());
        }
    })
    .await
    .unwrap();
    assert!(!dead.exists());
}

#[tokio::test]
async fn body_host_mismatch_is_not_removed() {
    let lock_dir = lock_path();
    let host = system_hostname();
    let pid = dead_pid();
    let token = host_token(pid, "mismatch", &host);
    let other = format!("{host}/other");
    let file = write_owner(&lock_dir, pid, &other, &token);
    let bytes = std::fs::read(&file).unwrap();
    let error = with_file_lock(lock_dir.clone(), opts(200, 20), || async {})
        .await
        .unwrap_err();
    assert!(error.is_timeout());
    assert_eq!(std::fs::read(&file).unwrap(), bytes);
    assert_eq!(holder_names(&lock_dir), vec![format!("holder.{token}")]);
}

#[tokio::test]
async fn smaller_token_takes_the_first_turn() {
    let lock_dir = lock_path();
    let arrived = Arc::new(AtomicUsize::new(0));
    let (tx, rx) = watch::channel(false);
    let released = Arc::new(AtomicBool::new(false));
    let before: BeforeReaddir = {
        let arrived = arrived.clone();
        let released = released.clone();
        Arc::new(move || {
            let arrived = arrived.clone();
            let released = released.clone();
            let tx = tx.clone();
            let mut rx = rx.clone();
            Box::pin(async move {
                let n = arrived.fetch_add(1, Ordering::SeqCst) + 1;
                if n == 2 {
                    released.store(true, Ordering::SeqCst);
                    let _ = tx.send(true);
                }
                if n <= 2 {
                    while !*rx.borrow() {
                        if rx.changed().await.is_err() {
                            break;
                        }
                    }
                }
            })
        })
    };
    let inside = Arc::new(AtomicUsize::new(0));
    let max_inside = Arc::new(AtomicUsize::new(0));
    let order = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let (hold_tx, hold_rx) = watch::channel(false);
    let run = |label: &'static str| {
        let lock_dir = lock_dir.clone();
        let before = before.clone();
        let inside = inside.clone();
        let max_inside = max_inside.clone();
        let order = order.clone();
        let hold_rx = hold_rx.clone();
        tokio::spawn(async move {
            let mut options = opts(4_000, 15);
            options.before_readdir = Some(before);
            with_file_lock(lock_dir.clone(), options, move || {
                let inside = inside.clone();
                let max_inside = max_inside.clone();
                let order = order.clone();
                let lock_dir = lock_dir.clone();
                let mut hold_rx = hold_rx.clone();
                async move {
                    let now = inside.fetch_add(1, Ordering::SeqCst) + 1;
                    max_inside.fetch_max(now, Ordering::SeqCst);
                    let mut present = holder_names(&lock_dir)
                        .into_iter()
                        .map(|name| name.trim_start_matches("holder.").to_string())
                        .collect::<Vec<_>>();
                    present.sort();
                    let first = present
                        .first()
                        .cloned()
                        .unwrap_or_else(|| label.to_string());
                    let len = {
                        let mut guard = order.lock().unwrap();
                        guard.push(first.clone());
                        guard.len()
                    };
                    if len == 1 {
                        assert_eq!(present, vec![first]);
                        while !*hold_rx.borrow() {
                            if hold_rx.changed().await.is_err() {
                                break;
                            }
                        }
                    }
                    inside.fetch_sub(1, Ordering::SeqCst);
                    label
                }
            })
            .await
            .unwrap()
        })
    };
    let first = run("a");
    let second = run("b");
    let started = std::time::Instant::now();
    while arrived.load(Ordering::SeqCst) < 2 && started.elapsed() < Duration::from_secs(1) {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(arrived.load(Ordering::SeqCst), 2);
    let saw = std::time::Instant::now();
    while order.lock().unwrap().is_empty() && saw.elapsed() < Duration::from_secs(2) {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(max_inside.load(Ordering::SeqCst), 1);
    hold_tx.send(true).unwrap();
    let mut results = vec![first.await.unwrap(), second.await.unwrap()];
    results.sort();
    assert_eq!(results, ["a", "b"]);
    assert_eq!(order.lock().unwrap().len(), 2);
    assert_eq!(max_inside.load(Ordering::SeqCst), 1);
    assert!(lock_dir.is_dir());
}

#[tokio::test]
async fn heartbeat_advances_mtime() {
    let lock_dir = lock_path();
    let advanced = Arc::new(AtomicBool::new(false));
    let flag = advanced.clone();
    let probe = lock_dir.clone();
    let mut options = opts(2_000, 20);
    options.stale_ms = Some(300);
    with_file_lock(lock_dir.clone(), options, move || {
        let flag = flag.clone();
        let probe = probe.clone();
        async move {
            let name = holder_names(&probe).into_iter().next().unwrap();
            let full = probe.join(name);
            let before = std::fs::metadata(&full).unwrap().modified().unwrap();
            tokio::time::sleep(Duration::from_millis(300)).await;
            let after = std::fs::metadata(&full).unwrap().modified().unwrap();
            flag.store(after > before, Ordering::SeqCst);
        }
    })
    .await
    .unwrap();
    assert!(advanced.load(Ordering::SeqCst));
    assert!(holder_names(&lock_dir).is_empty());
}

#[tokio::test]
async fn reclaims_empty_or_invalid_dead_body() {
    let host = system_hostname();
    for body in ["", "{"] {
        let lock_dir = lock_path();
        let pid = dead_pid();
        let token = host_token(pid, "incomplete", &host);
        assert_eq!(token.split('.').count(), 4);
        std::fs::create_dir_all(&lock_dir).unwrap();
        let dead = lock_dir.join(format!("holder.{token}"));
        std::fs::write(&dead, body).unwrap();
        let flag = Arc::new(AtomicBool::new(false));
        let seen = flag.clone();
        let probe = dead.clone();
        with_file_lock(lock_dir.clone(), opts(1_000, 20), move || {
            let seen = seen.clone();
            let probe = probe.clone();
            async move {
                seen.store(!probe.exists(), Ordering::SeqCst);
            }
        })
        .await
        .unwrap();
        assert!(flag.load(Ordering::SeqCst));
        assert!(!dead.exists());
        assert!(lock_dir.is_dir());
    }
}

#[tokio::test]
async fn empty_live_owner_times_out() {
    let lock_dir = lock_path();
    let host = system_hostname();
    let token = host_token(u64::from(std::process::id()), "empty-live", &host);
    std::fs::create_dir_all(&lock_dir).unwrap();
    let live = lock_dir.join(format!("holder.{token}"));
    std::fs::write(&live, "").unwrap();
    let error = with_file_lock(lock_dir.clone(), opts(250, 20), || async {})
        .await
        .unwrap_err();
    assert!(error.is_timeout());
    assert_eq!(std::fs::read_to_string(&live).unwrap(), "");
    assert_eq!(holder_names(&lock_dir), vec![format!("holder.{token}")]);
}

#[tokio::test]
async fn removes_orphan_holderpub_for_a_dead_pid() {
    let lock_dir = lock_path();
    let host = system_hostname();
    let pid = dead_pid();
    let token = host_token(pid, "partial", &host);
    std::fs::create_dir_all(&lock_dir).unwrap();
    let partial = lock_dir.join(format!(".holderpub.{token}"));
    std::fs::write(&partial, "").unwrap();
    let flag = Arc::new(AtomicBool::new(false));
    let seen = flag.clone();
    let probe = partial.clone();
    with_file_lock(lock_dir.clone(), opts(1_000, 20), move || {
        let seen = seen.clone();
        let probe = probe.clone();
        async move {
            seen.store(!probe.exists(), Ordering::SeqCst);
        }
    })
    .await
    .unwrap();
    assert!(flag.load(Ordering::SeqCst));
    assert!(!partial.exists());
    assert!(holder_names(&lock_dir).is_empty());
}

#[tokio::test]
async fn leaves_a_live_holderpub_in_place() {
    let lock_dir = lock_path();
    let host = system_hostname();
    let token = host_token(u64::from(std::process::id()), "publishing", &host);
    std::fs::create_dir_all(&lock_dir).unwrap();
    let partial = lock_dir.join(format!(".holderpub.{token}"));
    std::fs::write(&partial, "partial").unwrap();
    let probe = partial.clone();
    with_file_lock(lock_dir.clone(), opts(1_000, 20), move || {
        let probe = probe.clone();
        async move {
            assert!(probe.exists());
            assert_eq!(std::fs::read_to_string(&probe).unwrap(), "partial");
        }
    })
    .await
    .unwrap();
    assert!(partial.exists());
    assert!(holder_names(&lock_dir).is_empty());
}

#[tokio::test]
async fn enospc_leaves_no_owner_file() {
    let lock_dir = lock_path();
    let fault = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let mut options = opts(1_000, 20);
    options.publish_fault = Some(fault.clone());
    let error = with_file_lock(lock_dir.clone(), options, || async {})
        .await
        .unwrap_err();
    assert_eq!(error.code(), Some("ENOSPC"));
    assert!(!fault.load(Ordering::SeqCst));
    let names = std::fs::read_dir(&lock_dir)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| {
            name.starts_with("holder.")
                || name.starts_with(".holderpub.")
                || name.starts_with("owner.")
                || name.starts_with(".publish.")
        })
        .collect::<Vec<_>>();
    assert!(names.is_empty());
}

#[tokio::test]
async fn a_panicking_body_releases_the_holder() {
    let lock_dir = lock_path();
    let probe = lock_dir.clone();
    let joined = tokio::spawn(async move {
        let _ = with_file_lock(probe, opts(1_000, 20), || async { panic!("boom") }).await;
    })
    .await;
    assert!(joined.is_err());
    assert!(lock_dir.is_dir());
    let deadline = Instant::now() + Duration::from_secs(2);
    while !holder_names(&lock_dir).is_empty() {
        if Instant::now() >= deadline {
            panic!("holder was not released");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    with_file_lock(lock_dir.clone(), FileLockOptions::default(), || async {})
        .await
        .unwrap();
    assert!(lock_dir.is_dir());
}

#[test]
fn stalled_unlink_lets_the_runtime_progress() {
    let lock_dir = lock_path();
    let entered = Arc::new(AtomicBool::new(false));
    let progressed = Arc::new(AtomicBool::new(false));
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let entered_hook = entered.clone();
    let gate_hook = gate.clone();
    let mut options = opts(1_000, 20);
    options.unlink_hook = Some(Arc::new(move || {
        entered_hook.store(true, Ordering::SeqCst);
        let (lock, cv) = &*gate_hook;
        let guard = lock.lock().unwrap();
        let _ = cv.wait_timeout(guard, Duration::from_secs(3)).unwrap();
    }));
    let checker_entered = entered.clone();
    let checker_progressed = progressed.clone();
    let checker_gate = gate.clone();
    let checker = std::thread::spawn(move || {
        let start = Instant::now();
        while !checker_entered.load(Ordering::SeqCst) {
            if start.elapsed() > Duration::from_secs(2) {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        std::thread::sleep(Duration::from_millis(200));
        let saw = checker_progressed.load(Ordering::SeqCst);
        let (lock, cv) = &*checker_gate;
        let mut guard = lock.lock().unwrap();
        *guard = true;
        cv.notify_all();
        saw
    });
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let progressed_task = progressed.clone();
    let entered_task = entered.clone();
    runtime.block_on(async move {
        tokio::spawn(async move {
            loop {
                if entered_task.load(Ordering::SeqCst) {
                    progressed_task.store(true, Ordering::SeqCst);
                    break;
                }
                tokio::task::yield_now().await;
            }
        });
        with_file_lock(lock_dir, options, || async {})
            .await
            .unwrap();
    });
    assert!(checker.join().unwrap());
}
