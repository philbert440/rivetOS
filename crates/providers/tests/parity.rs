use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use parking_lot::Mutex;

use protocol::ContentPart;
use providers::{
    AiImage, AiModelContent, AiModelPart, AiSdkAccumulator, AiSdkError, AiSdkPart, AiUsage,
    AiUserPart, CLAUDE_DEFAULT_TOOLS, ChatRequest, ClaudeArgs, CliProvider, CodexArgs,
    DEFAULT_TOKEN_TTL_MS, EMBEDDING_COLUMN_DIMS, EmbedWireParse, EmbedWireShape, GrokArgs,
    HermesArgs, KimiArgs, LooseMessage, LooseNumber, LooseToolCall, ModelCatalog, NO_INSTRUCTION,
    OpencodeArgs, PERMISSION_PROMPT_TIMEOUT_MAX_MS, PERMISSION_PROMPT_TIMEOUT_MS, ParsedArgv,
    PiArgs, Provider, QwenArgs, TokenCommandInput, TokenEntry, TokenSource, authorized_call,
    build_done_chunk, build_embed_request, claude_args, codex_agent_text, codex_args, codex_prompt,
    convert_messages_to_ai_sdk, default_skip_git_repo_check, extract_text_value, grok_args,
    hermes_args, hermes_model_args, hermes_session_id, kimi_args, normalize_embed_vector,
    opencode_args, opencode_xdg_data_home, parse_cli_timeout_ms, parse_codex_line,
    parse_embed_response, parse_embed_wire_shape, parse_kimi_line, parse_permission_prompts,
    parse_permission_timeout_ms, parse_token_command_argv, parts_to_ai_sdk_user_content,
    permission_prompt_tool_id, pi_args, qwen_args, resolve_grok_binary, scrub_claude_env,
    scrub_codex_env, scrub_grok_env, translate_ai_sdk_part, variant_for_effort,
};
use serde_json::json;

fn loose(role: &str, text: &str) -> LooseMessage {
    LooseMessage {
        role: role.to_string(),
        content_text: Some(text.to_string()),
        content_parts: None,
        tool_calls: Vec::new(),
        tool_call_id: None,
    }
}

fn part(kind: &str) -> AiSdkPart {
    AiSdkPart {
        kind: kind.to_string(),
        text: None,
        delta: None,
        id: None,
        tool_name: None,
        source_type: None,
        url: None,
        error: None,
        usage: None,
        response_id: None,
    }
}

#[test]
fn extract_text_and_user_parts() {
    assert_eq!(extract_text_value(&json!("hello")), "hello");
    assert_eq!(
        extract_text_value(&json!([
            {"type": "text", "text": "a"},
            {"type": "image", "mimeType": "image/png", "data": "xxx"},
            {"type": "text", "text": "b"}
        ])),
        "ab"
    );
    assert_eq!(extract_text_value(&json!([])), "");
    assert_eq!(
        parts_to_ai_sdk_user_content(&[ContentPart::Text { text: "hi".into() }]),
        vec![AiUserPart::Text {
            text: "hi".to_string()
        }]
    );
    assert_eq!(
        parts_to_ai_sdk_user_content(&[ContentPart::Text {
            text: String::new().into(),
        }]),
        Vec::<AiUserPart>::new()
    );
    assert_eq!(
        parts_to_ai_sdk_user_content(&[ContentPart::Image {
            data: Some("BASE64".to_string()),
            url: None,
            mime_type: Some("image/png".to_string()),
        }]),
        vec![AiUserPart::Image {
            image: AiImage::Data("data:image/png;base64,BASE64".to_string()),
            media_type: Some("image/png".to_string()),
        }]
    );
    match &parts_to_ai_sdk_user_content(&[ContentPart::Image {
        data: Some("X".to_string()),
        url: None,
        mime_type: None,
    }])[0]
    {
        AiUserPart::Image { image, .. } => {
            assert_eq!(
                image,
                &AiImage::Data("data:image/jpeg;base64,X".to_string())
            );
        }
        other => panic!("{other:?}"),
    }
    match &parts_to_ai_sdk_user_content(&[ContentPart::Image {
        data: None,
        url: Some("https://example.com/a.jpg".to_string()),
        mime_type: Some("image/jpeg".to_string()),
    }])[0]
    {
        AiUserPart::Image { image, media_type } => {
            assert_eq!(
                image,
                &AiImage::Url("https://example.com/a.jpg".to_string())
            );
            assert_eq!(media_type.as_deref(), Some("image/jpeg"));
        }
        other => panic!("{other:?}"),
    }
    assert!(
        parts_to_ai_sdk_user_content(&[ContentPart::Image {
            data: None,
            url: None,
            mime_type: None,
        }])
        .is_empty()
    );
}

