use std::sync::Arc;

use parking_lot::Mutex;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    pub timeout: Duration,
}

pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    body: ResponseBody,
}

enum ResponseBody {
    Ready(String),
    Pending(Option<reqwest::Response>),
}

#[derive(Debug, Clone)]
pub struct RecordedCall {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

#[async_trait::async_trait]
pub trait HttpClient: Send + Sync {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, String>;
}

pub struct ReqwestClient {
    client: Option<reqwest::Client>,
}

impl Default for ReqwestClient {
    fn default() -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(20))
            .build()
            .ok();
        Self { client }
    }
}

impl ReqwestClient {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait::async_trait]
impl HttpClient for ReqwestClient {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, String> {
        let Some(client) = &self.client else {
            return Err("fetch failed: HTTP client unavailable".to_string());
        };
        let method = reqwest::Method::from_bytes(request.method.as_bytes())
            .map_err(|err| err.to_string())?;
        let mut builder = client
            .request(method, &request.url)
            .timeout(request.timeout);
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        if let Some(body) = request.body {
            builder = builder.body(body);
        }
        let response = builder.send().await.map_err(map_reqwest_error)?;
        let status = response.status();
        let status_text = status.canonical_reason().unwrap_or("Unknown").to_string();
        let headers = response
            .headers()
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_string(),
                    value.to_str().unwrap_or("").to_string(),
                )
            })
            .collect();
        Ok(HttpResponse {
            status: status.as_u16(),
            status_text,
            headers,
            body: ResponseBody::Pending(Some(response)),
        })
    }
}

impl HttpResponse {
    pub fn with_text(
        status: u16,
        status_text: impl Into<String>,
        headers: Vec<(String, String)>,
        body: impl Into<String>,
    ) -> Self {
        Self {
            status,
            status_text: status_text.into(),
            headers,
            body: ResponseBody::Ready(body.into()),
        }
    }

    pub async fn text(&mut self) -> Result<String, String> {
        match std::mem::replace(&mut self.body, ResponseBody::Ready(String::new())) {
            ResponseBody::Ready(text) => Ok(text),
            ResponseBody::Pending(slot) => {
                let Some(response) = slot else {
                    return Ok(String::new());
                };
                let bytes = response.bytes().await.map_err(map_reqwest_error)?;
                Ok(decode_http_body(&bytes))
            }
        }
    }
}

type RecordHandler = Arc<dyn Fn(&HttpRequest) -> Result<HttpResponse, String> + Send + Sync>;

pub struct RecordingClient {
    handler: RecordHandler,
    calls: Arc<Mutex<Vec<RecordedCall>>>,
}

impl RecordingClient {
    pub fn new<F>(handler: F) -> Arc<Self>
    where
        F: Fn(&HttpRequest) -> Result<HttpResponse, String> + Send + Sync + 'static,
    {
        Arc::new(Self {
            handler: Arc::new(handler),
            calls: Arc::new(Mutex::new(Vec::new())),
        })
    }

    pub fn calls(&self) -> Vec<RecordedCall> {
        self.calls.lock().clone()
    }
}

#[async_trait::async_trait]
impl HttpClient for RecordingClient {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, String> {
        self.calls.lock().push(RecordedCall {
            method: request.method.clone(),
            url: request.url.clone(),
            headers: request.headers.clone(),
            body: request.body.clone(),
        });
        (self.handler)(&request)
    }
}

pub fn default_http() -> Arc<dyn HttpClient> {
    Arc::new(ReqwestClient::new())
}

pub fn header_value<'a>(response: &'a HttpResponse, name: &str) -> Option<&'a str> {
    response
        .headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

pub fn request_header<'a>(request: &'a HttpRequest, name: &str) -> Option<&'a str> {
    request
        .headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

pub(crate) fn redact_transport_error(message: &str) -> String {
    redact_js(&protocol::js::JsString::from_text(message))
        .to_utf8()
        .to_string()
}

