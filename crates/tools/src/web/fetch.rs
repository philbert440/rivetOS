use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use std::time::{Duration, Instant};

use schemars::JsonSchema;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::args::{self, string};
use crate::context::{ToolContext, ToolSurface};
use crate::schema::{schema_of, set_property_description};

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
        let mut response = match self
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
        let content_type = header_value(&response, "content-type")
            .unwrap_or("")
            .to_string();
        if content_type.contains("application/pdf") {
            return text(PDF_MESSAGE);
        }
        let body = match response.text().await {
            Ok(body) => body,
            Err(err) => return text(format!("Fetch error: {err}")),
        };
        let mut result = if content_type.contains("application/json") {
            render_json(&body)
        } else if content_type.contains("text/html") {
            extract_markdown(&body)
        } else {
            body
        };
        if js_len_exceeds(protocol::js::utf16_len(&result), max_chars) {
            let end = js_end_index(protocol::js::utf16_len(&result), max_chars);
            let shown = protocol::JsNumber::from(max_chars);
            let head = protocol::js::js_substring(&result, Some(0.0), Some(end as f64));
            result = format!(
                "{}\n\n[Truncated at {shown} chars. Use max_chars parameter to see more.]",
                head.to_utf8()
            );
        }
        self.cache_set(cache_key, result.clone(), FETCH_CACHE_TTL);
        text(result)
    }
}

impl WebFetchTool {
    fn cache_get(&self, key: &str) -> Option<String> {
        let mut cache = self.cache.lock();
        let entry = cache.get(key)?;
        if Instant::now() > entry.expires {
            cache.remove(key);
            return None;
        }
        Some(entry.data.clone())
    }

    fn cache_set(&self, key: String, data: String, ttl: Duration) {
        self.cache.lock().insert(
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

fn render_json(raw: &str) -> String {
    match protocol::js::parse(raw) {
        Ok(value) => pretty_json(&protocol::js::stringify(&value)),
        Err(_) => raw.to_string(),
    }
}

fn pretty_json(compact: &str) -> String {
    let mut out = String::with_capacity(compact.len().saturating_mul(2));
    let mut rest = compact;
    let mut indent = 0usize;
    while let Some(ch) = rest.chars().next() {
        if ch == '"' {
            let (token, next) = take_string(rest);
            out.push_str(token);
            rest = next;
            continue;
        }
        rest = &rest[ch.len_utf8()..];
        match ch {
            '{' | '[' => {
                let close = if ch == '{' { '}' } else { ']' };
                out.push(ch);
                if rest.starts_with(close) {
                    out.push(close);
                    rest = &rest[close.len_utf8()..];
                } else {
                    indent += 1;
                    out.push('\n');
                    push_indent(&mut out, indent);
                }
            }
            '}' | ']' => {
                indent = indent.saturating_sub(1);
                out.push('\n');
                push_indent(&mut out, indent);
                out.push(ch);
            }
            ',' => {
                out.push(',');
                out.push('\n');
                push_indent(&mut out, indent);
            }
            ':' => {
                out.push(':');
                out.push(' ');
            }
            _ => out.push(ch),
        }
    }
    out
}

fn take_string(text: &str) -> (&str, &str) {
    let mut escaped = false;
    for (index, ch) in text.char_indices().skip(1) {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '"' {
            let end = index + ch.len_utf8();
            return (&text[..end], &text[end..]);
        }
    }
    (text, "")
}

fn push_indent(out: &mut String, indent: usize) {
    for _ in 0..indent.saturating_mul(2) {
        out.push(' ');
    }
}

fn js_len_exceeds(len: usize, max_chars: f64) -> bool {
    max_chars.is_finite() && (len as f64) > max_chars
}

fn js_end_index(len: usize, index: f64) -> usize {
    if !index.is_finite() {
        return if index.is_sign_positive() { len } else { 0 };
    }
    let truncated = index.trunc();
    if truncated < 0.0 {
        len.saturating_sub(f64_magnitude(truncated))
    } else {
        f64_magnitude(truncated).min(len)
    }
}

fn f64_magnitude(value: f64) -> usize {
    let magnitude = value.abs();
    if magnitude >= usize::MAX as f64 {
        usize::MAX
    } else {
        magnitude as usize
    }
}
