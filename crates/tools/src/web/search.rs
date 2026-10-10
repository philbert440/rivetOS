use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use regex::Regex;
use schemars::JsonSchema;
use serde_json::{Value, json};

use crate::args::{self, string};
use crate::context::{ToolContext, ToolSurface};
use crate::schema::{schema_of, set_property_description};
use crate::textutil::js_trim;
use crate::{Tool, text};

use super::http::{HttpClient, HttpRequest, default_http};

pub const XAI_RESPONSES_URL: &str = "https://api.x.ai/v1/responses";
pub const GOOGLE_CSE_URL: &str = "https://www.googleapis.com/customsearch/v1";
pub const DDG_HTML_URL: &str = "https://html.duckduckgo.com/html/";

const SEARCH_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const AGENT_DESCRIPTION: &str = "Search the web. Returns a concise answer with sources (titles, snippets, URLs). Use when you need current information, facts, or to find resources.";
const SIDECAR_DESCRIPTION: &str = "Search the web. Tries Google Custom Search when configured, falls back to DuckDuckGo. Returns titles, snippets, and URLs. Use when you need current information, facts, or to find resources. Mirrors the in-process `internet_search` tool exposed to local agents.";

#[derive(Debug, Clone)]
pub struct WebSearchConfig {
    pub google_api_key: Option<String>,
    pub google_cse_id: Option<String>,
    pub xai_api_key: Option<String>,
    pub xai_model: Option<String>,
    pub max_results: usize,
    pub xai_endpoint: Option<String>,
    pub google_endpoint: Option<String>,
    pub ddg_endpoint: Option<String>,
    pub retry_base: Duration,
    pub surface: ToolSurface,
}

impl Default for WebSearchConfig {
    fn default() -> Self {
        Self {
            google_api_key: None,
            google_cse_id: None,
            xai_api_key: None,
            xai_model: None,
            max_results: 5,
            xai_endpoint: None,
            google_endpoint: None,
            ddg_endpoint: None,
            retry_base: Duration::from_millis(1000),
            surface: ToolSurface::Agent,
        }
    }
}

struct CacheEntry {
    data: String,
    expires: Instant,
}

enum Provider {
    Xai {
        key: String,
        model: String,
        endpoint: String,
    },
    Google {
        key: String,
        cse: String,
        endpoint: String,
    },
    Ddg {
        endpoint: String,
    },
}

impl Provider {
    fn name(&self) -> &'static str {
        match self {
            Self::Xai { .. } => "web",
            Self::Google { .. } => "Google",
            Self::Ddg { .. } => "DuckDuckGo",
        }
    }
}

struct SearchHit {
    title: String,
    snippet: String,
    url: String,
    source: String,
}

pub struct WebSearchTool {
    providers: Vec<Provider>,
    max_results: usize,
    retry_base: Duration,
    surface: ToolSurface,
    http: Arc<dyn HttpClient>,
    cache: Mutex<HashMap<String, CacheEntry>>,
}

#[derive(JsonSchema)]
struct SearchParams {
    query: String,
    count: Option<f64>,
}

impl WebSearchTool {
    pub fn new(config: WebSearchConfig) -> Self {
        Self::with_http(config, default_http())
    }

