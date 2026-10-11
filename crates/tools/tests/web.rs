use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

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
    HttpResponse::with_text(
        status,
        status_text,
        vec![("content-type".to_string(), content_type.to_string())],
        body,
    )
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
async fn google_transport_error_redacts_api_key() {
    let key = "super-secret-google-key-value";
    let client = RecordingClient::new(|request: &HttpRequest| {
        Err(format!("error sending request for url ({})", request.url))
    });
    let http: Arc<dyn tools::HttpClient> = client;
    let tool = WebSearchTool::with_http(
        WebSearchConfig {
            google_api_key: Some(key.to_string()),
            google_cse_id: Some("test-cse".to_string()),
            xai_api_key: Some(String::new()),
            retry_base: Duration::from_millis(1),
            ..WebSearchConfig::default()
        },
        http,
    );
    let result = run(&tool, json!({"query": "secret query"})).await;
    assert!(result.contains("Search failed"), "{result}");
    assert!(!result.contains(key), "{result}");
    assert!(!result.contains("key="), "{result}");
}

#[tokio::test]
async fn google_403_message_omits_status_prefix() {
    let client = RecordingClient::new(|request: &HttpRequest| {
        if request.url.contains("duckduckgo") {
            Err("ddg down".to_string())
        } else {
            Ok(response(403, "Forbidden", "text/plain", "nope"))
        }
    });
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
    let result = run(&tool, json!({"query": "status line"})).await;
    assert!(result.contains("Google: Google CSE 403"), "{result}");
    assert!(!result.contains("status="), "{result}");
    assert!(result.contains("DuckDuckGo: ddg down"), "{result}");
}

#[tokio::test]
async fn fetch_json_uses_js_number_and_key_order() {
    let body = r#"{"a":"c","2":"b","value":1.0}"#;
    let client = RecordingClient::new(move |_: &HttpRequest| {
        Ok(response(200, "OK", "application/json", body))
    });
    let http: Arc<dyn tools::HttpClient> = client;
    let tool = WebFetchTool::with_http(WebFetchConfig::default(), http);
    let result = run(&tool, json!({"url": "https://api.test.com/order"})).await;
    assert_eq!(
        result,
        "{\n  \"2\": \"b\",\n  \"a\": \"c\",\n  \"value\": 1\n}"
    );
}

#[tokio::test]
async fn fetch_negative_max_chars_drops_last_unit() {
    let client =
        RecordingClient::new(|_: &HttpRequest| Ok(response(200, "OK", "text/plain", "abc")));
    let http: Arc<dyn tools::HttpClient> = client;
    let tool = WebFetchTool::with_http(WebFetchConfig::default(), http);
    let result = run(
        &tool,
        json!({"url": "https://test.com/short", "max_chars": -1}),
    )
    .await;
    assert!(result.starts_with("ab\n"), "{result}");
    assert!(result.contains("Truncated at -1 chars"), "{result}");
}

#[tokio::test]
async fn fetch_truncation_keeps_utf16_units_on_the_wire() {
    let client =
        RecordingClient::new(|_: &HttpRequest| Ok(response(200, "OK", "text/plain", "A😀B")));
    let http: Arc<dyn tools::HttpClient> = client.clone();
    let tool = WebFetchTool::with_http(WebFetchConfig::default(), http);
    let args = json!({"url": "https://test.com/emoji", "max_chars": 2});
    let first = tool
        .execute(
            args.clone(),
            &CancellationToken::new(),
            &ToolContext::default(),
        )
        .await;
    let second = tool
        .execute(args, &CancellationToken::new(), &ToolContext::default())
        .await;
    let first_json = serde_json::to_string(&first).unwrap();
    let second_json = serde_json::to_string(&second).unwrap();
    assert_eq!(first_json, second_json);
    assert_eq!(client.calls().len(), 1);
    assert!(first_json.contains(r"\ud83d"), "{first_json}");
    assert!(!first_json.contains(r"\ude00"), "{first_json}");
    assert!(!first_json.contains('\u{FFFD}'), "{first_json}");
    assert!(first_json.contains("Truncated at 2 chars"), "{first_json}");
}

