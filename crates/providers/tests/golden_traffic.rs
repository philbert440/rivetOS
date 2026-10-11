use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use protocol::ThinkingLevel;
use providers::{HttpProvider, Provider, js_norm, run_agent_turn};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Debug)]
struct Seen {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    body: String,
}

struct Resp {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

struct Slot {
    responses: Vec<Resp>,
    index: usize,
    seen: Vec<Seen>,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn golden_http_traffic() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden");
    let fixtures = [
        ("anthropic", 47811u16),
        ("xai", 47812),
        ("google", 47813),
        ("vllm", 47814),
        ("llama-server", 47815),
        ("ollama", 47816),
    ];
    let mut slots = Vec::new();
    let mut ports = Vec::new();
    for (name, fixture) in fixtures {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let actual = listener.local_addr().unwrap().port();
        let slot = Arc::new(Mutex::new(Slot {
            responses: Vec::new(),
            index: 0,
            seen: Vec::new(),
        }));
        let bound = Arc::clone(&slot);
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
        slots.push(slot);
        ports.push((name, fixture, actual));
    }
    let scenarios = [
        "probe",
        "A-text",
        "B-tool",
        "C-reasoning",
        "D-thinking-off",
        "E-reasoning-tool",
    ];
    for ((name, fixture, actual), slot) in ports.iter().copied().zip(slots.iter()) {
        for scenario in scenarios {
            run_scenario(name, fixture, actual, slot, &root, scenario).await;
        }
    }
}

async fn run_scenario(
    provider: &str,
    fixture: u16,
    actual: u16,
    slot: &Arc<Mutex<Slot>>,
    root: &Path,
    scenario: &str,
) {
    let dir = root.join(provider).join(scenario);
    let requests: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("requests.json")).unwrap()).unwrap();
    let mut responses = Vec::new();
    let mut canned = String::new();
    for item in requests.as_array().unwrap() {
        let served = &item["served"];
        let status = served["status"].as_u64().unwrap() as u16;
        let mut headers = Vec::new();
        for pair in served["headers"].as_array().unwrap() {
            let pair = pair.as_array().unwrap();
            headers.push((
                pair[0].as_str().unwrap().to_string(),
                pair[1].as_str().unwrap().to_string(),
            ));
        }
        let file = served["bodyFile"].as_str().unwrap();
        let body = std::fs::read(dir.join(file)).unwrap();
        canned.push_str(&String::from_utf8_lossy(&body));
        responses.push(Resp {
            status,
            headers,
            body,
        });
    }
    {
        let mut guard = slot.lock().unwrap();
        guard.responses = responses;
        guard.index = 0;
        guard.seen.clear();
    }
    let label = format!("{provider}/{scenario}");
    if scenario == "probe" {
        let provider_impl = build_provider(provider, actual);
        let available = tokio::time::timeout(Duration::from_secs(15), provider_impl.is_available())
            .await
            .unwrap_or_else(|_| panic!("{label} probe timed out"));
        assert!(available, "{label} probe was down");
        if provider == "vllm" {
            assert_eq!(provider_impl.context_window(), 32768, "{label} context");
            assert_eq!(provider_impl.get_model(), "test-model");
        }
        if provider == "llama-server" {
            assert_eq!(provider_impl.context_window(), 0, "{label} context");
            assert_eq!(provider_impl.get_model(), "test-model");
        }
    } else {
        let provider_impl = build_provider(provider, actual);
        let thinking = match scenario {
            "C-reasoning" => ThinkingLevel::High,
            "D-thinking-off" => ThinkingLevel::Off,
            _ => ThinkingLevel::Medium,
        };
        let output = tokio::time::timeout(
            Duration::from_secs(20),
            run_agent_turn(&provider_impl, thinking),
        )
        .await
        .unwrap_or_else(|_| panic!("{label} turn timed out"))
        .unwrap_or_else(|err| panic!("{label} turn failed: {}", err.message));
        let expected_chunks = std::fs::read_to_string(dir.join("chunks.json")).unwrap();
        let expected_events = std::fs::read_to_string(dir.join("events.json")).unwrap();
        let actual_chunks = serde_json::to_string(&output.chunks).unwrap();
        let actual_events = serde_json::to_string(&output.events).unwrap();
        let seen = slot
            .lock()
            .unwrap()
            .seen
            .iter()
            .map(seen_text)
            .collect::<Vec<_>>()
            .join("\n");
        let expected_requests = std::fs::read_to_string(dir.join("requests.json")).unwrap();
        let map = id_map(
            &format!("{expected_requests}\n{expected_chunks}\n{expected_events}"),
            &format!("{seen}\n{actual_chunks}\n{actual_events}"),
            &canned,
        );
        let actual_chunks = apply_map(&mask_secret(&actual_chunks), &map);
        let actual_events = apply_map(&mask_secret(&actual_events), &map);
        assert_same(
            &format!("{label} chunks"),
            &js_norm(&expected_chunks),
            &js_norm(&actual_chunks),
        );
        assert_same(
            &format!("{label} events"),
            &js_norm(&expected_events),
            &js_norm(&actual_events),
        );
    }
    let seen = slot.lock().unwrap().clone_into_seen();
    let expected = requests.as_array().unwrap();
    assert_eq!(
        seen.len(),
        expected.len(),
        "{label} request count\n{seen:?}"
    );
    for (index, (got, want)) in seen.iter().zip(expected.iter()).enumerate() {
        let want_method = want["method"].as_str().unwrap();
        let want_target = mask_secret(want["target"].as_str().unwrap());
        let got_target = swap_authority(
            &apply_map(&mask_secret(&got.target), &id_map_pair(want, got, &canned)),
            actual,
            fixture,
        );
        assert_eq!(got.method, want_method, "{label} request {index} method");
        assert_eq!(got_target, want_target, "{label} request {index} target");
        let want_headers = header_pairs(&want["headers"]);
        let got_headers = norm_headers(&got.headers)
            .into_iter()
            .map(|(name, value)| (name, swap_authority(&value, actual, fixture)))
            .collect::<Vec<_>>();
        assert_eq!(
            got_headers, want_headers,
            "{label} request {index} headers\n got {got_headers:?}\nwant {want_headers:?}"
        );
        let want_body = want["body"].as_str().unwrap();
        let got_body = apply_map(&mask_secret(&got.body), &id_map_pair(want, got, &canned));
        if !want_body.is_empty() {
            let want_len = want_headers
                .iter()
                .find(|(name, _)| name == "content-length")
                .map(|(_, value)| value.clone())
                .unwrap_or_default();
            assert_eq!(
                got.body.len().to_string(),
                want_len,
                "{label} request {index} content-length {} vs body {}",
                want_len,
                got.body.len()
            );
        }
        assert_same(
            &format!("{label} request {index} body"),
            &js_norm(want_body),
            &js_norm(&got_body),
        );
    }
}

