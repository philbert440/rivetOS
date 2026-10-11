use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use bytes::Bytes;
use futures_util::Stream;
use protocol::LlmChunk;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use tokio::time::Sleep;

use crate::error::ProviderError;
use crate::types::{ChatStream, StepCapture};

pub struct HttpAttempt {
    pub method: reqwest::Method,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

pub struct RawResponse {
    pub status: u16,
    pub response: reqwest::Response,
}

pub fn build_client() -> Result<reqwest::Client, ProviderError> {
    reqwest::Client::builder()
        .default_headers(HeaderMap::new())
        .http1_only()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(30))
        .pool_idle_timeout(Duration::from_secs(90))
        .build()
        .map_err(|err| ProviderError::new(err.to_string(), 0, "http"))
}

pub async fn send(
    client: &reqwest::Client,
    attempt: &HttpAttempt,
    timeout: Duration,
    provider_id: &str,
    redactor: &Redactor,
) -> Result<RawResponse, ProviderError> {
    if timeout.is_zero() {
        return Err(ProviderError::new(
            redactor.redact("provider timed out after 0 ms"),
            0,
            provider_id,
        ));
    }
    let shown = redactor.redact(&attempt.url);
    tracing::debug!(method = %attempt.method, url = %shown, provider = provider_id, "provider http");
    let mut builder = client
        .request(attempt.method.clone(), &attempt.url)
        .timeout(timeout);
    if !attempt
        .headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("host"))
        && let Some(host) = host_header_value(&attempt.url)
        && let Ok(value) = HeaderValue::from_str(&host)
    {
        builder = builder.header(HeaderName::from_static("host"), value);
    }
    for (name, value) in &attempt.headers {
        let Ok(header_name) = HeaderName::from_bytes(name.as_bytes()) else {
            continue;
        };
        let Ok(header_value) = HeaderValue::from_str(value) else {
            continue;
        };
        builder = builder.header(header_name, header_value);
    }
    if let Some(body) = &attempt.body {
        builder = builder.body(body.clone());
    }
    match builder.send().await {
        Ok(response) => Ok(RawResponse {
            status: response.status().as_u16(),
            response,
        }),
        Err(err) => {
            if err.is_timeout() {
                Err(ProviderError::new(
                    redactor.redact(&format!(
                        "provider timed out after {} ms",
                        timeout.as_millis()
                    )),
                    0,
                    provider_id,
                ))
            } else {
                Err(ProviderError::new(
                    redactor.redact(&err.to_string()),
                    0,
                    provider_id,
                ))
            }
        }
    }
}

pub async fn read_limited(response: reqwest::Response, limit: usize) -> String {
    match response.bytes().await {
        Ok(bytes) => {
            let slice = if bytes.len() > limit {
                &bytes[..limit]
            } else {
                &bytes
            };
            let text = String::from_utf8_lossy(slice);
            protocol::js::js_trim(&text).to_string()
        }
        Err(_) => String::new(),
    }
}

pub trait WireDecoder: Send {
    fn push(&mut self, bytes: &[u8], chunks: &mut Vec<LlmChunk>, cap: &mut StepCapture);
    fn finish(&mut self, chunks: &mut Vec<LlmChunk>, cap: &mut StepCapture);
    fn take_error(&mut self) -> Option<ProviderError> {
        None
    }
}

struct Live {
    incoming: Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>,
    decoder: Box<dyn WireDecoder>,
    pending: VecDeque<Result<LlmChunk, ProviderError>>,
    capture: Arc<Mutex<StepCapture>>,
    sleep: Pin<Box<Sleep>>,
    incoming_done: bool,
    finish_ran: bool,
    provider_id: String,
    timeout_ms: u64,
    redactor: Arc<Redactor>,
}

