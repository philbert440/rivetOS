use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::Stream;
use protocol::LlmChunk;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use tokio::time::Sleep;

use crate::error::ProviderError;
use crate::types::{lock, ChatStream, StepCapture};

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
) -> Result<RawResponse, ProviderError> {
    if timeout.is_zero() {
        return Err(ProviderError::new("provider timed out after 0 ms", 0, "http"));
    }
    tracing::debug!(method = %attempt.method, url = %attempt.url, "provider http");
    let mut builder = client
        .request(attempt.method.clone(), &attempt.url)
        .timeout(timeout);
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
                    "http",
                ))
            } else {
                Err(ProviderError::new(err.to_string(), 0, "http"))
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
            String::from_utf8_lossy(slice).trim().to_string()
        }
        Err(_) => String::new(),
    }
}

pub trait WireDecoder: Send {
    fn push(&mut self, bytes: &[u8], chunks: &mut Vec<LlmChunk>, cap: &mut StepCapture);
    fn finish(&mut self, chunks: &mut Vec<LlmChunk>, cap: &mut StepCapture);
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
                    let mut cap = lock(&live.capture);
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
                        err.to_string(),
                        0,
                        live.provider_id.clone(),
                    ))));
                }
                Poll::Ready(Some(Ok(bytes))) => {
                    let mut chunks = Vec::new();
                    {
                        let mut cap = lock(&live.capture);
                        live.decoder.push(&bytes, &mut chunks, &mut cap);
                    }
                    for chunk in chunks {
                        live.pending.push_back(Ok(chunk));
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
