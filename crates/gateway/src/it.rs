#![cfg(test)]

use std::collections::BTreeMap;
use std::io::Cursor;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;

use futures_util::StreamExt;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use rustls::{ClientConfig, RootCertStore};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_tungstenite::client_async;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

use crate::config::GatewayConfig;
use crate::http_codec::Reply;
use crate::hub::{Fanout, Hub, MAX_BUFFERED};
use crate::listen::{Running, serve, serve_with};
use crate::routes::{GatewayRoutes, MountRequest};
use crate::test_support::{isolated, scratch, token_lock};

const EVENT: &str = r#"{"v":1,"session":"s1","name":"alpha","ts":100,"type":"session.start","title":"hello","harness":"claude-code"}"#;

fn fixture(name: &str) -> &'static str {
    match name {
        "invalid-json" => include_str!("../tests/fixtures/invalid-json.json"),
        "events-batch" => include_str!("../tests/fixtures/events-batch.json"),
        "event-invalid" => include_str!("../tests/fixtures/event-invalid.json"),
        "event-index" => include_str!("../tests/fixtures/event-index.json"),
        "unknown-session" => include_str!("../tests/fixtures/unknown-session.json"),
        "owned-session" => include_str!("../tests/fixtures/owned-session.json"),
        "not-found" => include_str!("../tests/fixtures/not-found.json"),
        "body-too-large" => include_str!("../tests/fixtures/body-too-large.json"),
        "devices-disabled" => include_str!("../tests/fixtures/devices-disabled.json"),
        "unauthorized" => include_str!("../tests/fixtures/unauthorized.json"),
        "forbidden-origin" => include_str!("../tests/fixtures/forbidden-origin.json"),
        "pair-invalid" => include_str!("../tests/fixtures/pair-invalid.json"),
        "pair-post-only" => include_str!("../tests/fixtures/pair-post-only.json"),
        "phone-missing" => include_str!("../tests/fixtures/phone-missing.json"),
        "phone-post" => include_str!("../tests/fixtures/phone-post.json"),
        "voice-stt" => include_str!("../tests/fixtures/voice-stt.json"),
        "voice-tts" => include_str!("../tests/fixtures/voice-tts.json"),
        "terminal-disabled" => include_str!("../tests/fixtures/terminal-disabled.json"),
        "audio-disabled" => include_str!("../tests/fixtures/audio-disabled.json"),
        "files-disabled" => include_str!("../tests/fixtures/files-disabled.json"),
        "audio-bridge" => include_str!("../tests/fixtures/audio-bridge.json"),
        "node-pty" => include_str!("../tests/fixtures/node-pty.json"),
        "bad-viewer" => include_str!("../tests/fixtures/bad-viewer.json"),
        "no-layout" => include_str!("../tests/fixtures/no-layout.json"),
        "malformed-device" => include_str!("../tests/fixtures/malformed-device.json"),
        "no-mesh" => include_str!("../tests/fixtures/no-mesh.json"),
        "ok" => include_str!("../tests/fixtures/ok.json"),
        "phone-expired" => include_str!("../tests/fixtures/phone-expired.json"),
        "html" => include_str!("../tests/fixtures/unauthorized.html"),
        _ => panic!("unknown fixture {name}"),
    }
}

fn body_eq(got: &[u8], name: &str) {
    let expected = fixture(name).trim_end_matches('\n');
    assert_eq!(String::from_utf8_lossy(got).as_ref(), expected, "{name}");
}

struct HttpResp {
    status: u16,
    head: String,
    body: Vec<u8>,
}

fn header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
}

fn content_length(head: &str) -> Option<usize> {
    for line in head.lines() {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("content-length") {
            return value.trim().parse().ok();
        }
    }
    None
}

fn try_chunked(buf: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut index = 0;
    loop {
        let relative = buf[index..]
            .windows(2)
            .position(|window| window == b"\r\n")?;
        let line = std::str::from_utf8(&buf[index..index + relative]).ok()?;
        let size = usize::from_str_radix(line.trim(), 16).ok()?;
        index += relative + 2;
        if size == 0 {
            return Some(out);
        }
        if index + size + 2 > buf.len() {
            return None;
        }
        out.extend_from_slice(&buf[index..index + size]);
        index += size + 2;
    }
}

async fn read_http<S>(stream: &mut S) -> HttpResp
where
    S: AsyncReadExt + Unpin,
{
    let mut buf = Vec::new();
    let mut tmp = [0_u8; 8192];
    let end = loop {
        let read = tokio::time::timeout(Duration::from_secs(3), stream.read(&mut tmp))
            .await
            .unwrap()
            .unwrap();
        assert!(read > 0, "eof before headers");
        buf.extend_from_slice(&tmp[..read]);
        if let Some(end) = header_end(&buf) {
            break end;
        }
    };
    let head = String::from_utf8_lossy(&buf[..end]).into_owned();
    let status = head
        .lines()
        .next()
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let mut rest = buf[end..].to_vec();
    let lower = head.to_ascii_lowercase();
    let body = if status == 100 {
        Vec::new()
    } else if lower.contains("transfer-encoding: chunked") {
        loop {
            if let Some(body) = try_chunked(&rest) {
                break body;
            }
            let read = tokio::time::timeout(Duration::from_secs(3), stream.read(&mut tmp))
                .await
                .unwrap()
                .unwrap();
            assert!(read > 0, "eof in chunked body");
            rest.extend_from_slice(&tmp[..read]);
        }
    } else if let Some(len) = content_length(&head) {
        while rest.len() < len {
            let read = stream.read(&mut tmp).await.unwrap();
            assert!(read > 0);
            rest.extend_from_slice(&tmp[..read]);
        }
        rest[..len].to_vec()
    } else {
        Vec::new()
    };
    HttpResp { status, head, body }
}

async fn exchange(addr: SocketAddr, request: &str) -> HttpResp {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    read_http(&mut stream).await
}

fn request(method: &str, target: &str, host: &str, extra: &str, body: &str) -> String {
    let length = if method == "POST" || method == "PUT" || !body.is_empty() {
        format!("Content-Length: {}\r\n", body.len())
    } else {
        String::new()
    };
    format!("{method} {target} HTTP/1.1\r\nHost: {host}\r\n{extra}{length}\r\n{body}")
}

async fn boot(mut env: BTreeMap<String, String>) -> Running {
    env.entry("RIVETOS_DEN_PORT".to_string())
        .or_insert_with(|| "0".to_string());
    serve(GatewayConfig::from_env(&env)).await.unwrap()
}

