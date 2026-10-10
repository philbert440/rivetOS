use std::sync::{Arc, Mutex};

use hooks::{
    AbortSignal, HookContext, HookHandler, HookPipeline, HookRegistration, HookSignal,
    PreparedTool, StreamEvent, StreamSink, ToolBinding, ToolCallContext, ToolExecError, ToolFn,
    ToolResult, ToolResultContent, ToolResultOutput, execute_tool, to_ai_sdk_tools,
    to_tool_result_output,
};
use protocol::{ContentPart, HookEventName, StreamEventType};
use serde_json::{Value, json};

fn tool(name: &str, execute: ToolFn) -> PreparedTool {
    PreparedTool {
        name: name.to_string(),
        description: format!("{name} description"),
        parameters: json!({"type": "object", "properties": {"x": {"type": "string"}}}),
        execute,
    }
}

fn text_tool(name: &str, text: &'static str) -> PreparedTool {
    tool(
        name,
        Arc::new(move |_args, _signal, _ctx| {
            Box::pin(async move { Ok(ToolResult::Text(text.to_string())) })
        }),
    )
}

struct Collect(Mutex<Vec<StreamEvent>>);

impl StreamSink for Collect {
    fn emit(&self, event: &StreamEvent) {
        self.0
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .push(event.clone());
    }
}

#[tokio::test]
async fn executes_tools_through_before_and_after_hooks() {
    let set = to_ai_sdk_tools(
        vec![tool(
            "echo",
            Arc::new(|args, _signal, _ctx| {
                Box::pin(async move {
                    let value = args.get("x").and_then(Value::as_str).unwrap_or("");
                    Ok(ToolResult::Text(format!("got:{value}")))
                })
            }),
        )],
        ToolBinding::default(),
    );
    assert_eq!(set.names(), vec!["echo"]);
    assert!(!set.is_empty());
    assert_eq!(set.len(), 1);
    let echo = set.get("echo").expect("echo");
    assert_eq!(echo.description(), "echo description");
    assert_eq!(echo.name(), "echo");
    assert!(echo.parameters().get("type").is_some());
    let result = echo.execute(&json!({"x": "hi"}), None).await;
    assert_eq!(result, ToolResult::Text("got:hi".to_string()));

    let received = Arc::new(Mutex::new(None));
    let slot = Arc::clone(&received);
    let set = to_ai_sdk_tools(
        vec![tool(
            "capture",
            Arc::new(move |args, _signal, _ctx| {
                let slot = Arc::clone(&slot);
                Box::pin(async move {
                    *slot.lock().unwrap_or_else(|err| err.into_inner()) = Some(args);
                    Ok(ToolResult::Text("ok".to_string()))
                })
            }),
        )],
        ToolBinding::default(),
    );
    set.get("capture")
        .expect("capture")
        .execute(&json!({"x": "value"}), None)
        .await;
    assert_eq!(
        received
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone(),
        Some(
            json!({"x": "value"})
                .as_object()
                .cloned()
                .unwrap_or_default()
        )
    );

    let pipeline = Arc::new(HookPipeline::new());
    let fired = Arc::new(Mutex::new(Vec::new()));
    let before_args = Arc::new(Mutex::new(None));
    let after_state = Arc::new(Mutex::new(None));
    let fired_before = Arc::clone(&fired);
    let args_slot = Arc::clone(&before_args);
    pipeline.register(HookRegistration::new(
        "b",
        HookEventName::ToolBefore,
        HookHandler::from_sync(move |ctx: &mut HookContext| {
            fired_before
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .push("before");
            *args_slot.lock().unwrap_or_else(|err| err.into_inner()) = ctx.args.clone();
            Ok(HookSignal::Continue)
        }),
    ));
    let fired_after = Arc::clone(&fired);
    let after_slot = Arc::clone(&after_state);
    pipeline.register(HookRegistration::new(
        "a",
        HookEventName::ToolAfter,
        HookHandler::from_sync(move |ctx: &mut HookContext| {
            fired_after
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .push("after");
            *after_slot.lock().unwrap_or_else(|err| err.into_inner()) =
                Some((ctx.result.clone(), ctx.is_error, ctx.duration_ms));
            Ok(HookSignal::Continue)
        }),
    ));
    let result = execute_tool(
        &text_tool("echo", "done"),
        &json!({"x": "hi"}),
        &ToolBinding {
            hooks: Some(pipeline),
            ..ToolBinding::default()
        },
        None,
    )
    .await;
    assert_eq!(result, ToolResult::Text("done".to_string()));
    assert_eq!(
        fired
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .as_slice(),
        ["before", "after"]
    );
    assert_eq!(
        before_args
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone(),
        Some(json!({"x": "hi"}).as_object().cloned().unwrap_or_default())
    );
    let after = after_state
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .clone();
    let (after_result, is_error, duration) = after.expect("after");
    assert_eq!(after_result, Some(ToolResult::Text("done".to_string())));
    assert_eq!(is_error, Some(false));
    assert!(duration.unwrap_or(-1) >= 0);
}