#[test]
fn convert_messages_matches_the_sdk_cases() {
    let simple = convert_messages_to_ai_sdk(&[
        loose("system", "sys"),
        loose("user", "hello"),
        loose("assistant", "hi"),
    ]);
    assert_eq!(simple[0].role, "system");
    assert_eq!(simple[0].content, AiModelContent::Text("sys".to_string()));
    assert_eq!(simple[2].content, AiModelContent::Text("hi".to_string()));
    let mut multi = loose("user", "");
    multi.content_text = None;
    multi.content_parts = Some(vec![
        ContentPart::Text {
            text: "see this".into(),
        },
        ContentPart::Image {
            data: Some("AA".to_string()),
            url: None,
            mime_type: Some("image/png".to_string()),
        },
    ]);
    let out = convert_messages_to_ai_sdk(&[multi]);
    assert_eq!(out.len(), 1);
    assert!(matches!(out[0].content, AiModelContent::Parts(_)));
    let mut assistant = loose("assistant", "let me check");
    assistant.tool_calls = vec![LooseToolCall {
        id: "tc1".to_string(),
        name: "search".to_string(),
        arguments: json!({"q": "x"}),
    }];
    let out = convert_messages_to_ai_sdk(&[assistant]);
    match &out[0].content {
        AiModelContent::Parts(parts) => {
            assert!(matches!(parts[0], AiModelPart::Text { .. }));
            match &parts[1] {
                AiModelPart::ToolCall {
                    tool_call_id,
                    tool_name,
                    input,
                } => {
                    assert_eq!(tool_call_id, "tc1");
                    assert_eq!(tool_name, "search");
                    assert_eq!(input, &json!({"q": "x"}));
                }
                other => panic!("{other:?}"),
            }
        }
        other => panic!("{other:?}"),
    }
    let mut string_args = loose("assistant", "");
    string_args.tool_calls = vec![LooseToolCall {
        id: "tc1".to_string(),
        name: "f".to_string(),
        arguments: json!("{\"a\":1}"),
    }];
    let out = convert_messages_to_ai_sdk(&[string_args]);
    match &out[0].content {
        AiModelContent::Parts(parts) => match &parts[0] {
            AiModelPart::ToolCall { input, .. } => assert_eq!(input, &json!({"a": 1})),
            other => panic!("{other:?}"),
        },
        other => panic!("{other:?}"),
    }
    let mut bad = loose("assistant", "");
    bad.tool_calls = vec![LooseToolCall {
        id: "tc1".to_string(),
        name: "f".to_string(),
        arguments: json!("not json"),
    }];
    let out = convert_messages_to_ai_sdk(&[bad]);
    match &out[0].content {
        AiModelContent::Parts(parts) => match &parts[0] {
            AiModelPart::ToolCall { input, .. } => assert_eq!(input, &json!({"raw": "not json"})),
            other => panic!("{other:?}"),
        },
        other => panic!("{other:?}"),
    }
    let mut call = loose("assistant", "");
    call.tool_calls = vec![LooseToolCall {
        id: "tc1".to_string(),
        name: "search".to_string(),
        arguments: json!({}),
    }];
    let mut tool = loose("tool", "result data");
    tool.tool_call_id = Some("tc1".to_string());
    let out = convert_messages_to_ai_sdk(&[call, tool]);
    match &out[1].content {
        AiModelContent::Parts(parts) => match &parts[0] {
            AiModelPart::ToolResult {
                tool_name,
                tool_call_id,
                output,
            } => {
                assert_eq!(tool_name, "search");
                assert_eq!(tool_call_id, "tc1");
                assert_eq!(output, "result data");
            }
            other => panic!("{other:?}"),
        },
        other => panic!("{other:?}"),
    }
    let mut image_tool = loose("tool", "");
    image_tool.content_text = None;
    image_tool.content_parts = Some(vec![
        ContentPart::Text {
            text: "screenshot:".into(),
        },
        ContentPart::Image {
            data: Some("X".to_string()),
            url: None,
            mime_type: Some("image/png".to_string()),
        },
    ]);
    image_tool.tool_call_id = Some("tc1".to_string());
    let out = convert_messages_to_ai_sdk(&[image_tool]);
    match &out[0].content {
        AiModelContent::Parts(parts) => match &parts[0] {
            AiModelPart::ToolResult { output, .. } => {
                assert!(output.contains("screenshot:"));
                assert!(output.contains("1 image(s)"));
            }
            other => panic!("{other:?}"),
        },
        other => panic!("{other:?}"),
    }
    assert!(convert_messages_to_ai_sdk(&[loose("assistant", "")]).is_empty());
}