#[tokio::test]
async fn plain_http_routes_match_disabled_and_event_bodies() {
    let dir = scratch("http");
    let mut env = isolated(&dir);
    let static_dir = dir.join("static");
    std::fs::create_dir_all(&static_dir).unwrap();
    std::fs::write(
        static_dir.join("index.html"),
        "<!doctype html>\n<html>golden</html>\n",
    )
    .unwrap();
    std::fs::write(static_dir.join("app.js"), "console.log(1)\n").unwrap();
    env.insert(
        "RIVETOS_DEN_STATIC_DIR".to_string(),
        static_dir.to_string_lossy().into_owned(),
    );
    env.insert(
        "RIVETOS_DEN_ROOT_REDIRECT".to_string(),
        "https://example.test/hub".to_string(),
    );
    let running = boot(env).await;
    let addr = running.addr();
    let host = format!("127.0.0.1:{}", addr.port());

    let health = exchange(addr, &request("GET", "/healthz", &host, "", "")).await;
    assert_eq!(health.status, 200);
    let health_json: serde_json::Value = serde_json::from_slice(&health.body).unwrap();
    assert_eq!(health_json["ok"], true);
    assert_eq!(health_json["sessions"], 0);
    assert!(health.head.contains("Transfer-Encoding: chunked"));
    assert!(health.head.contains("Keep-Alive: timeout=5"));
    assert!(
        health
            .head
            .contains("Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS")
    );

    let options = exchange(addr, &request("OPTIONS", "/healthz", &host, "", "")).await;
    assert_eq!(options.status, 204);
    assert!(options.body.is_empty());
    assert!(
        !options
            .head
            .to_ascii_lowercase()
            .contains("transfer-encoding")
    );
    assert!(options.head.contains("DELETE"));

    let missing_host = exchange(addr, "GET /healthz HTTP/1.1\r\n\r\n").await;
    assert_eq!(missing_host.status, 400);
    let lines: Vec<&str> = missing_host.head.lines().collect();
    assert!(lines.contains(&"Connection: close"));
    assert!(missing_host.head.contains("Transfer-Encoding: chunked"));
    let connection_at = lines
        .iter()
        .position(|line| line.starts_with("Connection"))
        .unwrap();
    let date_at = lines
        .iter()
        .position(|line| line.starts_with("Date"))
        .unwrap();
    assert!(connection_at < date_at);

    let garbage = exchange(addr, "GARBAGE\r\n\r\n").await;
    assert_eq!(garbage.status, 400);
    assert_eq!(
        garbage.head,
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"
    );
    assert!(content_length(&garbage.head).is_none());

    let encoded = exchange(addr, &request("GET", "/heal%74hz", &host, "", "")).await;
    assert_eq!(encoded.status, 200);
    assert_eq!(
        std::str::from_utf8(&encoded.body).unwrap(),
        "<!doctype html>\n<html>golden</html>\n"
    );

    let scheme_relative = exchange(addr, &request("GET", "//healthz", &host, "", "")).await;
    assert_eq!(scheme_relative.status, 302);

    let star = exchange(addr, "OPTIONS * HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").await;
    assert_eq!(star.status, 204);

    let bad_json = exchange(
        addr,
        &request(
            "POST",
            "/event",
            &host,
            "Content-Type: application/json\r\n",
            "{",
        ),
    )
    .await;
    assert_eq!(bad_json.status, 400);
    body_eq(&bad_json.body, "invalid-json");

    let not_event = exchange(
        addr,
        &request(
            "POST",
            "/event",
            &host,
            "Content-Type: application/json\r\n",
            "\"hello\"",
        ),
    )
    .await;
    assert_eq!(not_event.status, 422);
    body_eq(&not_event.body, "event-invalid");

    let bad_batch = exchange(addr, &request("POST", "/events", &host, "", "[]")).await;
    assert_eq!(bad_batch.status, 400);
    body_eq(&bad_batch.body, "events-batch");

    let indexed = exchange(addr, &request("POST", "/events", &host, "", "[{\"v\":1}]")).await;
    assert_eq!(indexed.status, 422);
    body_eq(&indexed.body, "event-index");

    let ingested = exchange(
        addr,
        &request(
            "POST",
            "/event",
            &host,
            "Content-Type: application/json\r\n",
            EVENT,
        ),
    )
    .await;
    assert_eq!(ingested.status, 200);
    body_eq(&ingested.body, "ok");

    let sessions = exchange(addr, &request("GET", "/sessions", &host, "", "")).await;
    assert_eq!(sessions.status, 200);
    let listed: serde_json::Value = serde_json::from_slice(&sessions.body).unwrap();
    assert_eq!(listed["sessions"].as_array().unwrap().len(), 1);

    let alias = exchange(
        addr,
        &request("POST", "/api/events", &host, "", &format!("[{EVENT}]")),
    )
    .await;
    assert_eq!(alias.status, 200);
    let alias_json: serde_json::Value = serde_json::from_slice(&alias.body).unwrap();
    assert_eq!(alias_json["ingested"], 1);

    let uuid = "11111111-2222-4333-8444-555555555555";
    let posted = format!(
        r#"{{"v":1,"session":"{uuid}","name":"alpha","ts":101,"type":"session.start","title":"room","harness":"claude-code"}}"#
    );
    let posted_res = exchange(addr, &request("POST", "/event", &host, "", &posted)).await;
    assert_eq!(posted_res.status, 200);
    let state = exchange(
        addr,
        &request(
            "GET",
            &format!("/state?session=claude-code:{uuid}&session=ignored"),
            &host,
            "",
            "",
        ),
    )
    .await;
    assert_eq!(state.status, 200);
    let state_json: serde_json::Value = serde_json::from_slice(&state.body).unwrap();
    assert_eq!(state_json["session"], format!("claude-code:{uuid}"));
    assert!(state_json["state"].is_object());

    let unknown = exchange(
        addr,
        &request("DELETE", "/session?session=missing", &host, "", ""),
    )
    .await;
    assert_eq!(unknown.status, 404);
    body_eq(&unknown.body, "unknown-session");

    let removed = exchange(
        addr,
        &request("DELETE", "/session?session=s1", &host, "", ""),
    )
    .await;
    assert_eq!(removed.status, 200);
    body_eq(&removed.body, "ok");

    let devices = exchange(addr, &request("POST", "/api/devices/enroll", &host, "", "")).await;
    assert_eq!(devices.status, 503);
    body_eq(&devices.body, "devices-disabled");
    let pair_get = exchange(addr, &request("GET", "/api/devices/pair", &host, "", "")).await;
    assert_eq!(pair_get.status, 405);
    body_eq(&pair_get.body, "pair-post-only");
    let pair = exchange(
        addr,
        &request(
            "POST",
            "/api/devices/pair",
            &host,
            "",
            r#"{"token":"nope"}"#,
        ),
    )
    .await;
    assert_eq!(pair.status, 403);
    body_eq(&pair.body, "pair-invalid");
    let phone = exchange(addr, &request("GET", "/api/phone-pairing", &host, "", "")).await;
    assert_eq!(phone.status, 200);
    body_eq(&phone.body, "phone-missing");
    let phone_post = exchange(
        addr,
        &request("POST", "/api/phone-pairing", &host, "", "{}"),
    )
    .await;
    assert_eq!(phone_post.status, 503);
    body_eq(&phone_post.body, "phone-post");
    let malformed = exchange(addr, &request("GET", "/api/phone-pairing/%", &host, "", "")).await;
    assert_eq!(malformed.status, 400);
    body_eq(&malformed.body, "malformed-device");
    let expired = exchange(
        addr,
        &request("GET", "/api/phone-pairing/pixel", &host, "", ""),
    )
    .await;
    assert_eq!(expired.status, 200);
    body_eq(&expired.body, "phone-expired");

    let caps = exchange(addr, &request("GET", "/api/capabilities", &host, "", "")).await;
    assert_eq!(caps.status, 200);
    let caps_json: serde_json::Value = serde_json::from_slice(&caps.body).unwrap();
    assert_eq!(caps_json["subsystems"]["den"], true);
    assert_eq!(caps_json["subsystems"]["devices"], false);
    assert!(caps.head.lines().next().is_some());
    assert!(
        caps.head.contains("Access-Control-Allow-Origin") || caps.head.contains("Content-Type")
    );

    let voice = exchange(
        addr,
        &request("POST", "/api/voice/transcribe", &host, "", ""),
    )
    .await;
    assert_eq!(voice.status, 501);
    body_eq(&voice.body, "voice-stt");
    let speak = exchange(addr, &request("POST", "/api/voice/speak", &host, "", "")).await;
    assert_eq!(speak.status, 501);
    body_eq(&speak.body, "voice-tts");

    let term = exchange(addr, &request("GET", "/term/list", &host, "", "")).await;
    assert_eq!(term.status, 503);
    body_eq(&term.body, "terminal-disabled");
    let term_config = exchange(addr, &request("GET", "/api/terminal/config", &host, "", "")).await;
    assert_eq!(term_config.status, 200);
    let term_json: serde_json::Value = serde_json::from_slice(&term_config.body).unwrap();
    assert_eq!(term_json["enabled"], false);
    assert_eq!(term_json["default"], "claude");
    assert!(term_json["commands"].as_array().unwrap().len() >= 9);

    let audio = exchange(addr, &request("GET", "/audio/mic", &host, "", "")).await;
    assert_eq!(audio.status, 503);
    body_eq(&audio.body, "audio-disabled");
    let files = exchange(addr, &request("GET", "/files/list", &host, "", "")).await;
    assert_eq!(files.status, 503);
    body_eq(&files.body, "files-disabled");

    let mesh = exchange(addr, &request("GET", "/mesh.json", &host, "", "")).await;
    assert_eq!(mesh.status, 404);
    body_eq(&mesh.body, "no-mesh");

    let layout = exchange(addr, &request("GET", "/layout?viewer=../x", &host, "", "")).await;
    assert_eq!(layout.status, 400);
    body_eq(&layout.body, "bad-viewer");
    let missing_layout = exchange(addr, &request("GET", "/layout", &host, "", "")).await;
    assert_eq!(missing_layout.status, 404);
    body_eq(&missing_layout.body, "no-layout");
    let saved = exchange(
        addr,
        &request("POST", "/layout?viewer=desk", &host, "", r#"{"cols":2}"#),
    )
    .await;
    assert_eq!(saved.status, 200);
    body_eq(&saved.body, "ok");
    let loaded = exchange(addr, &request("GET", "/layout?viewer=desk", &host, "", "")).await;
    assert_eq!(loaded.status, 200);
    assert_eq!(loaded.body, br#"{"cols":2}"#);

    let foreign = exchange(
        addr,
        &request(
            "GET",
            "/sessions",
            &host,
            "Origin: https://evil.example\r\n",
            "",
        ),
    )
    .await;
    assert_eq!(foreign.status, 403);
    body_eq(&foreign.body, "forbidden-origin");
    assert!(
        !foreign
            .head
            .to_ascii_lowercase()
            .contains("access-control-allow-origin")
    );

    let rebound = exchange(addr, "GET /sessions HTTP/1.1\r\nHost: evil.example\r\n\r\n").await;
    assert_eq!(rebound.status, 403);
    body_eq(&rebound.body, "forbidden-origin");

    let redirect = exchange(addr, &request("GET", "/", &host, "", "")).await;
    assert_eq!(redirect.status, 302);
    assert!(redirect.head.contains("Location: https://example.test/hub"));
    let head = exchange(addr, &request("HEAD", "/", &host, "", "")).await;
    assert_eq!(head.status, 200);
    assert!(head.body.is_empty());
    assert!(head.head.contains("text/html"));

    let huge = exchange(
        addr,
        "POST /event HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 300000\r\n\r\n",
    )
    .await;
    assert_eq!(huge.status, 413);
    body_eq(&huge.body, "body-too-large");

    running.shutdown().await;
}

#[tokio::test]
async fn expect_continue_then_ingests() {
    let dir = scratch("expect");
    let running = boot(isolated(&dir)).await;
    let addr = running.addr();
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let head = format!(
        "POST /event HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nExpect: 100-continue\r\nContent-Length: {}\r\n\r\n",
        addr.port(),
        EVENT.len()
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    let cont = read_http(&mut stream).await;
    assert_eq!(cont.status, 100);
    stream.write_all(EVENT.as_bytes()).await.unwrap();
    let done = read_http(&mut stream).await;
    assert_eq!(done.status, 200);
    body_eq(&done.body, "ok");
    running.shutdown().await;
}

#[tokio::test]
async fn files_root_missing_audio_and_term_when_enabled() {
    let dir = scratch("enabled");
    let mut env = isolated(&dir);
    let missing = dir.join("no-such-files");
    env.insert(
        "RIVETOS_DEN_FILES_ROOT".to_string(),
        missing.to_string_lossy().into_owned(),
    );
    env.insert("RIVETOS_DEN_AUDIO".to_string(), "1".to_string());
    env.insert("RIVETOS_DEN_TERM".to_string(), "1".to_string());
    let running = boot(env).await;
    let addr = running.addr();
    let host = "127.0.0.1";
    let files = exchange(addr, &request("GET", "/files/", host, "", "")).await;
    assert_eq!(files.status, 503);
    let files_json: serde_json::Value = serde_json::from_slice(&files.body).unwrap();
    assert!(
        files_json["error"]
            .as_str()
            .unwrap()
            .starts_with("files root not available:")
    );
    let audio = exchange(addr, &request("GET", "/audio", host, "", "")).await;
    assert_eq!(audio.status, 503);
    body_eq(&audio.body, "audio-bridge");
    let term = exchange(addr, &request("POST", "/term", host, "", "{}")).await;
    assert_eq!(term.status, 503);
    body_eq(&term.body, "node-pty");
    let present = dir.join("files-root");
    std::fs::create_dir_all(&present).unwrap();
    running.shutdown().await;

    let mut env = isolated(&dir);
    env.insert(
        "RIVETOS_DEN_FILES_ROOT".to_string(),
        present.to_string_lossy().into_owned(),
    );
    let running = boot(env).await;
    let listed = exchange(running.addr(), &request("GET", "/files/", host, "", "")).await;
    assert_eq!(listed.status, 404);
    body_eq(&listed.body, "not-found");
    running.shutdown().await;
}

#[tokio::test]
async fn off_loopback_without_tls_refuses() {
    let dir = scratch("refuse");
    let mut env = isolated(&dir);
    env.insert("RIVETOS_DEN_HOST".to_string(), "192.0.2.10".to_string());
    let Err(err) = serve(GatewayConfig::from_env(&env)).await else {
        panic!("expected bind refusal");
    };
    assert!(err.to_string().contains("refusing to bind 192.0.2.10"));
}

#[tokio::test]
async fn websocket_snapshot_filter_tenancy_and_evict() {
    let _guard = token_lock().await;
    identity::clear_user_tokens();
    let dir = scratch("ws");
    let users = dir.join("users.json");
    std::fs::write(
        &users,
        r#"{"ownerUserId":"alice","unmappedIsOwner":false,"users":{"alice":{"devices":[],"pgUrl":"postgres://alice@db/alice"},"coco":{"devices":["win-coco"],"pgUrl":"postgres://coco@db/coco"}}}"#,
    )
    .unwrap();
    std::fs::write(
        dir.join("state").join("session-owners.json"),
        "{\n  \"coco-room\": \"coco\"\n}\n",
    )
    .unwrap();
    let mut env = isolated(&dir);
    env.insert(
        "RIVETOS_USERS_FILE".to_string(),
        users.to_string_lossy().into_owned(),
    );
    env.insert("RIVETOS_DEN_EVICT_TTL_MS".to_string(), "40".to_string());
    let running = boot(env).await;
    let addr = running.addr();
    let host = format!("127.0.0.1:{}", addr.port());
    let open = r#"{"v":1,"session":"open-room","name":"alpha","ts":1,"type":"session.start","title":"open","harness":"claude-code"}"#;
    let coco = r#"{"v":1,"session":"coco-room","name":"alpha","ts":2,"type":"session.start","title":"coco","harness":"claude-code"}"#;
    assert_eq!(
        exchange(addr, &request("POST", "/event", &host, "", open))
            .await
            .status,
        200
    );
    assert_eq!(
        exchange(addr, &request("POST", "/event", &host, "", coco))
            .await
            .status,
        200
    );

    let token = identity::mint_user_token("coco").unwrap();
    let owner_req = format!("ws://127.0.0.1:{}/ws", addr.port())
        .into_client_request()
        .unwrap();
    let owner_stream = TcpStream::connect(addr).await.unwrap();
    let (mut owner_ws, _) = client_async(owner_req, owner_stream).await.unwrap();
    let owner_snap = owner_ws.next().await.unwrap().unwrap();
    let Message::Text(text) = owner_snap else {
        panic!("owner snapshot");
    };
    let snap: serde_json::Value = serde_json::from_str(text.as_str()).unwrap();
    let ids: Vec<&str> = snap["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|item| item.get("id").and_then(|id| id.as_str()))
        .collect();
    assert!(ids.contains(&"open-room"));
    assert!(!ids.contains(&"coco-room"));

    let mut coco_req = format!("ws://127.0.0.1:{}/ws?session=coco-room", addr.port())
        .into_client_request()
        .unwrap();
    coco_req
        .headers_mut()
        .insert("x-rivetos-user-token", token.parse().unwrap());
    let coco_stream = TcpStream::connect(addr).await.unwrap();
    let (mut coco_ws, _) = client_async(coco_req, coco_stream).await.unwrap();
    let coco_snap = coco_ws.next().await.unwrap().unwrap();
    let Message::Text(text) = coco_snap else {
        panic!("coco snapshot");
    };
    assert!(text.as_str().contains("coco-room"));

    let follow = r#"{"v":1,"session":"open-room","name":"alpha","ts":3,"type":"thinking.delta","text":"hi","harness":"claude-code"}"#;
    assert_eq!(
        exchange(addr, &request("POST", "/event", &host, "", follow))
            .await
            .status,
        200
    );
    let live = tokio::time::timeout(Duration::from_secs(2), owner_ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let Message::Text(text) = live else {
        panic!("live");
    };
    assert!(text.as_str().contains("open-room"));
    let coco_silent = tokio::time::timeout(Duration::from_millis(200), coco_ws.next()).await;
    assert!(coco_silent.is_err());

    let reject_req = format!("ws://127.0.0.1:{}/ws?session=coco-room", addr.port())
        .into_client_request()
        .unwrap();
    let reject_stream = TcpStream::connect(addr).await.unwrap();
    let (mut reject_ws, _) = client_async(reject_req, reject_stream).await.unwrap();
    let closed = reject_ws.next().await.unwrap().unwrap();
    match closed {
        Message::Close(Some(frame)) => {
            assert_eq!(frame.code, CloseCode::from(4403_u16));
            assert_eq!(frame.reason.as_str(), "session is owned by another user");
        }
        other => panic!("expected 4403, got {other:?}"),
    }

    let end = r#"{"v":1,"session":"open-room","ts":4,"type":"session.end"}"#;
    assert_eq!(
        exchange(addr, &request("POST", "/event", &host, "", end))
            .await
            .status,
        200
    );
    let ended = tokio::time::timeout(Duration::from_secs(2), owner_ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let Message::Text(text) = ended else {
        panic!("end");
    };
    assert!(text.as_str().contains("session.end"));
    tokio::time::sleep(Duration::from_millis(80)).await;
    let removed = tokio::time::timeout(Duration::from_secs(2), owner_ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let Message::Text(text) = removed else {
        panic!("removed");
    };
    let removed_json: serde_json::Value = serde_json::from_str(text.as_str()).unwrap();
    assert_eq!(removed_json["type"], "session.removed");
    assert_eq!(removed_json["session"], "open-room");
    let after = exchange(addr, &request("GET", "/sessions", &host, "", "")).await;
    let after_json: serde_json::Value = serde_json::from_slice(&after.body).unwrap();
    let still = after_json["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item.get("id").and_then(|id| id.as_str()) == Some("open-room"));
    assert!(!still);
    running.shutdown().await;
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn websocket_missed_pong_closes() {
    let dir = scratch("pong");
    let running = boot(isolated(&dir)).await;
    let addr = running.addr();
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let key = "dGhlIHNhbXBsZSBub25jZQ==";
    let upgrade = format!(
        "GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n",
        addr.port()
    );
    stream.write_all(upgrade.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    let mut tmp = [0_u8; 4096];
    let end = loop {
        let read = stream.read(&mut tmp).await.unwrap();
        assert!(read > 0);
        buf.extend_from_slice(&tmp[..read]);
        if let Some(end) = header_end(&buf) {
            break end;
        }
    };
    assert!(buf[..end].starts_with(b"HTTP/1.1 101"));
    let head = String::from_utf8_lossy(&buf[..end]);
    assert!(head.contains("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo="));
    assert!(!head.contains("Sec-Websocket-Accept"));
    let mut pending = buf[end..].to_vec();
    let frame = read_frame(&mut stream, &mut pending).await;
    assert_eq!(frame.0 & 0x0f, 0x1);
    tokio::time::sleep(Duration::from_secs(61)).await;
    tokio::time::resume();
    let mut tmp = [0_u8; 256];
    let saw_eof = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match stream.read(&mut tmp).await {
                Ok(0) | Err(_) => return true,
                Ok(_) => {}
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(saw_eof);
    running.shutdown().await;
}

async fn read_frame(stream: &mut TcpStream, buf: &mut Vec<u8>) -> (u8, Vec<u8>) {
    let mut tmp = [0_u8; 4096];
    loop {
        if buf.len() >= 2 {
            let opcode = buf[0];
            let len_byte = buf[1] & 0x7f;
            let header = if len_byte == 126 {
                4
            } else if len_byte == 127 {
                10
            } else {
                2
            };
            if buf.len() >= header {
                let len = if len_byte == 126 {
                    u16::from_be_bytes([buf[2], buf[3]]) as usize
                } else if len_byte == 127 {
                    u64::from_be_bytes(buf[2..10].try_into().unwrap()) as usize
                } else {
                    usize::from(len_byte)
                };
                if buf.len() >= header + len {
                    let payload = buf[header..header + len].to_vec();
                    buf.drain(..header + len);
                    return (opcode, payload);
                }
            }
        }
        let read = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut tmp))
            .await
            .unwrap()
            .unwrap();
        assert!(read > 0);
        buf.extend_from_slice(&tmp[..read]);
    }
}

struct Issued {
    cert_pem: String,
    key_pem: String,
}

fn issue(
    ca_cert: &rcgen::Certificate,
    ca_key: &rcgen::KeyPair,
    cn: &str,
    ou: Option<&str>,
    names: Vec<String>,
    client: bool,
) -> Issued {
    let mut params = rcgen::CertificateParams::new(names).unwrap();
    params.not_before = rcgen::date_time_ymd(2024, 1, 1);
    params.not_after = rcgen::date_time_ymd(2032, 1, 1);
    params.distinguished_name = rcgen::DistinguishedName::new();
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, cn);
    if let Some(ou) = ou {
        params
            .distinguished_name
            .push(rcgen::DnType::OrganizationalUnitName, ou);
    }
    params.key_usages = vec![rcgen::KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![if client {
        rcgen::ExtendedKeyUsagePurpose::ClientAuth
    } else {
        rcgen::ExtendedKeyUsagePurpose::ServerAuth
    }];
    let key = rcgen::KeyPair::generate().unwrap();
    let cert = params.signed_by(&key, ca_cert, ca_key).unwrap();
    Issued {
        cert_pem: cert.pem(),
        key_pem: key.serialize_pem(),
    }
}

fn ca_pair() -> (rcgen::Certificate, rcgen::KeyPair, String) {
    let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    params.key_usages = vec![
        rcgen::KeyUsagePurpose::KeyCertSign,
        rcgen::KeyUsagePurpose::CrlSign,
    ];
    params.not_before = rcgen::date_time_ymd(2024, 1, 1);
    params.not_after = rcgen::date_time_ymd(2032, 1, 1);
    params.distinguished_name = rcgen::DistinguishedName::new();
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "test-ca");
    let key = rcgen::KeyPair::generate().unwrap();
    let cert = params.self_signed(&key).unwrap();
    let pem = cert.pem();
    (cert, key, pem)
}

fn pem_certs(pem: &str) -> Vec<CertificateDer<'static>> {
    rustls_pemfile::certs(&mut Cursor::new(pem.as_bytes()))
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

fn pem_key(pem: &str) -> PrivateKeyDer<'static> {
    rustls_pemfile::private_key(&mut Cursor::new(pem.as_bytes()))
        .unwrap()
        .unwrap()
}

static TLS13_ONLY: &[&rustls::SupportedProtocolVersion] = &[&rustls::version::TLS13];
static TLS12_ONLY: &[&rustls::SupportedProtocolVersion] = &[&rustls::version::TLS12];

fn client_config(ca_pem: &str, identity: Option<&Issued>) -> ClientConfig {
    client_config_with(ca_pem, identity, TLS13_ONLY)
}

fn client_config_with(
    ca_pem: &str,
    identity: Option<&Issued>,
    versions: &'static [&'static rustls::SupportedProtocolVersion],
) -> ClientConfig {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut roots = RootCertStore::empty();
    for cert in pem_certs(ca_pem) {
        roots.add(cert).unwrap();
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(versions)
        .unwrap()
        .with_root_certificates(roots);
    match identity {
        Some(issued) => builder
            .with_client_auth_cert(pem_certs(&issued.cert_pem), pem_key(&issued.key_pem))
            .unwrap(),
        None => builder.with_no_client_auth(),
    }
}

async fn tls_exchange(addr: SocketAddr, config: ClientConfig, request: &str) -> HttpResp {
    let connector = TlsConnector::from(Arc::new(config));
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.bind(SocketAddr::new(addr.ip(), 0)).unwrap();
    let tcp = socket.connect(addr).await.unwrap();
    let name = ServerName::try_from("127.0.0.2").unwrap();
    let mut stream = connector.connect(name, tcp).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    read_http(&mut stream).await
}

#[tokio::test]
async fn https_device_cert_matrix() {
    let dir = scratch("tls");
    let (ca_cert, ca_key, ca_pem) = ca_pair();
    let node = issue(
        &ca_cert,
        &ca_key,
        "node-test",
        None,
        vec!["127.0.0.1".to_string(), "127.0.0.2".to_string()],
        false,
    );
    let device = issue(
        &ca_cert,
        &ca_key,
        "device:pixel",
        Some("client"),
        vec!["pixel.local".to_string()],
        true,
    );
    let (other_cert, other_key, _) = ca_pair();
    let wrong = issue(
        &other_cert,
        &other_key,
        "device:other",
        Some("client"),
        vec!["other.local".to_string()],
        true,
    );
    let cert_path = dir.join("node.pem");
    let key_path = dir.join("node.key");
    let ca_path = dir.join("ca.pem");
    std::fs::write(&cert_path, &node.cert_pem).unwrap();
    std::fs::write(&key_path, &node.key_pem).unwrap();
    std::fs::write(&ca_path, &ca_pem).unwrap();

    let mut env = isolated(&dir);
    env.insert("RIVETOS_DEN_HOST".to_string(), "127.0.0.2".to_string());
    env.insert(
        "RIVETOS_DEN_TLS_CERT".to_string(),
        cert_path.to_string_lossy().into_owned(),
    );
    env.insert(
        "RIVETOS_DEN_TLS_KEY".to_string(),
        key_path.to_string_lossy().into_owned(),
    );
    env.insert(
        "RIVETOS_DEN_TLS_CA".to_string(),
        ca_path.to_string_lossy().into_owned(),
    );
    let running = boot(env).await;
    let addr = running.addr();
    let host = format!("127.0.0.2:{}", addr.port());
    let health = tls_exchange(
        addr,
        client_config(&ca_pem, Some(&device)),
        &request("GET", "/healthz", &host, "", ""),
    )
    .await;
    assert_eq!(health.status, 200);

    let html = tls_exchange(
        addr,
        client_config(&ca_pem, None),
        &request("GET", "/", &host, "Accept: text/html\r\n", ""),
    )
    .await;
    assert_eq!(html.status, 401);
    assert_eq!(
        String::from_utf8_lossy(&html.body).as_ref(),
        fixture("html")
    );
    assert!(html.head.contains("text/html; charset=utf-8"));

    let json = tls_exchange(
        addr,
        client_config(&ca_pem, None),
        &request("GET", "/sessions", &host, "", ""),
    )
    .await;
    assert_eq!(json.status, 401);
    body_eq(&json.body, "unauthorized");

    let forged = tls_exchange(
        addr,
        client_config(&ca_pem, Some(&wrong)),
        &request(
            "GET",
            "/sessions",
            &host,
            "Accept: application/json\r\n",
            "",
        ),
    )
    .await;
    assert_eq!(forged.status, 401);

    running.shutdown().await;

    let mut relaxed = isolated(&dir);
    relaxed.insert("RIVETOS_DEN_HOST".to_string(), "127.0.0.2".to_string());
    relaxed.insert(
        "RIVETOS_DEN_TLS_CERT".to_string(),
        cert_path.to_string_lossy().into_owned(),
    );
    relaxed.insert(
        "RIVETOS_DEN_TLS_KEY".to_string(),
        key_path.to_string_lossy().into_owned(),
    );
    relaxed.insert(
        "RIVETOS_DEN_TLS_CA".to_string(),
        ca_path.to_string_lossy().into_owned(),
    );
    relaxed.insert(
        "RIVETOS_DEN_TLS_REQUIRE_CLIENT".to_string(),
        "off".to_string(),
    );
    let running = boot(relaxed).await;
    let open = tls_exchange(
        running.addr(),
        client_config(&ca_pem, None),
        &request(
            "GET",
            "/healthz",
            &format!("127.0.0.2:{}", running.addr().port()),
            "",
            "",
        ),
    )
    .await;
    assert_eq!(open.status, 200);
    running.shutdown().await;

    let mut loopback = isolated(&dir);
    loopback.insert(
        "RIVETOS_DEN_TLS_CERT".to_string(),
        cert_path.to_string_lossy().into_owned(),
    );
    loopback.insert(
        "RIVETOS_DEN_TLS_KEY".to_string(),
        key_path.to_string_lossy().into_owned(),
    );
    loopback.insert(
        "RIVETOS_DEN_TLS_CA".to_string(),
        ca_path.to_string_lossy().into_owned(),
    );
    let running = boot(loopback).await;
    let connector = TlsConnector::from(Arc::new(client_config(&ca_pem, None)));
    let tcp = TcpStream::connect(running.addr()).await.unwrap();
    let name = ServerName::try_from("127.0.0.1").unwrap();
    let mut stream = connector.connect(name, tcp).await.unwrap();
    let host = format!("127.0.0.1:{}", running.addr().port());
    stream
        .write_all(request("GET", "/healthz", &host, "", "").as_bytes())
        .await
        .unwrap();
    let resp = read_http(&mut stream).await;
    assert_eq!(resp.status, 200);
    running.shutdown().await;
}

#[tokio::test]
async fn missing_tls_files_fail_verbatim() {
    let dir = scratch("missing-tls");
    let mut env = isolated(&dir);
    env.insert("RIVETOS_DEN_HOST".to_string(), "127.0.0.1".to_string());
    env.insert(
        "RIVETOS_DEN_TLS_CERT".to_string(),
        dir.join("missing-cert.pem").to_string_lossy().into_owned(),
    );
    env.insert(
        "RIVETOS_DEN_TLS_KEY".to_string(),
        dir.join("missing-key.pem").to_string_lossy().into_owned(),
    );
    let Err(err) = serve(GatewayConfig::from_env(&env)).await else {
        panic!("expected missing cert");
    };
    let message = err.to_string();
    assert!(message.contains("ENOENT: no such file or directory, open '"));
    assert!(message.contains("missing-cert.pem"));

    let (ca_cert, ca_key, _) = ca_pair();
    let node = issue(
        &ca_cert,
        &ca_key,
        "node-test",
        None,
        vec!["127.0.0.1".to_string()],
        false,
    );
    let cert_path = dir.join("node.pem");
    let key_path = dir.join("node.key");
    std::fs::write(&cert_path, node.cert_pem).unwrap();
    std::fs::write(&key_path, node.key_pem).unwrap();
    let mut env = isolated(&dir);
    env.insert(
        "RIVETOS_DEN_TLS_CERT".to_string(),
        cert_path.to_string_lossy().into_owned(),
    );
    env.insert(
        "RIVETOS_DEN_TLS_KEY".to_string(),
        key_path.to_string_lossy().into_owned(),
    );
    env.insert(
        "RIVETOS_DEN_TLS_CA".to_string(),
        dir.join("missing-ca.pem").to_string_lossy().into_owned(),
    );
    let Err(err) = serve(GatewayConfig::from_env(&env)).await else {
        panic!("expected missing ca");
    };
    assert!(err.to_string().contains("TLS CA chain missing at"));
}

#[tokio::test]
async fn rejected_origin_omits_cors_headers() {
    let dir = scratch("origin-deny");
    let running = boot(isolated(&dir)).await;
    let addr = running.addr();
    let host = format!("127.0.0.1:{}", addr.port());
    let allowed = exchange(addr, &request("GET", "/healthz", &host, "", "")).await;
    assert_eq!(allowed.status, 200);
    assert!(allowed.head.contains("Access-Control-Allow-Methods"));

    let origin = "Origin: https://evil.example\r\n";
    let denied = exchange(addr, &request("GET", "/sessions", &host, origin, "")).await;
    assert_eq!(denied.status, 403);
    assert!(!denied.head.contains("Access-Control-Allow-Methods"));
    assert!(!denied.head.contains("Access-Control-Allow-Headers"));
    body_eq(&denied.body, "forbidden-origin");

    let options = exchange(
        addr,
        &request("OPTIONS", "/api/events/sessions", &host, origin, ""),
    )
    .await;
    assert_eq!(options.status, 403);
    assert!(!options.head.contains("Access-Control-Allow-Methods"));
    body_eq(&options.body, "forbidden-origin");

    let evil_host = exchange(addr, &request("GET", "/sessions", "evil.example", "", "")).await;
    assert_eq!(evil_host.status, 403);
    assert!(!evil_host.head.contains("Access-Control-Allow-Methods"));
    body_eq(&evil_host.body, "forbidden-origin");

    let empty_host = exchange(addr, "GET /sessions HTTP/1.1\r\nHost: \r\n\r\n").await;
    assert_eq!(empty_host.status, 403);
    assert!(!empty_host.head.contains("Access-Control-Allow-Methods"));

    let http10 = exchange(addr, "GET /healthz HTTP/1.0\r\n\r\n").await;
    assert_eq!(http10.status, 403);
    assert!(http10.head.starts_with("HTTP/1.1 403 "));
    assert!(http10.head.contains("Content-Type: application/json"));
    assert!(http10.head.contains("Connection: close"));
    assert!(!http10.head.contains("Access-Control-Allow-Methods"));
    assert!(!http10.head.contains("Keep-Alive"));
    assert!(!http10.head.contains("Transfer-Encoding"));
    running.shutdown().await;
}

#[tokio::test]
async fn hashed_asset_cache_control() {
    let dir = scratch("hashed");
    let static_dir = dir.join("static");
    std::fs::create_dir_all(static_dir.join("assets")).unwrap();
    std::fs::write(
        static_dir.join("assets").join("app-abcdef12.js"),
        "console.log(\"hashed asset app-abcdef12\")\n",
    )
    .unwrap();
    std::fs::write(
        static_dir.join("assets").join("app-abcdef123.js"),
        "console.log(\"nine\")\n",
    )
    .unwrap();
    std::fs::write(
        static_dir.join("assets").join("plain.js"),
        "console.log(1)\n",
    )
    .unwrap();
    let mut env = isolated(&dir);
    env.insert(
        "RIVETOS_DEN_STATIC_DIR".to_string(),
        static_dir.to_string_lossy().into_owned(),
    );
    let running = boot(env).await;
    let addr = running.addr();
    let host = format!("127.0.0.1:{}", addr.port());
    let hashed = exchange(
        addr,
        &request("GET", "/assets/app-abcdef12.js", &host, "", ""),
    )
    .await;
    assert_eq!(hashed.status, 200);
    assert!(
        hashed
            .head
            .contains("Cache-Control: public, max-age=31536000, immutable")
    );
    assert_eq!(
        String::from_utf8_lossy(&hashed.body).as_ref(),
        "console.log(\"hashed asset app-abcdef12\")\n"
    );
    let nine = exchange(
        addr,
        &request("GET", "/assets/app-abcdef123.js", &host, "", ""),
    )
    .await;
    assert_eq!(nine.status, 200);
    assert!(nine.head.contains("Cache-Control: no-cache"));
    let plain = exchange(addr, &request("GET", "/assets/plain.js", &host, "", "")).await;
    assert_eq!(plain.status, 200);
    assert!(plain.head.contains("Cache-Control: no-cache"));
    running.shutdown().await;
}

#[tokio::test]
async fn mesh_shape_errors_are_500() {
    let dir = scratch("mesh-http");
    let mesh = dir.join("mesh.json");
    std::fs::write(&mesh, "[]\n").unwrap();
    let mut env = isolated(&dir);
    env.insert(
        "RIVETOS_DEN_MESH_FILE".to_string(),
        mesh.to_string_lossy().into_owned(),
    );
    env.insert("RIVETOS_DEN_MESH_CACHE_MS".to_string(), "0".to_string());
    let running = boot(env).await;
    let addr = running.addr();
    let host = format!("127.0.0.1:{}", addr.port());
    let root = exchange(addr, &request("GET", "/mesh.json", &host, "", "")).await;
    assert_eq!(root.status, 500);
    assert_eq!(
        String::from_utf8_lossy(&root.body).as_ref(),
        "{\"error\":\"mesh.json parse failed\",\"code\":\"MESH_INVALID_SHAPE\"}"
    );
    std::fs::write(&mesh, "{\"nodes\":[]}\n").unwrap();
    let flat = exchange(addr, &request("GET", "/mesh.json", &host, "", "")).await;
    assert_eq!(flat.status, 500);
    assert_eq!(
        String::from_utf8_lossy(&flat.body).as_ref(),
        "{\"error\":\"mesh.json parse failed\",\"code\":\"MESH_FLAT_ARRAY\"}"
    );
    std::fs::write(&mesh, "{\"nodes\":5}\n").unwrap();
    let number = exchange(addr, &request("GET", "/mesh.json", &host, "", "")).await;
    assert_eq!(number.status, 500);
    assert_eq!(
        String::from_utf8_lossy(&number.body).as_ref(),
        "{\"error\":\"mesh.json parse failed\",\"code\":\"MESH_INVALID_SHAPE\"}"
    );
    running.shutdown().await;
}

#[tokio::test]
async fn non_owner_phone_pairing_is_403() {
    let _guard = token_lock().await;
    identity::clear_user_tokens();
    let dir = scratch("phone-owner");
    let users = dir.join("users.json");
    std::fs::write(
        &users,
        r#"{"ownerUserId":"alice","unmappedIsOwner":false,"users":{"alice":{"devices":[],"pgUrl":"postgres://alice@db/alice"},"coco":{"devices":["win-coco"],"pgUrl":"postgres://coco@db/coco"}}}"#,
    )
    .unwrap();
    let mut env = isolated(&dir);
    env.insert(
        "RIVETOS_USERS_FILE".to_string(),
        users.to_string_lossy().into_owned(),
    );
    let running = boot(env).await;
    let addr = running.addr();
    let host = format!("127.0.0.1:{}", addr.port());
    let owner = exchange(addr, &request("GET", "/api/phone-pairing", &host, "", "")).await;
    assert_eq!(owner.status, 200);
    body_eq(&owner.body, "phone-missing");
    let token = identity::mint_user_token("coco").unwrap();
    let extra = format!("x-rivetos-user-token: {token}\r\n");
    let denied = exchange(
        addr,
        &request("GET", "/api/phone-pairing", &host, &extra, ""),
    )
    .await;
    assert_eq!(denied.status, 403);
    assert_eq!(
        String::from_utf8_lossy(&denied.body).as_ref(),
        "{\"error\":\"only the owner can pair a phone\"}"
    );
    let methods = denied
        .head
        .to_ascii_lowercase()
        .find("access-control-allow-methods")
        .unwrap();
    let content_type = denied
        .head
        .to_ascii_lowercase()
        .find("content-type")
        .unwrap();
    assert!(methods < content_type);
    let posted = exchange(
        addr,
        &request("POST", "/api/phone-pairing", &host, &extra, "{}"),
    )
    .await;
    assert_eq!(posted.status, 403);
    running.shutdown().await;
}

#[tokio::test]
async fn post_healthz_keeps_the_connection() {
    let dir = scratch("healthz-post");
    let running = boot(isolated(&dir)).await;
    let addr = running.addr();
    let host = format!("127.0.0.1:{}", addr.port());
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let first = request("POST", "/healthz", &host, "", r#"{"v":1}"#);
    stream.write_all(first.as_bytes()).await.unwrap();
    let resp = read_http(&mut stream).await;
    assert_eq!(resp.status, 200);
    assert!(resp.head.contains("Connection: keep-alive"));
    let second = request("GET", "/healthz", &host, "", "");
    stream.write_all(second.as_bytes()).await.unwrap();
    let again = read_http(&mut stream).await;
    assert_eq!(again.status, 200);
    running.shutdown().await;
}

#[tokio::test]
async fn shutdown_sends_empty_websocket_close() {
    let dir = scratch("ws-close");
    let running = boot(isolated(&dir)).await;
    let addr = running.addr();
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let key = "dGhlIHNhbXBsZSBub25jZQ==";
    let upgrade = format!(
        "GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n",
        addr.port()
    );
    stream.write_all(upgrade.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    let mut tmp = [0_u8; 4096];
    let end = loop {
        let read = stream.read(&mut tmp).await.unwrap();
        assert!(read > 0);
        buf.extend_from_slice(&tmp[..read]);
        if let Some(end) = header_end(&buf) {
            break end;
        }
    };
    let head = String::from_utf8_lossy(&buf[..end]);
    assert!(head.starts_with("HTTP/1.1 101"));
    assert!(head.contains("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo="));
    assert!(!head.contains("Sec-Websocket-Accept"));
    let mut pending = buf[end..].to_vec();
    let frame = read_frame(&mut stream, &mut pending).await;
    assert_eq!(frame.0 & 0x0f, 0x1);
    let shut = tokio::spawn(async move {
        running.shutdown().await;
    });
    let frame = read_frame(&mut stream, &mut pending).await;
    assert_eq!(frame.0 & 0x0f, 0x8);
    assert!(frame.1.is_empty());
    shut.await.unwrap();
}

fn assert_error_line(err: &crate::listen::ServeError) {
    let dump = err.node_stderr();
    assert_eq!(dump, format!("Error: {err}\n"));
    assert_eq!(dump.matches('\n').count(), 1);
    assert!(!dump.contains("    at "));
    assert!(!dump.contains("Node.js"));
    assert!(!dump.contains("file://"));
    assert!(!dump.contains("throw "));
}

#[tokio::test]
async fn startup_refusals_match_node_stderr() {
    let dir = scratch("startup-dump");
    let mut env = isolated(&dir);
    env.insert("RIVETOS_DEN_HOST".to_string(), "0.0.0.0".to_string());
    let Err(err) = serve(GatewayConfig::from_env(&env)).await else {
        panic!("bind refusal");
    };
    assert_error_line(&err);
    assert!(err.to_string().contains("refusing to bind 0.0.0.0"));

    let mut env = isolated(&dir);
    env.insert("RIVETOS_DEN_HOST".to_string(), String::new());
    let Err(err) = serve(GatewayConfig::from_env(&env)).await else {
        panic!("empty host");
    };
    assert_error_line(&err);
    assert!(err.to_string().contains("refusing to bind :"));

    std::fs::write(dir.join("cert.pem"), b"cert").unwrap();
    std::fs::write(dir.join("key.pem"), b"key").unwrap();
    let mut env = isolated(&dir);
    env.insert("RIVETOS_DEN_HOST".to_string(), "0.0.0.0".to_string());
    env.insert(
        "RIVETOS_DEN_TLS_CERT".to_string(),
        dir.join("cert.pem").to_string_lossy().into_owned(),
    );
    env.insert(
        "RIVETOS_DEN_TLS_KEY".to_string(),
        dir.join("key.pem").to_string_lossy().into_owned(),
    );
    let Err(err) = serve(GatewayConfig::from_env(&env)).await else {
        panic!("missing ca");
    };
    assert_error_line(&err);
    assert!(err.to_string().contains("TLS CA chain missing"));
    assert!(!err.node_stderr().contains("SECURITY"));

    let mut env = isolated(&dir);
    env.insert("RIVETOS_DEN_HOST".to_string(), "0.0.0.0".to_string());
    let missing = dir.join("no-such-cert.pem");
    env.insert(
        "RIVETOS_DEN_TLS_CERT".to_string(),
        missing.to_string_lossy().into_owned(),
    );
    env.insert(
        "RIVETOS_DEN_TLS_KEY".to_string(),
        dir.join("key.pem").to_string_lossy().into_owned(),
    );
    let Err(err) = serve(GatewayConfig::from_env(&env)).await else {
        panic!("missing cert");
    };
    assert_error_line(&err);
    assert_eq!(
        err.to_string(),
        format!(
            "ENOENT: no such file or directory, open '{}'",
            missing.to_string_lossy()
        )
    );

    let held = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = held.local_addr().unwrap().port();
    let mut env = isolated(&dir);
    env.insert("RIVETOS_DEN_HOST".to_string(), "127.0.0.1".to_string());
    env.insert("RIVETOS_DEN_PORT".to_string(), port.to_string());
    let Err(err) = serve(GatewayConfig::from_env(&env)).await else {
        panic!("port in use");
    };
    assert_error_line(&err);
    assert_eq!(
        err.to_string(),
        format!("listen EADDRINUSE: address already in use 127.0.0.1:{port}")
    );
    drop(held);
}

#[tokio::test]
async fn localhost_listen_uses_addrconfig() {
    let dir = scratch("localhost");
    let mut env = isolated(&dir);
    env.insert("RIVETOS_DEN_HOST".to_string(), "localhost".to_string());
    let running = boot(env).await;
    assert!(
        running
            .listen_line
            .starts_with("[den-server] listening on localhost:")
    );
    assert!(running.addr().ip().is_loopback());
    running.shutdown().await;

    let mut env = isolated(&dir);
    env.insert("RIVETOS_DEN_HOST".to_string(), "127.0.0.1".to_string());
    let running = boot(env).await;
    assert_eq!(running.addr().ip().to_string(), "127.0.0.1");
    assert!(
        running
            .listen_line
            .starts_with("[den-server] listening on 127.0.0.1:")
    );
    running.shutdown().await;

    let mut env = isolated(&dir);
    env.insert("RIVETOS_DEN_HOST".to_string(), "::1".to_string());
    let running = boot(env).await;
    assert_eq!(running.addr().ip().to_string(), "::1");
    assert!(
        running
            .listen_line
            .starts_with("[den-server] listening on ::1:")
    );
    running.shutdown().await;
}

fn masked_frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mask = [9_u8, 8, 7, 6];
    let mut frame = vec![0x80 | opcode, 0x80 | u8::try_from(payload.len()).unwrap()];
    frame.extend_from_slice(&mask);
    for (index, byte) in payload.iter().enumerate() {
        frame.push(byte ^ mask[index % 4]);
    }
    frame
}

fn mesh_doc(nodes: &[(&str, &str)]) -> String {
    let mut body = String::from("{\"version\":1,\"updatedAt\":1,\"nodes\":{");
    for (index, (id, url)) in nodes.iter().enumerate() {
        if index > 0 {
            body.push(',');
        }
        body.push_str(&format!(
            "\"{id}\":{{\"id\":\"{id}\",\"metadata\":{{\"denUrl\":\"{url}\"}}}}"
        ));
    }
    body.push_str("}}");
    body
}

async fn hold_listener(listener: tokio::net::TcpListener, accepts: Arc<AtomicUsize>) {
    let mut held = Vec::new();
    loop {
        let Ok((sock, _)) = listener.accept().await else {
            return;
        };
        accepts.fetch_add(1, Ordering::SeqCst);
        held.push(sock);
    }
}

#[tokio::test]
async fn body_limits_run_after_origin_and_auth() {
    let dir = scratch("body-order");
    let static_dir = dir.join("static");
    std::fs::create_dir_all(&static_dir).unwrap();
    std::fs::write(static_dir.join("index.html"), "index\n").unwrap();
    let mut env = isolated(&dir);
    env.insert(
        "RIVETOS_DEN_STATIC_DIR".to_string(),
        static_dir.to_string_lossy().into_owned(),
    );
    let running = boot(env).await;
    let addr = running.addr();
    let host = format!("127.0.0.1:{}", addr.port());
    let evil = format!(
        "POST /event HTTP/1.1\r\nHost: {host}\r\nOrigin: https://evil.example\r\nContent-Length: 300000\r\n\r\n"
    );
    let denied = exchange(addr, &evil).await;
    assert_eq!(denied.status, 403);
    body_eq(&denied.body, "forbidden-origin");
    let health =
        format!("POST /healthz HTTP/1.1\r\nHost: {host}\r\nContent-Length: 300000\r\n\r\n");
    let ok = exchange(addr, &health).await;
    assert_eq!(ok.status, 200);
    assert!(
        ok.head
            .to_ascii_lowercase()
            .contains("transfer-encoding: chunked")
    );
    running.shutdown().await;

    let (ca_cert, ca_key, ca_pem) = ca_pair();
    let node = issue(
        &ca_cert,
        &ca_key,
        "node-test",
        None,
        vec!["127.0.0.2".to_string()],
        false,
    );
    let cert_path = dir.join("node.pem");
    let key_path = dir.join("node.key");
    let ca_path = dir.join("ca.pem");
    std::fs::write(&cert_path, &node.cert_pem).unwrap();
    std::fs::write(&key_path, &node.key_pem).unwrap();
    std::fs::write(&ca_path, &ca_pem).unwrap();
    let material = crate::tls::load_server(
        &std::fs::read(&cert_path).unwrap(),
        &std::fs::read(&key_path).unwrap(),
        &std::fs::read(&ca_path).unwrap(),
        true,
    )
    .unwrap();
    assert!(material.root_hint_count() > 0);
    let mut tls_env = isolated(&dir);
    tls_env.insert("RIVETOS_DEN_HOST".to_string(), "127.0.0.2".to_string());
    tls_env.insert(
        "RIVETOS_DEN_TLS_CERT".to_string(),
        cert_path.to_string_lossy().into_owned(),
    );
    tls_env.insert(
        "RIVETOS_DEN_TLS_KEY".to_string(),
        key_path.to_string_lossy().into_owned(),
    );
    tls_env.insert(
        "RIVETOS_DEN_TLS_CA".to_string(),
        ca_path.to_string_lossy().into_owned(),
    );
    let running = boot(tls_env).await;
    let addr = running.addr();
    let host = format!("127.0.0.2:{}", addr.port());
    let huge = format!("POST /event HTTP/1.1\r\nHost: {host}\r\nContent-Length: 300000\r\n\r\n");
    let unauth = tls_exchange(addr, client_config(&ca_pem, None), &huge).await;
    assert_eq!(unauth.status, 401);
    body_eq(&unauth.body, "unauthorized");
    let connector = TlsConnector::from(Arc::new(client_config(&ca_pem, None)));
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.bind(SocketAddr::new(addr.ip(), 0)).unwrap();
    let tcp = socket.connect(addr).await.unwrap();
    let mut stream = connector
        .connect(ServerName::try_from("127.0.0.2").unwrap(), tcp)
        .await
        .unwrap();
    let enroll = request("POST", "/api/devices/enroll", &host, "", "{}");
    stream.write_all(enroll.as_bytes()).await.unwrap();
    let first = read_http(&mut stream).await;
    assert_eq!(first.status, 401);
    body_eq(&first.body, "unauthorized");
    assert!(first.head.contains("Connection: keep-alive"));
    let event = request(
        "POST",
        "/event",
        &host,
        "Accept: text/html\r\n",
        r#"{"v":1,"session":"x","type":"turn.end"}"#,
    );
    stream.write_all(event.as_bytes()).await.unwrap();
    let second = read_http(&mut stream).await;
    assert_eq!(second.status, 401);
    body_eq(&second.body, "unauthorized");
    let tls12 = tls_exchange(
        addr,
        client_config_with(&ca_pem, None, TLS12_ONLY),
        &request("GET", "/healthz", &host, "", ""),
    )
    .await;
    assert_eq!(tls12.status, 200);
    running.shutdown().await;
}

#[tokio::test]
async fn ambiguous_framing_follows_hyper() {
    let dir = scratch("framing");
    let running = boot(isolated(&dir)).await;
    let addr = running.addr();
    let host = format!("127.0.0.1:{}", addr.port());
    let event = r#"{"v":1,"session":"s1","name":"alpha","ts":100,"type":"session.start","title":"hello","harness":"claude-code"}"#;
    let same = format!(
        "POST /event HTTP/1.1\r\nHost: {host}\r\nContent-Length: {len}\r\nContent-Length: {len}\r\n\r\n{event}",
        len = event.len()
    );
    let ok = exchange(addr, &same).await;
    assert_eq!(ok.status, 200);
    let differ = format!(
        "POST /event HTTP/1.1\r\nHost: {host}\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nab"
    );
    let bad = exchange(addr, &differ).await;
    assert_eq!(bad.status, 400);
    assert_eq!(
        bad.head,
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"
    );
    assert!(content_length(&bad.head).is_none());
    assert!(!bad.head.to_ascii_lowercase().contains("transfer-encoding"));
    let smuggle = format!(
        "POST /event HTTP/1.1\r\nHost: {host}\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n[]\r\n0\r\n\r\n"
    );
    let mixed = exchange(addr, &smuggle).await;
    assert_eq!(mixed.status, 422);
    assert!(
        mixed
            .head
            .to_ascii_lowercase()
            .contains("transfer-encoding: chunked")
    );
    assert!(String::from_utf8_lossy(&mixed.body).contains("not a valid"));
    running.shutdown().await;
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn header_and_idle_deadlines_close() {
    let dir = scratch("deadlines");
    let running = boot(isolated(&dir)).await;
    let addr = running.addr();
    let mut silent = TcpStream::connect(addr).await.unwrap();
    tokio::time::sleep(Duration::from_secs(61)).await;
    tokio::time::resume();
    let mut tmp = [0_u8; 32];
    let n = tokio::time::timeout(Duration::from_secs(2), silent.read(&mut tmp))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(n, 0);
    let host = format!("127.0.0.1:{}", addr.port());
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream
        .write_all(request("GET", "/healthz", &host, "", "").as_bytes())
        .await
        .unwrap();
    let resp = read_http(&mut stream).await;
    assert_eq!(resp.status, 200);
    stream
        .write_all(request("GET", "/healthz", &host, "", "").as_bytes())
        .await
        .unwrap();
    let again = read_http(&mut stream).await;
    assert_eq!(again.status, 200);
    tokio::time::pause();
    tokio::time::sleep(Duration::from_secs(6)).await;
    tokio::time::resume();
    let n = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut tmp))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(n, 0);
    running.shutdown().await;
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn websocket_data_and_ping_do_not_count_as_pong() {
    let dir = scratch("pong-data");
    let running = boot(isolated(&dir)).await;
    let addr = running.addr();
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let key = "dGhlIHNhbXBsZSBub25jZQ==";
    let upgrade = format!(
        "GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n",
        addr.port()
    );
    stream.write_all(upgrade.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    let mut tmp = [0_u8; 4096];
    let end = loop {
        let read = stream.read(&mut tmp).await.unwrap();
        assert!(read > 0);
        buf.extend_from_slice(&tmp[..read]);
        if let Some(end) = header_end(&buf) {
            break end;
        }
    };
    assert!(buf[..end].starts_with(b"HTTP/1.1 101"));
    let head = String::from_utf8_lossy(&buf[..end]);
    assert!(head.contains("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo="));
    assert!(!head.contains("Sec-Websocket-Accept"));
    let mut pending = buf[end..].to_vec();
    let frame = read_frame(&mut stream, &mut pending).await;
    assert_eq!(frame.0 & 0x0f, 0x1);
    tokio::time::sleep(Duration::from_secs(31)).await;
    stream.write_all(&masked_frame(0x1, b"hi")).await.unwrap();
    stream.write_all(&masked_frame(0x9, b"")).await.unwrap();
    tokio::time::sleep(Duration::from_secs(31)).await;
    tokio::time::resume();
    let mut opcodes = Vec::new();
    let saw_eof = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if pending.len() >= 2 {
                let opcode = pending[0];
                let len_byte = pending[1] & 0x7f;
                let header = if len_byte == 126 {
                    4
                } else if len_byte == 127 {
                    10
                } else {
                    2
                };
                if pending.len() >= header {
                    let len = if len_byte == 126 {
                        u16::from_be_bytes([pending[2], pending[3]]) as usize
                    } else if len_byte == 127 {
                        u64::from_be_bytes(pending[2..10].try_into().unwrap()) as usize
                    } else {
                        usize::from(len_byte)
                    };
                    if pending.len() >= header + len {
                        opcodes.push(opcode & 0x0f);
                        pending.drain(..header + len);
                        continue;
                    }
                }
            }
            match stream.read(&mut tmp).await {
                Ok(0) | Err(_) => return true,
                Ok(n) => pending.extend_from_slice(&tmp[..n]),
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(saw_eof);
    assert!(!opcodes.contains(&0x8));
    running.shutdown().await;
}

#[tokio::test]
async fn fanout_stops_at_one_mib_before_enqueue() {
    let dir = scratch("ws-cap");
    let event = r#"{"v":1,"session":"s1","type":"thinking.delta","text":"hello","ts":1}"#;
    let hub = Hub::open(dir.join("owners.json").to_string_lossy().into_owned(), 0);
    let buffered = Arc::new(AtomicU64::new(MAX_BUFFERED));
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    hub.subscribe(None, None, tx, buffered.clone());
    hub.ingest_text(false, event).unwrap();
    assert!(matches!(rx.recv().await.unwrap(), Fanout::Shutdown));
    assert!(rx.recv().await.is_none());
    assert_eq!(buffered.load(Ordering::Relaxed), MAX_BUFFERED);

    let hub = Hub::open(dir.join("owners-2.json").to_string_lossy().into_owned(), 0);
    let buffered = Arc::new(AtomicU64::new(0));
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    hub.subscribe(None, None, tx, buffered.clone());
    hub.ingest_text(false, event).unwrap();
    let Fanout::Text(frame) = rx.recv().await.unwrap() else {
        panic!("first frame");
    };
    assert!(frame.contains("thinking.delta"));
    buffered.store(MAX_BUFFERED.saturating_sub(1), Ordering::Relaxed);
    hub.ingest_text(false, event).unwrap();
    assert!(matches!(rx.recv().await.unwrap(), Fanout::Shutdown));
    assert_eq!(
        buffered.load(Ordering::Relaxed),
        MAX_BUFFERED.saturating_sub(1)
    );
}

#[tokio::test]
async fn snapshot_preserves_a_lone_surrogate() {
    let dir = scratch("surrogate");
    let hub = Hub::open(dir.join("owners.json").to_string_lossy().into_owned(), 0);
    let body =
        "{\"v\":1,\"session\":\"s1\",\"type\":\"session.start\",\"title\":\"a\\uD800b\",\"ts\":1}";
    hub.ingest_text(false, body).unwrap();
    let snap = hub.snapshot_json(None, None);
    assert!(snap.contains("\\ud800"), "{snap}");
    assert_ne!(snap, "{}");
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn roster_none_clears_peers_and_shape_errors_keep_them() {
    let dir = scratch("roster");
    let mesh = dir.join("mesh.json");
    std::fs::write(&mesh, mesh_doc(&[("tls", "https://tls.example:5174")])).unwrap();
    let mut env = isolated(&dir);
    env.insert(
        "RIVETOS_DEN_MESH_FILE".to_string(),
        mesh.to_string_lossy().into_owned(),
    );
    env.insert("RIVETOS_DEN_MESH_CACHE_MS".to_string(), "5000".to_string());
    let running = boot(env).await;
    let addr = running.addr();
    let host = format!("127.0.0.1:{}", addr.port());
    let origin = "Origin: https://tls.example:5174\r\n";
    let allowed = exchange(addr, &request("GET", "/healthz", &host, origin, "")).await;
    assert_eq!(allowed.status, 200);
    std::fs::write(&mesh, "{\"version\":1,\"updatedAt\":1,\"nodes\":1}\n").unwrap();
    tokio::time::sleep(Duration::from_secs(6)).await;
    let kept = exchange(addr, &request("GET", "/healthz", &host, origin, "")).await;
    assert_eq!(kept.status, 200);
    std::fs::remove_file(&mesh).unwrap();
    tokio::time::sleep(Duration::from_secs(6)).await;
    let cleared = exchange(addr, &request("GET", "/healthz", &host, origin, "")).await;
    assert_eq!(cleared.status, 403);
    body_eq(&cleared.body, "forbidden-origin");
    running.shutdown().await;
}

#[tokio::test]
async fn mesh_probes_are_parallel_and_single_flight() {
    let left = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let right = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let left_port = left.local_addr().unwrap().port();
    let right_port = right.local_addr().unwrap().port();
    let accepts = Arc::new(AtomicUsize::new(0));
    tokio::spawn(hold_listener(left, accepts.clone()));
    tokio::spawn(hold_listener(right, accepts.clone()));
    let dir = scratch("mesh-flight");
    let mesh = dir.join("mesh.json");
    let doc = mesh_doc(&[
        ("a", &format!("http://127.0.0.1:{left_port}")),
        ("b", &format!("http://127.0.0.1:{right_port}")),
    ]);
    std::fs::write(&mesh, &doc).unwrap();
    let mut env = isolated(&dir);
    env.insert(
        "RIVETOS_DEN_MESH_FILE".to_string(),
        mesh.to_string_lossy().into_owned(),
    );
    env.insert("RIVETOS_DEN_MESH_CACHE_MS".to_string(), "60000".to_string());
    let running = boot(env).await;
    let addr = running.addr();
    let host = format!("127.0.0.1:{}", addr.port());
    let req = request("GET", "/mesh.json", &host, "", "");
    let (one, two) = tokio::join!(exchange(addr, &req), exchange(addr, &req));
    assert_eq!(one.status, 200);
    assert_eq!(two.status, 200);
    assert_eq!(accepts.load(Ordering::SeqCst), 2);
    running.shutdown().await;

    let left = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let right = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let left_port = left.local_addr().unwrap().port();
    let right_port = right.local_addr().unwrap().port();
    let accepts = Arc::new(AtomicUsize::new(0));
    tokio::spawn(hold_listener(left, accepts.clone()));
    tokio::spawn(hold_listener(right, accepts.clone()));
    let dir = scratch("mesh-zero");
    let mesh = dir.join("mesh.json");
    std::fs::write(
        &mesh,
        mesh_doc(&[
            ("a", &format!("http://127.0.0.1:{left_port}")),
            ("b", &format!("http://127.0.0.1:{right_port}")),
        ]),
    )
    .unwrap();
    let mut env = isolated(&dir);
    env.insert(
        "RIVETOS_DEN_MESH_FILE".to_string(),
        mesh.to_string_lossy().into_owned(),
    );
    env.insert("RIVETOS_DEN_MESH_CACHE_MS".to_string(), "0".to_string());
    let running = boot(env).await;
    let addr = running.addr();
    let host = format!("127.0.0.1:{}", addr.port());
    let req = request("GET", "/mesh.json", &host, "", "");
    let (one, two) = tokio::join!(exchange(addr, &req), exchange(addr, &req));
    assert_eq!(one.status, 200);
    assert_eq!(two.status, 200);
    assert_eq!(accepts.load(Ordering::SeqCst), 4);
    running.shutdown().await;
}

#[tokio::test]
async fn https_mesh_probe_decodes_chunked_healthz() {
    let dir = scratch("mesh-https");
    let (ca_cert, ca_key, ca_pem) = ca_pair();
    let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    params.not_before = rcgen::date_time_ymd(2024, 1, 1);
    params.not_after = rcgen::date_time_ymd(2032, 1, 1);
    params.subject_alt_names = vec![rcgen::SanType::IpAddress(std::net::IpAddr::V4(
        std::net::Ipv4Addr::LOCALHOST,
    ))];
    params.key_usages = vec![rcgen::KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
    let key = rcgen::KeyPair::generate().unwrap();
    let cert = params.signed_by(&key, &ca_cert, &ca_key).unwrap();
    let issued = Issued {
        cert_pem: cert.pem(),
        key_pem: key.serialize_pem(),
    };
    let _ = rustls::crypto::ring::default_provider().install_default();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let server = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(pem_certs(&issued.cert_pem), pem_key(&issued.key_pem))
        .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(server));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = listener.accept().await else {
                return;
            };
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let Ok(mut tls) = acceptor.accept(sock).await else {
                    return;
                };
                let mut buf = Vec::new();
                let mut tmp = [0_u8; 1024];
                loop {
                    let Ok(n) = tls.read(&mut tmp).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                    if buf.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                let payload = "{\"ok\":true,\"sessions\":2}";
                let msg = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{payload}\r\n0\r\n\r\n",
                    payload.len()
                );
                let _ = tls.write_all(msg.as_bytes()).await;
                let _ = tls.shutdown().await;
            });
        }
    });
    let ca_path = dir.join("ca.pem");
    std::fs::write(&ca_path, &ca_pem).unwrap();
    let mesh = dir.join("mesh.json");
    std::fs::write(
        &mesh,
        mesh_doc(&[("peer", &format!("https://127.0.0.1:{port}"))]),
    )
    .unwrap();
    let mut env = isolated(&dir);
    env.insert(
        "RIVETOS_DEN_MESH_FILE".to_string(),
        mesh.to_string_lossy().into_owned(),
    );
    env.insert("RIVETOS_DEN_MESH_CACHE_MS".to_string(), "0".to_string());
    env.insert(
        "RIVETOS_DEN_TLS_CA".to_string(),
        ca_path.to_string_lossy().into_owned(),
    );
    let running = boot(env).await;
    let addr = running.addr();
    let host = format!("127.0.0.1:{}", addr.port());
    let resp = exchange(addr, &request("GET", "/mesh.json", &host, "", "")).await;
    assert_eq!(resp.status, 200);
    let json: serde_json::Value = serde_json::from_slice(&resp.body).unwrap();
    let node = &json["nodes"][0];
    assert_eq!(node["online"], true);
    assert_eq!(node["sessions"], 2);
    running.shutdown().await;
}

#[tokio::test]
async fn mounts_claim_prefixes_and_stamp_non_owners() {
    let _guard = token_lock().await;
    identity::clear_user_tokens();
    let dir = scratch("mounts");
    let users = dir.join("users.json");
    std::fs::write(
        &users,
        r#"{"ownerUserId":"alice","unmappedIsOwner":false,"users":{"alice":{"devices":[],"pgUrl":"postgres://alice@db/alice"},"coco":{"devices":["win-coco"],"pgUrl":"postgres://coco@db/coco"}}}"#,
    )
    .unwrap();
    let static_dir = dir.join("static");
    std::fs::create_dir_all(&static_dir).unwrap();
    std::fs::write(static_dir.join("index.html"), "spa-index\n").unwrap();
    let mut routes = GatewayRoutes::new();
    routes.mount("/wiki", |request: MountRequest| async move {
        let user = request
            .headers
            .iter()
            .find(|(name, _)| name == "x-rivetos-user")
            .map(|(_, value)| value.clone())
            .unwrap_or_default();
        let spoof = request
            .headers
            .iter()
            .any(|(_, value)| value == "alice-spoof");
        Reply::json(
            200,
            &format!("{{\"hit\":\"wiki\",\"user\":\"{user}\",\"spoof\":{spoof}}}"),
            &request.preset,
        )
    });
    routes.mount("/api/tasks", |request: MountRequest| async move {
        Reply::json(200, "{\"hit\":\"tasks\"}", &request.preset)
    });
    routes.mount("/api/tasks/item", |request: MountRequest| async move {
        Reply::json(200, "{\"hit\":\"item\"}", &request.preset)
    });
    let mut env = isolated(&dir);
    env.insert(
        "RIVETOS_USERS_FILE".to_string(),
        users.to_string_lossy().into_owned(),
    );
    env.insert(
        "RIVETOS_DEN_STATIC_DIR".to_string(),
        static_dir.to_string_lossy().into_owned(),
    );
    let running = serve_with(GatewayConfig::from_env(&env), routes)
        .await
        .unwrap();
    let addr = running.addr();
    let host = format!("127.0.0.1:{}", addr.port());
    let wiki = exchange(addr, &request("GET", "/wiki", &host, "", "")).await;
    assert_eq!(wiki.status, 200);
    assert!(String::from_utf8_lossy(&wiki.body).contains("\"hit\":\"wiki\""));
    assert!(!String::from_utf8_lossy(&wiki.body).contains("spa-index"));
    let item = exchange(addr, &request("GET", "/api/tasks/item/9", &host, "", "")).await;
    assert!(String::from_utf8_lossy(&item.body).contains("\"hit\":\"item\""));
    let tasks = exchange(addr, &request("GET", "/api/tasks/other", &host, "", "")).await;
    assert!(String::from_utf8_lossy(&tasks.body).contains("\"hit\":\"tasks\""));
    let other = exchange(addr, &request("GET", "/api/tasks-other", &host, "", "")).await;
    assert_eq!(other.status, 404);
    let index = exchange(addr, &request("GET", "/", &host, "", "")).await;
    assert!(String::from_utf8_lossy(&index.body).contains("spa-index"));
    let coco = identity::mint_user_token("coco").unwrap();
    let spoofed = format!("x-rivetos-user: alice-spoof\r\nx-rivetos-user-token: {coco}\r\n");
    let stamped = exchange(addr, &request("GET", "/wiki/page", &host, &spoofed, "")).await;
    let text = String::from_utf8_lossy(&stamped.body);
    assert!(text.contains("\"user\":\"coco\""), "{text}");
    assert!(text.contains("\"spoof\":false"), "{text}");
    let alice = identity::mint_user_token("alice").unwrap();
    let owner = format!("x-rivetos-user: alice-spoof\r\nx-rivetos-user-token: {alice}\r\n");
    let owner_hit = exchange(addr, &request("GET", "/wiki", &host, &owner, "")).await;
    let owner_body = String::from_utf8_lossy(&owner_hit.body);
    assert!(owner_body.contains("\"user\":\"\""), "{owner_body}");
    assert!(owner_body.contains("\"spoof\":false"), "{owner_body}");
    running.shutdown().await;
}
