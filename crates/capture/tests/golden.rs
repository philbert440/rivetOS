use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use capture::{
    CaptureRedactionOptions, CaptureWriterOptions, UserSource, WriteOutcome, create_capture_writer,
};
use serde_json::Value;

const PROVENANCE: &str = "ts-runtime-c72e851f-rivet-harness";

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/golden")
        .join(PROVENANCE)
        .join(name)
}

struct Hit {
    method: String,
    path: String,
    content_type: String,
    body: String,
}

struct Server {
    url: String,
    hits: Arc<Mutex<Vec<Hit>>>,
}

impl Server {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(Mutex::new(Vec::new()));
        let stored = hits.clone();
        std::thread::spawn(move || {
            for _ in 0..16 {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let Some(hit) = read_hit(&mut stream) else {
                    continue;
                };
                let inserted = serde_json::from_str::<Value>(&hit.body)
                    .ok()
                    .and_then(|value| value.get("messages")?.as_array().map(|items| items.len()))
                    .unwrap_or(0);
                let reply = format!(
                    r#"{{"ok":true,"conversation_id":"c-1","inserted":{inserted},"skipped":0}}"#
                );
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                    reply.len()
                );
                let _ = stream.write_all(response.as_bytes());
                stored.lock().unwrap().push(hit);
            }
        });
        Self {
            url: format!("http://127.0.0.1:{port}"),
            hits,
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
                if let Some(end) = buf.windows(4).position(|window| window == b"\r\n\r\n") {
                    let length = content_length(&buf[..end]).unwrap_or(0);
                    if buf.len() >= end + 4 + length {
                        break (end, length);
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
    let header = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = header.lines();
    let request = lines.next().unwrap_or("");
    let mut parts = request.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    let mut content_type = String::new();
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("content-type") {
            content_type = value.trim().to_string();
        }
    }
    let start = header_end + 4;
    let body = String::from_utf8_lossy(&buf[start..start + length]).into_owned();
    Some(Hit {
        method,
        path,
        content_type,
        body,
    })
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

fn assert_same(case: &str, actual: &str, expected: &str) {
    if actual == expected {
        return;
    }
    let pos = actual
        .bytes()
        .zip(expected.bytes())
        .position(|(left, right)| left != right)
        .unwrap_or(actual.len().min(expected.len()));
    let start = actual.floor_char_boundary(pos.saturating_sub(80));
    let end_actual = actual.ceil_char_boundary((pos + 160).min(actual.len()));
    let expect_start = expected.floor_char_boundary(pos.saturating_sub(80));
    let end_expected = expected.ceil_char_boundary((pos + 160).min(expected.len()));
    panic!(
        "{case} mismatch at {pos} actual_len={} expected_len={}\nactual: {}\nexpect: {}",
        actual.len(),
        expected.len(),
        &actual[start..end_actual],
        &expected[expect_start..end_expected]
    );
}

#[tokio::test]
async fn golden_writer_matches_the_typescript_runtime() {
    let results = protocol::js::to_serde(
        &protocol::js::parse(&std::fs::read_to_string(fixture("results.json")).unwrap()).unwrap(),
    );
    for case in [
        "single",
        "numbers_and_keys",
        "surrogate_cap",
        "finalize_multi_chunk",
        "elide_tool_args",
        "redaction",
    ] {
        let raw = std::fs::read_to_string(fixture(&format!("{case}.input.json"))).unwrap();
        let input = protocol::js::parse(&raw).unwrap();
        let expected = protocol::js::to_serde(
            &protocol::js::parse(
                &std::fs::read_to_string(fixture(&format!("{case}.posts.json"))).unwrap(),
            )
            .unwrap(),
        );
        let server = Server::start();
        let spool = tempfile::tempdir().unwrap();
        let mut opts = CaptureWriterOptions::new(&server.url);
        opts.spool_dir = Some(spool.path().to_path_buf());
        opts.user = UserSource::Owner;
        opts.max_chunk_bytes = match case {
            "finalize_multi_chunk" => Some(20_000.0),
            "elide_tool_args" => Some(30_000.0),
            _ => None,
        };
        if case == "redaction" {
            opts.redaction = Some(CaptureRedactionOptions {
                enabled: Some(true),
                builtins: Some(true),
                patterns: Some(vec!["(?<=code=)[A-Z0-9]+".to_string()]),
            });
        }
        let writer = create_capture_writer(opts).unwrap();
        let saved = writer.write_value(input).await.unwrap();
        let posts = expected.as_array().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while server.hits.lock().unwrap().len() < posts.len()
            && std::time::Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let hits = server.hits.lock().unwrap();
        assert_eq!(hits.len(), posts.len(), "{case}");
        for (hit, post) in hits.iter().zip(posts) {
            assert_eq!(hit.method, post["method"].as_str().unwrap_or(""));
            assert_eq!(hit.path, post["url"].as_str().unwrap_or(""));
            assert_eq!(hit.content_type, post["contentType"].as_str().unwrap_or(""));
            assert_same(case, &hit.body, post["body"].as_str().unwrap_or(""));
        }
        let want = &results[case];
        match saved {
            WriteOutcome::Delivered {
                conversation_id,
                inserted,
                skipped,
                ..
            } => {
                assert_eq!(conversation_id, want["conversation_id"].as_str().unwrap());
                assert_eq!(inserted, want["inserted"].as_u64().unwrap());
                assert_eq!(skipped, want["skipped"].as_u64().unwrap());
            }
            WriteOutcome::Spooled { .. } => panic!("{case} spooled"),
            WriteOutcome::NotSaved { error } => panic!("{case} not saved: {error}"),
        }
    }
}