#[test]
fn translate_parts_and_done_chunk() {
    let mut acc = AiSdkAccumulator::new();
    let mut text = part("text-delta");
    text.text = Some("hi".to_string());
    let chunks = translate_ai_sdk_part(&text, &mut acc);
    assert_eq!(chunks[0].delta.as_deref(), Some("hi"));
    assert!(acc.had_text_content);
    let mut empty = part("text-delta");
    empty.text = Some(String::new());
    let mut acc = AiSdkAccumulator::new();
    assert!(translate_ai_sdk_part(&empty, &mut acc).is_empty());
    assert!(!acc.had_text_content);
    let mut reasoning = part("reasoning-delta");
    reasoning.text = Some("think".to_string());
    assert_eq!(
        translate_ai_sdk_part(&reasoning, &mut acc)[0]
            .delta
            .as_deref(),
        Some("think")
    );
    let mut start = part("tool-input-start");
    start.id = Some("a".to_string());
    start.tool_name = Some("x".to_string());
    let a = translate_ai_sdk_part(&start, &mut acc);
    start.id = Some("b".to_string());
    start.tool_name = Some("y".to_string());
    let b = translate_ai_sdk_part(&start, &mut acc);
    let index = serde_json::to_value(a[0].tool_call.as_ref().unwrap()).unwrap();
    assert_eq!(index["index"], 0);
    let index = serde_json::to_value(b[0].tool_call.as_ref().unwrap()).unwrap();
    assert_eq!(index["index"], 1);
    let mut delta = part("tool-input-delta");
    delta.id = Some("a".to_string());
    delta.delta = Some("{\"k\":".to_string());
    let delta = translate_ai_sdk_part(&delta, &mut acc);
    assert_eq!(delta[0].delta.as_deref(), Some("{\"k\":"));
    let mut end = part("tool-input-end");
    end.id = Some("a".to_string());
    assert_eq!(
        translate_ai_sdk_part(&end, &mut acc)[0].r#type,
        protocol::LlmChunkType::ToolCallDone
    );
    let mut source = part("source");
    source.source_type = Some("url".to_string());
    source.url = Some("https://a.com".to_string());
    assert!(translate_ai_sdk_part(&source, &mut acc).is_empty());
    source.url = Some("https://b.com".to_string());
    assert!(translate_ai_sdk_part(&source, &mut acc).is_empty());
    assert_eq!(acc.citations, vec!["https://a.com", "https://b.com"]);
    let mut finish = part("finish-step");
    finish.usage = Some(AiUsage {
        input_tokens: Some(50),
        output_tokens: Some(30),
        cache_read_tokens: Some(10),
        reasoning_tokens: Some(5),
    });
    finish.response_id = Some("resp_123".to_string());
    assert!(translate_ai_sdk_part(&finish, &mut acc).is_empty());
    assert_eq!(acc.prompt_tokens, 50);
    assert_eq!(acc.completion_tokens, 30);
    assert_eq!(acc.reasoning_tokens, Some(5));
    assert_eq!(acc.cached_tokens, Some(10));
    assert_eq!(acc.response_id.as_deref(), Some("resp_123"));
    let mut err = part("error");
    err.error = Some(AiSdkError::Error("bad".to_string()));
    assert_eq!(
        translate_ai_sdk_part(&err, &mut acc)[0].error.as_deref(),
        Some("bad")
    );
    err.error = Some(AiSdkError::Plain("plain".to_string()));
    assert_eq!(
        translate_ai_sdk_part(&err, &mut acc)[0].error.as_deref(),
        Some("plain")
    );
    assert!(translate_ai_sdk_part(&part("start"), &mut acc).is_empty());
    assert!(translate_ai_sdk_part(&part("finish"), &mut acc).is_empty());
    assert!(translate_ai_sdk_part(&part("tool-result"), &mut acc).is_empty());
    let mut done_acc = AiSdkAccumulator::new();
    done_acc.prompt_tokens = 10;
    done_acc.completion_tokens = 5;
    let done = build_done_chunk(&done_acc);
    assert!(done.citations.is_none());
    assert_eq!(done.usage.as_ref().unwrap().prompt_tokens, 10);
    done_acc.citations.push("https://x.com".to_string());
    assert_eq!(
        build_done_chunk(&done_acc).citations.unwrap(),
        vec!["https://x.com"]
    );
}

#[test]
fn token_argv_parser() {
    assert_eq!(parse_token_command_argv(None), ParsedArgv::Unset);
    assert_eq!(
        parse_token_command_argv(Some(TokenCommandInput::Null)),
        ParsedArgv::Unset
    );
    match parse_token_command_argv(Some(TokenCommandInput::String("op read".to_string()))) {
        ParsedArgv::Invalid(message) => assert!(message.contains("argv array")),
        other => panic!("{other:?}"),
    }
    match parse_token_command_argv(Some(TokenCommandInput::Array(vec![]))) {
        ParsedArgv::Invalid(message) => assert!(message.contains("non-empty")),
        other => panic!("{other:?}"),
    }
    match parse_token_command_argv(Some(TokenCommandInput::Array(vec![
        TokenEntry::String("ok".to_string()),
        TokenEntry::String(String::new()),
    ]))) {
        ParsedArgv::Invalid(message) => assert!(message.contains("non-empty strings")),
        other => panic!("{other:?}"),
    }
    match parse_token_command_argv(Some(TokenCommandInput::Array(vec![
        TokenEntry::String("ok".to_string()),
        TokenEntry::Other,
    ]))) {
        ParsedArgv::Invalid(message) => assert!(message.contains("non-empty strings")),
        other => panic!("{other:?}"),
    }
    assert_eq!(
        parse_token_command_argv(Some(TokenCommandInput::Array(vec![
            TokenEntry::String("/bin/helper".to_string()),
            TokenEntry::String("--out".to_string()),
        ]))),
        ParsedArgv::Argv(vec!["/bin/helper".to_string(), "--out".to_string()])
    );
    assert_eq!(DEFAULT_TOKEN_TTL_MS, 300_000);
}