#[tokio::test]
async fn fetch_user_agent_comes_from_the_injected_env() {
    let client =
        RecordingClient::new(|_: &HttpRequest| Ok(response(200, "OK", "text/plain", "hi")));
    let http: Arc<dyn tools::HttpClient> = client.clone();
    let mut env = protocol::host::MapEnv::new();
    env.set("RIVETOS_USER_AGENT", "SyntheticAgent/9");
    let tool = WebFetchTool::with_http_env(WebFetchConfig::default(), http, &env);
    let result = run(&tool, json!({"url": "https://test.com/agent"})).await;
    assert_eq!(result, "hi");
    let calls = client.calls();
    assert_eq!(
        header_of(&calls[0], "User-Agent").as_deref(),
        Some("SyntheticAgent/9")
    );
    let explicit =
        RecordingClient::new(|_: &HttpRequest| Ok(response(200, "OK", "text/plain", "hi")));
    let http: Arc<dyn tools::HttpClient> = explicit.clone();
    let tool = WebFetchTool::with_http_env(
        WebFetchConfig {
            user_agent: Some("Explicit/1".to_string()),
            ..WebFetchConfig::default()
        },
        http,
        &env,
    );
    let _ = run(&tool, json!({"url": "https://test.com/explicit"})).await;
    assert_eq!(
        header_of(&explicit.calls()[0], "User-Agent").as_deref(),
        Some("Explicit/1")
    );
}

fn header_of(call: &tools::RecordedCall, name: &str) -> Option<String> {
    call.headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.clone())
}

#[tokio::test]
async fn google_key_precedence_uses_the_injected_env() {
    let body = r#"{"items":[{"title":"T","snippet":"S","link":"https://example.com"}]}"#;
    let preferred = RecordingClient::new(move |_: &HttpRequest| {
        Ok(response(200, "OK", "application/json", body))
    });
    let http: Arc<dyn tools::HttpClient> = preferred.clone();
    let mut env = protocol::host::MapEnv::new();
    env.set("GOOGLE_CSE_API_KEY", "cse-key-preferred");
    env.set("GOOGLE_API_KEY", "api-key-fallback");
    env.set("GOOGLE_CSE_ID", "cse-id-value");
    let tool = WebSearchTool::with_http_env(
        WebSearchConfig {
            xai_api_key: Some(String::new()),
            google_endpoint: Some("https://google.test/search".to_string()),
            retry_base: Duration::from_millis(1),
            ..WebSearchConfig::default()
        },
        http,
        &env,
    );
    let result = run(&tool, json!({"query": "widgets"})).await;
    assert!(result.contains("example.com"), "{result}");
    let url = preferred.calls()[0].url.clone();
    assert!(url.contains("cse-key-preferred"), "{url}");
    assert!(!url.contains("api-key-fallback"), "{url}");

    let fallback_client = RecordingClient::new(move |_: &HttpRequest| {
        Ok(response(200, "OK", "application/json", body))
    });
    let http: Arc<dyn tools::HttpClient> = fallback_client.clone();
    let mut fallback = protocol::host::MapEnv::new();
    fallback.set("GOOGLE_API_KEY", "api-key-fallback");
    fallback.set("GOOGLE_CSE_ID", "cse-id-value");
    let tool = WebSearchTool::with_http_env(
        WebSearchConfig {
            xai_api_key: Some(String::new()),
            google_endpoint: Some("https://google.test/search".to_string()),
            retry_base: Duration::from_millis(1),
            ..WebSearchConfig::default()
        },
        http,
        &fallback,
    );
    let _ = run(&tool, json!({"query": "widgets"})).await;
    let url = fallback_client.calls()[0].url.clone();
    assert!(url.contains("api-key-fallback"), "{url}");

    let empty_client =
        RecordingClient::new(move |_: &HttpRequest| Ok(response(200, "OK", "text/html", DDG_HTML)));
    let http: Arc<dyn tools::HttpClient> = empty_client.clone();
    let mut empty = protocol::host::MapEnv::new();
    empty.set("GOOGLE_CSE_API_KEY", "");
    empty.set("GOOGLE_API_KEY", "api-key-fallback");
    empty.set("GOOGLE_CSE_ID", "cse-id-value");
    let tool = WebSearchTool::with_http_env(
        WebSearchConfig {
            xai_api_key: Some(String::new()),
            google_endpoint: Some("https://google.test/search".to_string()),
            retry_base: Duration::from_millis(1),
            ..WebSearchConfig::default()
        },
        http,
        &empty,
    );
    let _ = run(&tool, json!({"query": "widgets"})).await;
    let url = empty_client.calls()[0].url.clone();
    assert!(!url.contains("api-key-fallback"), "{url}");
    assert!(!url.contains("google.test"), "{url}");
}