    pub fn with_http(config: WebSearchConfig, http: Arc<dyn HttpClient>) -> Self {
        let mut providers = Vec::new();
        let xai_key = resolve_optional(config.xai_api_key.as_deref(), &["XAI_API_KEY"]);
        if !xai_key.is_empty() {
            providers.push(Provider::Xai {
                key: xai_key,
                model: config.xai_model.unwrap_or_else(|| "grok-4.3".to_string()),
                endpoint: config
                    .xai_endpoint
                    .unwrap_or_else(|| XAI_RESPONSES_URL.to_string()),
            });
        }
        let google_key = resolve_optional(
            config.google_api_key.as_deref(),
            &["GOOGLE_CSE_API_KEY", "GOOGLE_API_KEY"],
        );
        let cse = resolve_optional(config.google_cse_id.as_deref(), &["GOOGLE_CSE_ID"]);
        if !google_key.is_empty() && !cse.is_empty() {
            providers.push(Provider::Google {
                key: google_key,
                cse,
                endpoint: config
                    .google_endpoint
                    .unwrap_or_else(|| GOOGLE_CSE_URL.to_string()),
            });
        }
        providers.push(Provider::Ddg {
            endpoint: config
                .ddg_endpoint
                .unwrap_or_else(|| DDG_HTML_URL.to_string()),
        });
        Self {
            providers,
            max_results: config.max_results,
            retry_base: config.retry_base,
            surface: config.surface,
            http,
            cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn sidecar(mut config: WebSearchConfig) -> Self {
        config.surface = ToolSurface::Sidecar;
        Self::new(config)
    }
}

#[async_trait::async_trait]
impl Tool for WebSearchTool {
    fn name(&self) -> &'static str {
        "internet_search"
    }

    fn description(&self) -> &str {
        match self.surface {
            ToolSurface::Agent => AGENT_DESCRIPTION,
            ToolSurface::Sidecar => SIDECAR_DESCRIPTION,
        }
    }

    fn parameters(&self) -> Value {
        crate::anchor_schema!(SearchParams { query, count });
        let mut schema = schema_of::<SearchParams>();
        set_property_description(&mut schema, "query", "Search query");
        set_property_description(
            &mut schema,
            "count",
            "Number of results (default: 5, max: 10)",
        );
        schema
    }

    async fn execute(
        &self,
        args: Value,
        _cancellation: &tokio_util::sync::CancellationToken,
        _context: &ToolContext,
    ) -> protocol::ToolResult {
        let query = string(&args, "query").unwrap_or("");
        if query.is_empty() {
            return text("Error: No search query provided");
        }
        let count = result_count(args.get("count"), self.max_results as f64);
        let cache_key = format!("{query}::{}", protocol::JsNumber::from(count));
        if let Some(cached) = self.cache_get(&cache_key) {
            return text(cached);
        }
        let mut errors = Vec::new();
        for provider in &self.providers {
            match self.search_with_retry(provider, query, count).await {
                Ok(results) if results.is_empty() => {
                    errors.push(format!("{}: no results", provider.name()));
                }
                Ok(results) => {
                    let output = format_results(&results);
                    self.cache_set(cache_key, output.clone(), SEARCH_CACHE_TTL);
                    return text(output);
                }
                Err(err) => errors.push(format!("{}: {err}", provider.name())),
            }
        }
        let listed = errors
            .iter()
            .map(|err| format!("  - {err}"))
            .collect::<Vec<_>>()
            .join("\n");
        text(format!("Search failed. All providers exhausted:\n{listed}"))
    }
}

impl WebSearchTool {
    async fn search_with_retry(
        &self,
        provider: &Provider,
        query: &str,
        count: f64,
    ) -> Result<Vec<SearchHit>, String> {
        let mut last = String::new();
        for attempt in 0..=2 {
            match self.search_once(provider, query, count).await {
                Ok(results) => return Ok(results),
                Err(err) => {
                    let transient = is_transient(&err);
                    last = err;
                    if !transient || attempt == 2 {
                        return Err(last);
                    }
                    let delay = self.retry_base.saturating_mul((attempt + 1) as u32);
                    tokio::time::sleep(delay).await;
                }
            }
        }
        Err(last)
    }

