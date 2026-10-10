use std::sync::{Arc, Mutex};
use std::time::Duration;

use mesh::{
    AgentChannel, AgentChannelConfig, MeshNode, PeerConfig, TlsMaterial,
    agent_channel_from_plugin_config,
};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn plain(agent: &str) -> AgentChannelConfig {
    let mut config = AgentChannelConfig::new(agent);
    config.port = 0;
    config.host = "127.0.0.1".to_string();
    config.secret = Some("test-secret-123".to_string());
    config
}

async fn started(agent: &str) -> AgentChannel {
    let channel = AgentChannel::new(plain(agent));
    channel.start().await.unwrap();
    channel
}

async fn exchange(
    port: u16,
    method: &str,
    path: &str,
    body: Option<&str>,
    headers: &[(&str, &str)],
) -> (u16, Value, reqwest::header::HeaderMap) {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let mut request = client.request(
        method.parse::<reqwest::Method>().unwrap(),
        format!("http://127.0.0.1:{port}{path}"),
    );
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    if let Some(body) = body {
        request = request
            .header("content-type", "application/json")
            .body(body.to_string());
    }
    let response = request.send().await.unwrap();
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let text = response.text().await.unwrap();
    let value = serde_json::from_str(&text).unwrap_or(Value::Null);
    (status, value, headers)
}

#[tokio::test]
async fn lifecycle_health_and_ids() {
    let channel = AgentChannel::new(plain("grok"));
    assert_eq!(channel.platform(), "agent");
    assert_eq!(channel.id(), "agent-grok");
    channel.start().await.unwrap();
    let port = channel.bound_port();
    assert!(port > 0);
    let (status, body, _) = exchange(port, "GET", "/health", None, &[]).await;
    assert_eq!(status, 200);
    assert_eq!(body["status"], json!("ok"));
    assert_eq!(body["agent"], json!("grok"));
    assert!(body["timestamp"].as_f64().unwrap() > 0.0);
    channel.stop().await;
    channel.start().await.unwrap();
    let again = channel.bound_port();
    let (status, _, _) = exchange(again, "GET", "/health", None, &[]).await;
    assert_eq!(status, 200);
    channel.stop().await;
}

