use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tools::{
    CancellationToken, HttpRequest, HttpResponse, RecordingClient, Tool, ToolContext,
    WebFetchConfig, WebFetchTool, WebSearchConfig, WebSearchTool, XAI_RESPONSES_URL,
    request_header, result_text,
};

fn offline() -> WebSearchConfig {
    WebSearchConfig {
        xai_api_key: Some(String::new()),
        google_api_key: Some(String::new()),
        google_cse_id: Some(String::new()),
        retry_base: Duration::from_millis(1),
        ..WebSearchConfig::default()
    }
}

fn response(status: u16, status_text: &str, content_type: &str, body: &str) -> HttpResponse {
    HttpResponse {
        status,
        status_text: status_text.to_string(),
        headers: vec![("content-type".to_string(), content_type.to_string())],
        body: body.to_string(),
    }
}

async fn run(tool: &impl Tool, args: Value) -> String {
    result_text(
        &tool
            .execute(args, &CancellationToken::new(), &ToolContext::default())
            .await,
    )
    .to_string()
}

fn required(schema: &Value, name: &str) -> bool {
    schema
        .get("required")
        .and_then(Value::as_array)
        .map(|items| items.iter().any(|item| item.as_str() == Some(name)))
        .unwrap_or(false)
}

const DDG_HTML: &str = r#"
      <div class="result results_links results_links_deep web-result">
        <div class="links_main links_deep result__body">
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffallback.com">DDG Title</a>
          <a class="result__snippet">DDG snippet here</a>
        </div>
      </div>
    "#;

const DDG_ONLY_HTML: &str = r#"
        <div class="result">
          <div class="result__body">
            <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fddg-only.com">DDG Only</a>
            <a class="result__snippet">Only DDG available</a>
          </div>
        </div>
      "#;

fn google_body() -> String {
    json!({
        "items": [
            {"title": "Test Result", "snippet": "A test snippet", "link": "https://example.com"},
            {"title": "Another Result", "snippet": "More info", "link": "https://example.org"}
        ]
    })
    .to_string()
}

fn xai_body() -> String {
    json!({
        "output": [
            {"type": "reasoning", "summary": []},
            {"type": "web_search_call", "action": {"sources": [{"type": "url", "url": "https://nodejs.org/en"}]}},
            {"type": "message", "content": [{
                "type": "output_text",
                "text": "The latest LTS is v24.18.0.[[1]](https://nodejs.org/en)",
                "annotations": [{"type": "url_citation", "url": "https://nodejs.org/en", "title": "1"}]
            }]}
        ]
    })
    .to_string()
}

#[tokio::test]
async fn search_metadata_and_empty_query() {
    let tool = WebSearchTool::new(offline());
    assert_eq!(tool.name(), "internet_search");
    assert!(!tool.description().is_empty());
    assert!(required(&tool.parameters(), "query"));
    let result = run(&tool, json!({"query": ""})).await;
    assert!(result.contains("Error"));
    let sidecar = WebSearchTool::sidecar(offline());
    assert!(sidecar.description().contains("Mirrors"));
}

#[tokio::test]
async fn google_results_and_cache() {
    let client = RecordingClient::new(|_request: &HttpRequest| {
        Ok(response(200, "OK", "application/json", &google_body()))
    });
    let config = WebSearchConfig {
        google_api_key: Some("test-key".to_string()),
        google_cse_id: Some("test-cse".to_string()),
        xai_api_key: Some(String::new()),
        retry_base: Duration::from_millis(1),
        ..WebSearchConfig::default()
    };
    let http: Arc<dyn tools::HttpClient> = client.clone();
    let tool = WebSearchTool::with_http(config, http);
    let result = run(&tool, json!({"query": "test query"})).await;
    assert!(result.contains("Test Result"), "{result}");
    assert!(result.contains("example.com"));
    assert!(result.contains("[Source: Google]"));
    let cached = RecordingClient::new(|_| {
        Ok(response(
            200,
            "OK",
            "application/json",
            &json!({"items":[{"title":"Cached","snippet":"cached result","link":"https://cached.com"}]}).to_string(),
        ))
    });
    let http: Arc<dyn tools::HttpClient> = cached.clone();
    let tool = WebSearchTool::with_http(
        WebSearchConfig {
            google_api_key: Some("key".to_string()),
            google_cse_id: Some("cse".to_string()),
            xai_api_key: Some(String::new()),
            retry_base: Duration::from_millis(1),
            ..WebSearchConfig::default()
        },
        http,
    );
    let first = run(&tool, json!({"query": "cache test", "count": 5})).await;
    let second = run(&tool, json!({"query": "cache test", "count": 5})).await;
    assert_eq!(first, second);
    assert_eq!(cached.calls().len(), 1);
}

