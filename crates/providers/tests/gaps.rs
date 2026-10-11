use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use futures_util::{Stream, StreamExt};
use protocol::{LlmChunk, ThinkingLevel};
use providers::{
    ChatRequest, CliProvider, HermesTokenCounts, HermesTokenKind, HttpProvider, ManifestConfig,
    PermissionAnswer, PermissionAsk, PermissionEvent, Provider, Runner, TokenCommandInput,
    TurnMessage, chat_completions_url, default_run_command, execute_permission_prompt,
    models_probe_url, normalize_api_prefix, permission_decision_text, process_env,
    read_hermes_session_tokens, session_map_strings, strip_openai_base, tokens_for_turn,
    unknown_tokens, usage_delta, uuid_for_conversation,
};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

struct Resp {
    status: u16,
    body: Vec<u8>,
}

struct Hit {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    body: String,
}

struct Gate {
    responses: Mutex<Vec<Resp>>,
    hits: Mutex<Vec<Hit>>,
}

impl Gate {
    fn script(&self, items: &[(&str, u16)]) {
        let mut responses = self.responses.lock();
        responses.clear();
        for (body, status) in items {
            responses.push(Resp {
                status: *status,
                body: body.as_bytes().to_vec(),
            });
        }
        self.hits.lock().clear();
    }

    fn hits(&self) -> Vec<Hit> {
        self.hits.lock().clone()
    }
}

impl Clone for Hit {
    fn clone(&self) -> Self {
        Self {
            method: self.method.clone(),
            target: self.target.clone(),
            headers: self.headers.clone(),
            body: self.body.clone(),
        }
    }
}

async fn serve() -> (String, Arc<Gate>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let gate = Arc::new(Gate {
        responses: Mutex::new(Vec::new()),
        hits: Mutex::new(Vec::new()),
    });
    let bound = Arc::clone(&gate);
    tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = listener.accept().await else {
                break;
            };
            let bound = Arc::clone(&bound);
            tokio::spawn(async move {
                let _ = handle(sock, bound).await;
            });
        }
    });
    (format!("http://127.0.0.1:{port}"), gate)
}

async fn handle(mut sock: TcpStream, gate: Arc<Gate>) -> std::io::Result<()> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    loop {
        let Some(at) = header_end(&buf) else {
            let n = sock.read(&mut tmp).await?;
            if n == 0 {
                return Ok(());
            }
            buf.extend_from_slice(&tmp[..n]);
            continue;
        };
        let head = String::from_utf8_lossy(&buf[..at]).to_string();
        let Some(parsed) = parse_head(&head) else {
            return Ok(());
        };
        let mut body = buf[at + 4..].to_vec();
        while body.len() < parsed.length {
            let n = sock.read(&mut tmp).await?;
            if n == 0 {
                break;
            }
            body.extend_from_slice(&tmp[..n]);
        }
        let payload = if body.len() >= parsed.length {
            body[..parsed.length].to_vec()
        } else {
            body.clone()
        };
        let leftover = if body.len() > parsed.length {
            body[parsed.length..].to_vec()
        } else {
            Vec::new()
        };
        let response = {
            let mut responses = gate.responses.lock();
            let response = if responses.is_empty() {
                Resp {
                    status: 200,
                    body: br#"{"data":[]}"#.to_vec(),
                }
            } else {
                responses.remove(0)
            };
            gate.hits.lock().push(Hit {
                method: parsed.method,
                target: parsed.target,
                headers: parsed.headers,
                body: String::from_utf8_lossy(&payload).into_owned(),
            });
            response
        };
        write_response(&mut sock, &response).await?;
        buf = leftover;
    }
}

fn header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|window| window == b"\r\n\r\n")
}

struct Head {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    length: usize,
}

fn parse_head(head: &str) -> Option<Head> {
    let mut lines = head.split("\r\n");
    let request = lines.next()?;
    let mut parts = request.split(' ');
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();
    let mut headers = Vec::new();
    let mut length = 0usize;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let (name, value) = line.split_once(':')?;
        let value = value.trim_start().to_string();
        if name.eq_ignore_ascii_case("content-length") {
            length = value.parse().unwrap_or(0);
        }
        headers.push((name.to_string(), value));
    }
    Some(Head {
        method,
        target,
        headers,
        length,
    })
}

async fn write_response(sock: &mut TcpStream, resp: &Resp) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {} OK\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n",
        resp.status,
        resp.body.len()
    );
    sock.write_all(head.as_bytes()).await?;
    sock.write_all(&resp.body).await?;
    sock.flush().await?;
    Ok(())
}

fn header<'a>(hit: &'a Hit, name: &str) -> Option<&'a str> {
    hit.headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

fn mint_runner(counter: Arc<AtomicU64>) -> Runner {
    Arc::new(move |_argv, _timeout| {
        let n = counter.fetch_add(1, Ordering::SeqCst) + 1;
        Box::pin(async move { Ok(format!("tok-{n}")) })
    })
}

fn token_source(counter: Arc<AtomicU64>) -> Arc<providers::TokenSource> {
    Arc::new(
        providers::TokenSource::build(
            vec!["mint".to_string()],
            Some(60_000),
            Some(1_000),
            None,
            Some(mint_runner(counter)),
            None,
        )
        .unwrap(),
    )
}

fn scratch(name: &str) -> String {
    let dir = format!("/tmp/rr6p-gaps-{}-{name}", std::process::id());
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_script(path: &str, body: &str) {
    std::fs::write(path, body).unwrap();
    let mut perms = std::fs::metadata(path).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms).unwrap();
}

fn bash_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

fn chat(user: &str, key: &str, timeout_ms: u64) -> ChatRequest {
    let mut request = ChatRequest::simple("sys", user, ThinkingLevel::Off);
    request.tools.clear();
    request.conversation_key = Some(key.to_string());
    request.timeout = Duration::from_millis(timeout_ms);
    request
}

fn err_of<T>(result: Result<T, providers::ProviderError>) -> providers::ProviderError {
    match result {
        Err(err) => err,
        Ok(_) => panic!("expected provider error"),
    }
}

async fn drain(
    result: Result<
        impl Stream<Item = Result<LlmChunk, providers::ProviderError>> + Unpin,
        providers::ProviderError,
    >,
) -> Result<Vec<LlmChunk>, providers::ProviderError> {
    let mut stream = result?;
    let mut out = Vec::new();
    while let Some(item) = stream.next().await {
        out.push(item?);
    }
    Ok(out)
}

fn messages_of(body: &str) -> Vec<(String, String)> {
    let value: Value = serde_json::from_str(body).unwrap();
    value["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            (
                item["role"].as_str().unwrap_or("").to_string(),
                item["content"].as_str().unwrap_or("").to_string(),
            )
        })
        .collect()
}

