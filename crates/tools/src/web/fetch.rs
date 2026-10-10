use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use schemars::JsonSchema;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::args::{self, string};
use crate::context::{ToolContext, ToolSurface};
use crate::schema::{schema_of, set_property_description};
use crate::textutil::{utf16_len, utf16_slice};
use crate::{Tool, text};

use super::html::extract_markdown;
use super::http::{HttpClient, HttpRequest, default_http, header_value};

const FETCH_CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const PDF_MESSAGE: &str = "PDF content detected. PDF text extraction is not yet supported. Download the file and extract text locally using pdftotext or similar tools.";
const AGENT_DESCRIPTION: &str = "Fetch and extract readable content from a URL. Returns the text/markdown content of a web page. Use when you need to read a specific webpage.";
const SIDECAR_DESCRIPTION: &str = "Fetch and extract readable content from a URL. Returns the text/markdown content of a web page (HTML is converted to markdown). Use when you need to read a specific webpage. PDFs are detected but not extracted.";

#[derive(Debug, Clone)]
pub struct WebFetchConfig {
    pub user_agent: Option<String>,
    pub default_max_chars: f64,
    pub surface: ToolSurface,
}

impl Default for WebFetchConfig {
    fn default() -> Self {
        Self {
            user_agent: None,
            default_max_chars: 5000.0,
            surface: ToolSurface::Agent,
        }
    }
}

struct CacheEntry {
    data: String,
    expires: Instant,
}

pub struct WebFetchTool {
    user_agent: String,
    default_max_chars: f64,
    surface: ToolSurface,
    http: Arc<dyn HttpClient>,
    cache: Mutex<HashMap<String, CacheEntry>>,
}

#[derive(JsonSchema)]
struct FetchParams {
    url: String,
    max_chars: Option<f64>,
}

impl WebFetchTool {
    pub fn new(config: WebFetchConfig) -> Self {
        Self::with_http(config, default_http())
    }

    pub fn with_http(config: WebFetchConfig, http: Arc<dyn HttpClient>) -> Self {
        let user_agent = match config.user_agent {
            Some(value) => value,
            None => std::env::var("RIVETOS_USER_AGENT")
                .unwrap_or_else(|_| "RivetOS/0.1.0 (web-fetch)".to_string()),
        };
        Self {
            user_agent,
            default_max_chars: config.default_max_chars,
            surface: config.surface,
            http,
            cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn sidecar(mut config: WebFetchConfig) -> Self {
        config.surface = ToolSurface::Sidecar;
        Self::new(config)
    }
}

#[async_trait::async_trait]
impl Tool for WebFetchTool {
    fn name(&self) -> &'static str {
        "web_fetch"
    }

    fn description(&self) -> &str {
        match self.surface {
            ToolSurface::Agent => AGENT_DESCRIPTION,
            ToolSurface::Sidecar => SIDECAR_DESCRIPTION,
        }
    }

    fn parameters(&self) -> Value {
        crate::anchor_schema!(FetchParams { url, max_chars });
        let mut schema = schema_of::<FetchParams>();
        set_property_description(&mut schema, "url", "URL to fetch");
        set_property_description(
            &mut schema,
            "max_chars",
            "Max characters to return (default: 5000)",
        );
        schema
    }

    async fn execute(
        &self,
        args: Value,
        _cancellation: &CancellationToken,
        _context: &ToolContext,
    ) -> protocol::ToolResult {
        let url = string(&args, "url").unwrap_or("");
        if url.is_empty() {
            return text("Error: No URL provided");
        }
        let max_chars = max_chars(args.get("max_chars"), self.default_max_chars);
        let cache_key = format!("{url}::{}", protocol::JsNumber::from(max_chars));
        if let Some(cached) = self.cache_get(&cache_key) {
            return text(cached);
        }
        let mut headers = vec![
            ("User-Agent".to_string(), self.user_agent.clone()),
            (
                "Accept".to_string(),
                "text/html,application/xhtml+xml,text/plain,application/json".to_string(),
            ),
        ];
        if url.contains("raw.githubusercontent.com")
            && let Some(accept) = headers.iter_mut().find(|(name, _)| name == "Accept")
        {
            accept.1 = "text/plain".to_string();
        }
        let response = match self
            .http
            .send(HttpRequest {
                method: "GET".to_string(),
                url: url.to_string(),
                headers,
                body: None,
                timeout: Duration::from_secs(15),
            })
            .await
        {
            Ok(response) => response,
            Err(err) => return text(format!("Fetch error: {err}")),
        };
        if !(200..300).contains(&response.status) {
            return text(format!(
                "Fetch failed ({}): {}",
                response.status, response.status_text
            ));
        }
        let content_type = header_value(&response, "content-type").unwrap_or("");
        if content_type.contains("application/pdf") {
            return text(PDF_MESSAGE);
        }
        let mut result = if content_type.contains("application/json") {
            match serde_json::from_str::<Value>(&response.body) {
                Ok(value) => serde_json::to_string_pretty(&value).unwrap_or(response.body),
                Err(_) => response.body,
            }
        } else if content_type.contains("text/html") {
            extract_markdown(&response.body)
        } else {
            response.body
        };
        if utf16_len(&result) > js_slice_end(max_chars) && max_chars > 0.0 {
            let end = js_slice_end(max_chars);
            let shown = protocol::JsNumber::from(max_chars);
            result = format!(
                "{}\n\n[Truncated at {shown} chars. Use max_chars parameter to see more.]",
                utf16_slice(&result, 0, end)
            );
        }
        self.cache_set(cache_key, result.clone(), FETCH_CACHE_TTL);
        text(result)
    }
}

impl WebFetchTool {
    fn cache_get(&self, key: &str) -> Option<String> {
        let mut cache = self.cache.lock().unwrap_or_else(|err| err.into_inner());
        let entry = cache.get(key)?;
        if Instant::now() > entry.expires {
            cache.remove(key);
            return None;
        }
        Some(entry.data.clone())
    }

    fn cache_set(&self, key: String, data: String, ttl: Duration) {
        self.cache
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .insert(
                key,
                CacheEntry {
                    data,
                    expires: Instant::now() + ttl,
                },
            );
    }
}

fn max_chars(value: Option<&Value>, default_max: f64) -> f64 {
    let raw = args::js_number(value);
    if raw == 0.0 || raw.is_nan() {
        default_max
    } else {
        raw
    }
}

fn js_slice_end(value: f64) -> usize {
    if !value.is_finite() || value <= 0.0 {
        0
    } else {
        value.trunc() as usize
    }
}