#[tokio::test]
async fn blocked_hooks_stop_the_tool_without_stream_events() {
    let pipeline = Arc::new(HookPipeline::new());
    pipeline.register(HookRegistration::new(
        "block",
        HookEventName::ToolBefore,
        HookHandler::from_sync(|ctx| {
            ctx.blocked = Some(true);
            ctx.block_reason = Some("no shells in tests".to_string());
            Ok(HookSignal::Continue)
        }),
    ));
    let ran = Arc::new(Mutex::new(false));
    let flag = Arc::clone(&ran);
    let events = Arc::new(Collect(Mutex::new(Vec::new())));
    let prepared = tool(
        "shell",
        Arc::new(move |_args, _signal, _ctx| {
            let flag = Arc::clone(&flag);
            Box::pin(async move {
                *flag.lock().unwrap_or_else(|err| err.into_inner()) = true;
                Ok(ToolResult::Text("should not run".to_string()))
            })
        }),
    );
    let result = execute_tool(
        &prepared,
        &json!({"x": "rm -rf /"}),
        &ToolBinding {
            hooks: Some(pipeline),
            stream: Some(events.clone()),
            ..ToolBinding::default()
        },
        None,
    )
    .await;
    assert!(!*ran.lock().unwrap_or_else(|err| err.into_inner()));
    assert_eq!(
        result,
        ToolResult::Text("Blocked: no shells in tests".to_string())
    );
    assert!(
        events
            .0
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .is_empty()
    );

    let pipeline = Arc::new(HookPipeline::new());
    pipeline.register(HookRegistration::new(
        "block",
        HookEventName::ToolBefore,
        HookHandler::from_sync(|ctx| {
            ctx.blocked = Some(true);
            Ok(HookSignal::Abort)
        }),
    ));
    let result = execute_tool(
        &text_tool("shell", "ran"),
        &json!({}),
        &ToolBinding {
            hooks: Some(pipeline),
            ..ToolBinding::default()
        },
        None,
    )
    .await;
    assert_eq!(
        result,
        ToolResult::Text("Blocked: Blocked by safety hook".to_string())
    );

    let pipeline = Arc::new(HookPipeline::new());
    pipeline.register(HookRegistration::new(
        "block",
        HookEventName::ToolBefore,
        HookHandler::from_sync(|ctx| {
            ctx.blocked = Some(true);
            ctx.block_reason = Some(String::new());
            Ok(HookSignal::Continue)
        }),
    ));
    let result = execute_tool(
        &text_tool("shell", "ran"),
        &json!({}),
        &ToolBinding {
            hooks: Some(pipeline),
            ..ToolBinding::default()
        },
        None,
    )
    .await;
    assert_eq!(result, ToolResult::Text("Blocked: ".to_string()));
}