#[tokio::test]
async fn fetch_refused_port_redacts_userinfo() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let secret = "ghp_example_token_value";
    let url = format!("http://x-access-token:{secret}@127.0.0.1:{port}/org/repo");
    let tool = WebFetchTool::new(WebFetchConfig::default());
    let result = run(&tool, json!({"url": url, "max_chars": 1000})).await;
    assert!(result.contains("Fetch error"), "{result}");
    assert!(!result.contains(secret), "{result}");
    assert!(!result.contains("x-access-token"), "{result}");
}

fn http_message(status_line: &str, headers: &str, length: usize, body: &str) -> String {
    format!(
        "{status_line}\r\n{headers}\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n{body}"
    )
}

async fn spawn_local_http(
    response: impl Into<Vec<u8>>,
    stall: bool,
    hits: Option<Arc<AtomicUsize>>,
) -> u16 {
    let response = response.into();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            if let Some(hits) = &hits {
                hits.fetch_add(1, Ordering::SeqCst);
            }
            let response = response.clone();
            tokio::spawn(async move {
                let mut received = Vec::new();
                let mut buf = [0u8; 1024];
                loop {
                    if received.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                    let Ok(n) = socket.read(&mut buf).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    received.extend_from_slice(&buf[..n]);
                    if received.len() > 65536 {
                        return;
                    }
                }
                if socket.write_all(&response).await.is_err() {
                    return;
                }
                if stall {
                    let _ = socket.read(&mut buf).await;
                }
            });
        }
    });
    port
}

#[tokio::test]
async fn fetch_local_http_reads_a_finished_body() {
    let response = http_message(
        "HTTP/1.1 200 OK",
        "Content-Type: text/plain",
        "hello".len(),
        "hello",
    );
    let port = spawn_local_http(response, false, None).await;
    let tool = WebFetchTool::new(WebFetchConfig::default());
    let result = run(
        &tool,
        json!({"url": format!("http://127.0.0.1:{port}/hello")}),
    )
    .await;
    assert_eq!(result, "hello");
}

#[tokio::test]
async fn fetch_pdf_ignores_an_incomplete_body() {
    let response = http_message(
        "HTTP/1.1 200 OK",
        "Content-Type: application/pdf",
        1_000_000,
        "",
    );
    let port = spawn_local_http(response, false, None).await;
    let tool = WebFetchTool::new(WebFetchConfig::default());
    let started = std::time::Instant::now();
    let result = run(
        &tool,
        json!({"url": format!("http://127.0.0.1:{port}/file.pdf")}),
    )
    .await;
    assert!(result.contains("PDF content detected"), "{result}");
    assert!(!result.contains("Fetch error"), "{result}");
    assert!(started.elapsed() < Duration::from_secs(5), "{result}");
}