#[tokio::test]
async fn message_path_has_no_application_auth() {
    let channel = started("opus").await;
    channel.on_message(|_| async { Ok(()) });
    let (status, body, _) = exchange(
        channel.bound_port(),
        "POST",
        "/api/message",
        Some(r#"{"fromAgent":"grok","message":"hello","waitForResponse":false}"#),
        &[],
    )
    .await;
    assert_eq!(status, 202);
    assert_eq!(body["status"], json!("accepted"));
    assert_eq!(body["agent"], json!("opus"));
    channel.stop().await;
}

#[tokio::test]
async fn delivers_the_inbound_message_and_waits_for_send() {
    let channel = started("opus").await;
    let seen = Arc::new(Mutex::new(Vec::<protocol::InboundMessage>::new()));
    let seen_cb = Arc::clone(&seen);
    let responder = channel.clone();
    channel.on_message(move |message| {
        let seen_cb = Arc::clone(&seen_cb);
        let responder = responder.clone();
        async move {
            seen_cb.lock().unwrap().push(message.clone());
            responder.send(
                &message.channel_id,
                &format!("I got your message: {}", message.text),
            );
            Ok(())
        }
    });
    let (status, body, _) = exchange(
        channel.bound_port(),
        "POST",
        "/api/message",
        Some(r#"{"fromAgent":"grok","message":"what time is it?"}"#),
        &[("authorization", "Bearer test-secret-123")],
    )
    .await;
    assert_eq!(status, 200);
    assert!(
        body["response"]
            .as_str()
            .unwrap()
            .contains("what time is it")
    );
    assert_eq!(body["agent"], json!("opus"));
    assert_eq!(body["fromAgent"], json!("grok"));
    let message = seen.lock().unwrap()[0].clone();
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert_eq!(message.text, "what time is it?");
    assert_eq!(message.user_id, "agent:grok");
    assert_eq!(message.platform, "agent");
    assert_eq!(message.chat_type, "agent");
    assert_eq!(message.display_name.as_deref(), Some("Agent: grok"));
    assert_eq!(message.agent.as_deref(), Some("opus"));
    assert_eq!(message.id, message.channel_id);
    assert!(message.id.starts_with("agent-msg-"));
    assert!(message.timestamp.as_f64() * 1000.0 <= mesh::now_ms().as_f64());
    let metadata = message.metadata.as_ref().unwrap();
    assert_eq!(metadata.get("fromAgent"), Some(&json!("grok")));
    assert_eq!(metadata.get("isAgentMessage"), Some(&json!(true)));
    channel.stop().await;
}

#[tokio::test]
async fn rejects_missing_fields_invalid_json_and_a_missing_handler() {
    let channel = started("opus").await;
    let port = channel.bound_port();
    let (status, body, _) = exchange(
        port,
        "POST",
        "/api/message",
        Some(r#"{"message":"no fromAgent"}"#),
        &[],
    )
    .await;
    assert_eq!(status, 400);
    assert!(body["error"].as_str().unwrap().contains("fromAgent"));
    let (status, body, _) = exchange(port, "POST", "/api/message", Some("not json{{{"), &[]).await;
    assert_eq!(status, 400);
    assert_eq!(body["error"], json!("Invalid JSON body"));
    let (status, body, _) = exchange(
        port,
        "POST",
        "/api/message",
        Some(r#"{"fromAgent":"grok","message":"hello"}"#),
        &[],
    )
    .await;
    assert_eq!(status, 503);
    assert_eq!(body["error"], json!("No message handler registered"));
    channel.stop().await;
}

#[tokio::test]
async fn fire_and_forget_returns_accepted_without_waiting() {
    let channel = started("opus").await;
    channel.on_message(|_| async {
        tokio::time::sleep(Duration::from_millis(200)).await;
        Ok(())
    });
    let started_at = std::time::Instant::now();
    let (status, body, _) = exchange(
        channel.bound_port(),
        "POST",
        "/api/message",
        Some(r#"{"fromAgent":"grok","message":"fire and forget","waitForResponse":false}"#),
        &[],
    )
    .await;
    assert_eq!(status, 202);
    assert_eq!(body["status"], json!("accepted"));
    assert!(
        body["requestId"]
            .as_str()
            .unwrap()
            .starts_with("agent-msg-")
    );
    assert!(started_at.elapsed() < Duration::from_millis(500));
    let (status, _, _) = exchange(
        channel.bound_port(),
        "POST",
        "/api/message",
        Some(r#"{"fromAgent":"grok","message":"still accepted","waitForResponse":false}"#),
        &[],
    )
    .await;
    let bare = AgentChannel::new(plain("opus"));
    bare.start().await.unwrap();
    let (no_handler, _, _) = exchange(
        bare.bound_port(),
        "POST",
        "/api/message",
        Some(r#"{"fromAgent":"grok","message":"no handler","waitForResponse":false}"#),
        &[],
    )
    .await;
    assert_eq!(status, 202);
    assert_eq!(no_handler, 202);
    bare.stop().await;
    channel.stop().await;
}

#[tokio::test]
async fn browser_origin_is_refused_before_routing() {
    let channel = started("opus").await;
    let delivered = AtomicFlag::new();
    let flag = delivered.clone();
    channel.on_message(move |_| {
        let flag = flag.clone();
        async move {
            flag.set();
            Ok(())
        }
    });
    let (status, body, headers) = exchange(
        channel.bound_port(),
        "POST",
        "/api/message",
        Some(r#"{"fromAgent":"grok","message":"hello","waitForResponse":false}"#),
        &[("origin", "https://evil.example")],
    )
    .await;
    assert_eq!(status, 403);
    assert_eq!(body["error"], json!("browser requests are not accepted"));
    assert!(headers.get("access-control-allow-origin").is_none());
    let (preflight, _, pre_headers) = exchange(
        channel.bound_port(),
        "OPTIONS",
        "/api/message",
        None,
        &[("origin", "https://evil.example")],
    )
    .await;
    assert_eq!(preflight, 403);
    assert!(pre_headers.get("access-control-allow-origin").is_none());
    assert!(!delivered.get());
    channel.stop().await;
}

#[tokio::test]
async fn unknown_paths_methods_and_query_strings_are_404() {
    let channel = started("opus").await;
    let port = channel.bound_port();
    let (status, body, _) = exchange(port, "GET", "/unknown", None, &[]).await;
    assert_eq!(status, 404);
    assert_eq!(body["error"], json!("Not found"));
    let (status, _, _) = exchange(port, "POST", "/health", None, &[]).await;
    assert_eq!(status, 404);
    let (status, _, _) = exchange(port, "GET", "/health?x=1", None, &[]).await;
    assert_eq!(status, 404);
    let (status, _, _) = exchange(port, "GET", "/api/message", None, &[]).await;
    assert_eq!(status, 404);
    channel.stop().await;
}

#[tokio::test]
async fn mesh_routes_use_bearer_auth_and_ping_is_open() {
    let mut config = plain("opus");
    config.get_mesh_nodes = Some(Arc::new(|| Box::pin(async { Ok(Vec::<MeshNode>::new()) })));
    let joined = Arc::new(Mutex::new(Vec::<String>::new()));
    let joined_cb = Arc::clone(&joined);
    config.on_mesh_join = Some(Arc::new(move |node| {
        let joined_cb = Arc::clone(&joined_cb);
        Box::pin(async move {
            joined_cb.lock().unwrap().push(node.id);
            Ok(())
        })
    }));
    let channel = AgentChannel::new(config);
    channel.start().await.unwrap();
    let port = channel.bound_port();
    let (status, body, _) = exchange(port, "GET", "/api/mesh/ping", None, &[]).await;
    assert_eq!(status, 200);
    assert_eq!(body["ok"], json!(true));
    assert_eq!(body["tls"], json!(true));
    assert_eq!(body["node"], json!("opus"));
    let (status, body, _) = exchange(port, "GET", "/api/mesh", None, &[]).await;
    assert_eq!(status, 401);
    assert_eq!(body["error"], json!("Missing or invalid authorization"));
    let (status, body, _) = exchange(
        port,
        "GET",
        "/api/mesh",
        None,
        &[("authorization", "Bearer wrong")],
    )
    .await;
    assert_eq!(status, 403);
    assert_eq!(body["error"], json!("Invalid secret"));
    let (status, body, _) = exchange(
        port,
        "GET",
        "/api/mesh",
        None,
        &[("authorization", "Bearer test-secret-123")],
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body, json!([]));
    let (status, _, _) = exchange(port, "POST", "/api/mesh/join", Some("not-json"), &[]).await;
    assert_eq!(status, 401);
    let (status, body, _) = exchange(
        port,
        "POST",
        "/api/mesh/join",
        Some(r#"{"id":"n1"}"#),
        &[("authorization", "Bearer test-secret-123")],
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(
        body["error"],
        json!("Missing required fields: id, name, host")
    );
    let (status, body, _) = exchange(
        port,
        "POST",
        "/api/mesh/join",
        Some(r#"{"id":"n1","name":"n1","host":"10.0.0.9","port":3100}"#),
        &[("authorization", "Bearer test-secret-123")],
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["status"], json!("joined"));
    assert_eq!(joined.lock().unwrap().as_slice(), ["n1"]);
    let mut disabled = plain("opus");
    disabled.secret = Some("test-secret-123".to_string());
    let disabled = AgentChannel::new(disabled);
    disabled.start().await.unwrap();
    let (status, body, _) = exchange(
        disabled.bound_port(),
        "GET",
        "/api/mesh",
        None,
        &[("authorization", "Bearer test-secret-123")],
    )
    .await;
    assert_eq!(status, 501);
    assert_eq!(body["error"], json!("Mesh not enabled on this node"));
    disabled.stop().await;
    channel.stop().await;
}

#[tokio::test]
async fn timeout_handler_error_and_shutdown_texts() {
    let channel = started("opus").await;
    channel.on_message(|_| async { Ok(()) });
    let (status, body, _) = exchange(
        channel.bound_port(),
        "POST",
        "/api/message",
        Some(r#"{"fromAgent":"grok","message":"wait","timeoutMs":30}"#),
        &[],
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        body["response"],
        json!("[timeout — agent did not respond in time]")
    );
    let failing = started("opus").await;
    failing.on_message(|_| async { Err("boom".to_string()) });
    let (status, body, _) = exchange(
        failing.bound_port(),
        "POST",
        "/api/message",
        Some(r#"{"fromAgent":"grok","message":"wait"}"#),
        &[],
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["response"], json!("[error processing message: boom]"));
    let shutting = started("opus").await;
    let stopper = shutting.clone();
    shutting.on_message(move |_| {
        let stopper = stopper.clone();
        async move {
            stopper.stop().await;
            Ok(())
        }
    });
    let (status, body, _) = exchange(
        shutting.bound_port(),
        "POST",
        "/api/message",
        Some(r#"{"fromAgent":"grok","message":"stop"}"#),
        &[],
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["response"], json!("[channel shutting down]"));
    let quiet = started("opus").await;
    let quiet_send = quiet.clone();
    quiet.on_message(move |message| {
        let quiet = quiet_send.clone();
        async move {
            assert!(quiet.send(&message.channel_id, "").is_none());
            quiet.send(&message.channel_id, "later");
            Ok(())
        }
    });
    let (_, body, _) = exchange(
        quiet.bound_port(),
        "POST",
        "/api/message",
        Some(r#"{"fromAgent":"grok","message":"blank"}"#),
        &[],
    )
    .await;
    assert_eq!(body["response"], json!("later"));
    failing.stop().await;
    quiet.stop().await;
}

#[tokio::test]
async fn agent_message_tool_schema_peers_and_texts() {
    let channel = AgentChannel::new(plain("opus"));
    let tool = channel.create_message_tool();
    let schema = tool.schema();
    assert_eq!(tool.name(), "agent_message");
    assert!(
        schema["parameters"]["required"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item == "to_agent")
    );
    assert!(
        schema["parameters"]["required"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item == "message")
    );
    let unknown = tool
        .execute(&json!({ "to_agent": "unknown", "message": "hi" }))
        .await;
    assert_eq!(
        unknown,
        "Error: Unknown peer agent \"unknown\". Available peers: none"
    );
    let receiver = started("grok").await;
    let echo = receiver.clone();
    receiver.on_message(move |message| {
        let echo = echo.clone();
        async move {
            echo.send(&message.channel_id, &format!("Grok says: {}", message.text));
            Ok(())
        }
    });
    let mut sender_config = plain("opus");
    sender_config.peers.push((
        "grok".to_string(),
        PeerConfig {
            url: format!("http://127.0.0.1:{}", receiver.bound_port()),
            secret: Some("peer-secret".to_string()),
        },
    ));
    let sender = AgentChannel::new(sender_config);
    let tool = sender.create_message_tool();
    let result = tool
        .execute(&json!({ "to_agent": "grok", "message": "Hello from opus!" }))
        .await;
    assert!(result.contains("Hello from opus"));
    let async_result = tool
        .execute(&json!({
            "to_agent": "grok",
            "message": "FYI notification",
            "wait_for_response": false
        }))
        .await;
    assert!(async_result.contains("Message sent to grok"));
    assert!(async_result.contains("async — no response expected"));
    assert!(async_result.contains("Request ID: agent-msg-"));
    receiver.stop().await;
}

#[tokio::test]
async fn tool_reports_http_status_null_ids_and_bearer_undefined() {
    let missing_id = serve_json(202, r#"{"status":"accepted"}"#).await;
    let null_id = serve_json(202, r#"{"status":"accepted","requestId":null}"#).await;
    let no_response = serve_json(200, r#"{"ok":true}"#).await;
    let failed = serve_json(500, "nope").await;
    let echo = serve_echo().await;
    let mut config = AgentChannelConfig::new("opus");
    config.peers = vec![
        peer("missing", missing_id),
        peer("nullish", null_id),
        peer("empty", no_response),
        peer("failed", failed),
        peer("echo", echo),
    ];
    let tool = AgentChannel::new(config).create_message_tool();
    let missing = tool
        .execute(&json!({ "to_agent": "missing", "message": "x", "wait_for_response": false }))
        .await;
    assert!(missing.contains("Request ID: undefined"));
    let nullish = tool
        .execute(&json!({ "to_agent": "nullish", "message": "x", "wait_for_response": false }))
        .await;
    assert!(nullish.contains("Request ID: null"));
    let empty = tool
        .execute(&json!({ "to_agent": "empty", "message": "x" }))
        .await;
    assert_eq!(empty, "[no response]");
    let failed = tool
        .execute(&json!({ "to_agent": "failed", "message": "x" }))
        .await;
    assert!(failed.contains("Error sending message to failed: HTTP 500: nope"));
    let echoed = tool
        .execute(&json!({ "to_agent": "echo", "message": "x" }))
        .await;
    assert_eq!(echoed, "Bearer undefined");
}

#[tokio::test]
async fn two_channels_message_each_other_and_port_in_use_is_reported() {
    let left = started("opus").await;
    let left_send = left.clone();
    left.on_message(move |message| {
        let left_send = left_send.clone();
        async move {
            left_send.send(
                &message.channel_id,
                &format!("Opus received: {}", message.text),
            );
            Ok(())
        }
    });
    let mut right_config = plain("grok");
    right_config.secret = None;
    let right = AgentChannel::new(right_config);
    let response = right
        .send_to_peer(
            &PeerConfig {
                url: format!("http://127.0.0.1:{}", left.bound_port()),
                secret: None,
            },
            &json!({ "fromAgent": "grok", "message": "ping from grok" }),
        )
        .await
        .unwrap();
    assert!(
        response["response"]
            .as_str()
            .unwrap()
            .contains("Opus received: ping from grok")
    );
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut busy = plain("opus");
    busy.port = port;
    let busy = AgentChannel::new(busy);
    let err = busy.start().await.unwrap_err();
    assert_eq!(
        err.to_string(),
        format!("Agent channel port {port} is already in use")
    );
    drop(listener);
    left.stop().await;
}

#[tokio::test]
async fn mtls_requires_a_client_certificate_from_the_configured_ca() {
    let material = test_certs();
    let mut config = AgentChannelConfig::new("opus");
    config.port = 0;
    config.host = "127.0.0.1".to_string();
    config.tls = Some(material.server.clone());
    let channel = AgentChannel::new(config);
    channel.start().await.unwrap();
    let port = channel.bound_port();
    let url = format!("https://127.0.0.1:{port}/api/mesh/ping");
    let good = rustls_client(
        &material.ca_pem,
        Some(&material.client_cert),
        Some(&material.client_key),
    );
    let response = good.get(&url).send().await.unwrap();
    assert_eq!(response.status().as_u16(), 200);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["tls"], json!(true));
    assert_eq!(body["node"], json!("opus"));
    let missing = rustls_client(&material.ca_pem, None, None);
    assert!(missing.get(&url).send().await.is_err());
    let wrong = rustls_client(
        &material.ca_pem,
        Some(&material.wrong_cert),
        Some(&material.wrong_key),
    );
    assert!(wrong.get(&url).send().await.is_err());
    let mesh_url = format!("https://127.0.0.1:{port}/api/mesh");
    let mesh = good.get(&mesh_url).send().await.unwrap();
    assert_eq!(mesh.status().as_u16(), 501);
    channel.stop().await;
}

#[tokio::test]
async fn plugin_config_reads_snake_case_peers_and_ignores_partial_tls() {
    let channel = agent_channel_from_plugin_config(&json!({
        "agent_id": "grok",
        "port": 0,
        "host": "127.0.0.1",
        "secret": "s",
        "peers": {
            "opus": { "url": "http://127.0.0.1:1", "secret": "p" },
            "local": { "url": "http://127.0.0.1:2" }
        },
        "tls": { "ca": "not-a-cert" }
    }));
    assert_eq!(channel.id(), "agent-grok");
    assert_eq!(channel.platform(), "agent");
    channel.start().await.unwrap();
    let (status, _, _) = exchange(channel.bound_port(), "GET", "/health", None, &[]).await;
    assert_eq!(status, 200);
    let tool = channel.create_message_tool();
    let listed = tool
        .execute(&json!({ "to_agent": "missing", "message": "hi" }))
        .await;
    assert!(listed.contains("Available peers: opus, local"));
    channel.stop().await;
}

struct AtomicFlag(std::sync::atomic::AtomicBool);

impl AtomicFlag {
    fn new() -> Arc<Self> {
        Arc::new(Self(std::sync::atomic::AtomicBool::new(false)))
    }

    fn set(&self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    fn get(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

fn peer(name: &str, port: u16) -> (String, PeerConfig) {
    (
        name.to_string(),
        PeerConfig {
            url: format!("http://127.0.0.1:{port}"),
            secret: None,
        },
    )
}

async fn serve_json(status: u16, body: &'static str) -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (sock, _) = listener.accept().await.unwrap();
        write_http(sock, status, body).await;
    });
    port
}

async fn serve_echo() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let raw = read_headers(&mut sock).await;
        let auth = raw
            .lines()
            .find(|line| line.to_ascii_lowercase().starts_with("authorization:"))
            .and_then(|line| line.split_once(':'))
            .map(|(_, value)| value.trim().to_string())
            .unwrap_or_default();
        let body = json!({ "response": auth }).to_string();
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = sock.write_all(response.as_bytes()).await;
    });
    port
}

async fn write_http(mut sock: tokio::net::TcpStream, status: u16, body: &str) {
    let _ = read_headers(&mut sock).await;
    let response = format!(
        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = sock.write_all(response.as_bytes()).await;
}

async fn read_headers(sock: &mut tokio::net::TcpStream) -> String {
    let mut buf = Vec::new();
    let mut tmp = [0_u8; 1024];
    loop {
        let read = sock.read(&mut tmp).await.unwrap_or(0);
        if read == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..read]);
        if buf.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

struct TestCerts {
    ca_pem: String,
    client_cert: String,
    client_key: String,
    wrong_cert: String,
    wrong_key: String,
    server: TlsMaterial,
}

fn test_certs() -> TestCerts {
    let ca_key = rcgen::KeyPair::generate().unwrap();
    let mut ca_params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    ca_params.key_usages = vec![
        rcgen::KeyUsagePurpose::DigitalSignature,
        rcgen::KeyUsagePurpose::KeyCertSign,
        rcgen::KeyUsagePurpose::CrlSign,
    ];
    ca_params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "mesh-test-ca");
    let ca_cert = ca_params.self_signed(&ca_key).unwrap();
    let (server_cert, server_key) = signed_cert(&ca_cert, &ca_key, true);
    let (client_cert, client_key) = signed_cert(&ca_cert, &ca_key, false);
    let other_key = rcgen::KeyPair::generate().unwrap();
    let mut other_params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    other_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    other_params.key_usages = vec![
        rcgen::KeyUsagePurpose::DigitalSignature,
        rcgen::KeyUsagePurpose::KeyCertSign,
        rcgen::KeyUsagePurpose::CrlSign,
    ];
    other_params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "mesh-other-ca");
    let other_cert = other_params.self_signed(&other_key).unwrap();
    let (wrong_cert, wrong_key) = signed_cert(&other_cert, &other_key, false);
    let ca_pem = ca_cert.pem();
    TestCerts {
        server: TlsMaterial {
            ca_pem: ca_pem.as_bytes().to_vec(),
            cert_pem: server_cert.as_bytes().to_vec(),
            key_pem: server_key.as_bytes().to_vec(),
        },
        ca_pem,
        client_cert,
        client_key,
        wrong_cert,
        wrong_key,
    }
}

fn signed_cert(
    ca_cert: &rcgen::Certificate,
    ca_key: &rcgen::KeyPair,
    server: bool,
) -> (String, String) {
    let key = rcgen::KeyPair::generate().unwrap();
    let names = if server {
        vec!["127.0.0.1".to_string()]
    } else {
        Vec::new()
    };
    let mut params = rcgen::CertificateParams::new(names).unwrap();
    params.distinguished_name.push(
        rcgen::DnType::CommonName,
        if server { "127.0.0.1" } else { "mesh-client" },
    );
    params.key_usages = vec![
        rcgen::KeyUsagePurpose::DigitalSignature,
        rcgen::KeyUsagePurpose::KeyEncipherment,
    ];
    params.extended_key_usages = vec![if server {
        rcgen::ExtendedKeyUsagePurpose::ServerAuth
    } else {
        rcgen::ExtendedKeyUsagePurpose::ClientAuth
    }];
    let cert = params.signed_by(&key, ca_cert, ca_key).unwrap();
    (cert.pem(), key.serialize_pem())
}

fn rustls_client(ca_pem: &str, cert_pem: Option<&str>, key_pem: Option<&str>) -> reqwest::Client {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut roots = rustls::RootCertStore::empty();
    let mut reader = std::io::Cursor::new(ca_pem.as_bytes());
    for cert in rustls_pemfile::certs(&mut reader) {
        roots.add(cert.unwrap()).unwrap();
    }
    let builder = rustls::ClientConfig::builder().with_root_certificates(roots);
    let mut config = match (cert_pem, key_pem) {
        (Some(cert_pem), Some(key_pem)) => {
            let mut reader = std::io::Cursor::new(cert_pem.as_bytes());
            let certs = rustls_pemfile::certs(&mut reader)
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            let mut reader = std::io::Cursor::new(key_pem.as_bytes());
            let key = rustls_pemfile::private_key(&mut reader).unwrap().unwrap();
            builder.with_client_auth_cert(certs, key).unwrap()
        }
        _ => builder.with_no_client_auth(),
    };
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    reqwest::Client::builder()
        .use_preconfigured_tls(config)
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap()
}
