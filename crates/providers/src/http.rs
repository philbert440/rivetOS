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
) -> Result<RawResponse, ProviderError> {
    if timeout.is_zero() {
        return Err(ProviderError::new(
            "provider timed out after 0 ms",
            0,
            provider_id,
        ));
    }
    tracing::debug!(method = %attempt.method, url = %redact_url(&attempt.url), provider = provider_id, "provider http");
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
                    format!("provider timed out after {} ms", timeout.as_millis()),
                    0,
                    provider_id,
                ))
            } else {
                Err(ProviderError::new(
                    redact_text(&err.to_string()),
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
                        redact_text(&err.to_string()),
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
                        live.pending.push_back(Err(err));
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

pub fn redact_url(url: &str) -> String {
    let Ok(mut parsed) = reqwest::Url::parse(url) else {
        return redact_text(url);
    };
    strip_userinfo(&mut parsed);
    let pairs: Vec<(String, String)> = parsed
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    if pairs.is_empty() {
        return parsed.to_string();
    }
    parsed.set_query(None);
    let query = pairs
        .iter()
        .map(|(key, value)| {
            if secret_query(key) {
                format!("{key}=REDACTED")
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
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let rest = &text[index..];
        if let Some(start) = rest.find("http://").or_else(|| rest.find("https://")) {
            out.push_str(&rest[..start]);
            let tail = &rest[start..];
            let end = tail
                .find(|ch: char| ch.is_whitespace() || matches!(ch, ')' | '"' | '\'' | '>' | ','))
                .unwrap_or(tail.len());
            out.push_str(&redact_url_piece(&tail[..end]));
            index += start + end;
        } else {
            out.push_str(rest);
            break;
        }
    }
    out
}

fn redact_url_piece(piece: &str) -> String {
    if reqwest::Url::parse(piece).is_ok() {
        redact_url(piece)
    } else {
        piece.to_string()
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
    use super::{redact_text, redact_url};

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
}