impl Stream for Live {
    type Item = Result<LlmChunk, ProviderError>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let live = self.get_mut();
        loop {
            if let Some(item) = live.pending.pop_front() {
                return Poll::Ready(Some(item));
            }
            if live.finish_ran {
                return Poll::Ready(None);
            }
            if live.incoming_done {
                let mut chunks = Vec::new();
                {
                    let mut cap = live.capture.lock();
                    live.decoder.finish(&mut chunks, &mut cap);
                }
                live.finish_ran = true;
                for chunk in chunks {
                    live.pending.push_back(Ok(chunk));
                }
                continue;
            }
            if live.sleep.as_mut().poll(cx).is_ready() {
                live.finish_ran = true;
                return Poll::Ready(Some(Err(ProviderError::timeout(
                    &live.provider_id,
                    live.timeout_ms,
                ))));
            }
            match live.incoming.as_mut().poll_next(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(None) => {
                    live.incoming_done = true;
                }
                Poll::Ready(Some(Err(err))) => {
                    live.finish_ran = true;
                    return Poll::Ready(Some(Err(ProviderError::new(
                        live.redactor.redact(&err.to_string()),
                        0,
                        live.provider_id.clone(),
                    ))));
                }
                Poll::Ready(Some(Ok(bytes))) => {
                    let mut chunks = Vec::new();
                    {
                        let mut cap = live.capture.lock();
                        live.decoder.push(&bytes, &mut chunks, &mut cap);
                    }
                    for chunk in chunks {
                        live.pending.push_back(Ok(chunk));
                    }
                    if let Some(err) = live.decoder.take_error() {
                        live.pending.push_back(Err(ProviderError::new(
                            live.redactor.redact(&err.message),
                            err.status,
                            err.provider_id.clone(),
                        )));
                        live.incoming_done = true;
                        live.finish_ran = true;
                    }
                }
            }
        }
    }
}

pub fn decode_response(
    response: reqwest::Response,
    decoder: Box<dyn WireDecoder>,
    deadline: Instant,
    provider_id: &str,
    timeout_ms: u64,
    redactor: Arc<Redactor>,
) -> ChatStream {
    let capture = Arc::new(Mutex::new(StepCapture::default()));
    let remaining = deadline.saturating_duration_since(Instant::now());
    let live = Live {
        incoming: Box::pin(response.bytes_stream()),
        decoder,
        pending: VecDeque::new(),
        capture: Arc::clone(&capture),
        sleep: Box::pin(tokio::time::sleep(remaining)),
        incoming_done: false,
        finish_ran: false,
        provider_id: provider_id.to_string(),
        timeout_ms,
        redactor,
    };
    ChatStream {
        capture,
        inner: Box::pin(live),
    }
}

pub fn tail_headers() -> Vec<(String, String)> {
    vec![
        ("accept".to_string(), "*/*".to_string()),
        ("accept-language".to_string(), "*".to_string()),
        ("sec-fetch-mode".to_string(), "cors".to_string()),
        ("accept-encoding".to_string(), "gzip, deflate".to_string()),
    ]
}

pub fn connection_header() -> (String, String) {
    ("connection".to_string(), "keep-alive".to_string())
}

const SECRET_QUERY: &[&str] = &[
    "key",
    "token",
    "access_token",
    "api_key",
    "apikey",
    "api-key",
    "client_secret",
    "password",
    "secret",
    "id_token",
    "refresh_token",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DisplayUrl(String);

impl DisplayUrl {
    pub fn new(raw: &str) -> Self {
        Self(redact_url(raw))
    }
}

impl std::fmt::Display for DisplayUrl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

const REDACTED: &str = "REDACTED";

#[derive(Clone, Default)]
pub struct Redactor {
    secrets: Arc<Mutex<Vec<String>>>,
}

impl Redactor {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, secret: &str) {
        if secret.is_empty() || secret == REDACTED {
            return;
        }
        let mut guard = self.secrets.lock();
        if !guard.iter().any(|item| item == secret) {
            guard.push(secret.to_string());
        }
    }

    pub fn register_url(&self, url: &str) {
        if let Ok(parsed) = reqwest::Url::parse(url) {
            if !parsed.username().is_empty() {
                self.register(parsed.username());
                self.register(&percent_decode(parsed.username()));
            }
            if let Some(password) = parsed.password() {
                self.register(password);
                self.register(&percent_decode(password));
            }
            for (key, value) in parsed.query_pairs() {
                if secret_query(&key) {
                    self.register(&value);
                    self.register(&percent_decode(&value));
                }
            }
            return;
        }
        register_unparsed_secrets(self, url);
    }

    pub fn redact(&self, text: &str) -> String {
        let mut secrets = self.secrets.lock().clone();
        secrets.sort_by_key(|secret| std::cmp::Reverse(secret.len()));
        let mut out = text.to_string();
        for secret in &secrets {
            if secret.is_empty() || secret == REDACTED {
                continue;
            }
            out = out.replace(secret, REDACTED);
            let encoded = crate::jsonutil::encode_query(secret);
            if encoded != *secret {
                out = out.replace(&encoded, REDACTED);
                let lower = encoded.to_ascii_lowercase();
                if lower != encoded {
                    out = out.replace(&lower, REDACTED);
                }
            }
        }
        redact_text(&out)
    }
}

