use std::sync::Arc;

use parking_lot::Mutex;
use std::time::Duration;

use mesh::{
    AgentChannel, AgentChannelConfig, MeshNode, PeerConfig, TlsMaterial,
    agent_channel_from_plugin_config,
};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn js(value: Value) -> protocol::js::JsValue {
    protocol::js::from_serde(&value)
}

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
            seen_cb.lock().push(message.clone());
            responder.send(
                &message.channel_id,
                format!("I got your message: {}", message.text),
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
    let message = seen.lock()[0].clone();
    assert_eq!(seen.lock().len(), 1);
    assert_eq!(message.text.to_utf8(), "what time is it?");
    assert_eq!(message.user_id.to_utf8(), "agent:grok");
    assert_eq!(message.platform, "agent");
    assert_eq!(message.chat_type, "agent");
    assert_eq!(
        message
            .display_name
            .as_ref()
            .map(protocol::js::JsString::to_utf8),
        Some("Agent: grok")
    );
    assert_eq!(message.agent.as_deref(), Some("opus"));
    assert_eq!(message.id, message.channel_id);
    assert!(message.id.starts_with("agent-msg-"));
    assert!(message.timestamp.as_f64() * 1000.0 <= protocol::js::date_now());
    let metadata = message.metadata.as_ref().unwrap();
    assert_eq!(
        metadata.get("fromAgent"),
        Some(&protocol::js::JsValue::from_text("grok"))
    );
    assert_eq!(
        metadata.get("isAgentMessage"),
        Some(&protocol::js::JsValue::Bool(true))
    );
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
async fn message_body_keeps_an_escaped_unpaired_surrogate() {
    let channel = started("opus").await;
    let seen = Arc::new(Mutex::new(None));
    let seen_cb = Arc::clone(&seen);
    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    let done = Arc::new(Mutex::new(Some(done_tx)));
    channel.on_message(move |message| {
        let seen_cb = Arc::clone(&seen_cb);
        let done = Arc::clone(&done);
        async move {
            *seen_cb.lock() = Some(message.text.units().to_vec());
            if let Some(tx) = done.lock().take() {
                let _ = tx.send(());
            }
            Ok(())
        }
    });
    let (status, body, _) = exchange(
        channel.bound_port(),
        "POST",
        "/api/message",
        Some(
            r#"{"fromAgent":"peer","message":"hello \ud83d","waitForResponse":false,"note":"\ud83d"}"#,
        ),
        &[],
    )
    .await;
    assert_eq!(status, 202);
    assert_eq!(body["status"], json!("accepted"));
    tokio::time::timeout(Duration::from_secs(2), done_rx)
        .await
        .expect("handler finished")
        .unwrap();
    let mut expected: Vec<u16> = "hello ".encode_utf16().collect();
    expected.push(0xD83D);
    assert_eq!(seen.lock().clone().unwrap(), expected);
    channel.stop().await;
}

#[tokio::test]
async fn from_agent_identity_and_the_response_echo_keep_the_surrogate() {
    let channel = started("opus").await;
    let seen = Arc::new(Mutex::new(None));
    let seen_cb = Arc::clone(&seen);
    let responder = channel.clone();
    channel.on_message(move |message| {
        let seen_cb = Arc::clone(&seen_cb);
        let responder = responder.clone();
        async move {
            *seen_cb.lock() = Some(message.clone());
            responder.send(&message.channel_id, "ok");
            Ok(())
        }
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let response = client
        .post(format!(
            "http://127.0.0.1:{}/api/message",
            channel.bound_port()
        ))
        .header("content-type", "application/json")
        .body(r#"{"fromAgent":"peer\ud83d","message":"hi","waitForResponse":true}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    let raw = response.text().await.unwrap();
    assert!(raw.contains(r#""fromAgent":"peer\ud83d""#));
    let parsed = protocol::js::parse(&raw).unwrap();
    let mut peer: Vec<u16> = "peer".encode_utf16().collect();
    peer.push(0xD83D);
    assert_eq!(
        parsed
            .get("fromAgent")
            .and_then(protocol::js::JsValue::as_js_string)
            .unwrap()
            .units(),
        peer.as_slice()
    );
    let message = seen.lock().clone().unwrap();
    let mut user: Vec<u16> = "agent:peer".encode_utf16().collect();
    user.push(0xD83D);
    let mut display: Vec<u16> = "Agent: peer".encode_utf16().collect();
    display.push(0xD83D);
    assert_eq!(message.user_id.units(), user.as_slice());
    assert_eq!(message.username.unwrap().units(), peer.as_slice());
    assert_eq!(message.display_name.unwrap().units(), display.as_slice());
    assert_eq!(
        message
            .metadata
            .unwrap()
            .get("fromAgent")
            .and_then(protocol::js::JsValue::as_js_string)
            .unwrap()
            .units(),
        peer.as_slice()
    );
    channel.stop().await;
}

#[tokio::test]
async fn server_reply_keeps_a_lone_surrogate() {
    let channel = started("opus").await;
    let responder = channel.clone();
    channel.on_message(move |message| {
        let responder = responder.clone();
        async move {
            responder.send(&message.channel_id, message.text.clone());
            Ok(())
        }
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let response = client
        .post(format!(
            "http://127.0.0.1:{}/api/message",
            channel.bound_port()
        ))
        .header("content-type", "application/json")
        .body(r#"{"fromAgent":"peer","message":"hi \ud83d","waitForResponse":true}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    let raw = response.text().await.unwrap();
    assert!(raw.contains(r#""response":"hi \ud83d""#));
    let parsed = protocol::js::parse(&raw).unwrap();
    let mut expected: Vec<u16> = "hi ".encode_utf16().collect();
    expected.push(0xD83D);
    assert_eq!(
        parsed
            .get("response")
            .and_then(protocol::js::JsValue::as_js_string)
            .unwrap()
            .units(),
        expected.as_slice()
    );
    channel.stop().await;
}

#[tokio::test]
async fn fire_and_forget_returns_accepted_without_waiting() {
    let channel = started("opus").await;
    let (gate_tx, gate_rx) = tokio::sync::watch::channel(false);
    channel.on_message(move |_| {
        let mut gate_rx = gate_rx.clone();
        async move {
            let _ = gate_rx.wait_for(|open| *open).await;
            Ok(())
        }
    });
    let port = channel.bound_port();
    let send = tokio::spawn(async move {
        exchange(
            port,
            "POST",
            "/api/message",
            Some(r#"{"fromAgent":"grok","message":"fire and forget","waitForResponse":false}"#),
            &[],
        )
        .await
    });
    let (status, body, _) = tokio::time::timeout(Duration::from_secs(2), send)
        .await
        .expect("accepted before the handler was released")
        .unwrap();
    assert_eq!(status, 202);
    assert_eq!(body["status"], json!("accepted"));
    assert!(
        body["requestId"]
            .as_str()
            .unwrap()
            .starts_with("agent-msg-")
    );
    gate_tx.send(true).unwrap();
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
            joined_cb.lock().push(node.id().to_string());
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
    assert_eq!(joined.lock().as_slice(), ["n1"]);
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
        .execute(&js(json!({ "to_agent": "unknown", "message": "hi" })))
        .await;
    assert_eq!(
        unknown.to_utf8(),
        "Error: Unknown peer agent \"unknown\". Available peers: none"
    );
    let missing = tool.execute(&js(json!({ "message": "hi" }))).await;
    assert_eq!(
        missing.to_utf8(),
        "Error: Unknown peer agent \"undefined\". Available peers: none"
    );
    let null_peer = tool
        .execute(&js(json!({ "to_agent": Value::Null, "message": "hi" })))
        .await;
    assert_eq!(
        null_peer.to_utf8(),
        "Error: Unknown peer agent \"null\". Available peers: none"
    );
    let receiver = started("grok").await;
    let echo = receiver.clone();
    receiver.on_message(move |message| {
        let echo = echo.clone();
        async move {
            echo.send(&message.channel_id, format!("Grok says: {}", message.text));
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
        .execute(&js(
            json!({ "to_agent": "grok", "message": "Hello from opus!" }),
        ))
        .await;
    assert!(result.to_utf8().contains("Hello from opus"));
    let async_result = tool
        .execute(&js(json!({
            "to_agent": "grok",
            "message": "FYI notification",
            "wait_for_response": false
        })))
        .await;
    assert!(async_result.to_utf8().contains("Message sent to grok"));
    assert!(
        async_result
            .to_utf8()
            .contains("async — no response expected")
    );
    assert!(async_result.to_utf8().contains("Request ID: agent-msg-"));
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
        .execute(&js(
            json!({ "to_agent": "missing", "message": "x", "wait_for_response": false }),
        ))
        .await;
    assert!(missing.to_utf8().contains("Request ID: undefined"));
    let nullish = tool
        .execute(&js(
            json!({ "to_agent": "nullish", "message": "x", "wait_for_response": false }),
        ))
        .await;
    assert!(nullish.to_utf8().contains("Request ID: null"));
    let empty = tool
        .execute(&js(json!({ "to_agent": "empty", "message": "x" })))
        .await;
    assert_eq!(empty.to_utf8(), "[no response]");
    let failed = tool
        .execute(&js(json!({ "to_agent": "failed", "message": "x" })))
        .await;
    assert!(
        failed
            .to_utf8()
            .contains("Error sending message to failed: HTTP 500: nope")
    );
    let echoed = tool
        .execute(&js(json!({ "to_agent": "echo", "message": "x" })))
        .await;
    assert_eq!(echoed.to_utf8(), "Bearer undefined");
}

#[tokio::test]
async fn peer_success_keeps_json_parse_text_with_an_unpaired_surrogate() {
    let response_text = serve_json(200, r#"{"response":"done \ud83d","ignored":"\ud83d"}"#).await;
    let ignored = serve_json(200, r#"{"response":"plain","note":"\ud83d"}"#).await;
    let mut config = AgentChannelConfig::new("opus");
    config.peers = vec![peer("emoji", response_text), peer("plain", ignored)];
    let tool = AgentChannel::new(config).create_message_tool();
    let first = tool
        .execute(&js(json!({ "to_agent": "emoji", "message": "x" })))
        .await;
    let mut expected: Vec<u16> = "done ".encode_utf16().collect();
    expected.push(0xD83D);
    assert_eq!(first.units(), expected.as_slice());
    let second = tool
        .execute(&js(json!({ "to_agent": "plain", "message": "x" })))
        .await;
    assert_eq!(second.to_utf8(), "plain");
}

#[tokio::test]
async fn outbound_text_keeps_a_lone_surrogate() {
    let (port, seen) = serve_capture(200, r#"{"response":"ok"}"#).await;
    let mut config = AgentChannelConfig::new("opus");
    config.peers = vec![peer("cap", port)];
    let tool = AgentChannel::new(config).create_message_tool();
    let args =
        protocol::js::parse(r#"{"to_agent":"cap","message":"hi \ud83d","wait_for_response":true}"#)
            .unwrap();
    let result = tool.execute(&args).await;
    assert_eq!(result.to_utf8(), "ok");
    let raw = seen.lock().clone();
    let body = raw.split("\r\n\r\n").nth(1).unwrap();
    let parsed = protocol::js::parse(body).unwrap();
    let mut expected: Vec<u16> = "hi ".encode_utf16().collect();
    expected.push(0xD83D);
    assert_eq!(
        parsed
            .get("message")
            .and_then(protocol::js::JsValue::as_js_string)
            .unwrap()
            .units(),
        expected.as_slice()
    );

    let unknown = protocol::js::parse(r#"{"to_agent":"nope\ud83d","message":"x"}"#).unwrap();
    let err = tool.execute(&unknown).await;
    let mut error_units: Vec<u16> = "Error: Unknown peer agent \"nope".encode_utf16().collect();
    error_units.push(0xD83D);
    error_units.extend("\". Available peers: cap".encode_utf16());
    assert_eq!(err.units(), error_units.as_slice());
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
                format!("Opus received: {}", message.text),
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
            &js(json!({ "fromAgent": "grok", "message": "ping from grok" })),
        )
        .await
        .unwrap();
    assert!(
        response
            .get("response")
            .and_then(protocol::js::JsValue::as_str)
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
async fn plugin_config_reads_snake_case_peers_and_rejects_partial_tls() {
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
    let err = channel.start().await.unwrap_err();
    assert!(err.to_string().contains("TLS"));
    let tool = channel.create_message_tool();
    let listed = tool
        .execute(&js(json!({ "to_agent": "missing", "message": "hi" })))
        .await;
    assert!(listed.to_utf8().contains("Available peers: opus, local"));
}

#[tokio::test]
async fn configured_tls_fails_closed_before_bind() {
    let garbage = agent_channel_from_plugin_config(&json!({
        "agent_id": "grok",
        "port": 0,
        "host": "127.0.0.1",
        "tls": { "ca": "not-a-cert", "cert": "nope", "key": "nope" }
    }));
    let err = garbage.start().await.unwrap_err().to_string();
    assert!(err.starts_with("agent channel TLS setup failed:"));
    assert_eq!(garbage.bound_port(), 0);

    let truthy = agent_channel_from_plugin_config(&json!({
        "agent_id": "grok",
        "tls": true
    }));
    assert_eq!(
        truthy.start().await.unwrap_err().to_string(),
        "agent channel TLS configuration is unusable"
    );

    let material = test_certs();
    let mut mismatch = AgentChannelConfig::new("opus");
    mismatch.port = 0;
    mismatch.host = "127.0.0.1".to_string();
    mismatch.tls = Some(TlsMaterial {
        ca_pem: material.server.ca_pem.clone(),
        cert_pem: material.server.cert_pem.clone(),
        key_pem: material.wrong_key.as_bytes().to_vec(),
    });
    let err = AgentChannel::new(mismatch)
        .start()
        .await
        .unwrap_err()
        .to_string();
    assert!(err.starts_with("agent channel TLS setup failed:"));

    let plain_tls = agent_channel_from_plugin_config(&json!({
        "agent_id": "grok",
        "port": 0,
        "host": "127.0.0.1",
        "tls": false
    }));
    plain_tls.start().await.unwrap();
    let (status, _, _) = exchange(plain_tls.bound_port(), "GET", "/health", None, &[]).await;
    assert_eq!(status, 200);
    plain_tls.stop().await;
}

#[tokio::test]
async fn join_keeps_typed_fields_and_omits_null_operators() {
    let seen = Arc::new(Mutex::new(None));
    let seen_cb = Arc::clone(&seen);
    let mut config = plain("opus");
    config.get_mesh_nodes = Some(Arc::new(|| Box::pin(async { Ok(Vec::new()) })));
    config.on_mesh_join = Some(Arc::new(move |node| {
        let seen_cb = Arc::clone(&seen_cb);
        Box::pin(async move {
            *seen_cb.lock() = Some(node);
            Ok(())
        })
    }));
    let channel = AgentChannel::new(config);
    channel.start().await.unwrap();
    let (status, body, _) = exchange(
        channel.bound_port(),
        "POST",
        "/api/mesh/join",
        Some(
            r#"{"id":"n1","name":"N","host":"10.0.0.9","port":3100,"sshUser":null,"agents":["opus"],"status":"online","metadata":{"k":"v"},"custom":true}"#,
        ),
        &[("authorization", "Bearer test-secret-123")],
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["status"], json!("joined"));
    let node = seen.lock().clone().unwrap();
    assert!(node.ssh_user().is_none());
    assert!(node.original().get("sshUser").unwrap().is_null());
    assert_eq!(node.port().unwrap().as_f64(), 3100.0);
    assert_eq!(node.agents().unwrap(), vec!["opus".to_string()]);
    assert_eq!(
        node.status().map(protocol::js::JsString::to_utf8),
        Some("online")
    );
    assert_eq!(
        node.metadata()
            .unwrap()
            .get("k")
            .and_then(protocol::js::JsValue::as_str),
        Some("v")
    );
    assert_eq!(
        node.get("custom").and_then(protocol::js::JsValue::as_bool),
        Some(true)
    );
    let partial = Arc::new(Mutex::new(None));
    let partial_cb = Arc::clone(&partial);
    let mut partial_config = plain("opus");
    partial_config.on_mesh_join = Some(Arc::new(move |node| {
        let partial_cb = Arc::clone(&partial_cb);
        Box::pin(async move {
            *partial_cb.lock() = Some(node);
            Ok(())
        })
    }));
    let partial_channel = AgentChannel::new(partial_config);
    partial_channel.start().await.unwrap();
    let (partial_status, _, _) = exchange(
        partial_channel.bound_port(),
        "POST",
        "/api/mesh/join",
        Some(r#"{"id":"only","name":"N","host":"h"}"#),
        &[("authorization", "Bearer test-secret-123")],
    )
    .await;
    assert_eq!(partial_status, 200);
    let forwarded = partial.lock().clone().unwrap();
    assert!(forwarded.port().is_none());
    assert!(forwarded.status().is_none());
    assert!(forwarded.agents().is_none());
    assert_eq!(
        protocol::js::stringify(forwarded.original()),
        r#"{"id":"only","name":"N","host":"h"}"#
    );
    partial_channel.stop().await;
    let (numeric, numeric_body, _) = exchange(
        channel.bound_port(),
        "POST",
        "/api/mesh/join",
        Some(r#"{"id":1,"name":"N","host":"10.0.0.9"}"#),
        &[("authorization", "Bearer test-secret-123")],
    )
    .await;
    assert_eq!(numeric, 400);
    assert_eq!(
        numeric_body["error"],
        json!("Missing required fields: id, name, host")
    );
    channel.stop().await;
}

#[tokio::test]
async fn zero_wait_is_fire_and_forget_and_the_server_still_waits() {
    let (port, seen) = serve_capture(202, r#"{"requestId":"abc"}"#).await;
    let mut config = AgentChannelConfig::new("opus");
    config.peers = vec![peer("grok", port)];
    let tool = AgentChannel::new(config).create_message_tool();
    let result = tool
        .execute(&js(
            json!({ "to_agent": "grok", "message": "x", "wait_for_response": 0 }),
        ))
        .await;
    assert!(result.to_utf8().contains("async — no response expected"));
    assert!(result.to_utf8().contains("Request ID: abc"));
    let captured = seen.lock().clone();
    assert!(captured.contains("\"waitForResponse\":0"));

    let channel = started("opus").await;
    channel.on_message(|_| async { Ok(()) });
    let (status, body, _) = exchange(
        channel.bound_port(),
        "POST",
        "/api/message",
        Some(r#"{"fromAgent":"grok","message":"wait","waitForResponse":0,"timeoutMs":50}"#),
        &[],
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        body["response"],
        json!("[timeout — agent did not respond in time]")
    );
    channel.stop().await;
}

#[tokio::test]
async fn negative_timeout_fires_and_zero_keeps_waiting() {
    let negative = started("opus").await;
    negative.on_message(|_| async { Ok(()) });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    let response = client
        .post(format!(
            "http://127.0.0.1:{}/api/message",
            negative.bound_port()
        ))
        .header("content-type", "application/json")
        .body(r#"{"fromAgent":"grok","message":"wait","timeoutMs":-1}"#)
        .send()
        .await
        .expect("negative timeout hung");
    assert_eq!(response.status().as_u16(), 200);
    let body: Value = response.json().await.unwrap();
    assert_eq!(
        body["response"],
        json!("[timeout — agent did not respond in time]")
    );
    negative.stop().await;

    let holding = started("opus").await;
    let port = holding.bound_port();
    let seen = AtomicFlag::new();
    let seen_handler = Arc::clone(&seen);
    holding.on_message(move |_| {
        seen_handler.set();
        async { Ok(()) }
    });
    let pending = tokio::spawn(async move {
        exchange(
            port,
            "POST",
            "/api/message",
            Some(r#"{"fromAgent":"grok","message":"hold","timeoutMs":0}"#),
            &[],
        )
        .await
    });
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while !seen.get() {
        if tokio::time::Instant::now() > deadline {
            panic!("zero-timeout handler was not called");
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!pending.is_finished(), "timeoutMs 0 scheduled a timer");
    holding.stop().await;
    let (status, body, _) = pending.await.unwrap();
    assert_eq!(status, 200);
    assert_eq!(body["response"], json!("[channel shutting down]"));

    let (kept_port, kept_body) = serve_capture(200, r#"{"response":"kept"}"#).await;
    let (zero_port, zero_body) = serve_capture(200, r#"{"response":"zero"}"#).await;
    let mut config = AgentChannelConfig::new("opus");
    config.peers = vec![peer("neg", kept_port), peer("zero", zero_port)];
    let tool = AgentChannel::new(config).create_message_tool();
    let kept = tool
        .execute(&js(
            json!({ "to_agent": "neg", "message": "x", "timeout_ms": -1 }),
        ))
        .await;
    assert_eq!(kept.to_utf8(), "kept");
    let zero = tool
        .execute(&js(
            json!({ "to_agent": "zero", "message": "x", "timeout_ms": 0 }),
        ))
        .await;
    assert_eq!(zero.to_utf8(), "zero");
    assert!(kept_body.lock().contains("\"timeoutMs\":-1"));
    assert!(zero_body.lock().contains("\"timeoutMs\":0"));

    let hung = serve_hang().await;
    let mut config = AgentChannelConfig::new("opus");
    config.peers = vec![peer("hung", hung)];
    let tool = AgentChannel::new(config).create_message_tool();
    let aborted = tokio::time::timeout(
        Duration::from_secs(2),
        tool.execute(&js(
            json!({ "to_agent": "hung", "message": "x", "timeout_ms": -6000 }),
        )),
    )
    .await
    .expect("negative outbound timeout hung");
    assert!(
        aborted
            .to_utf8()
            .starts_with("Error sending message to hung:")
    );
}

#[tokio::test]
async fn join_auth_answers_before_the_body_is_read() {
    let mut config = plain("opus");
    config.on_mesh_join = Some(Arc::new(|_| Box::pin(async { Ok(()) })));
    let channel = AgentChannel::new(config);
    channel.start().await.unwrap();
    let status = raw_exchange(
        channel.bound_port(),
        "POST /api/mesh/join HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100000000\r\n\r\n",
    )
    .await;
    assert_eq!(status, 401);

    let disabled = AgentChannel::new(plain("opus"));
    disabled.start().await.unwrap();
    let request = "POST /api/mesh/join HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer test-secret-123\r\nContent-Length: 100000000\r\n\r\n";
    let status = raw_exchange(disabled.bound_port(), request).await;
    assert_eq!(status, 501);
    disabled.stop().await;
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

async fn raw_exchange(port: u16, request: &str) -> u16 {
    let mut sock = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    sock.write_all(request.as_bytes()).await.unwrap();
    let mut buf = vec![0_u8; 512];
    let read = tokio::time::timeout(Duration::from_secs(2), sock.read(&mut buf))
        .await
        .expect("response before the body arrived")
        .unwrap();
    let text = String::from_utf8_lossy(&buf[..read]);
    text.split_whitespace().nth(1).unwrap().parse().unwrap()
}

async fn serve_capture(status: u16, body: &'static str) -> (u16, Arc<Mutex<String>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(String::new()));
    let seen_task = Arc::clone(&seen);
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let raw = read_http(&mut sock).await;
        *seen_task.lock() = raw;
        let response = format!(
            "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = sock.write_all(response.as_bytes()).await;
    });
    (port, seen)
}

async fn read_http(sock: &mut tokio::net::TcpStream) -> String {
    let mut buf = Vec::new();
    let mut tmp = [0_u8; 1024];
    loop {
        let read = sock.read(&mut tmp).await.unwrap_or(0);
        if read == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..read]);
        if let Some(header_end) = buf.windows(4).position(|window| window == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&buf[..header_end]);
            let length = headers
                .lines()
                .find(|line| line.to_ascii_lowercase().starts_with("content-length:"))
                .and_then(|line| line.split_once(':'))
                .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                .unwrap_or(0);
            if buf.len() >= header_end + 4 + length {
                break;
            }
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

async fn serve_hang() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        if let Ok((mut sock, _)) = listener.accept().await {
            let _ = read_http(&mut sock).await;
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    });
    port
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
