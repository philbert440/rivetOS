use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    pub timeout: Duration,
}

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
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
        let body = response.text().await.map_err(map_reqwest_error)?;
        Ok(HttpResponse {
            status: status.as_u16(),
            status_text,
            headers,
            body,
        })
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
        self.calls
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
    }
}

#[async_trait::async_trait]
impl HttpClient for RecordingClient {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, String> {
        self.calls
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .push(RecordedCall {
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
    let bytes = message.as_bytes();
    let mut out = String::with_capacity(message.len());
    let mut index = 0;
    while index < bytes.len() {
        if has_prefix_ignore_ascii(&bytes[index..], b"https://")
            || has_prefix_ignore_ascii(&bytes[index..], b"http://")
        {
            let start = index;
            index += 1;
            while index < bytes.len() && !url_terminator(bytes[index]) {
                index += 1;
            }
            let url = &message[start..index];
            out.push_str(&strip_url_credentials(url));
        } else {
            let Some(ch) = message[index..].chars().next() else {
                break;
            };
            out.push(ch);
            index += ch.len_utf8();
        }
    }
    out
}

fn has_prefix_ignore_ascii(bytes: &[u8], prefix: &[u8]) -> bool {
    bytes.len() >= prefix.len()
        && bytes
            .iter()
            .zip(prefix)
            .all(|(byte, expected)| byte.eq_ignore_ascii_case(expected))
}

fn url_terminator(byte: u8) -> bool {
    byte.is_ascii_whitespace() || matches!(byte, b'"' | b'\'' | b'<' | b'>' | b')' | b'`')
}

fn strip_url_credentials(url: &str) -> String {
    let cut = url.find(['?', '#']).unwrap_or(url.len());
    let url = &url[..cut];
    let Some(scheme) = url.find("://") else {
        return url.to_string();
    };
    let auth_start = scheme + 3;
    let path_at = url[auth_start..]
        .find(['/', '?', '#'])
        .map(|offset| auth_start + offset)
        .unwrap_or(url.len());
    let authority = &url[auth_start..path_at];
    let Some(at) = authority.rfind('@') else {
        return url.to_string();
    };
    let mut stripped = String::with_capacity(url.len());
    stripped.push_str(&url[..auth_start]);
    stripped.push_str(&authority[at + 1..]);
    stripped.push_str(&url[path_at..]);
    stripped
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