#[tokio::test]
async fn fetch_pdf_returns_before_a_stalled_body() {
    let response = http_message(
        "HTTP/1.1 200 OK",
        "Content-Type: application/pdf",
        1_000_000,
        "",
    );
    let port = spawn_local_http(response, true, None).await;
    let tool = WebFetchTool::new(WebFetchConfig::default());
    let started = std::time::Instant::now();
    let result = run(
        &tool,
        json!({"url": format!("http://127.0.0.1:{port}/file.pdf")}),
    )
    .await;
    assert!(result.contains("PDF content detected"), "{result}");
    assert!(!result.contains("Fetch error"), "{result}");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn fetch_error_status_returns_before_a_stalled_body() {
    let response = http_message(
        "HTTP/1.1 404 Not Found",
        "Content-Type: text/plain",
        1_000_000,
        "",
    );
    let port = spawn_local_http(response, true, None).await;
    let tool = WebFetchTool::new(WebFetchConfig::default());
    let started = std::time::Instant::now();
    let result = run(
        &tool,
        json!({"url": format!("http://127.0.0.1:{port}/missing")}),
    )
    .await;
    assert_eq!(result, "Fetch failed (404): Not Found");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn google_status_retries_before_a_stalled_body() {
    let stalled = http_message(
        "HTTP/1.1 500 Internal Server Error",
        "Content-Type: text/plain",
        1_000_000,
        "",
    );
    let hits = Arc::new(AtomicUsize::new(0));
    let google_port = spawn_local_http(stalled, true, Some(hits.clone())).await;
    let ddg = http_message(
        "HTTP/1.1 200 OK",
        "Content-Type: text/html",
        DDG_HTML.len(),
        DDG_HTML,
    );
    let ddg_port = spawn_local_http(ddg, false, None).await;
    let tool = WebSearchTool::new(WebSearchConfig {
        google_api_key: Some("test-key".to_string()),
        google_cse_id: Some("test-cse".to_string()),
        xai_api_key: Some(String::new()),
        google_endpoint: Some(format!("http://127.0.0.1:{google_port}/search")),
        ddg_endpoint: Some(format!("http://127.0.0.1:{ddg_port}/html/")),
        retry_base: Duration::from_millis(1),
        ..WebSearchConfig::default()
    });
    let started = std::time::Instant::now();
    let result = run(&tool, json!({"query": "stalled status"})).await;
    assert!(result.contains("DDG Title"), "{result}");
    assert_eq!(hits.load(Ordering::SeqCst), 3);
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?} {result}",
        started.elapsed()
    );
}