#[tokio::test]
async fn token_source_cache_invalidate_and_auth() {
    let now = Arc::new(Mutex::new(1_000i64));
    let clock = {
        let now = Arc::clone(&now);
        Arc::new(move || *now.lock()) as Arc<dyn Fn() -> i64 + Send + Sync>
    };
    let n = Arc::new(AtomicU64::new(0));
    let counter = Arc::clone(&n);
    let run = Arc::new(move |_argv: Vec<String>, _timeout: u64| {
        let counter = Arc::clone(&counter);
        Box::pin(async move {
            let next = counter.fetch_add(1, Ordering::SeqCst) + 1;
            Ok(format!("token-{next}\n"))
        }) as providers::RunnerFuture
    });
    let src = TokenSource::build(
        vec!["helper".to_string()],
        Some(100),
        None,
        Some(clock),
        Some(run),
        None,
    )
    .unwrap();
    assert_eq!(src.get_token().await.unwrap(), "token-1");
    assert_eq!(src.get_token().await.unwrap(), "token-1");
    assert_eq!(n.load(Ordering::SeqCst), 1);
    assert_eq!(src.get_cached_token().as_deref(), Some("token-1"));
    *now.lock() = 1_100;
    assert!(src.get_cached_token().is_none());
    assert_eq!(src.get_token().await.unwrap(), "token-2");
    let minted = Arc::new(AtomicU64::new(0));
    let counter = Arc::clone(&minted);
    let src = TokenSource::build(
        vec!["helper".to_string()],
        None,
        None,
        None,
        Some(Arc::new(move |_argv, _timeout| {
            let counter = Arc::clone(&counter);
            Box::pin(async move {
                let next = counter.fetch_add(1, Ordering::SeqCst) + 1;
                Ok(format!("t-{next}"))
            })
        })),
        None,
    )
    .unwrap();
    assert_eq!(src.get_token().await.unwrap(), "t-1");
    src.invalidate(None);
    assert_eq!(src.get_token().await.unwrap(), "t-2");
    src.invalidate(Some("t-1"));
    assert_eq!(src.get_cached_token().as_deref(), Some("t-2"));
    assert_eq!(src.get_token().await.unwrap(), "t-2");
    src.invalidate(src.get_cached_token().as_deref());
    assert!(src.get_cached_token().is_none());
    assert_eq!(src.get_token().await.unwrap(), "t-3");
    let empty = TokenSource::build(
        vec!["helper".to_string()],
        None,
        None,
        None,
        Some(Arc::new(|_argv, _timeout| {
            Box::pin(async { Ok("   \n".to_string()) })
        })),
        None,
    )
    .unwrap();
    let err = empty.get_token().await.unwrap_err();
    assert!(err.0.contains("empty stdout"));
    let multi = TokenSource::build(
        vec!["helper".to_string()],
        None,
        None,
        None,
        Some(Arc::new(|_argv, _timeout| {
            Box::pin(async { Ok("abc\nleak".to_string()) })
        })),
        None,
    )
    .unwrap();
    let err = multi.get_token().await.unwrap_err();
    assert!(err.0.contains("single line"));
    let src = TokenSource::build(
        vec!["helper".to_string()],
        None,
        None,
        None,
        Some(Arc::new(|_argv, _timeout| {
            Box::pin(async { Ok("sekrit".to_string()) })
        })),
        None,
    )
    .unwrap();
    let headers = src
        .auth_headers(vec![("Accept".to_string(), "application/json".to_string())])
        .await
        .unwrap();
    assert_eq!(headers[0].0, "Accept");
    assert_eq!(headers[1].1, "Bearer sekrit");
}