pub(crate) fn redact_js(message: &protocol::js::JsString) -> protocol::js::JsString {
    protocol::js::JsString::from_units(redact_units(message.units()))
}

fn redact_units(units: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(units.len());
    let mut index = 0;
    while index < units.len() {
        if has_prefix_units(&units[index..], b"https://")
            || has_prefix_units(&units[index..], b"http://")
        {
            let start = index;
            index += 1;
            while index < units.len() && !url_terminator_unit(units[index]) {
                index += 1;
            }
            out.extend(strip_url_units(&units[start..index]));
        } else {
            out.push(units[index]);
            index += 1;
        }
    }
    out
}

fn has_prefix_units(units: &[u16], prefix: &[u8]) -> bool {
    units.len() >= prefix.len()
        && units.iter().zip(prefix).all(|(unit, expected)| {
            u8::try_from(*unit)
                .ok()
                .is_some_and(|byte| byte.eq_ignore_ascii_case(expected))
        })
}

fn url_terminator_unit(unit: u16) -> bool {
    let Ok(byte) = u8::try_from(unit) else {
        return false;
    };
    byte.is_ascii_whitespace() || matches!(byte, b'"' | b'\'' | b'<' | b'>' | b')' | b'`')
}

fn strip_url_units(units: &[u16]) -> Vec<u16> {
    let cut = units
        .iter()
        .position(|unit| *unit == u16::from(b'?') || *unit == u16::from(b'#'))
        .unwrap_or(units.len());
    let url = &units[..cut];
    let Some(scheme) = find_ascii(url, b"://") else {
        return url.to_vec();
    };
    let auth_start = scheme + 3;
    let path_at = url[auth_start..]
        .iter()
        .position(|unit| {
            *unit == u16::from(b'/') || *unit == u16::from(b'?') || *unit == u16::from(b'#')
        })
        .map(|offset| auth_start + offset)
        .unwrap_or(url.len());
    let authority = &url[auth_start..path_at];
    let Some(at) = authority.iter().rposition(|unit| *unit == u16::from(b'@')) else {
        return url.to_vec();
    };
    let mut stripped = Vec::with_capacity(url.len());
    stripped.extend_from_slice(&url[..auth_start]);
    stripped.extend_from_slice(&authority[at + 1..]);
    stripped.extend_from_slice(&url[path_at..]);
    stripped
}

fn find_ascii(units: &[u16], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    units.windows(needle.len()).position(|window| {
        window
            .iter()
            .zip(needle)
            .all(|(unit, expected)| *unit == u16::from(*expected))
    })
}

fn decode_http_body(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

fn map_reqwest_error(err: reqwest::Error) -> String {
    let message = redact_transport_error(&err.to_string());
    let lower = message.to_ascii_lowercase();
    if err.is_connect() || lower.contains("connection refused") {
        format!("fetch failed: ECONNREFUSED: {message}")
    } else {
        message
    }
}

#[cfg(test)]
mod tests {
    use super::redact_transport_error;

    #[test]
    fn strips_userinfo_query_and_fragment() {
        let message = "error sending request for url (https://x-access-token:ghp_example@github.com/org/repo?key=super-secret-google-key-value#frag) and http://user:password@127.0.0.1:9/path";
        let redacted = redact_transport_error(message);
        assert!(
            redacted.contains("https://github.com/org/repo"),
            "{redacted}"
        );
        assert!(redacted.contains("http://127.0.0.1:9/path"), "{redacted}");
        assert!(!redacted.contains("ghp_example"), "{redacted}");
        assert!(!redacted.contains("x-access-token"), "{redacted}");
        assert!(!redacted.contains("password"), "{redacted}");
        assert!(!redacted.contains("super-secret"), "{redacted}");
        assert!(!redacted.contains("key="), "{redacted}");
        assert!(!redacted.contains("#frag"), "{redacted}");
    }
}
