use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use capture::{
    CHUNK_OVER_LIMIT, CaptureBatch, CaptureError, CaptureMessage, CaptureRedactionOptions,
    CaptureResult, CaptureRole, CaptureWriter, CaptureWriterOptions, MapEnv, UserSource,
    WriteOutcome, create_capture_writer, spool_batch,
};
use serde_json::{Value, json};

struct Hit {
    path: String,
    token: Option<String>,
    body: String,
}

struct Server {
    url: String,
    hits: Arc<Mutex<Vec<Hit>>>,
    addr: std::net::SocketAddr,
    shutdown: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl Server {
    fn start(handler: impl FnMut(&Hit) -> (u16, String) + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(Mutex::new(Vec::new()));
        let shutdown = Arc::new(AtomicBool::new(false));
        let hits_thread = hits.clone();
        let stop = shutdown.clone();
        let join = std::thread::spawn(move || {
            let mut handler = handler;
            loop {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let Some(hit) = read_hit(&mut stream) else {
                    continue;
                };
                hits_thread.lock().unwrap().push(Hit {
                    path: hit.path.clone(),
                    token: hit.token.clone(),
                    body: hit.body.clone(),
                });
                let (status, body) = handler(&hit);
                let reason = if (200..300).contains(&status) {
                    "OK"
                } else {
                    "ERR"
                };
                let response = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        Self {
            url: format!("http://127.0.0.1:{}", addr.port()),
            hits,
            addr,
            shutdown,
            join: Some(join),
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.addr);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

fn read_hit(stream: &mut TcpStream) -> Option<Hit> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    let (header_end, length) = loop {
        match stream.read(&mut tmp) {
            Ok(0) => return None,
            Ok(count) => {
                buf.extend_from_slice(&tmp[..count]);
                if let Some(end) = find_headers(&buf) {
                    let length = content_length(&buf[..end]).unwrap_or(0);
                    let header_end = end + 4;
                    if buf.len() >= header_end + length {
                        break (header_end, length);
                    }
                }
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::TimedOut =>
            {
                return None;
            }
            Err(_) => return None,
        }
        if buf.len() > 8_000_000 {
            return None;
        }
    };
    let header = String::from_utf8_lossy(&buf[..header_end.saturating_sub(4)]).to_string();
    let mut lines = header.lines();
    let request = lines.next().unwrap_or("");
    let path = request.split_whitespace().nth(1).unwrap_or("").to_string();
    let mut token = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("x-rivetos-user-token") {
            token = Some(value.trim().to_string());
        }
    }
    let body = String::from_utf8_lossy(&buf[header_end..header_end + length]).into_owned();
    Some(Hit { path, token, body })
}

fn find_headers(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|window| window == b"\r\n\r\n")
}

fn content_length(headers: &[u8]) -> Option<usize> {
    let text = String::from_utf8_lossy(headers);
    for line in text.lines() {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("content-length") {
            return value.trim().parse().ok();
        }
    }
    None
}

fn ok_body(inserted: u64, skipped: u64) -> String {
    serde_json::to_string(&CaptureResult {
        ok: true,
        conversation_id: "c".to_string(),
        inserted,
        skipped,
    })
    .unwrap()
}

fn batch() -> CaptureBatch {
    CaptureBatch {
        session_key: "codex:s".to_string(),
        agent: "rivet".to_string(),
        channel: None,
        title: None,
        settings: None,
        task_id: None,
        finalize: None,
        created_at: None,
        updated_at: None,
        messages: vec![message("e", CaptureRole::User, "hello")],
    }
}

fn message(id: &str, role: CaptureRole, content: &str) -> CaptureMessage {
    CaptureMessage {
        event_id: id.to_string(),
        role,
        content: content.to_string(),
        tool_name: None,
        tool_args: None,
        tool_result: None,
        metadata: None,
        created_at: None,
    }
}

fn one() -> CaptureBatch {
    CaptureBatch {
        session_key: "s1".to_string(),
        agent: "a".to_string(),
        channel: None,
        title: None,
        settings: None,
        task_id: None,
        finalize: None,
        created_at: None,
        updated_at: None,
        messages: vec![message("e1", CaptureRole::User, "hello")],
    }
}

struct Built {
    writer: CaptureWriter,
    logs: Arc<Mutex<Vec<String>>>,
}

fn open_writer(
    url: &str,
    spool: PathBuf,
    now_ms: i64,
    limit: Option<f64>,
    env: MapEnv,
    user: UserSource,
    redaction: Option<CaptureRedactionOptions>,
) -> Built {
    let logs = Arc::new(Mutex::new(Vec::new()));
    let sink = logs.clone();
    let mut opts = CaptureWriterOptions::new(url);
    opts.spool_dir = Some(spool.clone());
    opts.now_ms = Some(Arc::new(move || now_ms));
    opts.log = Some(Arc::new(move |line| {
        sink.lock().unwrap().push(line.to_string())
    }));
    opts.env = Arc::new(env);
    opts.user = user;
    opts.max_chunk_bytes = limit;
    opts.redaction = redaction;
    let writer = create_capture_writer(opts).unwrap();
    Built { writer, logs }
}

fn mode_of(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn json_len(value: &impl serde::Serialize) -> usize {
    let value = serde_json::to_value(value).unwrap();
    protocol::js::stringify(&protocol::js::from_serde(&value)).len()
}

fn accept_and_drop() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for _ in 0..64 {
            let Ok((mut stream, _)) = listener.accept() else {
                break;
            };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut buf = [0u8; 8192];
            let _ = stream.read(&mut buf);
            drop(stream);
        }
    });
    format!("http://127.0.0.1:{port}")
}

#[tokio::test]
async fn posts_the_exact_batch() {
    let server = Server::start(|hit| {
        assert_eq!(hit.path, "/api/capture");
        (200, ok_body(1, 0))
    });
    let spool = tempfile::tempdir().unwrap().keep();
    let built = open_writer(
        &server.url,
        spool,
        1000,
        None,
        MapEnv::default(),
        UserSource::Owner,
        None,
    );
    let saved = built.writer.write(batch()).await.unwrap();
    assert_eq!(
        saved,
        WriteOutcome::Delivered {
            ok: true,
            conversation_id: "c".to_string(),
            inserted: 1,
            skipped: 0,
        }
    );
    assert_eq!(
        server.hits.lock().unwrap()[0].body,
        serde_json::to_string(&batch()).unwrap()
    );
}

#[tokio::test]
async fn spools_on_http_and_transport_failure() {
    let spool = tempfile::tempdir().unwrap().keep();
    let server = Server::start(|_| (503, String::new()));
    let built = open_writer(
        &server.url,
        spool.clone(),
        1000,
        None,
        MapEnv::default(),
        UserSource::Owner,
        None,
    );
    let saved = built.writer.write(batch()).await.unwrap();
    let WriteOutcome::Spooled { file, .. } = saved else {
        panic!("expected spool");
    };
    let name = Path::new(&file)
        .file_name()
        .unwrap()
        .to_string_lossy()
        .to_string();
    assert!(name.starts_with("1000-") && name.ends_with(".json"));
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        serde_json::to_string(&batch()).unwrap()
    );
    assert_eq!(mode_of(Path::new(&file)), 0o600);
    assert!(
        built
            .logs
            .lock()
            .unwrap()
            .iter()
            .any(|line| line == "Error: capture HTTP 503")
    );
    assert_eq!(std::fs::read_dir(&spool).unwrap().count(), 1);

    let closed = open_writer(
        &accept_and_drop(),
        spool,
        1000,
        None,
        MapEnv::default(),
        UserSource::Owner,
        None,
    );
    let saved = closed.writer.write(batch()).await.unwrap();
    let WriteOutcome::Spooled { file, .. } = saved else {
        panic!("expected transport spool");
    };
    assert!(
        Path::new(&file)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("1000-")
    );
    assert!(
        closed
            .logs
            .lock()
            .unwrap()
            .iter()
            .any(|line| line.starts_with("Error:"))
    );
}

#[tokio::test]
async fn reports_spool_failure_without_saving() {
    let parent = tempfile::tempdir().unwrap().keep();
    let blocked = parent.join("not-a-directory");
    std::fs::write(&blocked, "blocked").unwrap();
    let server = Server::start(|_| (503, String::new()));
    let built = open_writer(
        &server.url,
        blocked.clone(),
        1000,
        None,
        MapEnv::default(),
        UserSource::Owner,
        None,
    );
    let saved = built.writer.write(batch()).await.unwrap();
    let WriteOutcome::NotSaved { error } = saved else {
        panic!("expected not saved");
    };
    assert!(error.contains("capture spool failed; batch was not saved:"));
    assert!(!error.contains(&blocked.display().to_string()));
    let logs = built.logs.lock().unwrap().clone();
    assert!(logs.iter().any(|line| line == &error));
    assert!(logs.iter().any(|line| line == "Error: capture HTTP 503"));
    assert_eq!(server.hits.lock().unwrap().len(), 1);
    assert_eq!(std::fs::read_to_string(&blocked).unwrap(), "blocked");
}

#[tokio::test]
async fn client_statuses_do_not_spool() {
    for status in [400, 401, 403, 405, 413, 429] {
        let flag = Arc::new(AtomicU16::new(status));
        let current = flag.clone();
        let server = Server::start(move |_| (current.load(Ordering::SeqCst), String::new()));
        let spool = tempfile::tempdir().unwrap().keep();
        let built = open_writer(
            &server.url,
            spool.clone(),
            1000,
            None,
            MapEnv::default(),
            UserSource::Owner,
            None,
        );
        let error = built.writer.write(batch()).await.unwrap_err();
        assert!(matches!(error, CaptureError::Client { status: got } if got == status));
        assert_eq!(std::fs::read_dir(&spool).unwrap().count(), 0);
    }
}

#[tokio::test]
async fn replays_oldest_first_and_dead_letters_client_errors() {
    let queue = Arc::new(Mutex::new(VecDeque::from([
        (200, ok_body(1, 0)),
        (400, String::new()),
        (200, ok_body(1, 0)),
    ])));
    let pending = queue.clone();
    let server = Server::start(move |_| pending.lock().unwrap().pop_front().unwrap());
    let spool = tempfile::tempdir().unwrap().keep();
    for time in [30, 10, 20] {
        let mut item = batch();
        item.session_key = time.to_string();
        spool_batch(&spool, &item, time).await.unwrap();
    }
    let built = open_writer(
        &server.url,
        spool.clone(),
        1000,
        None,
        MapEnv::default(),
        UserSource::Owner,
        None,
    );
    let report = built
        .writer
        .replay(capture::ReplayOptions { max: Some(2.0) })
        .await;
    assert_eq!(report.replayed, 1);
    assert_eq!(report.dead, 1);
    assert_eq!(report.remaining, 1);
    let keys = server
        .hits
        .lock()
        .unwrap()
        .iter()
        .map(|hit| {
            serde_json::from_str::<Value>(&hit.body).unwrap()["session_key"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect::<Vec<_>>();
    assert_eq!(keys, ["10", "20"]);
    assert_eq!(std::fs::read_dir(spool.join("dead")).unwrap().count(), 1);
    let rest = built.writer.replay(capture::ReplayOptions::default()).await;
    assert_eq!(rest.replayed, 1);
    assert_eq!(rest.dead, 0);
    assert_eq!(rest.remaining, 0);
}

#[tokio::test]
async fn stops_replay_on_server_and_transport_errors() {
    let spool = tempfile::tempdir().unwrap().keep();
    let server = Server::start(|_| (500, String::new()));
    for time in [1, 2] {
        spool_batch(&spool, &batch(), time).await.unwrap();
    }
    let built = open_writer(
        &server.url,
        spool.clone(),
        1000,
        None,
        MapEnv::default(),
        UserSource::Owner,
        None,
    );
    let report = built.writer.replay(capture::ReplayOptions::default()).await;
    assert_eq!((report.replayed, report.remaining, report.dead), (0, 2, 0));
    assert_eq!(server.hits.lock().unwrap().len(), 1);

    let closed = open_writer(
        &accept_and_drop(),
        spool,
        1000,
        None,
        MapEnv::default(),
        UserSource::Owner,
        None,
    );
    let report = closed
        .writer
        .replay(capture::ReplayOptions::default())
        .await;
    assert_eq!((report.replayed, report.remaining, report.dead), (0, 2, 0));
}

#[tokio::test]
async fn drains_fifty_files_before_the_new_write() {
    let server = Server::start(|_| (200, ok_body(1, 0)));
    let spool = tempfile::tempdir().unwrap().keep();
    for index in 0..51 {
        let mut item = batch();
        item.session_key = index.to_string();
        spool_batch(&spool, &item, index).await.unwrap();
    }
    let built = open_writer(
        &server.url,
        spool.clone(),
        1000,
        None,
        MapEnv::default(),
        UserSource::Owner,
        None,
    );
    built.writer.write(batch()).await.unwrap();
    let hits = server.hits.lock().unwrap();
    assert_eq!(hits.len(), 51);
    assert_eq!(
        serde_json::from_str::<Value>(&hits[0].body).unwrap()["session_key"],
        "0"
    );
    assert_eq!(
        serde_json::from_str::<Value>(&hits[50].body).unwrap(),
        serde_json::to_value(batch()).unwrap()
    );
    drop(hits);
    assert_eq!(std::fs::read_dir(&spool).unwrap().count(), 1);
}

#[tokio::test]
async fn packs_chunks_and_finalizes_only_the_last() {
    let messages: Vec<CaptureMessage> = (1..=4)
        .map(|n| {
            message(
                &format!("e{n}"),
                CaptureRole::User,
                &format!("m{n}-{}", "x".repeat(80)),
            )
        })
        .collect();
    let source = CaptureBatch {
        session_key: "s".to_string(),
        agent: "a".to_string(),
        channel: Some("c".to_string()),
        title: Some("t".to_string()),
        settings: None,
        task_id: None,
        finalize: Some(true),
        created_at: None,
        updated_at: None,
        messages: messages.clone(),
    };
    let two = CaptureBatch {
        finalize: None,
        messages: messages[..2].to_vec(),
        ..source.clone()
    };
    let limit = json_len(&two);
    let server = Server::start(|hit| {
        let parsed: CaptureBatch = serde_json::from_str(&hit.body).unwrap();
        let skipped = if parsed.messages.len() == 1 { 1 } else { 0 };
        (200, ok_body(parsed.messages.len() as u64, skipped))
    });
    let spool = tempfile::tempdir().unwrap().keep();
    let built = open_writer(
        &server.url,
        spool,
        1000,
        Some(limit as f64),
        MapEnv::default(),
        UserSource::Owner,
        None,
    );
    let saved = built.writer.write(source).await.unwrap();
    let hits = server.hits.lock().unwrap();
    assert!(hits.len() > 1);
    assert_eq!(hits[0].body.len(), limit);
    for hit in hits.iter() {
        assert!(hit.body.len() <= limit);
    }
    let parsed: Vec<CaptureBatch> = hits
        .iter()
        .map(|hit| serde_json::from_str(&hit.body).unwrap())
        .collect();
    assert!(
        parsed[..parsed.len() - 1]
            .iter()
            .all(|chunk| chunk.finalize.is_none())
    );
    assert_eq!(parsed.last().unwrap().finalize, Some(true));
    let ids: Vec<_> = parsed
        .iter()
        .flat_map(|chunk| chunk.messages.iter().map(|item| item.event_id.clone()))
        .collect();
    assert_eq!(ids, ["e1", "e2", "e3", "e4"]);
    assert_eq!(parsed[0].session_key, "s");
    assert_eq!(parsed[0].channel.as_deref(), Some("c"));
    let inserted: u64 = parsed.iter().map(|chunk| chunk.messages.len() as u64).sum();
    let skipped = parsed
        .iter()
        .filter(|chunk| chunk.messages.len() == 1)
        .count() as u64;
    assert_eq!(
        saved,
        WriteOutcome::Delivered {
            ok: true,
            conversation_id: "c".to_string(),
            inserted,
            skipped,
        }
    );
}

#[tokio::test]
async fn sends_an_empty_finalize_batch() {
    let server = Server::start(|_| (200, ok_body(0, 0)));
    let spool = tempfile::tempdir().unwrap().keep();
    let built = open_writer(
        &server.url,
        spool,
        1000,
        None,
        MapEnv::default(),
        UserSource::Owner,
        None,
    );
    let mut empty = batch();
    empty.messages.clear();
    empty.finalize = Some(true);
    assert_eq!(
        built.writer.write(empty.clone()).await.unwrap(),
        WriteOutcome::Delivered {
            ok: true,
            conversation_id: "c".to_string(),
            inserted: 0,
            skipped: 0,
        }
    );
    let posted: Value = serde_json::from_str(&server.hits.lock().unwrap()[0].body).unwrap();
    assert_eq!(posted, serde_json::to_value(empty).unwrap());
}

#[tokio::test]
async fn returns_every_spooled_chunk() {
    let messages = vec![
        message("e1", CaptureRole::User, &"x".repeat(40)),
        message("e2", CaptureRole::User, &"x".repeat(40)),
    ];
    let source = CaptureBatch {
        session_key: "s".to_string(),
        agent: "a".to_string(),
        channel: None,
        title: None,
        settings: None,
        task_id: None,
        finalize: None,
        created_at: None,
        updated_at: None,
        messages: messages.clone(),
    };
    let one_chunk = CaptureBatch {
        messages: messages[..1].to_vec(),
        ..source.clone()
    };
    let limit = json_len(&one_chunk);
    let spool = tempfile::tempdir().unwrap().keep();
    let built = open_writer(
        &accept_and_drop(),
        spool.clone(),
        1000,
        Some(limit as f64),
        MapEnv::default(),
        UserSource::Owner,
        None,
    );
    let saved = built.writer.write(source).await.unwrap();
    let WriteOutcome::Spooled { file, files } = saved else {
        panic!("expected spool");
    };
    assert_eq!(files.len(), 2);
    assert_eq!(file, files[0]);
    let mut names = std::fs::read_dir(&spool)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".json"))
        .collect::<Vec<_>>();
    names.sort();
    assert_eq!(names.len(), 2);
    let ids = names
        .iter()
        .map(|name| {
            let text = std::fs::read_to_string(spool.join(name)).unwrap();
            let parsed: CaptureBatch = serde_json::from_str(&text).unwrap();
            parsed.messages[0].event_id.clone()
        })
        .collect::<Vec<_>>();
    assert_eq!(ids, ["e1", "e2"]);
    assert!(
        built
            .logs
            .lock()
            .unwrap()
            .iter()
            .any(|line| line.starts_with("Error:"))
    );
}

#[tokio::test]
async fn elides_tool_args_over_budget() {
    let tool_args = json!({"blob": "y".repeat(4000)});
    let bytes = serde_json::to_string(&tool_args).unwrap().len();
    let mut item = message("big", CaptureRole::User, "hi");
    item.tool_args = Some(tool_args);
    item.metadata = Some(serde_json::Map::from_iter([(
        "source".to_string(),
        json!("codex"),
    )]));
    let source = CaptureBatch {
        session_key: "s".to_string(),
        agent: "a".to_string(),
        channel: None,
        title: None,
        settings: None,
        task_id: None,
        finalize: None,
        created_at: None,
        updated_at: None,
        messages: vec![item],
    };
    let server = Server::start(|_| (200, ok_body(1, 0)));
    let spool = tempfile::tempdir().unwrap().keep();
    let built = open_writer(
        &server.url,
        spool,
        1000,
        Some(500.0),
        MapEnv::default(),
        UserSource::Owner,
        None,
    );
    built.writer.write(source).await.unwrap();
    let posted: CaptureBatch = serde_json::from_str(&server.hits.lock().unwrap()[0].body).unwrap();
    assert_eq!(
        posted.messages[0].tool_args,
        Some(json!({"_elided": true, "bytes": bytes}))
    );
    let metadata = posted.messages[0].metadata.as_ref().unwrap();
    assert_eq!(metadata["source"], "codex");
    assert_eq!(metadata["full_tool_args_length"], bytes);
    assert!(json_len(&posted) <= 500);
    assert!(
        built
            .logs
            .lock()
            .unwrap()
            .iter()
            .any(|line| line == &format!("elided tool_args for event big ({bytes} bytes)"))
    );
}

#[tokio::test]
async fn caps_content_and_tool_result() {
    let emoji = format!("{}😀", "z".repeat(15_999));
    let mut first = message("cap", CaptureRole::Tool, &"x".repeat(16_001));
    first.tool_name = Some("exec".to_string());
    first.tool_result = Some("y".repeat(16_002));
    first.metadata = Some(serde_json::Map::from_iter([(
        "source".to_string(),
        json!("codex"),
    )]));
    let second = message("pair", CaptureRole::User, &emoji);
    let source = CaptureBatch {
        session_key: "s".to_string(),
        agent: "a".to_string(),
        channel: None,
        title: None,
        settings: None,
        task_id: None,
        finalize: None,
        created_at: None,
        updated_at: None,
        messages: vec![first, second],
    };
    let server = Server::start(|_| (200, ok_body(2, 0)));
    let spool = tempfile::tempdir().unwrap().keep();
    let built = open_writer(
        &server.url,
        spool,
        1000,
        None,
        MapEnv::default(),
        UserSource::Owner,
        None,
    );
    built.writer.write(source).await.unwrap();
    let posted: CaptureBatch = serde_json::from_str(&server.hits.lock().unwrap()[0].body).unwrap();
    assert_eq!(posted.messages[0].content, "x".repeat(16_000));
    assert_eq!(
        posted.messages[0].tool_result.as_deref(),
        Some("y".repeat(16_000).as_str())
    );
    let metadata = posted.messages[0].metadata.as_ref().unwrap();
    assert_eq!(metadata["full_content_length"], 16_001);
    assert_eq!(metadata["full_tool_result_length"], 16_002);
    assert_eq!(metadata["truncated"], true);
    assert_eq!(posted.messages[1].content, "z".repeat(15_999));
    assert_eq!(
        posted.messages[1].metadata.as_ref().unwrap()["full_content_length"],
        16_001
    );
    assert_eq!(
        posted.messages[1].metadata.as_ref().unwrap()["truncated"],
        true
    );
}

#[tokio::test]
async fn dead_letters_an_oversized_spool_once() {
    let server = Server::start(|_| (413, String::new()));
    let spool = tempfile::tempdir().unwrap().keep();
    let name = "1-oversized.json";
    let huge = CaptureBatch {
        messages: vec![message("huge", CaptureRole::User, &"x".repeat(2_000_000))],
        ..batch()
    };
    std::fs::write(spool.join(name), serde_json::to_string(&huge).unwrap()).unwrap();
    let built = open_writer(
        &server.url,
        spool.clone(),
        1000,
        None,
        MapEnv::default(),
        UserSource::Owner,
        None,
    );
    let report = built.writer.replay(capture::ReplayOptions::default()).await;
    assert_eq!((report.replayed, report.dead, report.remaining), (0, 1, 0));
    let dead: Vec<_> = std::fs::read_dir(spool.join("dead"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(dead, vec![name.to_string()]);
    assert!(
        built
            .logs
            .lock()
            .unwrap()
            .iter()
            .any(|line| line.contains("413"))
    );
    let again = built.writer.replay(capture::ReplayOptions::default()).await;
    assert_eq!((again.replayed, again.dead, again.remaining), (0, 0, 0));
    assert_eq!(server.hits.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn elides_huge_metadata() {
    let note = "m".repeat(1_100_000);
    let mut item = message("meta", CaptureRole::User, "hi");
    item.metadata = Some(serde_json::Map::from_iter([
        ("source".to_string(), json!("codex")),
        (
            "session_jsonl_path".to_string(),
            json!("/tmp/session.jsonl"),
        ),
        ("session_jsonl_line".to_string(), json!(4)),
        ("note".to_string(), json!(note)),
    ]));
    let source = CaptureBatch {
        session_key: "s".to_string(),
        agent: "a".to_string(),
        channel: None,
        title: None,
        settings: None,
        task_id: None,
        finalize: None,
        created_at: None,
        updated_at: None,
        messages: vec![item],
    };
    let server = Server::start(|_| (200, ok_body(1, 0)));
    let spool = tempfile::tempdir().unwrap().keep();
    let built = open_writer(
        &server.url,
        spool.clone(),
        1000,
        None,
        MapEnv::default(),
        UserSource::Owner,
        None,
    );
    built.writer.write(source).await.unwrap();
    let raw = server.hits.lock().unwrap()[0].body.clone();
    assert!(raw.len() <= 768 * 1024);
    let posted: CaptureBatch = serde_json::from_str(&raw).unwrap();
    let metadata = posted.messages[0].metadata.as_ref().unwrap();
    assert_eq!(metadata["source"], "codex");
    assert_eq!(metadata["session_jsonl_path"], "/tmp/session.jsonl");
    assert_eq!(metadata["session_jsonl_line"], 4);
    assert_eq!(metadata["metadata_elided"], true);
    assert!(metadata.get("note").is_none());
    assert!(metadata["full_metadata_bytes"].as_u64().unwrap() > 1_100_000);
    assert_eq!(std::fs::read_dir(&spool).unwrap().count(), 0);
}

#[tokio::test]
async fn elides_settings_when_the_header_exceeds_the_limit() {
    let settings = json!({"blob": "s".repeat(8_000)});
    let bytes = serde_json::to_string(&settings).unwrap().len();
    let source = CaptureBatch {
        session_key: "s".to_string(),
        agent: "a".to_string(),
        channel: None,
        title: None,
        settings: Some(settings),
        task_id: None,
        finalize: Some(true),
        created_at: None,
        updated_at: None,
        messages: Vec::new(),
    };
    let server = Server::start(|_| (200, ok_body(0, 0)));
    let spool = tempfile::tempdir().unwrap().keep();
    let built = open_writer(
        &server.url,
        spool,
        1000,
        Some(500.0),
        MapEnv::default(),
        UserSource::Owner,
        None,
    );
    built.writer.write(source).await.unwrap();
    let raw = server.hits.lock().unwrap()[0].body.clone();
    assert!(raw.len() <= 500);
    let posted: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(posted["settings"], json!({"_elided": true, "bytes": bytes}));
    assert_eq!(posted["finalize"], true);
    assert_eq!(posted["messages"], json!([]));
}

#[tokio::test]
async fn refuses_a_singleton_that_still_exceeds_the_limit() {
    let messages = vec![
        message("e1", CaptureRole::User, &"x".repeat(40)),
        message("e2", CaptureRole::User, &"x".repeat(40)),
    ];
    let source = CaptureBatch {
        session_key: "s".to_string(),
        agent: "a".to_string(),
        channel: None,
        title: None,
        settings: None,
        task_id: None,
        finalize: Some(true),
        created_at: None,
        updated_at: None,
        messages: messages.clone(),
    };
    let one_chunk = CaptureBatch {
        session_key: "s".to_string(),
        agent: "a".to_string(),
        channel: None,
        title: None,
        settings: None,
        task_id: None,
        finalize: None,
        created_at: None,
        updated_at: None,
        messages: messages[..1].to_vec(),
    };
    let limit = json_len(&one_chunk);
    let server = Server::start(|_| (200, ok_body(1, 0)));
    let spool = tempfile::tempdir().unwrap().keep();
    let built = open_writer(
        &server.url,
        spool.clone(),
        1000,
        Some(limit as f64),
        MapEnv::default(),
        UserSource::Owner,
        None,
    );
    let saved = built.writer.write(source).await.unwrap();
    assert_eq!(
        saved,
        WriteOutcome::NotSaved {
            error: CHUNK_OVER_LIMIT.to_string()
        }
    );
    assert_eq!(server.hits.lock().unwrap().len(), 1);
    let posted: CaptureBatch = serde_json::from_str(&server.hits.lock().unwrap()[0].body).unwrap();
    assert_eq!(posted.messages[0].event_id, "e1");
    assert!(
        built
            .logs
            .lock()
            .unwrap()
            .iter()
            .any(|line| line == CHUNK_OVER_LIMIT)
    );
    assert_eq!(std::fs::read_dir(&spool).unwrap().count(), 0);
}

#[tokio::test]
async fn does_not_spool_a_header_that_still_exceeds() {
    let source = CaptureBatch {
        session_key: "s".to_string(),
        agent: "a".to_string(),
        channel: None,
        title: Some("t".repeat(5_000)),
        settings: Some(json!({"blob": "s".repeat(5_000)})),
        task_id: None,
        finalize: None,
        created_at: None,
        updated_at: None,
        messages: vec![message("e", CaptureRole::User, "hi")],
    };
    let server = Server::start(|_| (200, ok_body(1, 0)));
    let spool = tempfile::tempdir().unwrap().keep();
    let built = open_writer(
        &server.url,
        spool.clone(),
        1000,
        Some(200.0),
        MapEnv::default(),
        UserSource::Owner,
        None,
    );
    let saved = built.writer.write(source).await.unwrap();
    assert_eq!(
        saved,
        WriteOutcome::NotSaved {
            error: CHUNK_OVER_LIMIT.to_string()
        }
    );
    assert!(server.hits.lock().unwrap().is_empty());
    assert!(
        built
            .logs
            .lock()
            .unwrap()
            .iter()
            .any(|line| line == CHUNK_OVER_LIMIT)
    );
    assert_eq!(std::fs::read_dir(&spool).unwrap().count(), 0);
}

#[tokio::test]
async fn redaction_is_opt_in() {
    let mut secret = batch();
    secret.messages[0].content = "token sk-abcdefghijklmnopqrstuvwxyz stays".to_string();
    let server = Server::start(|_| (200, ok_body(1, 0)));
    let spool = tempfile::tempdir().unwrap().keep();
    let built = open_writer(
        &server.url,
        spool.clone(),
        1000,
        None,
        MapEnv::default(),
        UserSource::Owner,
        None,
    );
    built.writer.write(secret.clone()).await.unwrap();
    assert_eq!(
        server.hits.lock().unwrap()[0].body,
        serde_json::to_string(&secret).unwrap()
    );
    assert_eq!(std::fs::read_dir(&spool).unwrap().count(), 0);
}

#[tokio::test]
async fn redacts_before_post_and_logs_a_count() {
    let mut secret = batch();
    secret.messages[0].content = "token sk-abcdefghijklmnopqrstuvwxyz".to_string();
    let server = Server::start(|_| (200, ok_body(1, 0)));
    let spool = tempfile::tempdir().unwrap().keep();
    let redaction = CaptureRedactionOptions {
        enabled: Some(true),
        ..CaptureRedactionOptions::default()
    };
    let built = open_writer(
        &server.url,
        spool,
        1000,
        None,
        MapEnv::default(),
        UserSource::Owner,
        Some(redaction),
    );
    built.writer.write(secret).await.unwrap();
    let posted: CaptureBatch = serde_json::from_str(&server.hits.lock().unwrap()[0].body).unwrap();
    assert!(posted.messages[0].content.contains("[REDACTED:sk_token]"));
    assert!(
        !posted.messages[0]
            .content
            .contains("sk-abcdefghijklmnopqrstuvwxyz")
    );
    let logs = built.logs.lock().unwrap().clone();
    assert!(
        logs.iter()
            .any(|line| line.starts_with("redacted ") && line.ends_with(" spans"))
    );
    assert!(!logs.join("\n").contains("sk-abcdefghijklmnopqrstuvwxyz"));
}

#[tokio::test]
async fn env_enable_redacts_and_falsey_values_do_not() {
    let mut secret = batch();
    secret.messages[0].content = "token sk-abcdefghijklmnopqrstuvwxyz".to_string();
    let server = Server::start(|_| (200, ok_body(1, 0)));
    let spool = tempfile::tempdir().unwrap().keep();
    let env = MapEnv::from_pairs(&[("RIVETOS_CAPTURE_REDACTION", "1")]);
    let built = open_writer(&server.url, spool, 1000, None, env, UserSource::Owner, None);
    built.writer.write(secret).await.unwrap();
    let posted: CaptureBatch = serde_json::from_str(&server.hits.lock().unwrap()[0].body).unwrap();
    assert!(posted.messages[0].content.contains("[REDACTED:sk_token]"));

    for value in ["0", "false", "no", "off"] {
        let mut secret = batch();
        secret.messages[0].content = "token sk-abcdefghijklmnopqrstuvwxyz stays".to_string();
        let server = Server::start(|_| (200, ok_body(1, 0)));
        let spool = tempfile::tempdir().unwrap().keep();
        let env = MapEnv::from_pairs(&[("RIVETOS_CAPTURE_REDACTION", value)]);
        let built = open_writer(&server.url, spool, 1000, None, env, UserSource::Owner, None);
        built.writer.write(secret.clone()).await.unwrap();
        assert_eq!(
            server.hits.lock().unwrap()[0].body,
            serde_json::to_string(&secret).unwrap()
        );
    }
}

#[tokio::test]
async fn empty_redaction_options_do_not_override_env() {
    let mut secret = batch();
    secret.messages[0].content = "token sk-abcdefghijklmnopqrstuvwxyz".to_string();
    let server = Server::start(|_| (200, ok_body(1, 0)));
    let spool = tempfile::tempdir().unwrap().keep();
    let env = MapEnv::from_pairs(&[("RIVETOS_CAPTURE_REDACTION", "1")]);
    let built = open_writer(
        &server.url,
        spool,
        1000,
        None,
        env,
        UserSource::Owner,
        Some(CaptureRedactionOptions::default()),
    );
    built.writer.write(secret).await.unwrap();
    let posted: CaptureBatch = serde_json::from_str(&server.hits.lock().unwrap()[0].body).unwrap();
    assert!(posted.messages[0].content.contains("[REDACTED:sk_token]"));
}

#[tokio::test]
async fn explicit_disable_wins_over_env() {
    let mut secret = batch();
    secret.messages[0].content = "token sk-abcdefghijklmnopqrstuvwxyz stays".to_string();
    let server = Server::start(|_| (200, ok_body(1, 0)));
    let spool = tempfile::tempdir().unwrap().keep();
    let env = MapEnv::from_pairs(&[("RIVETOS_CAPTURE_REDACTION", "1")]);
    let redaction = CaptureRedactionOptions {
        enabled: Some(false),
        ..CaptureRedactionOptions::default()
    };
    let built = open_writer(
        &server.url,
        spool,
        1000,
        None,
        env,
        UserSource::Owner,
        Some(redaction),
    );
    built.writer.write(secret.clone()).await.unwrap();
    assert_eq!(
        server.hits.lock().unwrap()[0].body,
        serde_json::to_string(&secret).unwrap()
    );
}

#[tokio::test]
async fn spools_redacted_bytes() {
    let mut secret = batch();
    secret.messages[0].content = "token sk-abcdefghijklmnopqrstuvwxyz".to_string();
    let spool = tempfile::tempdir().unwrap().keep();
    let redaction = CaptureRedactionOptions {
        enabled: Some(true),
        ..CaptureRedactionOptions::default()
    };
    let built = open_writer(
        &accept_and_drop(),
        spool.clone(),
        1000,
        None,
        MapEnv::default(),
        UserSource::Owner,
        Some(redaction),
    );
    let saved = built.writer.write(secret).await.unwrap();
    assert!(matches!(saved, WriteOutcome::Spooled { .. }));
    let names = std::fs::read_dir(&spool)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".json"))
        .collect::<Vec<_>>();
    assert_eq!(names.len(), 1);
    let text = std::fs::read_to_string(spool.join(&names[0])).unwrap();
    assert!(text.contains("[REDACTED:sk_token]"));
    assert!(!text.contains("sk-abcdefghijklmnopqrstuvwxyz"));
}

#[tokio::test]
async fn routed_user_token_and_private_spool() {
    let status = Arc::new(AtomicU16::new(200));
    let current = status.clone();
    let server = Server::start(move |_| (current.load(Ordering::SeqCst), ok_body(1, 0)));
    let spool = tempfile::tempdir().unwrap().keep();
    let user = capture::CaptureUser {
        id: "guest".to_string(),
        token: "tok-123".to_string(),
    };
    let built = open_writer(
        &server.url,
        spool.clone(),
        1000,
        None,
        MapEnv::default(),
        UserSource::Routed(user),
        None,
    );
    built.writer.write(one()).await.unwrap();
    assert_eq!(
        server.hits.lock().unwrap()[0].token.as_deref(),
        Some("tok-123")
    );
    status.store(403, Ordering::SeqCst);
    let saved = built.writer.write(one()).await.unwrap();
    assert!(matches!(saved, WriteOutcome::Spooled { .. }));
    assert_eq!(std::fs::read_dir(&spool).unwrap().count(), 1);
    let young = built.writer.replay(capture::ReplayOptions::default()).await;
    assert_eq!((young.replayed, young.dead, young.remaining), (0, 0, 1));
    let name = std::fs::read_dir(&spool)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .file_name()
        .to_string_lossy()
        .into_owned();
    let old = SystemTime::now() - Duration::from_secs(8 * 24 * 60 * 60);
    let file = std::fs::File::options()
        .write(true)
        .open(spool.join(&name))
        .unwrap();
    file.set_times(
        std::fs::FileTimes::new()
            .set_accessed(old)
            .set_modified(old),
    )
    .unwrap();
    status.store(503, Ordering::SeqCst);
    let aged = built.writer.replay(capture::ReplayOptions::default()).await;
    assert_eq!((aged.replayed, aged.dead, aged.remaining), (0, 1, 0));
    let dead = std::fs::read_dir(spool.join("dead"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(dead, vec![name]);

    let home = tempfile::tempdir().unwrap().keep();
    status.store(503, Ordering::SeqCst);
    for (id, token) in [
        ("guest", "t1-padding-padding"),
        ("../visitor", "t2-padding-padding"),
    ] {
        let mut opts = CaptureWriterOptions::new(server.url.clone());
        opts.env = Arc::new(MapEnv::from_pairs(&[("HOME", home.to_str().unwrap())]));
        opts.user = UserSource::Routed(capture::CaptureUser {
            id: id.to_string(),
            token: token.to_string(),
        });
        opts.now_ms = Some(Arc::new(|| 1000));
        create_capture_writer(opts)
            .unwrap()
            .write(one())
            .await
            .unwrap();
    }
    let mut opts = CaptureWriterOptions::new(server.url.clone());
    opts.env = Arc::new(MapEnv::from_pairs(&[("HOME", home.to_str().unwrap())]));
    opts.user = UserSource::Owner;
    opts.now_ms = Some(Arc::new(|| 1000));
    create_capture_writer(opts)
        .unwrap()
        .write(one())
        .await
        .unwrap();
    let users = std::fs::read_dir(home.join(".rivetos").join("capture-spool-users")).unwrap();
    let names = users
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(names.len(), 2);
    for name in &names {
        assert!(name.len() == 32 && name.chars().all(|ch| ch.is_ascii_hexdigit()));
        assert_eq!(
            std::fs::read_dir(home.join(".rivetos").join("capture-spool-users").join(name))
                .unwrap()
                .count(),
            1
        );
    }
    assert_eq!(
        std::fs::read_dir(home.join(".rivetos").join("capture-spool"))
            .unwrap()
            .count(),
        1
    );
}

#[tokio::test]
async fn user_comes_from_the_environment() {
    let server = Server::start(|_| (200, ok_body(1, 0)));
    let spool_a = tempfile::tempdir().unwrap().keep();
    let env = MapEnv::from_pairs(&[
        ("RIVETOS_USER_ID", "guest"),
        ("RIVETOS_USER_TOKEN", "tok-123"),
    ]);
    let built = open_writer(
        &server.url,
        spool_a,
        1000,
        None,
        env,
        UserSource::FromEnv,
        None,
    );
    built.writer.write(one()).await.unwrap();
    let spool_b = tempfile::tempdir().unwrap().keep();
    let env = MapEnv::from_pairs(&[
        ("RIVETOS_USER_ID", "guest"),
        ("RIVETOS_USER_TOKEN", "tok-123"),
    ]);
    let owner = open_writer(
        &server.url,
        spool_b,
        1000,
        None,
        env,
        UserSource::Owner,
        None,
    );
    owner.writer.write(one()).await.unwrap();
    let mut opts = CaptureWriterOptions::new(server.url.clone());
    opts.env = Arc::new(MapEnv::from_pairs(&[("RIVETOS_USER_ID", "guest")]));
    opts.spool_dir = Some(tempfile::tempdir().unwrap().keep());
    assert!(create_capture_writer(opts).is_err());
    let spool_c = tempfile::tempdir().unwrap().keep();
    let plain = open_writer(
        &server.url,
        spool_c,
        1000,
        None,
        MapEnv::default(),
        UserSource::FromEnv,
        None,
    );
    plain.writer.write(one()).await.unwrap();
    let hits = server.hits.lock().unwrap();
    assert_eq!(hits[0].token.as_deref(), Some("tok-123"));
    assert!(hits[1].token.is_none());
    assert!(hits[2].token.is_none());
}

#[tokio::test]
async fn replays_chunked_files_in_write_order() {
    let messages = vec![
        message("e1", CaptureRole::User, &"x".repeat(30)),
        message("e2", CaptureRole::User, &"x".repeat(30)),
        message("e3", CaptureRole::User, &"x".repeat(30)),
    ];
    let source = CaptureBatch {
        session_key: "s".to_string(),
        agent: "a".to_string(),
        channel: None,
        title: None,
        settings: None,
        task_id: None,
        finalize: Some(true),
        created_at: None,
        updated_at: None,
        messages: messages.clone(),
    };
    let one_chunk = CaptureBatch {
        finalize: Some(true),
        messages: messages[..1].to_vec(),
        ..source.clone()
    };
    let limit = json_len(&one_chunk);
    let spool = tempfile::tempdir().unwrap().keep();
    let offline = open_writer(
        &accept_and_drop(),
        spool.clone(),
        5000,
        Some(limit as f64),
        MapEnv::default(),
        UserSource::Owner,
        None,
    );
    assert!(matches!(
        offline.writer.write(source).await.unwrap(),
        WriteOutcome::Spooled { .. }
    ));
    let server = Server::start(|hit| {
        let parsed: CaptureBatch = serde_json::from_str(&hit.body).unwrap();
        (200, ok_body(parsed.messages.len() as u64, 0))
    });
    let online = open_writer(
        &server.url,
        spool,
        9000,
        None,
        MapEnv::default(),
        UserSource::Owner,
        None,
    );
    let report = online
        .writer
        .replay(capture::ReplayOptions::default())
        .await;
    assert_eq!(report.dead, 0);
    assert_eq!(report.remaining, 0);
    let hits = server.hits.lock().unwrap();
    let seen = hits
        .iter()
        .map(|hit| {
            let parsed: CaptureBatch = serde_json::from_str(&hit.body).unwrap();
            parsed
                .messages
                .iter()
                .map(|item| item.event_id.clone())
                .collect::<Vec<_>>()
                .join(",")
        })
        .collect::<Vec<_>>();
    assert_eq!(seen[0], "e1");
    assert!(seen.last().unwrap().contains("e3"));
    let joined = seen.join("|");
    assert!(joined.find("e1").unwrap() < joined.find("e2").unwrap());
    assert!(joined.find("e2").unwrap() < joined.find("e3").unwrap());
    let last: CaptureBatch = serde_json::from_str(&hits.last().unwrap().body).unwrap();
    assert_eq!(last.finalize, Some(true));
}

#[tokio::test]
async fn later_chunk_spool_failure_returns_not_saved() {
    let messages = vec![
        message("e1", CaptureRole::User, &"x".repeat(40)),
        message("e2", CaptureRole::User, &"x".repeat(40)),
        message("e3", CaptureRole::User, &"x".repeat(40)),
    ];
    let source = CaptureBatch {
        session_key: "s".to_string(),
        agent: "a".to_string(),
        channel: None,
        title: None,
        settings: None,
        task_id: None,
        finalize: Some(true),
        created_at: None,
        updated_at: None,
        messages: messages.clone(),
    };
    let one_chunk = CaptureBatch {
        finalize: None,
        messages: messages[..1].to_vec(),
        ..source.clone()
    };
    let limit = json_len(&one_chunk);
    let queue = Arc::new(Mutex::new(VecDeque::from([200u16])));
    let pending = queue.clone();
    let server = Server::start(move |_| {
        let status = pending.lock().unwrap().pop_front().unwrap_or(503);
        if status == 200 {
            (200, ok_body(1, 0))
        } else {
            (status, String::new())
        }
    });
    let parent = tempfile::tempdir().unwrap().keep();
    let blocked = parent.join("not-a-directory");
    std::fs::write(&blocked, "blocked").unwrap();
    let built = open_writer(
        &server.url,
        blocked.clone(),
        1000,
        Some(limit as f64),
        MapEnv::default(),
        UserSource::Owner,
        None,
    );
    let saved = built.writer.write(source).await.unwrap();
    let WriteOutcome::NotSaved { error } = saved else {
        panic!("expected not saved");
    };
    assert!(error.contains("capture spool failed; batch was not saved:"));
    assert!(server.hits.lock().unwrap().len() >= 2);
    assert_eq!(std::fs::read_to_string(&blocked).unwrap(), "blocked");
}

#[tokio::test]
async fn plain_http_does_not_read_the_ca_file() {
    let server = Server::start(|_| (200, ok_body(1, 0)));
    let spool = tempfile::tempdir().unwrap().keep();
    let mut opts = CaptureWriterOptions::new(&server.url);
    opts.spool_dir = Some(spool);
    opts.user = UserSource::Owner;
    opts.ca_path = Some(PathBuf::from("/no/such/capture-ca.pem"));
    let writer = create_capture_writer(opts).unwrap();
    let saved = writer.write(batch()).await.unwrap();
    assert!(matches!(saved, WriteOutcome::Delivered { .. }));
    assert_eq!(server.hits.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn truncated_client_status_is_not_spooled() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for _ in 0..8 {
            let Ok((mut stream, _)) = listener.accept() else {
                break;
            };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut buf = [0u8; 8192];
            let _ = stream.read(&mut buf);
            let _ = stream.write_all(
                b"HTTP/1.1 413 Payload Too Large\r\nContent-Length: 100\r\nConnection: close\r\n\r\nhi",
            );
            drop(stream);
        }
    });
    let spool = tempfile::tempdir().unwrap().keep();
    let built = open_writer(
        &format!("http://127.0.0.1:{port}"),
        spool.clone(),
        1000,
        None,
        MapEnv::default(),
        UserSource::Owner,
        None,
    );
    let saved = built.writer.write(batch()).await;
    assert!(matches!(saved, Err(CaptureError::Client { status: 413 })));
    assert_eq!(std::fs::read_dir(&spool).unwrap().count(), 0);
}

#[tokio::test]
async fn explicit_null_survives_post_and_spool() {
    let raw = r#"{"agent":"a","session_key":"s","messages":[{"tool_args":null,"content":"hi","role":"user","event_id":"e","note":null}],"title":null}"#;
    let input = protocol::js::parse(raw).unwrap();
    let expected = protocol::js::stringify(&input);
    assert!(expected.contains("\"tool_args\":null"));
    assert!(expected.contains("\"note\":null"));
    assert!(expected.contains("\"title\":null"));
    assert!(expected.find("\"tool_args\"").unwrap() < expected.find("\"content\"").unwrap());
    assert!(expected.find("\"agent\"").unwrap() < expected.find("\"session_key\"").unwrap());
    let server = Server::start(|_| (200, ok_body(1, 0)));
    let spool = tempfile::tempdir().unwrap().keep();
    let built = open_writer(
        &server.url,
        spool,
        1000,
        None,
        MapEnv::default(),
        UserSource::Owner,
        None,
    );
    let saved = built.writer.write_value(input).await.unwrap();
    assert!(matches!(saved, WriteOutcome::Delivered { .. }));
    assert_eq!(server.hits.lock().unwrap()[0].body, expected);

    let mut typed = one();
    typed.settings = Some(Value::Null);
    typed.messages[0].tool_args = Some(Value::Null);
    let typed_wire = serde_json::to_string(&typed).unwrap();
    assert!(typed_wire.contains("\"tool_args\":null"));
    assert!(typed_wire.contains("\"settings\":null"));
    let refused = Server::start(|_| (503, String::new()));
    let spool = tempfile::tempdir().unwrap().keep();
    let built = open_writer(
        &refused.url,
        spool,
        1000,
        None,
        MapEnv::default(),
        UserSource::Owner,
        None,
    );
    let saved = built.writer.write(typed.clone()).await.unwrap();
    let WriteOutcome::Spooled { file, .. } = saved else {
        panic!("expected spool");
    };
    assert_eq!(std::fs::read_to_string(&file).unwrap(), typed_wire);
    assert_eq!(refused.hits.lock().unwrap()[0].body, typed_wire);
}

#[tokio::test]
async fn global_replace_keeps_trailing_empty_match() {
    let server = Server::start(|_| (200, ok_body(1, 0)));
    let spool = tempfile::tempdir().unwrap().keep();
    let built = open_writer(
        &server.url,
        spool,
        1000,
        None,
        MapEnv::default(),
        UserSource::Owner,
        Some(CaptureRedactionOptions {
            enabled: Some(true),
            builtins: Some(false),
            patterns: Some(vec![r"a*".to_string()]),
        }),
    );
    let mut batch = one();
    batch.messages[0].content = "a".to_string();
    let saved = built.writer.write(batch).await.unwrap();
    assert!(matches!(saved, WriteOutcome::Delivered { .. }));
    let body = server.hits.lock().unwrap()[0].body.clone();
    assert!(body.contains(r#""content":"[REDACTED:pattern:0][REDACTED:pattern:0]""#));
    assert!(
        built
            .logs
            .lock()
            .unwrap()
            .iter()
            .any(|line| line == "redacted 2 spans")
    );
}

#[tokio::test]
async fn replacement_keeps_lone_surrogate() {
    let raw = "{\"session_key\":\"s\",\"agent\":\"a\",\"messages\":[{\"event_id\":\"e\",\"role\":\"user\",\"content\":\"\u{1F600}\",\"tool_args\":{\"q\":\"\u{1F600}\"}}]}";
    let input = protocol::js::parse(raw).unwrap();
    let server = Server::start(|_| (200, ok_body(1, 0)));
    let spool = tempfile::tempdir().unwrap().keep();
    let built = open_writer(
        &server.url,
        spool.clone(),
        1000,
        None,
        MapEnv::default(),
        UserSource::Owner,
        Some(CaptureRedactionOptions {
            enabled: Some(true),
            builtins: Some(false),
            patterns: Some(vec![r"\uD83D".to_string()]),
        }),
    );
    let saved = built.writer.write_value(input).await.unwrap();
    assert!(matches!(saved, WriteOutcome::Delivered { .. }));
    let body = server.hits.lock().unwrap()[0].body.clone();
    let expected = r#"{"session_key":"s","agent":"a","messages":[{"event_id":"e","role":"user","content":"[REDACTED:pattern:0]\ude00","tool_args":{"q":"[REDACTED:pattern:0]\ude00"}}]}"#;
    assert_eq!(body, expected);
    let refused = Server::start(|_| (503, String::new()));
    let built = open_writer(
        &refused.url,
        spool,
        1000,
        None,
        MapEnv::default(),
        UserSource::Owner,
        Some(CaptureRedactionOptions {
            enabled: Some(true),
            builtins: Some(false),
            patterns: Some(vec![r"\uD83D".to_string()]),
        }),
    );
    let saved = built
        .writer
        .write_value(protocol::js::parse(raw).unwrap())
        .await
        .unwrap();
    let WriteOutcome::Spooled { file, .. } = saved else {
        panic!("expected spool");
    };
    assert_eq!(std::fs::read_to_string(&file).unwrap(), body);
}

#[tokio::test]
async fn invalid_patterns_only_resolve_to_none() {
    let server = Server::start(|_| (200, ok_body(1, 0)));
    let spool = tempfile::tempdir().unwrap().keep();
    let built = open_writer(
        &server.url,
        spool,
        1000,
        None,
        MapEnv::default(),
        UserSource::Owner,
        Some(CaptureRedactionOptions {
            enabled: Some(true),
            builtins: Some(false),
            patterns: Some(vec!["(".to_string()]),
        }),
    );
    let mut batch = one();
    batch.messages[0].tool_args = Some(json!({"password": "hunter2"}));
    let saved = built.writer.write(batch).await.unwrap();
    assert!(matches!(saved, WriteOutcome::Delivered { .. }));
    let body = &server.hits.lock().unwrap()[0].body;
    assert!(body.contains("hunter2"));
    assert!(!body.contains("REDACTED"));
    assert!(built.logs.lock().unwrap().is_empty());
}

#[tokio::test]
async fn extension_field_splits_like_the_posted_object() {
    let extra = "z".repeat(400);
    let first_message = r#"{"event_id":"e1","role":"user","content":"one"}"#;
    let second_message = r#"{"event_id":"e2","role":"user","content":"two"}"#;
    let both = format!(
        r#"{{"session_key":"s","agent":"a","extra":"{extra}","messages":[{first_message},{second_message}]}}"#
    );
    let first = format!(
        r#"{{"session_key":"s","agent":"a","extra":"{extra}","messages":[{first_message}]}}"#
    );
    let second = format!(
        r#"{{"session_key":"s","agent":"a","extra":"{extra}","messages":[{second_message}]}}"#
    );
    let input = protocol::js::parse(&both).unwrap();
    let both_len = protocol::js::stringify(&input).len();
    let first_len = protocol::js::stringify(&protocol::js::parse(&first).unwrap()).len();
    let second_len = protocol::js::stringify(&protocol::js::parse(&second).unwrap()).len();
    let limit = first_len.max(second_len);
    assert!(both_len > limit);
    let server = Server::start(|_| (200, ok_body(1, 0)));
    let spool = tempfile::tempdir().unwrap().keep();
    let built = open_writer(
        &server.url,
        spool,
        1000,
        Some(limit as f64),
        MapEnv::default(),
        UserSource::Owner,
        None,
    );
    let saved = built.writer.write_value(input).await.unwrap();
    assert!(matches!(saved, WriteOutcome::Delivered { inserted: 2, .. }));
    let hits = server.hits.lock().unwrap();
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].body, first);
    assert_eq!(hits[1].body, second);
    assert!(hits[0].body.len() <= limit);
    assert!(hits[1].body.len() <= limit);
}