fn raw_http(status_line: &str, headers: &str, body: &[u8]) -> Vec<u8> {
    let mut message = format!(
        "{status_line}\r\n{headers}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    message.extend_from_slice(body);
    message
}

#[tokio::test]
async fn fetch_ignores_charset_and_strips_bom() {
    let latin1 = raw_http(
        "HTTP/1.1 200 OK",
        "Content-Type: text/plain; charset=iso-8859-1",
        &[0x63, 0x61, 0x66, 0xe9],
    );
    let port = spawn_local_http(latin1, false, None).await;
    let tool = WebFetchTool::new(WebFetchConfig::default());
    let result = run(
        &tool,
        json!({"url": format!("http://127.0.0.1:{port}/cafe")}),
    )
    .await;
    assert_eq!(result, "caf\u{FFFD}");
    let bom = raw_http(
        "HTTP/1.1 200 OK",
        "Content-Type: text/plain; charset=utf-16",
        &[0xEF, 0xBB, 0xBF, 0x68, 0x69],
    );
    let port = spawn_local_http(bom, false, None).await;
    let tool = WebFetchTool::new(WebFetchConfig::default());
    let result = run(
        &tool,
        json!({"url": format!("http://127.0.0.1:{port}/bom")}),
    )
    .await;
    assert_eq!(result, "hi");
}

#[tokio::test]
async fn malformed_provider_json_is_not_no_results() {
    let google = http_message(
        "HTTP/1.1 200 OK",
        "Content-Type: application/json",
        "not-json".len(),
        "not-json",
    );
    let google_port = spawn_local_http(google, false, None).await;
    let ddg = http_message("HTTP/1.1 200 OK", "Content-Type: text/html", 0, "");
    let ddg_port = spawn_local_http(ddg, false, None).await;
    let tool = WebSearchTool::new(WebSearchConfig {
        google_api_key: Some("test-key".to_string()),
        google_cse_id: Some("test-cse".to_string()),
        xai_api_key: Some(String::new()),
        google_endpoint: Some(format!("http://127.0.0.1:{google_port}/search")),
        ddg_endpoint: Some(format!("http://127.0.0.1:{ddg_port}/html/")),
        retry_base: Duration::from_millis(1),
        ..WebSearchConfig::default()
    });
    let result = run(&tool, json!({"query": "broken json"})).await;
    assert!(result.contains("Google:"), "{result}");
    assert!(!result.contains("Google: no results"), "{result}");
    assert!(result.contains("expected"), "{result}");
    let empty = http_message(
        "HTTP/1.1 200 OK",
        "Content-Type: application/json",
        "{}".len(),
        "{}",
    );
    let empty_port = spawn_local_http(empty, false, None).await;
    let empty_tool = WebSearchTool::new(WebSearchConfig {
        google_api_key: Some("test-key".to_string()),
        google_cse_id: Some("test-cse".to_string()),
        xai_api_key: Some(String::new()),
        google_endpoint: Some(format!("http://127.0.0.1:{empty_port}/search")),
        ddg_endpoint: Some(format!("http://127.0.0.1:{ddg_port}/html/")),
        retry_base: Duration::from_millis(1),
        ..WebSearchConfig::default()
    });
    let empty_result = run(&empty_tool, json!({"query": "empty json"})).await;
    assert!(
        empty_result.contains("Google: no results"),
        "{empty_result}"
    );
}

#[tokio::test]
async fn provider_error_truncation_keeps_a_split_surrogate() {
    let xai_body = format!("{}😀XAI_TAIL", "a".repeat(159));
    let google_body = format!("{}😀GOOGLE_TAIL", "b".repeat(199));
    let client = RecordingClient::new(move |request: &HttpRequest| {
        if request.url.contains("xai.test") {
            Ok(response(
                400,
                "Bad Request",
                "text/plain",
                xai_body.as_str(),
            ))
        } else if request.url.contains("google.test") {
            Ok(response(
                400,
                "Bad Request",
                "text/plain",
                google_body.as_str(),
            ))
        } else {
            Err("ddg down".to_string())
        }
    });
    let http: Arc<dyn tools::HttpClient> = client;
    let tool = WebSearchTool::with_http(
        WebSearchConfig {
            xai_api_key: Some("test-key".to_string()),
            xai_endpoint: Some("https://xai.test/v1/responses".to_string()),
            google_api_key: Some("google-key".to_string()),
            google_cse_id: Some("cse".to_string()),
            google_endpoint: Some("https://google.test/search".to_string()),
            ddg_endpoint: Some("https://ddg.test/html/".to_string()),
            retry_base: Duration::from_millis(1),
            ..WebSearchConfig::default()
        },
        http,
    );
    let result = tool
        .execute(
            json!({"query": "split surrogate"}),
            &CancellationToken::new(),
            &ToolContext::default(),
        )
        .await;
    let json = serde_json::to_string(&result).unwrap();
    assert!(json.contains("web search 400:"), "{json}");
    assert!(json.contains("Google CSE failed (400):"), "{json}");
    assert!(json.contains("DuckDuckGo: ddg down"), "{json}");
    assert!(
        json.contains(&format!("{}\\ud83d", "a".repeat(159))),
        "{json}"
    );
    assert!(
        json.contains(&format!("{}\\ud83d", "b".repeat(199))),
        "{json}"
    );
    assert!(!json.contains(&"a".repeat(160)), "{json}");
    assert!(!json.contains(&"b".repeat(200)), "{json}");
    assert!(!json.contains(r"\ude00"), "{json}");
    assert!(!json.contains('\u{FFFD}'), "{json}");
    assert!(!json.contains('😀'), "{json}");
    assert!(!json.contains("XAI_TAIL"), "{json}");
    assert!(!json.contains("GOOGLE_TAIL"), "{json}");
}
