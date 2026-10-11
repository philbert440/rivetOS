use parking_lot::Mutex;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

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

fn serve() -> (String, Arc<Mutex<Vec<Hit>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let hits = Arc::new(Mutex::new(Vec::new()));
    let stored = hits.clone();
    std::thread::spawn(move || {
        for _ in 0..32 {
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
                r#"{{"ok":true,"conversation_id":"conv-1","inserted":{inserted},"skipped":0}}"#
            );
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            );
            let _ = stream.write_all(response.as_bytes());
            stored.lock().push(hit);
        }
    });
    (format!("http://127.0.0.1:{port}"), hits)
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

fn js_json(text: &str) -> Value {
    js_json_value(&protocol::js::parse(text).unwrap())
}

fn json_number(number: f64) -> Value {
    if number.is_finite() && number.fract() == 0.0 {
        if number >= 0.0 {
            let bits = number as u64;
            if bits as f64 == number {
                return Value::Number(bits.into());
            }
        } else {
            let bits = number as i64;
            if bits as f64 == number {
                return Value::Number(bits.into());
            }
        }
    }
    serde_json::Number::from_f64(number)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

fn js_json_value(value: &protocol::js::JsValue) -> Value {
    match value {
        protocol::js::JsValue::Null => Value::Null,
        protocol::js::JsValue::Bool(flag) => Value::Bool(*flag),
        protocol::js::JsValue::Number(number) => json_number(*number),
        protocol::js::JsValue::String(text) => Value::String(text.to_utf8().to_string()),
        protocol::js::JsValue::Array(items) => {
            Value::Array(items.iter().map(js_json_value).collect())
        }
        protocol::js::JsValue::Object(object) => {
            let mut map = serde_json::Map::new();
            for (key, child) in object.iter() {
                map.insert(key.to_utf8().to_string(), js_json_value(child));
            }
            Value::Object(map)
        }
    }
}

fn sub_all(text: &str, pattern: &str, replacement: &str) -> String {
    protocol::js::js_replace(
        &protocol::js::JsString::from_text(text),
        pattern,
        "g",
        replacement,
    )
    .unwrap()
    .to_utf8()
    .to_string()
}

fn normalize_body(body: &str, transcript: &str) -> String {
    let body = body.replace(transcript, "__TRANSCRIPT__");
    let body = sub_all(
        &body,
        r#""ingest_key":"[0-9]+-[0-9a-z]{6}""#,
        r#""ingest_key":"<ms>-<rand>""#,
    );
    sub_all(
        &body,
        r#""last_ingest_at":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z""#,
        r#""last_ingest_at":"<ts>""#,
    )
}

fn normalize_log(text: &str) -> String {
    let mut out = String::new();
    for line in text.split_inclusive('\n') {
        if let Some(index) = line.find(' ') {
            out.push_str("<ts>");
            out.push_str(&line[index..]);
        } else {
            out.push_str(line);
        }
    }
    out
}

fn assert_same(label: &str, actual: &str, expected: &str) {
    if actual == expected {
        return;
    }
    let pos = actual
        .bytes()
        .zip(expected.bytes())
        .position(|(left, right)| left != right)
        .unwrap_or(actual.len().min(expected.len()));
    let start = actual.floor_char_boundary(pos.saturating_sub(80));
    let end_actual = actual.ceil_char_boundary((pos + 180).min(actual.len()));
    let expect_start = expected.floor_char_boundary(pos.saturating_sub(80));
    let end_expected = expected.ceil_char_boundary((pos + 180).min(expected.len()));
    panic!(
        "{label} mismatch at {pos} actual_len={} expected_len={}\nactual: {}\nexpect: {}",
        actual.len(),
        expected.len(),
        &actual[start..end_actual],
        &expected[expect_start..end_expected]
    );
}

fn wait_until(label: &str, mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(25);
    while Instant::now() < deadline {
        if ready() {
            return;
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    panic!("timed out waiting for {label}");
}

#[test]
fn golden_hook_matches_the_typescript_runtime() {
    let events = js_json(&std::fs::read_to_string(fixture("hook-ts.json")).unwrap());
    let (url, hits) = serve();
    for event in events.as_array().unwrap() {
        let home = tempfile::tempdir().unwrap();
        let transcript = home.path().join("transcript.jsonl");
        std::fs::copy(fixture("transcript.jsonl"), &transcript).unwrap();
        let transcript_text = transcript.display().to_string();
        let stdin = event["stdin"]
            .as_str()
            .unwrap()
            .replace("__TRANSCRIPT__", &transcript_text);
        let spool = home.path().join("hook-spool");
        let before = hits.lock().len();
        let mut child = Command::new(env!("CARGO_BIN_EXE_rivetos"))
            .args(["capture", "hook", "--harness", "claude-code"])
            .env_clear()
            .env("HOME", home.path())
            .env("PATH", "/usr/bin:/bin")
            .env("RIVET_DEN_URL", &url)
            .env("RIVETOS_CAPTURE_TRANSPORT", "den")
            .env("RIVETOS_ROOT", "/tmp/rr-1-rivetos-root")
            .env("RIVETOS_CLAUDE_HOOK_SPOOL", &spool)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(stdin.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert_eq!(
            output.status.code(),
            Some(event["exit"].as_i64().unwrap() as i32)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            event["stdout"].as_str().unwrap()
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stderr),
            event["stderr"].as_str().unwrap()
        );
        let expected_posts = event["posts"].as_array().unwrap();
        wait_until(&format!("posts {}", event["event"]), || {
            hits.lock().len() >= before + expected_posts.len()
        });
        let log_path = home.path().join(".rivetos").join("claude-capture.log");
        wait_until(&format!("log {}", event["event"]), || log_path.is_file());
        wait_until(&format!("spool {}", event["event"]), || {
            !spool_has_json(&spool)
        });
        let got = hits.lock();
        let slice = &got[before..];
        assert_eq!(slice.len(), expected_posts.len());
        for (hit, post) in slice.iter().zip(expected_posts) {
            assert_eq!(hit.method, post["method"].as_str().unwrap());
            assert_eq!(hit.path, post["url"].as_str().unwrap());
            assert_eq!(hit.content_type, post["contentType"].as_str().unwrap());
            let expected_body = post["body"].as_str().unwrap();
            if expected_body.contains("ingest_key") {
                let marked = sub_all(&hit.body, r#""ingest_key":"([0-9]+-[0-9a-z]{6})""#, "\u{1}");
                assert!(
                    marked.contains('\u{1}'),
                    "ingest_key format {}",
                    event["event"]
                );
            }
            let actual = normalize_body(&hit.body, &transcript_text);
            let expected = normalize_body(expected_body, &transcript_text);
            assert_same(event["event"].as_str().unwrap(), &actual, &expected);
        }
        drop(got);
        for file in event["files"].as_array().unwrap() {
            let path = home.path().join(file["path"].as_str().unwrap());
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            let recorded = u32::from_str_radix(file["mode"].as_str().unwrap(), 8).unwrap();
            if path.ends_with("claude-capture.log") {
                let probe = home.path().join("default-mode-probe");
                std::fs::File::create(&probe).unwrap();
                let created = std::fs::metadata(&probe).unwrap().permissions().mode() & 0o777;
                let _ = std::fs::remove_file(&probe);
                assert_eq!(mode, created);
                if created == 0o644 {
                    assert_eq!(mode, recorded);
                }
            } else {
                assert_eq!(mode, recorded);
            }
            let actual = if path.ends_with("claude-capture.log") {
                normalize_log(&std::fs::read_to_string(&path).unwrap())
            } else {
                std::fs::read_to_string(&path).unwrap()
            };
            assert_eq!(actual, file["content"].as_str().unwrap());
        }
    }
}

fn spool_has_json(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        entry
            .file_name()
            .to_string_lossy()
            .to_ascii_lowercase()
            .ends_with(".json")
    })
}