#[tokio::test]
async fn abort_without_blocked_still_runs_and_rewrites_args() {
    let pipeline = Arc::new(HookPipeline::new());
    pipeline.register(HookRegistration::new(
        "abort",
        HookEventName::ToolBefore,
        HookHandler::from_sync(|_| Ok(HookSignal::Abort)),
    ));
    let result = execute_tool(
        &text_tool("echo", "ran"),
        &json!({"x": "hi"}),
        &ToolBinding {
            hooks: Some(pipeline),
            ..ToolBinding::default()
        },
        None,
    )
    .await;
    assert_eq!(result, ToolResult::Text("ran".to_string()));

    let pipeline = Arc::new(HookPipeline::new());
    pipeline.register(HookRegistration::new(
        "rewrite",
        HookEventName::ToolBefore,
        HookHandler::from_sync(|ctx| {
            ctx.args = Some(
                json!({"x": "rewritten"})
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
            );
            Ok(HookSignal::Continue)
        }),
    ));
    let received = Arc::new(Mutex::new(None));
    let slot = Arc::clone(&received);
    let result = execute_tool(
        &tool(
            "capture",
            Arc::new(move |args, _signal, _ctx| {
                let slot = Arc::clone(&slot);
                Box::pin(async move {
                    *slot.lock().unwrap_or_else(|err| err.into_inner()) = Some(args);
                    Ok(ToolResult::Text("ok".to_string()))
                })
            }),
        ),
        &json!({"x": "original"}),
        &ToolBinding {
            hooks: Some(pipeline),
            ..ToolBinding::default()
        },
        None,
    )
    .await;
    assert_eq!(result, ToolResult::Text("ok".to_string()));
    assert_eq!(
        received
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone(),
        Some(
            json!({"x": "rewritten"})
                .as_object()
                .cloned()
                .unwrap_or_default()
        )
    );

    let wrapped = execute_tool(
        &text_tool("wrap", "ok"),
        &json!("hi"),
        &ToolBinding::default(),
        None,
    )
    .await;
    assert_eq!(wrapped, ToolResult::Text("ok".to_string()));
    let seen = Arc::new(Mutex::new(None));
    let slot = Arc::clone(&seen);
    execute_tool(
        &tool(
            "wrap",
            Arc::new(move |args, _signal, _ctx| {
                let slot = Arc::clone(&slot);
                Box::pin(async move {
                    *slot.lock().unwrap_or_else(|err| err.into_inner()) = Some(args);
                    Ok(ToolResult::Text("ok".to_string()))
                })
            }),
        ),
        &json!("hi"),
        &ToolBinding::default(),
        None,
    )
    .await;
    assert_eq!(
        seen.lock().unwrap_or_else(|err| err.into_inner()).clone(),
        Some(
            json!({"value": "hi"})
                .as_object()
                .cloned()
                .unwrap_or_default()
        )
    );
}