#[test]
fn url_helpers_match_the_prefix_rules() {
    assert_eq!(normalize_api_prefix(None), "/v1");
    assert_eq!(normalize_api_prefix(Some("  ")), "");
    assert_eq!(normalize_api_prefix(Some("/")), "");
    assert_eq!(normalize_api_prefix(Some("v1/")), "/v1");
    assert_eq!(normalize_api_prefix(Some("/custom/")), "/custom");
    assert_eq!(strip_openai_base("http://h:1/v1/"), "http://h:1");
    assert_eq!(
        chat_completions_url("http://h:1/v1", ""),
        "http://h:1/chat/completions"
    );
    assert_eq!(
        chat_completions_url("http://h:1", "/v1"),
        "http://h:1/v1/chat/completions"
    );
    assert_eq!(
        models_probe_url("http://h:1/v1", "/custom", Some("http://h:9/override")),
        "http://h:9/override"
    );
}

#[test]
fn process_env_reads_only_named_variables() {
    let map = process_env(&["HOME", "RR6P_ABSENT_ENV_KEY"]);
    if let Ok(home) = std::env::var("HOME") {
        assert_eq!(map.get("HOME").map(String::as_str), Some(home.as_str()));
    }
    assert!(!map.contains_key("RR6P_ABSENT_ENV_KEY"));
}

#[test]
fn warm_outside_a_runtime_does_not_panic_or_mint() {
    let counter = Arc::new(AtomicU64::new(0));
    let config = ManifestConfig {
        model: "grok-test".to_string(),
        token_argv: Some(vec!["mint".to_string()]),
        token_runner: Some(mint_runner(Arc::clone(&counter))),
        ..Default::default()
    };
    let provider = HttpProvider::from_manifest("xai", config).unwrap();
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(counter.load(Ordering::SeqCst), 0);
    assert!(provider.warnings().is_empty());
}

#[test]
fn shell_string_token_command_warns_and_still_registers() {
    let config = ManifestConfig {
        model: "claude-test".to_string(),
        token_command: Some(TokenCommandInput::String("echo hi".to_string())),
        ..Default::default()
    };
    let provider = HttpProvider::from_manifest("anthropic", config).unwrap();
    let warnings = provider.warnings();
    assert!(
        warnings
            .iter()
            .any(|item| { item == "token_command must be an argv array (no shell string)" })
    );
    assert!(warnings.iter().any(|item| {
        item == "No Anthropic API key found. Set ANTHROPIC_API_KEY or providers.anthropic.api_key"
    }));
    let empty = ManifestConfig {
        model: "m".to_string(),
        base_url: Some("http://127.0.0.1:9".to_string()),
        token_command: Some(TokenCommandInput::Array(Vec::new())),
        ..Default::default()
    };
    let provider = HttpProvider::from_manifest("vllm", empty).unwrap();
    assert!(
        provider
            .warnings()
            .iter()
            .any(|item| { item == "token_command must be a non-empty argv array" })
    );
}

#[test]
fn hermes_token_math_and_message_fallback() {
    let before = HermesTokenCounts {
        input: Some(10.0),
        output: Some(4.0),
        cache_read: Some(1.0),
        cache_write: None,
        reasoning: None,
    };
    let after = HermesTokenCounts {
        input: Some(16.0),
        output: Some(3.0),
        cache_read: Some(1.0),
        cache_write: Some(2.0),
        reasoning: None,
    };
    let delta = usage_delta(&before, &after);
    assert_eq!(delta.input, Some(6.0));
    assert_eq!(delta.output, Some(0.0));
    assert_eq!(delta.cache_read, Some(0.0));
    assert_eq!(delta.cache_write, None);
    let prior = providers::HermesTokenSnapshot {
        kind: HermesTokenKind::SessionTotal,
        counts: before,
    };
    let later = providers::HermesTokenSnapshot {
        kind: HermesTokenKind::SessionTotal,
        counts: after.clone(),
    };
    assert_eq!(tokens_for_turn(false, &prior, &later).input, Some(16.0));
    assert_eq!(tokens_for_turn(true, &prior, &later).input, Some(6.0));
    assert_eq!(unknown_tokens().kind, HermesTokenKind::Unknown);
    let dir = scratch("hermes-math");
    let path = format!("{dir}/state.db");
    assert_eq!(
        read_hermes_session_tokens(&path, "missing").kind,
        HermesTokenKind::Unknown
    );
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (id TEXT, note TEXT);
             CREATE TABLE messages (
               session_id TEXT, role TEXT, timestamp REAL, token_count TEXT
             );
             INSERT INTO sessions (id, note) VALUES ('s1', 'none');
             INSERT INTO messages (session_id, role, timestamp, token_count)
               VALUES ('s1', 'assistant', 2, '9');
             INSERT INTO messages (session_id, role, timestamp, token_count)
               VALUES ('s1', 'assistant', 1, '4');",
        )
        .unwrap();
    }
    let snap = read_hermes_session_tokens(&path, "s1");
    assert_eq!(snap.kind, HermesTokenKind::Message);
    assert_eq!(snap.counts.output, Some(9.0));
}

#[tokio::test]
async fn from_manifest_warms_a_token_command_on_xai() {
    let counter = Arc::new(AtomicU64::new(0));
    let config = ManifestConfig {
        model: "grok-test".to_string(),
        token_argv: Some(vec!["mint".to_string()]),
        token_runner: Some(mint_runner(Arc::clone(&counter))),
        ..Default::default()
    };
    let provider = HttpProvider::from_manifest("xai", config).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while counter.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(counter.load(Ordering::SeqCst), 1);
    assert!(provider.warnings().is_empty());
    assert!(provider.api_key().is_none());
}