fn swap_authority(text: &str, actual: u16, fixture: u16) -> String {
    text.replace(
        &format!("127.0.0.1:{actual}"),
        &format!("127.0.0.1:{fixture}"),
    )
}

fn build_provider(name: &str, port: u16) -> HttpProvider {
    match name {
        "anthropic" => {
            let provider = HttpProvider::anthropic("golden-key", "test-model").unwrap();
            provider.set_base_url(format!("http://127.0.0.1:{port}"));
            provider
        }
        "xai" => {
            let provider = HttpProvider::xai("golden-key", "test-model").unwrap();
            provider.set_base_url(format!("http://127.0.0.1:{port}/v1"));
            provider
        }
        "google" => {
            let provider = HttpProvider::google("golden-key", "test-model").unwrap();
            provider.set_base_url(format!("http://127.0.0.1:{port}/v1beta"));
            provider
        }
        "vllm" => HttpProvider::vllm(
            Some("golden-key".to_string()),
            "test-model",
            format!("http://127.0.0.1:{port}"),
        )
        .unwrap(),
        "llama-server" => HttpProvider::llama(
            Some("golden-key".to_string()),
            "test-model",
            format!("http://127.0.0.1:{port}"),
        )
        .unwrap(),
        "ollama" => HttpProvider::ollama("test-model", format!("http://127.0.0.1:{port}")).unwrap(),
        other => panic!("unknown provider {other}"),
    }
}

trait SeenList {
    fn clone_into_seen(&self) -> Vec<Seen>;
}

impl SeenList for Slot {
    fn clone_into_seen(&self) -> Vec<Seen> {
        self.seen
            .iter()
            .map(|seen| Seen {
                method: seen.method.clone(),
                target: seen.target.clone(),
                headers: seen.headers.clone(),
                body: seen.body.clone(),
            })
            .collect()
    }
}

fn seen_text(seen: &Seen) -> String {
    format!(
        "{}\n{}\n{}",
        seen.target,
        header_text(&seen.headers),
        seen.body
    )
}

fn header_text(headers: &[(String, String)]) -> String {
    headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn header_pairs(value: &Value) -> Vec<(String, String)> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|pair| {
            let pair = pair.as_array().unwrap();
            (
                pair[0].as_str().unwrap().to_ascii_lowercase(),
                mask_secret(pair[1].as_str().unwrap()),
            )
        })
        .collect()
}

fn norm_headers(headers: &[(String, String)]) -> Vec<(String, String)> {
    headers
        .iter()
        .map(|(name, value)| (name.to_ascii_lowercase(), mask_secret(value)))
        .collect()
}

fn mask_secret(text: &str) -> String {
    text.replace("golden-key", "<redacted>")
}