#[tokio::test]
async fn thrown_errors_stream_events_and_session_identity() {
    let pipeline = Arc::new(HookPipeline::new());
    let after_error = Arc::new(Mutex::new(None));
    let slot = Arc::clone(&after_error);
    pipeline.register(HookRegistration::new(
        "observe",
        HookEventName::ToolAfter,
        HookHandler::from_sync(move |ctx| {
            *slot.lock().unwrap_or_else(|err| err.into_inner()) = ctx.is_error;
            Ok(HookSignal::Continue)
        }),
    ));
    let events = Arc::new(Collect(Mutex::new(Vec::new())));
    let result = execute_tool(
        &tool(
            "boom",
            Arc::new(|_args, _signal, _ctx| Box::pin(async { Err(ToolExecError::new("kaboom")) })),
        ),
        &json!({}),
        &ToolBinding {
            hooks: Some(pipeline),
            stream: Some(events.clone()),
            ..ToolBinding::default()
        },
        None,
    )
    .await;
    assert_eq!(result, ToolResult::Text("Error: kaboom".to_string()));
    assert_eq!(
        *after_error.lock().unwrap_or_else(|err| err.into_inner()),
        Some(true)
    );
    let streamed = events
        .0
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .clone();
    assert_eq!(streamed[0].r#type, StreamEventType::ToolStart);
    assert_eq!(streamed[0].content, "🔧 boom");
    assert_eq!(streamed[1].r#type, StreamEventType::ToolResult);
    assert_eq!(streamed[1].content, "❌ boom: Error: kaboom");

    let signal = AbortSignal::new();
    let seen_signal = Arc::new(Mutex::new(None));
    let slot = Arc::clone(&seen_signal);
    let seen_session = Arc::new(Mutex::new(None));
    let session_slot = Arc::clone(&seen_session);
    execute_tool(
        &tool(
            "inspect",
            Arc::new(move |_args, signal, ctx: ToolCallContext| {
                let slot = Arc::clone(&slot);
                let session_slot = Arc::clone(&session_slot);
                Box::pin(async move {
                    *slot.lock().unwrap_or_else(|err| err.into_inner()) = Some(signal);
                    *session_slot.lock().unwrap_or_else(|err| err.into_inner()) =
                        Some((ctx.agent_id, ctx.working_dir, ctx.session.agent_id));
                    Ok(ToolResult::Text("ok".to_string()))
                })
            }),
        ),
        &json!({}),
        &ToolBinding {
            agent_id: Some("owner".to_string()),
            working_dir: Some("/tmp/work".to_string()),
            session_id: Some("sess-1".to_string()),
            ..ToolBinding::default()
        },
        Some(signal.clone()),
    )
    .await;
    assert_eq!(
        seen_signal
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone(),
        Some(signal)
    );
    assert_eq!(
        seen_session
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone(),
        Some((
            Some("owner".to_string()),
            Some("/tmp/work".to_string()),
            "owner".to_string()
        ))
    );

    let long = "x".repeat(250);
    let events = Arc::new(Collect(Mutex::new(Vec::new())));
    let long_tool = tool(
        "long",
        Arc::new(move |_args, _signal, _ctx| {
            let long = long.clone();
            Box::pin(async move { Ok(ToolResult::Text(long)) })
        }),
    );
    let mut args = serde_json::Map::new();
    args.insert("blob".to_string(), json!("y".repeat(201)));
    execute_tool(
        &long_tool,
        &Value::Object(args),
        &ToolBinding {
            stream: Some(events.clone()),
            ..ToolBinding::default()
        },
        None,
    )
    .await;
    let streamed = events
        .0
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .clone();
    let metadata = streamed[0].metadata.clone().expect("metadata");
    let summary = metadata
        .get("args")
        .and_then(Value::as_object)
        .expect("args");
    let truncated = format!("{}…", "y".repeat(200));
    assert_eq!(
        summary.get("blob").and_then(Value::as_str),
        Some(truncated.as_str())
    );
    assert_eq!(streamed[1].content, format!("✅ long: {}", "x".repeat(200)));

    let pipeline = Arc::new(HookPipeline::new());
    let flagged = Arc::new(Mutex::new(None));
    let slot = Arc::clone(&flagged);
    pipeline.register(HookRegistration::new(
        "observe",
        HookEventName::ToolAfter,
        HookHandler::from_sync(move |ctx| {
            *slot.lock().unwrap_or_else(|err| err.into_inner()) = ctx.is_error;
            Ok(HookSignal::Continue)
        }),
    ));
    execute_tool(
        &text_tool("explicit", "Error: explicit failure"),
        &json!({}),
        &ToolBinding {
            hooks: Some(pipeline),
            ..ToolBinding::default()
        },
        None,
    )
    .await;
    assert_eq!(
        *flagged.lock().unwrap_or_else(|err| err.into_inner()),
        Some(true)
    );
}

#[test]
fn to_model_output_matches_the_typescript_cases() {
    assert_eq!(
        to_tool_result_output(&ToolResult::Text("hello".to_string())),
        ToolResultOutput::Text {
            value: "hello".to_string()
        }
    );
    let parts = ToolResult::Parts(vec![
        ContentPart::Text {
            text: "one".to_string(),
        },
        ContentPart::Text {
            text: " two".to_string(),
        },
    ]);
    assert_eq!(
        to_tool_result_output(&parts),
        ToolResultOutput::Text {
            value: "one two".to_string()
        }
    );
    let image = ToolResult::Parts(vec![
        ContentPart::Text {
            text: "snap:".to_string(),
        },
        ContentPart::Image {
            data: Some("aGVsbG8=".to_string()),
            url: None,
            mime_type: Some("image/png".to_string()),
        },
    ]);
    assert_eq!(
        to_tool_result_output(&image),
        ToolResultOutput::Content {
            value: vec![
                ToolResultContent::Text {
                    text: "snap:".to_string()
                },
                ToolResultContent::ImageData {
                    data: "aGVsbG8=".to_string(),
                    media_type: "image/png".to_string(),
                },
            ]
        }
    );
    let urls = ToolResult::Parts(vec![
        ContentPart::Image {
            data: None,
            url: Some("https://cdn.example.com/a.jpg".to_string()),
            mime_type: None,
        },
        ContentPart::Image {
            data: Some("YWJjZA==".to_string()),
            url: None,
            mime_type: None,
        },
    ]);
    assert_eq!(
        to_tool_result_output(&urls),
        ToolResultOutput::Content {
            value: vec![
                ToolResultContent::ImageUrl {
                    url: "https://cdn.example.com/a.jpg".to_string()
                },
                ToolResultContent::ImageData {
                    data: "YWJjZA==".to_string(),
                    media_type: "image/jpeg".to_string(),
                },
            ]
        }
    );
    let set = to_ai_sdk_tools(
        vec![text_tool("a", "x"), text_tool("b", "y")],
        ToolBinding::default(),
    );
    assert_eq!(set.names(), vec!["a", "b"]);
    assert_eq!(set.get("a").expect("a").description(), "a description");
    assert_eq!(
        set.get("t")
            .map(|tool| tool.to_model_output(&ToolResult::Text("hello".to_string()))),
        None
    );
    assert_eq!(
        set.get("a")
            .expect("a")
            .to_model_output(&ToolResult::Text("hello".to_string())),
        ToolResultOutput::Text {
            value: "hello".to_string()
        }
    );
}