pub fn redact_url(url: &str) -> String {
    let Ok(mut parsed) = reqwest::Url::parse(url) else {
        return redact_unparsed_url(url);
    };
    let userinfo = !parsed.username().is_empty() || parsed.password().is_some();
    strip_userinfo(&mut parsed);
    let pairs: Vec<(String, String)> = parsed
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    let needs_query = pairs
        .iter()
        .any(|(key, value)| secret_query(key) && value != REDACTED);
    if !userinfo && !needs_query {
        return url.to_string();
    }
    if !needs_query {
        return parsed.to_string();
    }
    parsed.set_query(None);
    let query = pairs
        .iter()
        .map(|(key, value)| {
            if secret_query(key) {
                format!("{key}={REDACTED}")
            } else {
                format!("{key}={value}")
            }
        })
        .collect::<Vec<_>>()
        .join("&");
    parsed.set_query(Some(&query));
    parsed.to_string()
}

pub fn redact_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < text.len() {
        let rest = &text[index..];
        if let Some(start) = find_scheme(rest) {
            out.push_str(&rest[..start]);
            let tail = &rest[start..];
            let end = tail.find(url_terminator).unwrap_or(tail.len());
            out.push_str(&redact_url_piece(&tail[..end]));
            index += start + end;
        } else {
            out.push_str(rest);
            break;
        }
    }
    out
}

fn find_scheme(text: &str) -> Option<usize> {
    match (text.find("http://"), text.find("https://")) {
        (Some(http), Some(https)) => Some(http.min(https)),
        (Some(http), None) => Some(http),
        (None, Some(https)) => Some(https),
        (None, None) => None,
    }
}

fn url_terminator(ch: char) -> bool {
    ch.is_whitespace() || matches!(ch, ')' | '"' | '\'' | '>' | '<' | '}' | ']' | '|')
}

fn redact_url_piece(piece: &str) -> String {
    if reqwest::Url::parse(piece).is_ok() {
        redact_url(piece)
    } else {
        redact_unparsed_url(piece)
    }
}

fn redact_unparsed_url(piece: &str) -> String {
    let Some(start) = find_scheme(piece) else {
        return piece.to_string();
    };
    let scheme_len = if piece[start..].starts_with("https://") {
        "https://".len()
    } else {
        "http://".len()
    };
    let auth_start = start + scheme_len;
    let mut out = piece.to_string();
    let rest = &piece[auth_start..];
    if let Some(at) = rest.find('@') {
        let userinfo = &rest[..at];
        if !userinfo.is_empty() && !userinfo.contains('/') && !userinfo.contains('?') {
            out.replace_range(auth_start..auth_start + at + 1, "");
        }
    }
    let Some(query_at) = out.find('?') else {
        return out;
    };
    let head = out[..query_at].to_string();
    let query = &out[query_at + 1..];
    let end = query.find(url_terminator).unwrap_or(query.len());
    let mut rebuilt = head;
    rebuilt.push('?');
    rebuilt.push_str(&redact_query_pairs(&query[..end]));
    rebuilt.push_str(&query[end..]);
    rebuilt
}