fn id_map(expected: &str, actual: &str, canned: &str) -> Vec<(String, String)> {
    let placeholders = tokens(expected);
    let generated = generated_ids(actual, canned);
    assert_eq!(
        generated.len(),
        placeholders.len(),
        "generated ids {generated:?} vs {placeholders:?}"
    );
    generated.into_iter().zip(placeholders).collect()
}

fn id_map_pair(want: &Value, got: &Seen, canned: &str) -> Vec<(String, String)> {
    let expected = want.to_string();
    let actual = seen_text(got);
    let placeholders = tokens(&expected);
    let generated = generated_ids(&actual, canned);
    generated.into_iter().zip(placeholders).collect()
}

fn tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'<'
            && let Some(end) = text[index..].find('>')
        {
            let token = &text[index..index + end + 1];
            if (token.starts_with("<generated-id-") || token == "<generated-timestamp>")
                && !out.iter().any(|seen| seen == token)
            {
                out.push(token.to_string());
            }
            index += end + 1;
            continue;
        }
        index += 1;
    }
    out
}

fn generated_ids(text: &str, canned: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] != '"' {
            index += 1;
            continue;
        }
        index += 1;
        let start = index;
        while index < chars.len() && chars[index] != '"' {
            if chars[index] == '\\' {
                index += 2;
                continue;
            }
            index += 1;
        }
        let value: String = chars[start..index.min(chars.len())].iter().collect();
        if is_generated(&value)
            && !canned.contains(&value)
            && !out.iter().any(|seen| seen == &value)
        {
            out.push(value);
        }
        index += 1;
    }
    out
}

fn is_generated(text: &str) -> bool {
    if text.len() == 16
        && text.starts_with("00000")
        && text.chars().all(|ch| ch.is_ascii_alphanumeric())
    {
        return true;
    }
    if let Some(rest) = text.strip_prefix("aitxt-") {
        return rest.len() == 24 && rest.chars().all(|ch| ch.is_ascii_alphanumeric());
    }
    false
}

fn apply_map(text: &str, map: &[(String, String)]) -> String {
    let mut out = text.to_string();
    for (from, to) in map {
        out = out.replace(from, to);
    }
    out
}

fn assert_same(label: &str, expected: &str, actual: &str) {
    if expected == actual {
        return;
    }
    let mut at = 0usize;
    for (left, right) in expected.chars().zip(actual.chars()) {
        if left != right {
            break;
        }
        at += left.len_utf8();
    }
    let exp = window(expected, at);
    let got = window(actual, at);
    panic!("{label} differ at {at}\nexpected: {exp}\nactual:   {got}");
}

fn window(text: &str, at: usize) -> String {
    let start = at.saturating_sub(80);
    let end = (at + 160).min(text.len());
    text[start..end].to_string()
}

async fn handle(mut sock: TcpStream, slot: Arc<Mutex<Slot>>) -> std::io::Result<()> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    loop {
        let at = header_end(&buf);
        if at.is_none() {
            let n = sock.read(&mut tmp).await?;
            if n == 0 {
                return Ok(());
            }
            buf.extend_from_slice(&tmp[..n]);
            if buf.len() > 8_000_000 {
                return Ok(());
            }
            continue;
        }
        let at = at.unwrap();
        let head = String::from_utf8_lossy(&buf[..at]).to_string();
        let Some(Head {
            method,
            target,
            headers,
            length,
        }) = parse_head(&head)
        else {
            return Ok(());
        };
        let mut body = buf[at + 4..].to_vec();
        while body.len() < length {
            let n = sock.read(&mut tmp).await?;
            if n == 0 {
                break;
            }
            body.extend_from_slice(&tmp[..n]);
        }
        let payload = if body.len() >= length {
            body[..length].to_vec()
        } else {
            body.clone()
        };
        let leftover = if body.len() > length {
            body[length..].to_vec()
        } else {
            Vec::new()
        };
        let response = {
            let mut guard = slot.lock().unwrap();
            let response = guard.responses.get(guard.index).map(|resp| Resp {
                status: resp.status,
                headers: resp.headers.clone(),
                body: resp.body.clone(),
            });
            guard.index += 1;
            guard.seen.push(Seen {
                method,
                target,
                headers,
                body: String::from_utf8_lossy(&payload).to_string(),
            });
            response
        };
        let response = response.unwrap_or(Resp {
            status: 500,
            headers: Vec::new(),
            body: Vec::new(),
        });
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
    let reason = if resp.status == 200 { "OK" } else { "ERR" };
    let mut head = format!("HTTP/1.1 {} {reason}\r\n", resp.status);
    for (name, value) in &resp.headers {
        head.push_str(name);
        head.push_str(": ");
        head.push_str(value);
        head.push_str("\r\n");
    }
    head.push_str(&format!(
        "Content-Length: {}\r\nConnection: keep-alive\r\n\r\n",
        resp.body.len()
    ));
    sock.write_all(head.as_bytes()).await?;
    sock.write_all(&resp.body).await?;
    sock.flush().await?;
    Ok(())
}