#[tokio::test]
async fn env_keys_fall_back_and_blank_config_does_not() {
    let (base, gate) = serve().await;
    let mut blank = ManifestConfig {
        model: "claude-test".to_string(),
        api_key: Some(String::new()),
        ..Default::default()
    };
    blank
        .env
        .insert("ANTHROPIC_API_KEY".to_string(), "from-env".to_string());
    let provider = HttpProvider::from_manifest("anthropic", blank).unwrap();
    assert!(provider.api_key().is_none());
    assert!(provider.warnings().iter().any(|item| {
        item == "No Anthropic API key found. Set ANTHROPIC_API_KEY or providers.anthropic.api_key"
    }));

    let cases = [
        (
            "anthropic",
            "ANTHROPIC_API_KEY",
            "anth-env",
            "x-api-key",
            false,
        ),
        ("xai", "XAI_API_KEY", "xai-env", "authorization", true),
        ("google", "GOOGLE_API_KEY", "goog-env", "", false),
        ("vllm", "VLLM_API_KEY", "vllm-env", "authorization", true),
        (
            "llama-server",
            "LLAMA_SERVER_API_KEY",
            "llama-env",
            "authorization",
            true,
        ),
    ];
    for (wire, env_name, secret, header_name, bearer) in cases {
        gate.script(&[("{}", 200)]);
        let mut config = ManifestConfig {
            model: "test-model".to_string(),
            base_url: matches!(wire, "vllm" | "llama-server").then(|| base.clone()),
            ..Default::default()
        };
        config.env.insert(env_name.to_string(), secret.to_string());
        let provider = HttpProvider::from_manifest(wire, config).unwrap();
        if !matches!(wire, "vllm" | "llama-server") {
            provider.set_base_url(base.clone());
        }
        assert_eq!(provider.api_key().as_deref(), Some(secret));
        assert!(provider.is_available().await, "{wire} probe");
        let hits = gate.hits();
        assert_eq!(hits.len(), 1, "{wire}");
        if wire == "google" {
            assert!(
                hits[0].target.contains("key=goog-env"),
                "{}",
                hits[0].target
            );
        } else if bearer {
            assert_eq!(
                header(&hits[0], header_name),
                Some(format!("Bearer {secret}")).as_deref()
            );
        } else {
            assert_eq!(header(&hits[0], header_name), Some(secret));
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    let mut ollama = ManifestConfig {
        base_url: Some(base),
        ..Default::default()
    };
    ollama
        .env
        .insert("OLLAMA_API_KEY".to_string(), "nope".to_string());
    let provider = HttpProvider::from_manifest("ollama", ollama).unwrap();
    assert!(provider.api_key().is_none());
    assert!(provider.warnings().is_empty());
}

#[tokio::test]
async fn token_401_remints_once_on_every_wire() {
    let (base, gate) = serve().await;
    let wires = ["anthropic", "xai", "vllm", "llama-server", "ollama"];
    for wire in wires {
        gate.script(&[("", 401), (r#"{"data":[{"id":"served"}]}"#, 200)]);
        let counter = Arc::new(AtomicU64::new(0));
        let provider = match wire {
            "anthropic" => HttpProvider::anthropic("static", "test-model").unwrap(),
            "xai" => HttpProvider::xai("static", "test-model").unwrap(),
            "vllm" => HttpProvider::vllm(Some("static".to_string()), "test-model", &base).unwrap(),
            "llama-server" => {
                HttpProvider::llama(Some("static".to_string()), "test-model", &base).unwrap()
            }
            _ => HttpProvider::ollama("test-model", &base).unwrap(),
        };
        if !matches!(wire, "vllm" | "llama-server" | "ollama") {
            provider.set_base_url(base.clone());
        }
        provider.set_token_source(Some(token_source(Arc::clone(&counter))));
        assert!(provider.is_available().await, "{wire}");
        let hits = gate.hits();
        assert_eq!(hits.len(), 2, "{wire} retries once");
        if wire == "ollama" {
            assert_eq!(counter.load(Ordering::SeqCst), 0);
        } else {
            assert_eq!(counter.load(Ordering::SeqCst), 2, "{wire}");
            assert_eq!(
                header(&hits[0], "authorization").or_else(|| header(&hits[0], "x-api-key")),
                Some(if wire == "anthropic" {
                    "tok-1"
                } else {
                    "Bearer tok-1"
                })
            );
            assert_eq!(
                header(&hits[1], "authorization").or_else(|| header(&hits[1], "x-api-key")),
                Some(if wire == "anthropic" {
                    "tok-2"
                } else {
                    "Bearer tok-2"
                })
            );
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

#[tokio::test]
async fn static_key_401_does_not_retry() {
    let (base, gate) = serve().await;
    gate.script(&[("", 401), ("{}", 200)]);
    let provider = HttpProvider::anthropic("static-key", "test-model").unwrap();
    provider.set_base_url(base.clone());
    assert!(!provider.is_available().await);
    assert_eq!(gate.hits().len(), 1);
    assert_eq!(header(&gate.hits()[0], "x-api-key"), Some("static-key"));

    gate.script(&[("", 401), ("{}", 200)]);
    let provider = HttpProvider::google("static-key", "test-model").unwrap();
    provider.set_base_url(base);
    assert!(!provider.is_available().await);
    let hits = gate.hits();
    assert_eq!(hits.len(), 1);
    assert!(
        hits[0].target.contains("key=static-key"),
        "{}",
        hits[0].target
    );
}

#[tokio::test]
async fn google_probe_query_key_and_chat_header_remint() {
    let (base, gate) = serve().await;
    gate.script(&[("", 401), ("{}", 200)]);
    let counter = Arc::new(AtomicU64::new(0));
    let provider = HttpProvider::google("static", "test-model").unwrap();
    provider.set_base_url(base.clone());
    provider.set_token_source(Some(token_source(Arc::clone(&counter))));
    assert!(provider.is_available().await);
    let hits = gate.hits();
    assert_eq!(hits.len(), 2);
    assert!(hits[0].target.contains("key=tok-1"), "{}", hits[0].target);
    assert!(hits[1].target.contains("key=tok-2"), "{}", hits[1].target);
    assert_eq!(counter.load(Ordering::SeqCst), 2);

    gate.script(&[("", 401), ("", 200)]);
    let counter = Arc::new(AtomicU64::new(0));
    let provider = HttpProvider::google("static", "test-model").unwrap();
    provider.set_base_url(base);
    provider.set_token_source(Some(token_source(counter)));
    provider.stream_chat(chat("hi", "g", 5_000)).await.unwrap();
    let hits = gate.hits();
    assert_eq!(hits.len(), 2);
    assert_eq!(header(&hits[0], "x-goog-api-key"), Some("tok-1"));
    assert_eq!(header(&hits[1], "x-goog-api-key"), Some("tok-2"));
    assert!(!hits[0].target.contains("key="));
}

#[tokio::test]
async fn second_401_is_returned() {
    let (base, gate) = serve().await;
    gate.script(&[("", 401), ("nope", 401)]);
    let counter = Arc::new(AtomicU64::new(0));
    let provider = HttpProvider::xai("static", "test-model").unwrap();
    provider.set_base_url(base);
    provider.set_token_source(Some(token_source(Arc::clone(&counter))));
    assert!(!provider.is_available().await);
    assert_eq!(gate.hits().len(), 2);
    assert_eq!(counter.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn vllm_prefix_models_url_and_llama_ignores_both() {
    let (base, gate) = serve().await;
    gate.script(&[("{}", 200)]);
    let config = ManifestConfig {
        model: "m".to_string(),
        base_url: Some(format!("{base}/v1")),
        api_prefix: Some("custom".to_string()),
        ..Default::default()
    };
    let provider = HttpProvider::from_manifest("vllm", config).unwrap();
    assert!(provider.is_available().await);
    assert_eq!(gate.hits()[0].target, "/custom/models");

    gate.script(&[("{}", 200)]);
    let config = ManifestConfig {
        model: "m".to_string(),
        base_url: Some(base.clone()),
        api_prefix: Some("  ".to_string()),
        ..Default::default()
    };
    let provider = HttpProvider::from_manifest("vllm", config).unwrap();
    assert!(provider.is_available().await);
    assert_eq!(gate.hits()[0].target, "/models");

    gate.script(&[("{}", 200)]);
    let config = ManifestConfig {
        model: "m".to_string(),
        base_url: Some(base.clone()),
        api_prefix: Some("/custom".to_string()),
        models_url: Some(format!("{base}/override")),
        ..Default::default()
    };
    let provider = HttpProvider::from_manifest("vllm", config).unwrap();
    assert!(provider.is_available().await);
    assert_eq!(gate.hits()[0].target, "/override");

    gate.script(&[("{}", 200)]);
    let config = ManifestConfig {
        model: "m".to_string(),
        base_url: Some(format!("{base}/v1")),
        api_prefix: Some("/custom".to_string()),
        models_url: Some(format!("{base}/override")),
        ..Default::default()
    };
    let provider = HttpProvider::from_manifest("llama-server", config).unwrap();
    assert!(provider.is_available().await);
    assert_eq!(gate.hits()[0].target, "/v1/models");
}

#[tokio::test]
async fn fold_system_on_vllm_and_llama_only() {
    let (base, gate) = serve().await;
    let mut request = chat("ask", "fold", 5_000);
    request.system = "lead".to_string();
    request.messages.push(TurnMessage::System {
        text: "later".to_string(),
    });
    request.messages.push(TurnMessage::System {
        text: String::new(),
    });
    request.messages.push(TurnMessage::User {
        parts: Vec::new(),
        text: "after".to_string(),
    });
    for (wire, fold) in [("vllm", true), ("llama-server", true), ("ollama", false)] {
        gate.script(&[("", 200)]);
        let provider = match wire {
            "vllm" => HttpProvider::vllm(None, "m", &base).unwrap(),
            "llama-server" => HttpProvider::llama(None, "m", &base).unwrap(),
            _ => HttpProvider::ollama("m", &base).unwrap(),
        };
        provider.stream_chat(request.clone()).await.unwrap();
        let folded = messages_of(&gate.hits()[0].body);
        if fold {
            assert_eq!(
                folded,
                vec![
                    ("system".to_string(), "lead".to_string()),
                    ("user".to_string(), "ask".to_string()),
                    ("user".to_string(), "[SYSTEM NOTICE]\nlater".to_string()),
                    (
                        "user".to_string(),
                        "[SYSTEM NOTICE]\n(empty system message)".to_string()
                    ),
                    ("user".to_string(), "after".to_string()),
                ],
                "{wire}"
            );
        } else {
            assert_eq!(folded[0], ("system".to_string(), "lead".to_string()));
            assert_eq!(folded[2], ("user".to_string(), "later".to_string()));
            assert_eq!(folded[3], ("user".to_string(), String::new()));
        }
    }
}

#[tokio::test]
async fn catalog_floor_discovery_and_probe_warning() {
    let floor = ManifestConfig {
        base_url: Some("http://127.0.0.1:9".to_string()),
        model: "pinned".to_string(),
        models: Some(vec!["floor-a".to_string(), "floor-b".to_string()]),
        probe_models: Some(false),
        ..Default::default()
    };
    let provider = HttpProvider::from_manifest("vllm", floor).unwrap();
    assert!(provider.warnings().is_empty());
    assert_eq!(
        provider.list_models().await.unwrap(),
        vec!["floor-a".to_string(), "floor-b".to_string()]
    );
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(
        provider.list_models().await.unwrap(),
        vec!["floor-a".to_string(), "floor-b".to_string()]
    );

    let unpinned = ManifestConfig {
        base_url: Some("http://127.0.0.1:9".to_string()),
        probe_models: Some(false),
        ..Default::default()
    };
    let provider = HttpProvider::from_manifest("vllm", unpinned).unwrap();
    assert!(
        provider
            .warnings()
            .iter()
            .any(|item| { item.contains("probe_models is false and model is unset/default") })
    );
    assert!(provider.list_models().await.unwrap().is_empty());
    assert!(provider.is_available().await);

    let quiet = ManifestConfig {
        base_url: Some("http://127.0.0.1:9".to_string()),
        model: "real".to_string(),
        probe_models: Some(false),
        ..Default::default()
    };
    let provider = HttpProvider::from_manifest("vllm", quiet).unwrap();
    assert!(provider.warnings().is_empty());
    assert!(provider.is_available().await);

    let (base, gate) = serve().await;
    gate.script(&[(
        r#"{"data":[{"id":"alpha","max_model_len":32768},{"id":"beta","max_model_len":1000}]}"#,
        200,
    )]);
    let provider = HttpProvider::vllm(None, "default", &base).unwrap();
    assert!(provider.is_available().await);
    assert_eq!(provider.get_model(), "alpha");
    assert_eq!(provider.context_window(), 32768);
    assert!(
        provider
            .warnings()
            .iter()
            .any(|item| { item.contains("auto-selected model \"alpha\" (also available: beta)") })
    );
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(gate.hits().len(), 1);

    gate.script(&[(
        r#"{"data":[{"id":"alpha","max_model_len":1},{"id":"beta","max_model_len":2}]}"#,
        200,
    )]);
    let provider = HttpProvider::llama(None, "default", &base).unwrap();
    assert!(provider.is_available().await);
    assert_eq!(provider.get_model(), "alpha");
    assert!(
        provider
            .warnings()
            .iter()
            .any(|item| { item.contains("auto-selected served model \"alpha\"") })
    );
    assert!(
        !provider
            .warnings()
            .iter()
            .any(|item| item.contains("also available"))
    );

    gate.script(&[(
        r#"{"data":[{"id":"test-model","meta":{"n_ctx_train":999}}]}"#,
        200,
    )]);
    let provider = HttpProvider::llama(None, "test-model", &base).unwrap();
    assert!(provider.is_available().await);
    assert_eq!(provider.get_model(), "test-model");
    assert_eq!(provider.context_window(), 0);

    gate.script(&[(
        r#"{"data":[{"id":"test-model","max_model_len":32768}]}"#,
        200,
    )]);
    let provider = HttpProvider::vllm(None, "test-model", &base).unwrap();
    assert!(provider.is_available().await);
    assert_eq!(provider.get_model(), "test-model");
    assert_eq!(provider.context_window(), 32768);
    assert!(provider.warnings().is_empty());

    gate.script(&[(r#"{"data":[{"id":"other"}]}"#, 200)]);
    let mut provider = HttpProvider::vllm(None, "missing", &base).unwrap();
    provider.set_verify_model(true);
    assert!(!provider.is_available().await);
    assert!(provider.warnings().iter().any(|item| {
        item.contains("configured model \"missing\"") && item.contains("(served: other)")
    }));
}

#[tokio::test]
async fn ollama_unload_posts_keep_alive_zero() {
    let (base, gate) = serve().await;
    gate.script(&[("nope", 500), ("{}", 200)]);
    let provider = HttpProvider::ollama("", &base).unwrap();
    assert_eq!(provider.get_model(), "llama3.1");
    provider.unload_model(None).await.unwrap();
    provider
        .unload_model(Some("mistral".to_string()))
        .await
        .unwrap();
    let hits = gate.hits();
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].method, "POST");
    assert_eq!(hits[0].target, "/api/chat");
    assert_eq!(header(&hits[0], "content-type"), Some("application/json"));
    assert_eq!(
        hits[0].body,
        r#"{"model":"llama3.1","messages":[],"keep_alive":"0"}"#
    );
    assert_eq!(
        hits[1].body,
        r#"{"model":"mistral","messages":[],"keep_alive":"0"}"#
    );
    let vllm = HttpProvider::vllm(None, "m", &base).unwrap();
    vllm.unload_model(None).await.unwrap();
    assert_eq!(gate.hits().len(), 2);
    let dead = HttpProvider::ollama("m", "http://127.0.0.1:9").unwrap();
    assert!(dead.unload_model(None).await.is_err());
}

#[tokio::test]
async fn permission_prompt_allow_deny_and_empty_tool() {
    assert_eq!(
        permission_decision_text("allow", Some("ignored")),
        "{\"behavior\":\"allow\"}"
    );
    let called = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&called);
    let text = execute_permission_prompt(
        "task",
        "",
        Value::Null,
        None,
        move |_ask: PermissionAsk| {
            flag.store(true, Ordering::SeqCst);
            async {
                Ok(PermissionAnswer {
                    behavior: "allow".to_string(),
                    message: None,
                    decision: "allow".to_string(),
                })
            }
        },
        |_event| {},
    )
    .await;
    assert!(!called.load(Ordering::SeqCst));
    assert_eq!(
        text,
        "{\"behavior\":\"deny\",\"message\":\"permission request missing tool_name\"}"
    );
    let events = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&events);
    let text = execute_permission_prompt(
        "task-1",
        "Bash",
        json!({"cmd": "ls"}),
        Some("tu-1".to_string()),
        |ask: PermissionAsk| async move {
            assert_eq!(ask.name, "Bash");
            assert_eq!(ask.task_id, "task-1");
            assert!(ask.request_id.starts_with("perm-"));
            Ok(PermissionAnswer {
                behavior: "allow".to_string(),
                message: None,
                decision: "allow".to_string(),
            })
        },
        move |event: PermissionEvent| seen.lock().push(event),
    )
    .await;
    assert_eq!(text, "{\"behavior\":\"allow\"}");
    let events = events.lock().clone();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].kind, "approval-request");
    assert_eq!(events[0].name.as_deref(), Some("Bash"));
    assert_eq!(events[0].tool_call_id.as_deref(), Some("tu-1"));
    assert_eq!(events[1].kind, "approval-resolved");
    assert_eq!(events[1].decision.as_deref(), Some("allow"));
    assert_eq!(events[0].request_id, events[1].request_id);
    let text = execute_permission_prompt(
        "task-1",
        "Bash",
        json!({}),
        None,
        |_ask: PermissionAsk| async { Err(()) },
        |_event| {},
    )
    .await;
    assert_eq!(
        text,
        "{\"behavior\":\"deny\",\"message\":\"permission request failed closed\"}"
    );
}

#[tokio::test]
async fn cli_sessions_hermes_db_and_signals() {
    let dir = scratch("cli");
    let home = format!("{dir}/home");
    std::fs::create_dir_all(&home).unwrap();

    let mut missing = CliProvider::hermes(format!("{dir}/no-such-hermes"));
    missing.set_home(Some(home.clone()));
    missing.set_session_map_path(Some(format!("{dir}/unused-map.json")));
    missing.set_hermes_db_path(Some(format!("{dir}/unused.db")));
    let err = err_of(missing.stream_chat(chat("hi", "c", 1_000)).await);
    assert!(err.message.contains("hermes binary not found at"));
    assert!(!Path::new(&format!("{dir}/unused-map.json")).exists());

    let db = format!("{dir}/state.db");
    {
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (
               id TEXT PRIMARY KEY,
               input_tokens REAL,
               output_tokens REAL,
               cache_read_tokens REAL,
               cache_write_tokens REAL,
               reasoning_tokens REAL
             );
             INSERT INTO sessions VALUES ('ses-1', 10, 4, 1, 0, 0);",
        )
        .unwrap();
    }
    let hermes_bin = format!("{dir}/hermes");
    let hermes_flag = format!("{dir}/hermes-flag");
    write_script(
        &hermes_bin,
        &format!(
            "#!/bin/bash\nflag={flag}\ndb={db}\nif [ -f \"$flag\" ]; then\n  HERMES_DB=\"$db\" python3 -c 'import sqlite3,os; c=sqlite3.connect(os.environ[\"HERMES_DB\"]); c.execute(\"UPDATE sessions SET input_tokens=16, output_tokens=9 WHERE id=?\", (\"ses-1\",)); c.commit()'\nelse\n  : > \"$flag\"\nfi\necho hello\necho 'session_id: ses-1' >&2\nexit 0\n",
            flag = bash_quote(&hermes_flag),
            db = bash_quote(&db)
        ),
    );
    let map = format!("{dir}/hermes-map.json");
    let mut hermes = CliProvider::hermes(&hermes_bin);
    hermes.set_home(Some(home.clone()));
    hermes.set_session_map_path(Some(map.clone()));
    hermes.set_hermes_db_path(Some(db.clone()));
    drain(hermes.stream_chat(chat("hi", "conv", 2_000)).await)
        .await
        .unwrap();
    assert_eq!(
        session_map_strings(&map).get("conv").map(String::as_str),
        Some("ses-1")
    );
    assert_eq!(hermes.hermes_turn_counts().input, Some(10.0));
    drain(hermes.stream_chat(chat("again", "conv", 2_000)).await)
        .await
        .unwrap();
    assert_eq!(hermes.hermes_turn_counts().input, Some(6.0));
    assert_eq!(hermes.hermes_turn_counts().output, Some(5.0));

    let codex_log = format!("{dir}/codex-args");
    let codex_bin = format!("{dir}/codex");
    write_script(
        &codex_bin,
        &format!(
            "#!/bin/bash\nprintf '%s\\n' \"$@\" >> {}\nif printf '%s\\n' \"$@\" | grep -q resume; then\n  exit 1\nfi\necho '{{\"type\":\"thread.started\",\"thread_id\":\"thr-1\"}}'\necho '{{\"type\":\"item.completed\",\"item\":{{\"type\":\"agent_message\",\"text\":\"hi\"}}}}'\nexit 0\n",
            bash_quote(&codex_log)
        ),
    );
    let codex_map = format!("{dir}/codex-map.json");
    let mut codex = CliProvider::codex(&codex_bin);
    codex.set_home(Some(home.clone()));
    codex.set_session_map_path(Some(codex_map.clone()));
    drain(codex.stream_chat(chat("hi", "conv", 2_000)).await)
        .await
        .unwrap();
    assert_eq!(
        session_map_strings(&codex_map)
            .get("conv")
            .map(String::as_str),
        Some("thr-1")
    );
    let mode = std::fs::metadata(&codex_map).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    let err = drain(codex.stream_chat(chat("again", "conv", 2_000)).await)
        .await
        .unwrap_err();
    assert!(err.message.contains("codex"));
    assert!(!session_map_strings(&codex_map).contains_key("conv"));
    let logged = std::fs::read_to_string(&codex_log).unwrap();
    assert!(logged.contains("resume"));
    assert!(logged.contains("thr-1"));

    let qwen_log = format!("{dir}/qwen-args");
    let qwen_map = format!("{dir}/qwen-map.json");
    let qwen_bin = format!("{dir}/qwen");
    write_script(
        &qwen_bin,
        &format!(
            "#!/bin/bash\nlog={}\nmap={}\nprintf '%s\\n' \"$@\" >> \"$log\"\nsid=\"\"\nprev=\"\"\nfor arg in \"$@\"; do\n  if [ \"$prev\" = \"--session-id\" ] || [ \"$prev\" = \"--resume\" ]; then sid=\"$arg\"; fi\n  prev=\"$arg\"\ndone\nif [ -n \"$sid\" ] && ! grep -q -F \"$sid\" \"$map\"; then echo missing >> \"$log\"; exit 3; fi\nfor arg in \"$@\"; do\n  if [ \"$arg\" = \"--resume\" ]; then echo \"No saved session found with ID $sid\"; exit 0; fi\ndone\necho '{{\"text\":\"ok\"}}'\nexit 0\n",
            bash_quote(&qwen_log),
            bash_quote(&qwen_map)
        ),
    );
    let mut qwen = CliProvider::qwen(&qwen_bin);
    qwen.set_home(Some(home.clone()));
    qwen.set_session_map_path(Some(qwen_map.clone()));
    drain(qwen.stream_chat(chat("hi", "conv", 2_000)).await)
        .await
        .unwrap();
    let first = session_map_strings(&qwen_map).get("conv").cloned().unwrap();
    drain(qwen.stream_chat(chat("again", "conv", 2_000)).await)
        .await
        .unwrap();
    let second = session_map_strings(&qwen_map).get("conv").cloned().unwrap();
    assert_ne!(first, second);
    let qlog = std::fs::read_to_string(&qwen_log).unwrap();
    assert!(qlog.contains("--session-id"));
    assert!(qlog.contains("--resume"));
    assert!(!qlog.contains("missing"));

    let pi_log = format!("{dir}/pi-args");
    let pi_bin = format!("{dir}/pi");
    write_script(
        &pi_bin,
        &format!(
            "#!/bin/bash\nprintf '%s\\n' \"$@\" >> {}\necho '{{\"type\":\"session\",\"id\":\"pi-1\"}}'\necho '{{\"text\":\"ok\"}}'\nexit 0\n",
            bash_quote(&pi_log)
        ),
    );
    let pi_map = format!("{dir}/pi-map.json");
    let mut pi = CliProvider::pi(&pi_bin);
    pi.set_home(Some(home.clone()));
    pi.set_session_map_path(Some(pi_map.clone()));
    drain(pi.stream_chat(chat("hi", "conv", 2_000)).await)
        .await
        .unwrap();
    assert_eq!(
        session_map_strings(&pi_map).get("conv").map(String::as_str),
        Some("pi-1")
    );
    drain(pi.stream_chat(chat("again", "conv", 2_000)).await)
        .await
        .unwrap();
    let plog = std::fs::read_to_string(&pi_log).unwrap();
    assert!(plog.contains("--session"));
    assert!(plog.contains("pi-1"));

    let oc_log = format!("{dir}/oc-args");
    let oc_bin = format!("{dir}/oc");
    write_script(
        &oc_bin,
        &format!(
            "#!/bin/bash\nprintf '%s\\n' \"$@\" >> {}\nif printf '%s\\n' \"$@\" | grep -q -- '--session'; then echo 'session not found' >&2; exit 1; fi\necho '{{\"sessionID\":\"oc-1\"}}'\necho '{{\"text\":\"ok\"}}'\nexit 0\n",
            bash_quote(&oc_log)
        ),
    );
    let oc_map = format!("{dir}/oc-map.json");
    let mut opencode = CliProvider::opencode(&oc_bin);
    opencode.set_home(Some(home.clone()));
    opencode.set_session_map_path(Some(oc_map.clone()));
    drain(opencode.stream_chat(chat("hi", "conv", 2_000)).await)
        .await
        .unwrap();
    assert_eq!(
        session_map_strings(&oc_map).get("conv").map(String::as_str),
        Some("oc-1")
    );
    let chunks = drain(opencode.stream_chat(chat("again", "conv", 2_000)).await)
        .await
        .unwrap();
    let text: String = chunks.into_iter().filter_map(|chunk| chunk.delta).collect();
    assert!(text.contains("opencode-cli bridge error"), "{text}");
    assert!(!session_map_strings(&oc_map).contains_key("conv"));

    let kimi_bin = format!("{dir}/kimi");
    write_script(
        &kimi_bin,
        "#!/bin/bash\necho '{\"role\":\"assistant\",\"content\":\"hi\"}'\necho '{\"role\":\"meta\",\"type\":\"session.resume_hint\",\"session_id\":\"kimi-9\"}'\nexit 0\n",
    );
    let kimi_map = format!("{dir}/kimi-map.json");
    let mut kimi = CliProvider::kimi(&kimi_bin);
    kimi.set_home(Some(home.clone()));
    kimi.set_session_map_path(Some(kimi_map.clone()));
    drain(kimi.stream_chat(chat("hi", "conv", 2_000)).await)
        .await
        .unwrap();
    assert_eq!(
        session_map_strings(&kimi_map)
            .get("conv")
            .map(String::as_str),
        Some("kimi-9")
    );

    let grok_log = format!("{dir}/grok-args");
    let grok_bin = format!("{dir}/grok");
    write_script(
        &grok_bin,
        &format!(
            "#!/bin/bash\nprintf '%s\\n' \"$@\" > {}\necho '{{\"type\":\"result\",\"session_id\":\"grok-real\",\"result\":\"ok\"}}'\nexit 0\n",
            bash_quote(&grok_log)
        ),
    );
    let grok_map = format!("{dir}/grok-map.json");
    let mut grok = CliProvider::grok(&grok_bin);
    grok.set_home(Some(home.clone()));
    grok.set_session_map_path(Some(grok_map.clone()));
    drain(grok.stream_chat(chat("hi", "conv", 2_000)).await)
        .await
        .unwrap();
    let first = std::fs::read_to_string(&grok_log).unwrap();
    assert!(first.contains("--session-id"));
    assert!(!first.contains("--resume"));
    assert_eq!(
        session_map_strings(&grok_map)
            .get("conv")
            .map(String::as_str),
        Some("grok-real")
    );
    drain(grok.stream_chat(chat("again", "conv", 2_000)).await)
        .await
        .unwrap();
    let second = std::fs::read_to_string(&grok_log).unwrap();
    assert!(second.contains("--resume"));
    assert!(second.contains("grok-real"));
    grok.set_session_replay(true);
    std::fs::write(&grok_log, "").unwrap();
    drain(grok.stream_chat(chat("replay", "conv", 2_000)).await)
        .await
        .unwrap();
    let replay = std::fs::read_to_string(&grok_log).unwrap();
    assert!(!replay.contains("--resume"));
    assert!(!replay.contains("--session-id"));
    assert_eq!(
        session_map_strings(&grok_map)
            .get("conv")
            .map(String::as_str),
        Some("grok-real")
    );

    let term_file = format!("{dir}/term");
    let term_bin = format!("{dir}/term");
    write_script(
        &term_bin,
        &format!(
            "#!/bin/bash\nfile={}\nprintf '%s' start > \"$file\"\ntrap 'printf %s TERM > \"$file\"; exit 0' TERM\nsleep 30\nprintf '%s' lived > \"$file\"\n",
            bash_quote(&term_file)
        ),
    );
    let mut term = CliProvider::claude(&term_bin);
    term.set_home(Some(home.clone()));
    let started = Instant::now();
    let err = drain(term.stream_chat(chat("hi", "c", 400)).await)
        .await
        .unwrap_err();
    assert!(err.message.contains("timed out"));
    assert!(started.elapsed() < Duration::from_millis(2_500));
    assert_eq!(std::fs::read_to_string(&term_file).unwrap(), "TERM");

    let kill_pid = format!("{dir}/kill-pid");
    let kill_flag = format!("{dir}/kill-lived");
    let kill_bin = format!("{dir}/kill");
    write_script(
        &kill_bin,
        &format!(
            "#!/bin/bash\necho $$ > {}\ntrap '' TERM\nsleep 30\necho lived > {}\n",
            bash_quote(&kill_pid),
            bash_quote(&kill_flag)
        ),
    );
    let mut killer = CliProvider::claude(&kill_bin);
    killer.set_home(Some(home.clone()));
    let started = Instant::now();
    let err = drain(killer.stream_chat(chat("hi", "c", 200)).await)
        .await
        .unwrap_err();
    let elapsed = started.elapsed();
    assert!(err.message.contains("timed out"));
    assert!(elapsed >= Duration::from_millis(2_900), "{elapsed:?}");
    assert!(elapsed < Duration::from_secs(8), "{elapsed:?}");
    assert!(!Path::new(&kill_flag).exists());
    let pid = std::fs::read_to_string(&kill_pid).unwrap();
    let pid = pid.trim();
    assert!(!Path::new(&format!("/proc/{pid}")).exists());

    let drop_file = format!("{dir}/drop-out");
    let drop_bin = format!("{dir}/drop-bin");
    write_script(
        &drop_bin,
        &format!(
            "#!/bin/bash\nfile={}\ntrap 'printf %s TERM > \"$file\"; exit 0' TERM\nprintf '%s' ready > \"$file\"\nsleep 30\n",
            bash_quote(&drop_file)
        ),
    );
    let mut dropped = CliProvider::claude(&drop_bin);
    dropped.set_home(Some(home));
    let stream = dropped.stream_chat(chat("hi", "c", 20_000)).await.unwrap();
    let ready_deadline = Instant::now() + Duration::from_secs(2);
    let mut ready = String::new();
    while Instant::now() < ready_deadline {
        if let Ok(text) = std::fs::read_to_string(&drop_file) {
            ready = text;
            if ready == "ready" {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(ready, "ready");
    drop(stream);
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut saw = String::new();
    while Instant::now() < deadline {
        if let Ok(text) = std::fs::read_to_string(&drop_file) {
            saw = text;
            if saw == "TERM" {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(saw, "TERM");
}

fn script_with(template: &str, pairs: &[(&str, &str)]) -> String {
    let mut body = template.to_string();
    for (key, value) in pairs {
        body = body.replace(key, &bash_quote(value));
    }
    body
}

fn as_map(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        other => panic!("expected object, got {other}"),
    }
}

fn hold_stdout_script(pid_file: &str, lived: &str) -> String {
    script_with(
        r#"#!/bin/bash
pidfile=PIDFILE
lived=LIVED
(
  trap '' TERM HUP
  printf '%s\n' "$BASHPID" > "$pidfile"
  while true; do
    sleep 30
  done
  printf '%s\n' lived > "$lived"
) &
while [ ! -s "$pidfile" ]; do
  sleep 0.05
done
exit 0
"#,
        &[("PIDFILE", pid_file), ("LIVED", lived)],
    )
}

async fn wait_gone(pid: &str) {
    let path = format!("/proc/{pid}");
    let deadline = Instant::now() + Duration::from_secs(2);
    while Path::new(&path).exists() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!Path::new(&path).exists(), "{pid}");
}

#[tokio::test]
async fn cli_timeout_kills_descendants_after_the_leader_exits() {
    let dir = scratch("cli-desc");
    let pid_file = format!("{dir}/pid");
    let lived = format!("{dir}/lived");
    let bin = format!("{dir}/bin");
    write_script(&bin, &hold_stdout_script(&pid_file, &lived));
    let mut provider = CliProvider::claude(&bin);
    provider.set_home(Some(dir));
    let started = Instant::now();
    let err = drain(provider.stream_chat(chat("hi", "desc", 1_000)).await)
        .await
        .unwrap_err();
    let elapsed = started.elapsed();
    assert!(err.message.contains("timed out"), "{}", err.message);
    assert!(elapsed >= Duration::from_millis(3_500), "{elapsed:?}");
    assert!(elapsed < Duration::from_secs(8), "{elapsed:?}");
    assert!(!Path::new(&lived).exists());
    let pid = std::fs::read_to_string(&pid_file).unwrap();
    wait_gone(pid.trim()).await;
}

#[tokio::test]
async fn token_timeout_kills_descendants_after_the_leader_exits() {
    let dir = scratch("tok-desc");
    let pid_file = format!("{dir}/pid");
    let lived = format!("{dir}/lived");
    let bin = format!("{dir}/bin");
    write_script(&bin, &hold_stdout_script(&pid_file, &lived));
    let started = Instant::now();
    let err = default_run_command(&[bin], 600, None).await.unwrap_err();
    let elapsed = started.elapsed();
    assert!(err.contains("timed out"), "{err}");
    assert!(elapsed >= Duration::from_millis(3_200), "{elapsed:?}");
    assert!(elapsed < Duration::from_secs(8), "{elapsed:?}");
    assert!(!Path::new(&lived).exists());
    let pid = std::fs::read_to_string(&pid_file).unwrap();
    wait_gone(pid.trim()).await;
}

#[tokio::test]
async fn qwen_recovered_answer_survives_resume_retry() {
    let dir = scratch("qwen-retry");
    let args_log = format!("{dir}/args");
    let count = format!("{dir}/count");
    let bin = format!("{dir}/qwen");
    write_script(
        &bin,
        &script_with(
            r#"#!/bin/bash
args=ARGS
count=COUNT
printf '\n---\n' >> "$args"
printf '%s\n' "$@" >> "$args"
n=0
if [ -f "$count" ]; then
  IFS= read -r n < "$count" || true
fi
case "$n" in
  ''|*[!0-9]*) n=0 ;;
esac
n=$((n + 1))
printf '%s\n' "$n" > "$count"
if printf '%s\n' "$@" | grep -q -- --resume; then
  printf '%s\n' 'No saved session found with ID stale'
  exit 1
fi
if [ "$n" = 1 ]; then
  printf '%s\n' '{"type":"result","is_error":false,"result":"ok"}'
  exit 0
fi
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"recovered answer"}]}}'
printf '%s\n' '{"type":"result","is_error":false,"result":"recovered answer"}'
exit 0
"#,
            &[("ARGS", args_log.as_str()), ("COUNT", count.as_str())],
        ),
    );
    let map = format!("{dir}/map.json");
    let mut qwen = CliProvider::qwen(&bin);
    qwen.set_home(Some(dir.clone()));
    qwen.set_session_map_path(Some(map));
    drain(qwen.stream_chat(chat("hi", "qwen-recover", 2_000)).await)
        .await
        .unwrap();
    let chunks = drain(qwen.stream_chat(chat("again", "qwen-recover", 2_000)).await)
        .await
        .unwrap();
    let text: String = chunks.into_iter().filter_map(|chunk| chunk.delta).collect();
    assert!(text.contains("recovered answer"), "{text}");
    assert!(!text.contains("qwen-code bridge error"), "{text}");
    let logged = std::fs::read_to_string(&args_log).unwrap();
    assert!(logged.contains("--resume"), "{logged}");
    assert!(logged.contains("--session-id"), "{logged}");
}

#[tokio::test]
async fn grok_fresh_resume_id_wins_over_the_dead_one() {
    let dir = scratch("grok-retry");
    let args_log = format!("{dir}/args");
    let count = format!("{dir}/count");
    let bin = format!("{dir}/grok");
    write_script(
        &bin,
        &script_with(
            r#"#!/bin/bash
args=ARGS
count=COUNT
printf '\n---\n' >> "$args"
printf '%s\n' "$@" >> "$args"
n=0
if [ -f "$count" ]; then
  IFS= read -r n < "$count" || true
fi
case "$n" in
  ''|*[!0-9]*) n=0 ;;
esac
n=$((n + 1))
printf '%s\n' "$n" > "$count"
if printf '%s\n' "$@" | grep -q -- --resume; then
  printf '%s\n' '{"type":"system","session_id":"dead-1"}'
  exit 1
fi
if [ "$n" = 1 ]; then
  printf '%s\n' '{"type":"result","session_id":"dead-1","result":"ok"}'
  exit 0
fi
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"kept"}}}'
exit 0
"#,
            &[("ARGS", args_log.as_str()), ("COUNT", count.as_str())],
        ),
    );
    let map = format!("{dir}/map.json");
    let key = "grok-fresh";
    let expected = uuid_for_conversation(key);
    let mut grok = CliProvider::grok(&bin);
    grok.set_home(Some(dir));
    grok.set_session_map_path(Some(map.clone()));
    drain(grok.stream_chat(chat("hi", key, 2_000)).await)
        .await
        .unwrap();
    assert_eq!(
        session_map_strings(&map).get(key).map(String::as_str),
        Some("dead-1")
    );
    let chunks = drain(grok.stream_chat(chat("again", key, 2_000)).await)
        .await
        .unwrap();
    let text: String = chunks.into_iter().filter_map(|chunk| chunk.delta).collect();
    assert!(text.contains("kept"), "{text}");
    assert_eq!(
        session_map_strings(&map).get(key).map(String::as_str),
        Some(expected.as_str())
    );
}

#[tokio::test]
async fn vllm_extra_body_does_not_override_named_kwargs() {
    let (base, gate) = serve().await;
    gate.script(&[("", 200)]);
    let mut extra = Map::new();
    extra.insert(
        "chat_template_kwargs".to_string(),
        json!({"format": "text"}),
    );
    extra.insert("mm_processor_kwargs".to_string(), json!({"fps": 9}));
    extra.insert(
        "guided_decoding_backend".to_string(),
        Value::from("outlines"),
    );
    extra.insert("temperature".to_string(), json!(0.1));
    let provider = HttpProvider::from_manifest(
        "vllm",
        ManifestConfig {
            base_url: Some(base.clone()),
            model: "m".to_string(),
            probe_models: Some(false),
            chat_template_kwargs: Some(as_map(json!({"format": "json"}))),
            mm_processor_kwargs: Some(json!({"fps": 2})),
            extra_body: Some(extra),
            ..Default::default()
        },
    )
    .unwrap();
    provider
        .stream_chat(chat("ask", "vllm", 5_000))
        .await
        .unwrap();
    let hits = gate.hits();
    let hit = hits
        .iter()
        .find(|hit| hit.target.contains("chat/completions"))
        .unwrap();
    let body: Value = serde_json::from_str(&hit.body).unwrap();
    assert_eq!(body["chat_template_kwargs"]["format"], "json");
    assert_eq!(body["chat_template_kwargs"]["enable_thinking"], false);
    assert_eq!(body["mm_processor_kwargs"]["fps"], 2);
    assert_eq!(body["guided_decoding_backend"], "outlines");
    assert_eq!(body["temperature"].to_string(), "0.7");

    gate.script(&[("", 200)]);
    let mut llama_extra = Map::new();
    llama_extra.insert(
        "guided_decoding_backend".to_string(),
        Value::from("outlines"),
    );
    llama_extra.insert("temperature".to_string(), json!(0.1));
    let llama = HttpProvider::from_manifest(
        "llama-server",
        ManifestConfig {
            base_url: Some(base),
            model: "m".to_string(),
            probe_models: Some(false),
            extra_body: Some(llama_extra),
            ..Default::default()
        },
    )
    .unwrap();
    llama
        .stream_chat(chat("ask", "llama", 5_000))
        .await
        .unwrap();
    let hits = gate.hits();
    let hit = hits
        .iter()
        .rev()
        .find(|hit| hit.target.contains("chat/completions"))
        .unwrap();
    let body: Value = serde_json::from_str(&hit.body).unwrap();
    assert!(body.get("chat_template_kwargs").is_none());
    assert_eq!(body["guided_decoding_backend"], "outlines");
    assert_eq!(body["temperature"].to_string(), "0.7");
}