#[tokio::test]
async fn falls_back_to_duckduckgo_on_google_403() {
    let client = RecordingClient::new(|request: &HttpRequest| {
        if request.url.contains("duckduckgo") {
            Ok(response(200, "OK", "text/html", DDG_HTML))
        } else {
            Ok(response(403, "Forbidden", "text/plain", "forbidden"))
        }
    });
    let http: Arc<dyn tools::HttpClient> = client.clone();
    let tool = WebSearchTool::with_http(
        WebSearchConfig {
            google_api_key: Some("test-key".to_string()),
            google_cse_id: Some("test-cse".to_string()),
            xai_api_key: Some(String::new()),
            retry_base: Duration::from_millis(1),
            ..WebSearchConfig::default()
        },
        http,
    );
    let result = run(&tool, json!({"query": "test fallback"})).await;
    assert!(
        result.contains("DDG Title") || result.contains("DuckDuckGo"),
        "{result}"
    );
    assert_eq!(
        client
            .calls()
            .iter()
            .filter(|call| !call.url.contains("duckduckgo"))
            .count(),
        1
    );
}

#[tokio::test]
async fn all_providers_fail() {
    let client = RecordingClient::new(|_: &HttpRequest| Err("Network error".to_string()));
    let http: Arc<dyn tools::HttpClient> = client;
    let tool = WebSearchTool::with_http(
        WebSearchConfig {
            google_api_key: Some("test-key".to_string()),
            google_cse_id: Some("test-cse".to_string()),
            xai_api_key: Some(String::new()),
            retry_base: Duration::from_millis(1),
            ..WebSearchConfig::default()
        },
        http,
    );
    let result = run(&tool, json!({"query": "doomed query"})).await;
    assert!(result.contains("Search failed"), "{result}");
    assert!(result.contains("All providers exhausted"));
}

#[tokio::test]
async fn ddg_only_when_no_google_keys() {
    let client =
        RecordingClient::new(|_: &HttpRequest| Ok(response(200, "OK", "text/html", DDG_ONLY_HTML)));
    let http: Arc<dyn tools::HttpClient> = client.clone();
    let tool = WebSearchTool::with_http(offline(), http);
    let _ = run(&tool, json!({"query": "ddg only"})).await;
    assert!(!client.calls().is_empty());
    assert!(client.calls()[0].url.contains("duckduckgo"));
}

#[tokio::test]
async fn xai_provider_behavior() {
    let client = RecordingClient::new(|request: &HttpRequest| {
        if request.url == XAI_RESPONSES_URL {
            Ok(response(200, "OK", "application/json", &xai_body()))
        } else {
            Err("unexpected provider".to_string())
        }
    });
    let http: Arc<dyn tools::HttpClient> = client.clone();
    let tool = WebSearchTool::with_http(
        WebSearchConfig {
            xai_api_key: Some("test-key".to_string()),
            retry_base: Duration::from_millis(1),
            ..WebSearchConfig::default()
        },
        http,
    );
    let result = run(&tool, json!({"query": "latest node lts", "count": 5})).await;
    assert_eq!(client.calls()[0].url, XAI_RESPONSES_URL);
    assert!(result.contains("v24.18.0"), "{result}");
    assert!(result.contains("nodejs.org"));
    assert!(!result.to_lowercase().contains("xai"));
    assert!(!result.to_lowercase().contains("grok"));
    let quiet =
        RecordingClient::new(|_| Ok(response(200, "OK", "application/json", "{\"output\":[]}")));
    let http: Arc<dyn tools::HttpClient> = quiet.clone();
    let tool = WebSearchTool::with_http(offline(), http);
    let _ = run(&tool, json!({"query": "x", "count": 3})).await;
    assert!(
        quiet
            .calls()
            .iter()
            .all(|call| !call.url.contains("api.x.ai"))
    );
}

