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
            .redirect(reqwest::redirect::Policy::limited(10))
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

fn map_reqwest_error(err: reqwest::Error) -> String {
    let message = err.to_string();
    let lower = message.to_ascii_lowercase();
    if err.is_connect() || lower.contains("connection refused") {
        format!("fetch failed: ECONNREFUSED: {message}")
    } else {
        message
    }
}