fn redact_query_pairs(query: &str) -> String {
    query
        .split('&')
        .map(|pair| {
            let Some((key, _)) = pair.split_once('=') else {
                return pair.to_string();
            };
            let decoded = percent_decode(key);
            if secret_query(&decoded) || secret_query(key) {
                format!("{key}={REDACTED}")
            } else {
                pair.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("&")
}

fn register_unparsed_secrets(redactor: &Redactor, url: &str) {
    let Some(start) = find_scheme(url) else {
        return;
    };
    let scheme_len = if url[start..].starts_with("https://") {
        "https://".len()
    } else {
        "http://".len()
    };
    let rest = &url[start + scheme_len..];
    let (after_user, query_from) = if let Some(at) = rest.find('@') {
        let userinfo = &rest[..at];
        if !userinfo.is_empty() && !userinfo.contains('/') && !userinfo.contains('?') {
            if let Some((user, password)) = userinfo.split_once(':') {
                redactor.register(&percent_decode(user));
                redactor.register(&percent_decode(password));
            } else {
                redactor.register(&percent_decode(userinfo));
            }
        }
        (&rest[at + 1..], &rest[at + 1..])
    } else {
        (rest, rest)
    };
    let Some(query_at) = query_from.find('?').or_else(|| after_user.find('?')) else {
        return;
    };
    let query = &query_from[query_at + 1..];
    let end = query.find(url_terminator).unwrap_or(query.len());
    for pair in query[..end].split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        let decoded = percent_decode(key);
        if secret_query(&decoded) || secret_query(key) {
            redactor.register(value);
            redactor.register(&percent_decode(value));
        }
    }
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let (Some(hi), Some(lo)) = (hex_val(bytes[index + 1]), hex_val(bytes[index + 2]))
        {
            out.push((hi << 4) | lo);
            index += 3;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn strip_userinfo(url: &mut reqwest::Url) {
    if url.username().is_empty() && url.password().is_none() {
        return;
    }
    if url.password().is_some() {
        let _ = url.set_password(None);
    }
    if !url.username().is_empty() {
        let _ = url.set_username("");
    }
}

fn secret_query(key: &str) -> bool {
    SECRET_QUERY
        .iter()
        .any(|name| key.eq_ignore_ascii_case(name))
}

fn host_header_value(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let host = parsed.host_str()?;
    let host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    match parsed.port() {
        Some(port) => Some(format!("{host}:{port}")),
        None => Some(host),
    }
}

#[cfg(test)]
mod tests {
    use super::{DisplayUrl, Redactor, redact_text, redact_url};

    const CRED_MARK: &str = "rr6p-cred-4f91c2e7";

    #[test]
    fn strips_userinfo_before_query_secrets() {
        let out = redact_url("https://user:pass@example.com/v1?token=sekret&x=1");
        assert!(!out.contains("user"));
        assert!(!out.contains("pass"));
        assert!(!out.contains('@'));
        assert!(out.contains("token=REDACTED"), "{out}");
        assert!(out.contains("x=1"), "{out}");
        let bare = redact_url("https://operator:secret@example.test/v1");
        assert!(!bare.contains("operator"), "{bare}");
        assert!(!bare.contains("secret"), "{bare}");
        assert!(!bare.contains('@'), "{bare}");
        assert!(bare.contains("example.test"), "{bare}");
        let text = redact_text("see https://user:pass@example.com/v1?api_key=abc now");
        assert!(!text.contains("user:pass"), "{text}");
        assert!(text.contains("api_key=REDACTED"), "{text}");
    }

    #[test]
    fn display_url_is_the_only_diagnostic_form() {
        let raw = "https://rr6puser:rr6p-cred-4f91c2e7@example.test/models?api_key=rr6p-cred-4f91c2e7&x=1";
        let shown = DisplayUrl::new(raw).to_string();
        assert!(!shown.contains("rr6puser"), "{shown}");
        assert!(!shown.contains("rr6p-cred-4f91c2e7"), "{shown}");
        assert!(!shown.contains('@'), "{shown}");
        assert!(shown.contains("api_key=REDACTED"), "{shown}");
        assert!(shown.contains("x=1"), "{shown}");
        assert!(shown.contains("example.test"), "{shown}");
        assert_eq!(redact_url(&shown), shown);
        assert_eq!(
            DisplayUrl::new(&shown).to_string(),
            shown,
            "redaction is stable"
        );
        let clean = "http://127.0.0.1:9/v1/models";
        assert_eq!(redact_url(clean), clean);
        let keyed = DisplayUrl::new(
            "https://generativelanguage.googleapis.com/v1beta/models/m?key=rr6p-cred-4f91c2e7",
        );
        assert!(!keyed.to_string().contains(CRED_MARK), "{}", keyed);
        assert!(keyed.to_string().contains("key=REDACTED"), "{keyed}");
        let text = redact_text(&format!("boom {raw} tail"));
        assert!(!text.contains("rr6p-cred-4f91c2e7"), "{text}");
        assert!(text.starts_with("boom "), "{text}");
        assert!(text.ends_with(" tail"), "{text}");
    }

    #[test]
    fn registered_secrets_die_in_realistic_diagnostics() {
        let redactor = Redactor::new();
        redactor.register("sk-live-value");
        redactor.register_url("https://operator:sekret@example.test:8/v1?api_key=sk-live-value");
        let cases = [
            "models probe http://127.0.0.1:8000/v1/models?served-model-name=llama,mistral&api_key=sk-live-value".to_string(),
            "{\"error\":\"bad key sk-live-value (vLLM), retry later\"}".to_string(),
            "config \"https://operator:sekret@example.test:8/v1?api_key=sk-live-value\" rejected".to_string(),
            "https://example.test/v1?api%5Fkey=sk-live-value&x=1".to_string(),
            "https://operator:sekret@example.test:bad/models?api_key=sk-live-value".to_string(),
            "upstream https://example.test/?api_key=sk-live-value see http://help.test".to_string(),
            "token=%73k-live-value and (sk-live-value, sk-live-value)".to_string(),
        ];
        for case in &cases {
            let out = redactor.redact(case);
            assert!(!out.contains("sk-live-value"), "{case} -> {out}");
            assert!(!out.contains("sekret"), "{case} -> {out}");
            assert!(!out.contains("operator"), "{case} -> {out}");
            assert!(out.contains("REDACTED"), "{case} -> {out}");
        }
    }

    #[test]
    fn url_scan_fails_closed_without_registered_values() {
        let mixed = redact_text(
            "upstream https://example.test/?api_key=unregistered-secret see http://help.test",
        );
        assert!(!mixed.contains("unregistered-secret"), "{mixed}");
        assert!(
            mixed.contains("https://example.test/?api_key=REDACTED"),
            "{mixed}"
        );
        assert!(mixed.contains("http://help.test"), "{mixed}");
        let malformed = redact_text(
            "probe https://operator:sekret@example.test:bad/models?api_key=token failed",
        );
        assert!(!malformed.contains("sekret"), "{malformed}");
        assert!(!malformed.contains("operator"), "{malformed}");
        assert!(malformed.contains("example.test:bad"), "{malformed}");
        assert!(malformed.contains("api_key=REDACTED"), "{malformed}");
        let comma =
            redact_text("see http://user:sekret@example.test/v?list=a,b&token=tok-value end");
        assert!(!comma.contains("tok-value"), "{comma}");
        assert!(!comma.contains("sekret"), "{comma}");
        assert!(!comma.contains("user"), "{comma}");
        assert!(comma.contains("list=a,b"), "{comma}");
        assert!(comma.contains("token=REDACTED"), "{comma}");
        let quoted = redact_text("docs \"https://example.test/v?api%5Fkey=tok-value\" done");
        assert!(!quoted.contains("tok-value"), "{quoted}");
        assert!(quoted.contains("REDACTED"), "{quoted}");
    }
}