#[tokio::test]
async fn fetch_cases() {
    let tool = WebFetchTool::new(WebFetchConfig::default());
    assert_eq!(tool.name(), "web_fetch");
    assert!(!tool.description().is_empty());
    assert!(required(&tool.parameters(), "url"));
    assert!(run(&tool, json!({"url": ""})).await.contains("Error"));
    let sidecar = WebFetchTool::sidecar(WebFetchConfig::default());
    assert!(sidecar.description().contains("PDFs are detected"));
    let html = r#"
      <html>
      <head><title>Test</title></head>
      <body>
        <nav>Skip this nav</nav>
        <main>
          <h1>Main Title</h1>
          <p>This is a paragraph with <strong>bold</strong> and <em>italic</em> text.</p>
          <h2>Section Two</h2>
          <ul>
            <li>Item one</li>
            <li>Item two</li>
          </ul>
          <a href="https://example.com">A link</a>
        </main>
        <footer>Skip this footer</footer>
      </body>
      </html>
    "#;
    let client = RecordingClient::new(move |_: &HttpRequest| {
        Ok(response(200, "OK", "text/html; charset=utf-8", html))
    });
    let http: Arc<dyn tools::HttpClient> = client;
    let tool = WebFetchTool::with_http(WebFetchConfig::default(), http);
    let result = run(&tool, json!({"url": "https://test.com"})).await;
    assert!(result.contains("# Main Title"), "{result}");
    assert!(result.contains("**bold**"));
    assert!(result.contains("*italic*"));
    assert!(result.contains("- Item one"));
    assert!(result.contains("[A link](https://example.com)"));
    assert!(!result.contains("Skip this nav"));
    assert!(!result.contains("Skip this footer"));
    let noisy = r#"
      <html><body>
        <script>alert('xss')</script>
        <style>.red { color: red; }</style>
        <p>Visible content</p>
      </body></html>
    "#;
    let client =
        RecordingClient::new(move |_: &HttpRequest| Ok(response(200, "OK", "text/html", noisy)));
    let http: Arc<dyn tools::HttpClient> = client;
    let tool = WebFetchTool::with_http(WebFetchConfig::default(), http);
    let result = run(&tool, json!({"url": "https://test.com"})).await;
    assert!(result.contains("Visible content"), "{result}");
    assert!(!result.contains("alert"));
    assert!(!result.contains(".red"));
    let data = json!({"key": "value", "nested": {"a": 1}}).to_string();
    let client = RecordingClient::new(move |_: &HttpRequest| {
        Ok(response(200, "OK", "application/json", &data))
    });
    let http: Arc<dyn tools::HttpClient> = client;
    let tool = WebFetchTool::with_http(WebFetchConfig::default(), http);
    let result = run(&tool, json!({"url": "https://api.test.com/data"})).await;
    assert!(result.contains("\"key\": \"value\""), "{result}");
    assert!(result.contains("\"a\": 1"));
    let client = RecordingClient::new(|_: &HttpRequest| {
        Ok(response(200, "OK", "application/pdf", "binary pdf data"))
    });
    let http: Arc<dyn tools::HttpClient> = client;
    let tool = WebFetchTool::with_http(WebFetchConfig::default(), http);
    let result = run(&tool, json!({"url": "https://test.com/file.pdf"})).await;
    assert!(result.contains("PDF"));
    assert!(result.contains("not yet supported"));
    let long_text = "a".repeat(10000);
    let client = RecordingClient::new(move |_: &HttpRequest| {
        Ok(response(200, "OK", "text/plain", &long_text))
    });
    let http: Arc<dyn tools::HttpClient> = client;
    let tool = WebFetchTool::with_http(WebFetchConfig::default(), http);
    let result = run(&tool, json!({"url": "https://test.com", "max_chars": 100})).await;
    assert!(result.len() < 10000);
    assert!(result.contains("[Truncated at 100 chars"));
    assert!(result.contains("max_chars"));
    let cached = RecordingClient::new(|_: &HttpRequest| {
        Ok(response(200, "OK", "text/plain", "cached content"))
    });
    let http: Arc<dyn tools::HttpClient> = cached.clone();
    let tool = WebFetchTool::with_http(WebFetchConfig::default(), http);
    let first = run(&tool, json!({"url": "https://cache-test.com"})).await;
    let second = run(&tool, json!({"url": "https://cache-test.com"})).await;
    assert_eq!(first, second);
    assert_eq!(cached.calls().len(), 1);
    let agent =
        RecordingClient::new(|_: &HttpRequest| Ok(response(200, "OK", "text/plain", "content")));
    let http: Arc<dyn tools::HttpClient> = agent.clone();
    let tool = WebFetchTool::with_http(
        WebFetchConfig {
            user_agent: Some("CustomBot/2.0".to_string()),
            ..WebFetchConfig::default()
        },
        http,
    );
    let _ = run(&tool, json!({"url": "https://test.com"})).await;
    let calls = agent.calls();
    let request = http_request(&calls[0]);
    assert_eq!(
        request_header(&request, "User-Agent"),
        Some("CustomBot/2.0")
    );
    let raw =
        RecordingClient::new(|_: &HttpRequest| Ok(response(200, "OK", "text/plain", "# README")));
    let http: Arc<dyn tools::HttpClient> = raw.clone();
    let tool = WebFetchTool::with_http(WebFetchConfig::default(), http);
    let _ = run(
        &tool,
        json!({"url": "https://raw.githubusercontent.com/user/repo/main/README.md"}),
    )
    .await;
    let calls = raw.calls();
    let request = http_request(&calls[0]);
    assert_eq!(request_header(&request, "Accept"), Some("text/plain"));
    let down = RecordingClient::new(|_: &HttpRequest| Err("Connection refused".to_string()));
    let http: Arc<dyn tools::HttpClient> = down;
    let tool = WebFetchTool::with_http(WebFetchConfig::default(), http);
    let result = run(&tool, json!({"url": "https://down.com"})).await;
    assert!(result.contains("Fetch error"));
    assert!(result.contains("Connection refused"));
    let missing = RecordingClient::new(|_: &HttpRequest| {
        Ok(response(404, "Not Found", "text/plain", "not found"))
    });
    let http: Arc<dyn tools::HttpClient> = missing;
    let tool = WebFetchTool::with_http(WebFetchConfig::default(), http);
    let result = run(&tool, json!({"url": "https://test.com/missing"})).await;
    assert!(result.contains("404"));
    assert!(result.contains("Not Found"));
    let entities = "<html><body><p>AT&amp;T &mdash; &ldquo;quoted&rdquo; &#169;</p></body></html>";
    let client =
        RecordingClient::new(move |_: &HttpRequest| Ok(response(200, "OK", "text/html", entities)));
    let http: Arc<dyn tools::HttpClient> = client;
    let tool = WebFetchTool::with_http(WebFetchConfig::default(), http);
    let result = run(&tool, json!({"url": "https://test.com"})).await;
    assert!(result.contains("AT&T"), "{result}");
    assert!(result.contains("—"));
    assert!(result.contains("©"));
}

fn http_request(call: &tools::RecordedCall) -> HttpRequest {
    HttpRequest {
        method: call.method.clone(),
        url: call.url.clone(),
        headers: call.headers.clone(),
        body: call.body.clone(),
        timeout: Duration::from_secs(1),
    }
}

#[tokio::test]
async fn fetch_invalid_url_returns_text() {
    let tool = WebFetchTool::new(WebFetchConfig::default());
    let result = run(
        &tool,
        json!({"url": "http://127.0.0.1:1/nope", "max_chars": 1000}),
    )
    .await;
    assert!(result.contains("Fetch error"), "{result}");
}