#[tokio::test]
async fn token_coalesce_and_authorized_call() {
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let rx = Arc::new(Mutex::new(Some(rx)));
    let calls = Arc::new(AtomicU64::new(0));
    let rx_run = Arc::clone(&rx);
    let calls_run = Arc::clone(&calls);
    let src = TokenSource::build(
        vec!["helper".to_string()],
        None,
        None,
        None,
        Some(Arc::new(move |_argv, _timeout| {
            let rx_run = Arc::clone(&rx_run);
            let calls_run = Arc::clone(&calls_run);
            Box::pin(async move {
                calls_run.fetch_add(1, Ordering::SeqCst);
                let rx = rx_run.lock().take().unwrap();
                rx.await.unwrap_or_else(|_| Err("closed".to_string()))
            })
        })),
        None,
    )
    .unwrap();
    let a = src.get_token();
    let b = src.get_token();
    tokio::task::yield_now().await;
    tx.send(Ok("shared".to_string())).unwrap();
    assert_eq!(a.await.unwrap(), "shared");
    assert_eq!(b.await.unwrap(), "shared");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let minted = Arc::new(AtomicU64::new(0));
    let counter = Arc::clone(&minted);
    let src = TokenSource::build(
        vec!["helper".to_string()],
        None,
        None,
        None,
        Some(Arc::new(move |_argv, _timeout| {
            let counter = Arc::clone(&counter);
            Box::pin(async move {
                let next = counter.fetch_add(1, Ordering::SeqCst) + 1;
                Ok(format!("tok-{next}"))
            })
        })),
        None,
    )
    .unwrap();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&calls);
    let status = authorized_call(&src, "Authorization", move |_name, token| {
        let seen = Arc::clone(&seen);
        let token = token.to_string();
        async move {
            let denied = token == "tok-1";
            seen.lock().push(token);
            if denied { 401 } else { 200 }
        }
    })
    .await
    .unwrap();
    assert_eq!(status, 200);
    assert_eq!(calls.lock().as_slice(), ["tok-1", "tok-2"]);
    let src = TokenSource::build(
        vec!["helper".to_string()],
        None,
        None,
        None,
        Some(Arc::new(|_argv, _timeout| {
            Box::pin(async { Ok("anth-key".to_string()) })
        })),
        None,
    )
    .unwrap();
    let status = authorized_call(&src, "x-api-key", |_name, token| {
        let token = token.to_string();
        async move {
            assert_eq!(token, "anth-key");
            200
        }
    })
    .await
    .unwrap();
    assert_eq!(status, 200);
}