    async fn search_once(
        &self,
        provider: &Provider,
        query: &str,
        count: f64,
    ) -> Result<Vec<SearchHit>, String> {
        match provider {
            Provider::Xai {
                key,
                model,
                endpoint,
            } => xai_search(self.http.as_ref(), endpoint, key, model, query, count).await,
            Provider::Google { key, cse, endpoint } => {
                google_search(self.http.as_ref(), endpoint, key, cse, query, count).await
            }
            Provider::Ddg { endpoint } => {
                ddg_search(self.http.as_ref(), endpoint, query, count).await
            }
        }
    }

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

async fn xai_search(
    http: &dyn HttpClient,
    endpoint: &str,
    key: &str,
    model: &str,
    query: &str,
    count: f64,
) -> Result<Vec<SearchHit>, String> {
    let body = json!({
        "model": model,
        "input": query,
        "tools": [{ "type": "web_search" }]
    })
    .to_string();
    let response = http
        .send(HttpRequest {
            method: "POST".to_string(),
            url: endpoint.to_string(),
            headers: vec![
                ("Authorization".to_string(), format!("Bearer {key}")),
                ("Content-Type".to_string(), "application/json".to_string()),
            ],
            body: Some(body),
            timeout: Duration::from_secs(45),
        })
        .await?;
    if response.status < 200 || response.status >= 300 {
        let snippet = utf16_prefix(&response.body, 160);
        return Err(status_error(
            response.status,
            format!("web search {}: {snippet}", response.status),
        ));
    }
    let data: Value = serde_json::from_str(&response.body).unwrap_or(Value::Null);
    let output = data
        .get("output")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let message = output
        .iter()
        .find(|item| item.get("type").and_then(Value::as_str) == Some("message"));
    let text_part = message
        .and_then(|item| item.get("content"))
        .and_then(Value::as_array)
        .and_then(|parts| {
            parts
                .iter()
                .find(|part| part.get("type").and_then(Value::as_str) == Some("output_text"))
        });
    let answer = js_trim(
        text_part
            .and_then(|part| part.get("text"))
            .and_then(Value::as_str)
            .unwrap_or(""),
    )
    .to_string();
    let mut results = Vec::new();
    if !answer.is_empty() {
        results.push(SearchHit {
            title: "Answer".to_string(),
            snippet: answer,
            url: String::new(),
            source: "web".to_string(),
        });
    }
    let mut seen = std::collections::HashSet::new();
    let mut push_url = |results: &mut Vec<SearchHit>, url: &str, title: Option<&str>| {
        if url.is_empty() || !seen.insert(url.to_string()) {
            return;
        }
        let numeric = title.is_some_and(|title| {
            let trimmed = js_trim(title);
            !trimmed.is_empty() && trimmed.chars().all(|ch| ch.is_ascii_digit())
        });
        let label = match title {
            Some(title) if !numeric && !js_trim(title).is_empty() => title.to_string(),
            _ => hostname_of(url),
        };
        results.push(SearchHit {
            title: label,
            snippet: String::new(),
            url: url.to_string(),
            source: hostname_of(url),
        });
    };
    let annotations = text_part
        .and_then(|part| part.get("annotations"))
        .and_then(Value::as_array);
    if let Some(annotations) = annotations {
        for ann in annotations {
            if ann.get("type").and_then(Value::as_str) == Some("url_citation") {
                let url = ann.get("url").and_then(Value::as_str).unwrap_or("");
                let title = ann.get("title").and_then(Value::as_str);
                push_url(&mut results, url, title);
            }
        }
    }
    if results.len() <= 1 {
        for item in &output {
            if item.get("type").and_then(Value::as_str) != Some("web_search_call") {
                continue;
            }
            let sources = item
                .get("action")
                .and_then(|action| action.get("sources"))
                .and_then(Value::as_array);
            if let Some(sources) = sources {
                for source in sources {
                    let url = source.get("url").and_then(Value::as_str).unwrap_or("");
                    push_url(&mut results, url, None);
                }
            }
        }
    }
    let end = js_slice_end(count + 1.0);
    if results.len() > end {
        results.truncate(end);
    }
    Ok(results)
}

async fn google_search(
    http: &dyn HttpClient,
    endpoint: &str,
    key: &str,
    cse: &str,
    query: &str,
    count: f64,
) -> Result<Vec<SearchHit>, String> {
    let params = form_encode(&[
        ("key", key),
        ("cx", cse),
        ("q", query),
        ("num", &protocol::JsNumber::from(count).to_string()),
    ]);
    let url = format!("{endpoint}?{params}");
    let response = http
        .send(HttpRequest {
            method: "GET".to_string(),
            url,
            headers: Vec::new(),
            body: None,
            timeout: Duration::from_secs(10),
        })
        .await?;
    if !(200..300).contains(&response.status) {
        if response.status == 403 || response.status == 429 || response.status >= 500 {
            return Err(status_error(
                response.status,
                format!("Google CSE {}", response.status),
            ));
        }
        let snippet = utf16_prefix(&response.body, 200);
        return Err(format!(
            "Google CSE failed ({}): {snippet}",
            response.status
        ));
    }
    let data: Value = serde_json::from_str(&response.body).unwrap_or(Value::Null);
    let items = data
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(items
        .into_iter()
        .map(|item| SearchHit {
            title: item
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            snippet: item
                .get("snippet")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            url: item
                .get("link")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            source: "Google".to_string(),
        })
        .collect())
}

async fn ddg_search(
    http: &dyn HttpClient,
    endpoint: &str,
    query: &str,
    count: f64,
) -> Result<Vec<SearchHit>, String> {
    let params = form_encode(&[("q", query)]);
    let url = format!("{endpoint}?{params}");
    let response = http
        .send(HttpRequest {
            method: "POST".to_string(),
            url,
            headers: vec![
                (
                    "User-Agent".to_string(),
                    "RivetOS/0.1.0 (web-search)".to_string(),
                ),
                (
                    "Content-Type".to_string(),
                    "application/x-www-form-urlencoded".to_string(),
                ),
            ],
            body: Some(params),
            timeout: Duration::from_secs(10),
        })
        .await?;
    if !(200..300).contains(&response.status) {
        return Err(status_error(
            response.status,
            format!("DuckDuckGo {}", response.status),
        ));
    }
    Ok(parse_ddg(&response.body, count))
}

fn parse_ddg(html: &str, max_results: f64) -> Vec<SearchHit> {
    let Ok(blocks) =
        Regex::new(r#"(?i)<div[^>]*class="[^"]*result[^"]*"[^>]*>[\s\S]*?</div>\s*</div>"#)
    else {
        return Vec::new();
    };
    let Ok(title_re) =
        Regex::new(r#"(?i)<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)</a>"#)
    else {
        return Vec::new();
    };
    let Ok(snippet_a) = Regex::new(r#"(?i)<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)</a>"#)
    else {
        return Vec::new();
    };
    let Ok(snippet_td) = Regex::new(r#"(?i)<td[^>]*class="result__snippet"[^>]*>([\s\S]*?)</td>"#)
    else {
        return Vec::new();
    };
    let Ok(tags) = Regex::new(r"<[^>]+>") else {
        return Vec::new();
    };
    let mut results = Vec::new();
    for block in blocks.find_iter(html) {
        if results.len() as f64 >= max_results {
            break;
        }
        let block = block.as_str();
        let Some(title_match) = title_re.captures(block) else {
            continue;
        };
        let href = title_match.get(1).map(|item| item.as_str()).unwrap_or("");
        let raw_title = title_match.get(2).map(|item| item.as_str()).unwrap_or("");
        let snippet_raw = snippet_a
            .captures(block)
            .or_else(|| snippet_td.captures(block))
            .and_then(|caps| caps.get(1).map(|item| item.as_str()))
            .unwrap_or("");
        let after_uddg = match href.rfind("uddg=") {
            Some(index) => &href[index + "uddg=".len()..],
            None => href,
        };
        let stripped = after_uddg.split('&').next().unwrap_or("").to_string();
        let Ok(url) = decode_uri_component(&stripped) else {
            continue;
        };
        let title = js_trim(&tags.replace_all(raw_title, "")).to_string();
        let snippet = js_trim(&tags.replace_all(snippet_raw, "")).to_string();
        if !url.is_empty() && !title.is_empty() && !url.contains("duckduckgo.com") {
            results.push(SearchHit {
                title,
                snippet,
                url,
                source: "DuckDuckGo".to_string(),
            });
        }
    }
    results
}

fn format_results(results: &[SearchHit]) -> String {
    results
        .iter()
        .enumerate()
        .map(|(index, hit)| {
            format!(
                "{}. **{}**\n   {}\n   {}\n   [Source: {}]",
                index + 1,
                hit.title,
                hit.snippet,
                hit.url,
                hit.source
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn result_count(value: Option<&Value>, max_results: f64) -> f64 {
    let raw = args::js_number(value);
    let chosen = if raw == 0.0 || raw.is_nan() {
        max_results
    } else {
        raw
    };
    if !chosen.is_finite() {
        return 10.0;
    }
    chosen.min(10.0)
}

fn js_slice_end(value: f64) -> usize {
    if !value.is_finite() || value <= 0.0 {
        0
    } else {
        value.trunc() as usize
    }
}

fn is_transient(err: &str) -> bool {
    if err.contains("fetch failed") || err.contains("ECONNREFUSED") {
        return true;
    }
    status_of(err).is_some_and(|status| status == 429 || status >= 500)
}

fn status_error(status: u16, message: String) -> String {
    format!("status={status} {message}")
}

fn status_of(err: &str) -> Option<u16> {
    let rest = err.strip_prefix("status=")?;
    let number = rest.split_whitespace().next()?;
    number.parse().ok()
}

fn resolve_optional(explicit: Option<&str>, env_names: &[&str]) -> String {
    if let Some(value) = explicit {
        return value.to_string();
    }
    for name in env_names {
        if let Ok(value) = std::env::var(name) {
            return value;
        }
    }
    String::new()
}

fn hostname_of(url: &str) -> String {
    let Some(parsed) = url::Url::parse(url).ok() else {
        return "web".to_string();
    };
    let host = parsed.host_str().unwrap_or("web");
    host.strip_prefix("www.").unwrap_or(host).to_string()
}

fn form_encode(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(key, value)| format!("{}={}", encode_component(key), encode_component(value)))
        .collect::<Vec<_>>()
        .join("&")
}

fn encode_component(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(byte as char);
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn decode_uri_component(value: &str) -> Result<String, ()> {
    let bytes = value.as_bytes();
    let mut out = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(());
            }
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).map_err(|_| ())?;
            let byte = u8::from_str_radix(hex, 16).map_err(|_| ())?;
            out.push(byte);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).map_err(|_| ())
}

fn utf16_prefix(text: &str, max: usize) -> String {
    crate::textutil::utf16_slice(text, 0, max)
}