#[test]
fn embed_wire_contract() {
    let built = build_embed_request(
        "http://127.0.0.1:9401/",
        EmbedWireShape::Openai,
        "emb-1",
        &["hello".to_string()],
    );
    assert_eq!(built.url, "http://127.0.0.1:9401/v1/embeddings");
    assert_eq!(built.body, json!({"model": "emb-1", "input": ["hello"]}));
    let built = build_embed_request(
        "http://127.0.0.1:9401/embed",
        EmbedWireShape::Native,
        "emb-1",
        &["a".to_string(), "b".to_string()],
    );
    assert_eq!(built.url, "http://127.0.0.1:9401/embed");
    assert_eq!(
        built.body,
        json!({"model": "emb-1", "texts": ["a", "b"], "input": ["a", "b"]})
    );
    let vectors = parse_embed_response(
        &json!({"data": [{"index": 1, "embedding": [0.1, 0.2]}, {"index": 0, "embedding": [0.3, 0.4]}]}),
        2,
    );
    assert_eq!(vectors[0].as_deref(), Some(&[0.3, 0.4][..]));
    assert_eq!(vectors[1].as_deref(), Some(&[0.1, 0.2][..]));
    let vectors = parse_embed_response(&json!({"embeddings": [[1.0, 2.0], [3.0, 4.0]]}), 2);
    assert_eq!(vectors[0].as_deref(), Some(&[1.0, 2.0][..]));
    assert!(normalize_embed_vector(Some(&[1.0, 2.0, 3.0, 4.0]), Some(2), None).is_none());
    assert!(normalize_embed_vector(Some(&[1.0]), Some(2), None).is_none());
    assert_eq!(
        normalize_embed_vector(Some(&[1.0, 2.0, 3.0]), None, Some(2)).unwrap(),
        vec![1.0, 2.0]
    );
    assert_eq!(EMBEDDING_COLUMN_DIMS, 1024);
    let exact: Vec<f64> = (0..1024).map(|index| index as f64).collect();
    assert_eq!(
        normalize_embed_vector(Some(&exact), Some(EMBEDDING_COLUMN_DIMS), None).unwrap(),
        exact
    );
    let mut longer = exact.clone();
    longer.push(99.0);
    assert!(normalize_embed_vector(Some(&longer), Some(EMBEDDING_COLUMN_DIMS), None).is_none());
    assert!(matches!(
        parse_embed_wire_shape(None),
        EmbedWireParse::Shape(EmbedWireShape::Openai)
    ));
    assert!(matches!(
        parse_embed_wire_shape(Some("native")),
        EmbedWireParse::Shape(EmbedWireShape::Native)
    ));
    match parse_embed_wire_shape(Some("grpc")) {
        EmbedWireParse::Error(message) => assert!(message.contains("openai")),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn model_catalog_floor_merge_and_failure() {
    let cat = ModelCatalog::new(
        vec!["floor-a".to_string(), "floor-b".to_string()],
        Arc::new(|| Box::pin(async { Ok(Vec::new()) })),
        None,
        None,
        Some(Arc::new(|| 0)),
        None,
        None,
    );
    assert_eq!(cat.list(), vec!["floor-a", "floor-b"]);
    let now = Arc::new(Mutex::new(0i64));
    let clock = {
        let now = Arc::clone(&now);
        Arc::new(move || *now.lock()) as Arc<dyn Fn() -> i64 + Send + Sync>
    };
    let cat = ModelCatalog::new(
        vec!["floor-a".to_string()],
        Arc::new(|| Box::pin(async { Ok(vec!["floor-a".to_string(), "disc-1".to_string()]) })),
        Some(10),
        None,
        Some(clock),
        None,
        None,
    );
    cat.refresh();
    wait_for(|| cat.list() == vec!["floor-a".to_string(), "disc-1".to_string()]).await;
    *now.lock() = 20;
    assert_eq!(
        cat.refresh(),
        vec!["floor-a".to_string(), "disc-1".to_string()]
    );
    let now = Arc::new(Mutex::new(0i64));
    let clock = {
        let now = Arc::clone(&now);
        Arc::new(move || *now.lock()) as Arc<dyn Fn() -> i64 + Send + Sync>
    };
    let fail = Arc::new(Mutex::new(false));
    let fail_fetch = Arc::clone(&fail);
    let logs = Arc::new(Mutex::new(Vec::new()));
    let logs_fn = Arc::clone(&logs);
    let cat = ModelCatalog::new(
        vec!["floor".to_string()],
        Arc::new(move || {
            let fail_fetch = Arc::clone(&fail_fetch);
            Box::pin(async move {
                if *fail_fetch.lock() {
                    Err("down".to_string())
                } else {
                    Ok(vec!["disc".to_string()])
                }
            })
        }),
        Some(10),
        None,
        Some(clock),
        Some(Arc::new(move |message| logs_fn.lock().push(message))),
        Some("vllm".to_string()),
    );
    cat.refresh();
    wait_for(|| cat.list().iter().any(|id| id == "disc")).await;
    *fail.lock() = true;
    *now.lock() = 20;
    cat.refresh();
    wait_for(|| cat.last_error().as_deref() == Some("down")).await;
    assert_eq!(cat.list(), vec!["floor".to_string(), "disc".to_string()]);
    assert_eq!(logs.lock().len(), 1);
    *now.lock() = 40;
    cat.refresh();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(logs.lock().len(), 1);
}

async fn wait_for(mut ready: impl FnMut() -> bool) {
    for _ in 0..50 {
        if ready() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for catalog");
}

#[test]
fn cli_argv_env_and_parsers() {
    let args = claude_args(&ClaudeArgs {
        model_id: "claude-sonnet".to_string(),
        tools_arg: CLAUDE_DEFAULT_TOOLS.to_string(),
        effort: "high".to_string(),
        permission_mode: "default".to_string(),
        permission_prompts: Some("ui".to_string()),
        exclude_dynamic: true,
        system_text: "sys".to_string(),
        mcp_config_path: Some("mcp.json".to_string()),
        json_schema: Some("{}".to_string()),
        setting_sources: Some("user".to_string()),
        settings_json: Some("{}".to_string()),
        strict_mcp_config: true,
        allowed_tools: vec!["mcp__rivetos".to_string(), "Bash(git status:*)".to_string()],
    });
    assert_eq!(args[0], "-p");
    assert!(args.contains(&"--no-session-persistence".to_string()));
    assert!(args.contains(&permission_prompt_tool_id()));
    assert_eq!(
        permission_prompt_tool_id(),
        "mcp__rivetos__request_permission"
    );
    let at = args.iter().position(|arg| arg == "--allowedTools").unwrap();
    assert_eq!(args[at + 1], "mcp__rivetos");
    assert_eq!(args[at + 2], "Bash(git status:*)");
    assert_eq!(
        parse_permission_timeout_ms(LooseNumber::Missing),
        PERMISSION_PROMPT_TIMEOUT_MS
    );
    assert_eq!(parse_permission_timeout_ms(LooseNumber::Empty), 60_000);
    assert_eq!(
        parse_permission_timeout_ms(LooseNumber::Text("60000".to_string())),
        60_000
    );
    assert_eq!(
        parse_permission_timeout_ms(LooseNumber::Number(1.5)),
        60_000
    );
    assert_eq!(
        parse_permission_timeout_ms(LooseNumber::Number(0.0)),
        60_000
    );
    assert_eq!(
        parse_permission_timeout_ms(LooseNumber::Number(-1.0)),
        60_000
    );
    assert_eq!(
        parse_permission_timeout_ms(LooseNumber::Number(600_001.0)),
        PERMISSION_PROMPT_TIMEOUT_MAX_MS - PERMISSION_PROMPT_TIMEOUT_MAX_MS + 60_000
    );
    assert_eq!(
        parse_permission_timeout_ms(LooseNumber::Number(f64::NAN)),
        60_000
    );
    assert_eq!(
        parse_permission_timeout_ms(LooseNumber::Number(15_000.0)),
        15_000
    );
    assert_eq!(parse_cli_timeout_ms(LooseNumber::Missing), 0);
    assert_eq!(parse_cli_timeout_ms(LooseNumber::Number(0.0)), 0);
    assert_eq!(parse_cli_timeout_ms(LooseNumber::Number(10.9)), 10);
    assert_eq!(
        parse_cli_timeout_ms(LooseNumber::Text("12.2".to_string())),
        12
    );
    assert_eq!(parse_permission_prompts(None), None);
    assert_eq!(parse_permission_prompts(Some("ui")), Some("ui"));
    assert_eq!(parse_permission_prompts(Some("nope")), None);
    let args = codex_args(&CodexArgs {
        model_id: Some("gpt".to_string()),
        reasoning_effort: Some("high".to_string()),
        cwd: Some("/work".to_string()),
        sandbox: "read-only".to_string(),
        approve_for_me: true,
        skip_git_repo_check: true,
        profile: Some("p".to_string()),
        session_id: Some("thread".to_string()),
    });
    assert_eq!(
        args,
        vec![
            "exec",
            "resume",
            "thread",
            "--json",
            "-s",
            "read-only",
            "--approve-for-me",
            "--skip-git-repo-check",
            "-C",
            "/work",
            "-m",
            "gpt",
            "-p",
            "p",
            "-c",
            "model_reasoning_effort=high",
            "-"
        ]
    );
    assert!(default_skip_git_repo_check("read-only", None));
    assert!(!default_skip_git_repo_check("workspace-write", None));
    assert!(default_skip_git_repo_check("workspace-write", Some(true)));
    assert_eq!(codex_prompt("rules", "hi"), "SYSTEM:\nrules\n\n---\n\nhi");
    assert_eq!(codex_prompt("", ""), "USER:\n(no message)");
    let event = parse_codex_line(
        r#"{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}"#,
    )
    .unwrap();
    assert_eq!(codex_agent_text(&event).as_deref(), Some("hello"));
    let reasoning =
        parse_codex_line(r#"{"type":"item.completed","item":{"type":"reasoning","text":"no"}}"#)
            .unwrap();
    assert!(codex_agent_text(&reasoning).is_none());
    let scrubbed = scrub_codex_env(vec![
        ("OPENAI_API_KEY".to_string(), "x".to_string()),
        ("OPENAI_BASE_URL".to_string(), "y".to_string()),
        ("HOME".to_string(), "/home".to_string()),
    ]);
    assert_eq!(scrubbed, vec![("HOME".to_string(), "/home".to_string())]);
    let scrubbed = scrub_claude_env(vec![
        ("ANTHROPIC_API_KEY".to_string(), "x".to_string()),
        ("ANTHROPIC_AUTH_TOKEN".to_string(), "y".to_string()),
        ("PATH".to_string(), "/bin".to_string()),
    ]);
    assert_eq!(scrubbed, vec![("PATH".to_string(), "/bin".to_string())]);
    let scrubbed = scrub_grok_env(vec![
        ("XAI_API_KEY".to_string(), "x".to_string()),
        ("TERM_PROGRAM".to_string(), "tmux".to_string()),
        ("HOME".to_string(), "/home".to_string()),
    ]);
    assert_eq!(scrubbed, vec![("HOME".to_string(), "/home".to_string())]);
    let args = grok_args(
        &GrokArgs {
            model_id: Some("grok-2".to_string()),
            permission_mode: "dontAsk".to_string(),
            reasoning_effort: Some("high".to_string()),
            max_turns: Some(4),
            no_plan: true,
            system_prompt_override: "sys".to_string(),
            allow: vec!["Bash".to_string()],
            tools: Some("default".to_string()),
            cwd: Some("/work".to_string()),
            session_id: Some("sess".to_string()),
            resume: true,
        },
        "hi",
    );
    assert_eq!(args[0], "-p");
    assert_eq!(args[1], "hi");
    assert!(args.contains(&"--no-plan".to_string()));
    assert!(args.contains(&"--resume".to_string()));
    assert_eq!(resolve_grok_binary(Some("/no/such/home"), None), "grok");
    assert_eq!(resolve_grok_binary(None, Some("/bin/grok")), "/bin/grok");
    assert_eq!(
        hermes_model_args("custom:openrouter:qwen/qwen-2"),
        vec!["--provider", "openrouter", "-m", "qwen/qwen-2"]
    );
    assert_eq!(hermes_model_args("qwen-27b"), vec!["-m", "qwen-27b"]);
    assert_eq!(
        hermes_args(
            &HermesArgs {
                model_id: Some("qwen-27b".to_string()),
                cwd: Some("/work".to_string()),
                session_id: Some("abc".to_string()),
            },
            ""
        ),
        vec![
            "chat", "-q", "(empty)", "-Q", "--yolo", "--cli", "-m", "qwen-27b", "--in", "/work",
            "--resume", "abc"
        ]
    );
    assert_eq!(
        hermes_session_id("noise session_id: sess-1 more").as_deref(),
        Some("sess-1")
    );
    assert_eq!(
        kimi_args(
            &KimiArgs {
                model_id: Some("k".to_string()),
                session_id: Some("s".to_string())
            },
            ""
        ),
        vec![
            "-p",
            NO_INSTRUCTION,
            "--output-format",
            "stream-json",
            "-m",
            "k",
            "-S",
            "s"
        ]
    );
    assert_eq!(
        parse_kimi_line(r#"{"role":"assistant","content":"hi"}"#).as_deref(),
        Some("hi")
    );
    assert!(parse_kimi_line("not json").is_none());
    assert_eq!(variant_for_effort(Some("low")), Some("minimal"));
    assert_eq!(variant_for_effort(Some("medium")), None);
    assert_eq!(variant_for_effort(Some("xhigh")), Some("max"));
    assert_eq!(variant_for_effort(Some("nope")), None);
    assert_eq!(
        opencode_args(
            &OpencodeArgs {
                model_id: Some("m".to_string()),
                session_id: Some("s".to_string()),
                effort: Some("high".to_string()),
            },
            ""
        ),
        vec![
            "run",
            "--format",
            "json",
            "--model",
            "m",
            "--variant",
            "high",
            "--session",
            "s",
            NO_INSTRUCTION
        ]
    );
    assert_eq!(opencode_xdg_data_home("/data/opencode"), "/data");
    assert_eq!(opencode_xdg_data_home("/data/other"), "/data/other");
    assert_eq!(
        pi_args(
            &PiArgs {
                model_id: Some("m".to_string()),
                session_id: Some("s".to_string()),
                pin_session_id: None,
                session_dir: Some("/tmp/s".to_string()),
                append_system_prompt: Some("sys".to_string()),
            },
            "hi"
        ),
        vec![
            "--print",
            "--mode",
            "json",
            "--session",
            "s",
            "--session-dir",
            "/tmp/s",
            "--model",
            "m",
            "--append-system-prompt",
            "sys",
            "--",
            "hi"
        ]
    );
    assert_eq!(
        qwen_args(
            &QwenArgs {
                model_id: Some("m".to_string()),
                session_id: None,
                pin_session_id: Some("pin".to_string()),
                append_system_prompt: Some("sys".to_string()),
            },
            ""
        ),
        vec![
            "-p",
            NO_INSTRUCTION,
            "--output-format",
            "stream-json",
            "--include-partial-messages",
            "--approval-mode",
            "yolo",
            "--session-id",
            "pin",
            "-m",
            "m",
            "--append-system-prompt",
            "sys"
        ]
    );
}

#[tokio::test]
async fn cli_provider_defaults_and_missing_hermes() {
    let hermes = CliProvider::hermes("/no/such/hermes");
    assert_eq!(hermes.id(), "hermes-cli");
    assert_eq!(hermes.get_model(), "qwen-27b");
    assert_eq!(hermes.context_window(), 262_144);
    assert_eq!(hermes.max_output_tokens(), 81_920);
    assert!(!hermes.is_available().await);
    let err = match hermes
        .stream_chat(ChatRequest::simple(
            "You are a test.",
            "Say hi.",
            protocol::ThinkingLevel::Medium,
        ))
        .await
    {
        Ok(_) => panic!("missing hermes binary returned a stream"),
        Err(err) => err,
    };
    assert!(
        err.message
            .contains("hermes binary not found at /no/such/hermes")
    );
    let kimi = CliProvider::kimi("kimi");
    assert_eq!(kimi.context_window(), 256_000);
    assert_eq!(kimi.max_output_tokens(), 8_192);
    let opencode = CliProvider::opencode("opencode");
    assert_eq!(opencode.context_window(), 128_000);
    let qwen = CliProvider::qwen("qwen");
    assert_eq!(qwen.get_model(), "");
    assert_eq!(qwen.context_window(), 262_144);
    let claude = CliProvider::claude("claude");
    claude.warn_session_map("disk full");
    claude.warn_session_map("disk full");
    assert_eq!(claude.id(), "claude-cli");
    assert_eq!(CliProvider::codex("codex").id(), "codex-cli");
    assert_eq!(CliProvider::grok("grok").id(), "grok-cli");
    assert_eq!(
        CliProvider::pi("pi").get_model(),
        "deepseek/deepseek-v4-flash"
    );
}
