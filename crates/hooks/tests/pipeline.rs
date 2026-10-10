use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::common::{CaptureLog, calls, provider_before, push_call, tool_before};
use hooks::{
    HookContext, HookErrorMode, HookEventName, HookFailure, HookHandler, HookPipeline,
    HookRegistration, HookSignal,
};
use serde_json::json;

#[tokio::test]
async fn runs_hooks_for_the_matching_event() {
    let pipeline = HookPipeline::new();
    let seen = calls();
    pipeline.register(HookRegistration::new(
        "hook-a",
        HookEventName::ProviderBefore,
        push_call(&seen, "a"),
    ));
    let mut ctx = provider_before();
    let result = pipeline.run(&mut ctx).await;
    assert_eq!(
        seen.lock()
            .unwrap_or_else(|err| err.into_inner())
            .as_slice(),
        ["a"]
    );
    assert_eq!(result.ran, vec!["hook-a".to_string()]);
    assert!(!result.aborted);
    assert!(!result.skipped);
    assert!(result.errors.is_empty());
}

#[tokio::test]
async fn skips_hooks_for_a_different_event() {
    let pipeline = HookPipeline::new();
    let seen = calls();
    pipeline.register(HookRegistration::new(
        "hook-a",
        HookEventName::ProviderAfter,
        push_call(&seen, "a"),
    ));
    let mut ctx = provider_before();
    let result = pipeline.run(&mut ctx).await;
    assert!(
        seen.lock()
            .unwrap_or_else(|err| err.into_inner())
            .is_empty()
    );
    assert!(result.ran.is_empty());
}

#[tokio::test]
async fn runs_multiple_hooks_for_the_same_event() {
    let pipeline = HookPipeline::new();
    let seen = calls();
    pipeline.register(HookRegistration::new(
        "hook-a",
        HookEventName::ProviderBefore,
        push_call(&seen, "a"),
    ));
    pipeline.register(HookRegistration::new(
        "hook-b",
        HookEventName::ProviderBefore,
        push_call(&seen, "b"),
    ));
    let mut ctx = provider_before();
    let result = pipeline.run(&mut ctx).await;
    assert_eq!(
        seen.lock()
            .unwrap_or_else(|err| err.into_inner())
            .as_slice(),
        ["a", "b"]
    );
    assert_eq!(result.ran, vec!["hook-a".to_string(), "hook-b".to_string()]);
}

#[tokio::test]
async fn runs_in_priority_order_and_keeps_equal_priorities_stable() {
    let pipeline = HookPipeline::new();
    let seen = calls();
    pipeline.register(
        HookRegistration::new(
            "hook-c",
            HookEventName::ProviderBefore,
            push_call(&seen, "c"),
        )
        .priority(90),
    );
    pipeline.register(
        HookRegistration::new(
            "hook-a",
            HookEventName::ProviderBefore,
            push_call(&seen, "a"),
        )
        .priority(10),
    );
    pipeline.register(
        HookRegistration::new(
            "explicit-50",
            HookEventName::ProviderBefore,
            push_call(&seen, "explicit"),
        )
        .priority(50),
    );
    pipeline.register(HookRegistration::new(
        "default-50",
        HookEventName::ProviderBefore,
        push_call(&seen, "default"),
    ));
    pipeline.register(
        HookRegistration::new(
            "low-priority",
            HookEventName::ProviderBefore,
            push_call(&seen, "low"),
        )
        .priority(10),
    );
    let mut ctx = provider_before();
    pipeline.run(&mut ctx).await;
    assert_eq!(
        seen.lock()
            .unwrap_or_else(|err| err.into_inner())
            .as_slice(),
        ["a", "low", "explicit", "default", "c"]
    );
}

#[tokio::test]
async fn passes_mutated_context_through_the_pipeline() {
    let pipeline = HookPipeline::new();
    pipeline.register(
        HookRegistration::new(
            "set-flag",
            HookEventName::ProviderBefore,
            HookHandler::from_sync(|ctx| {
                ctx.metadata.insert("rateLimited".to_string(), json!(true));
                Ok(HookSignal::Continue)
            }),
        )
        .priority(10),
    );
    pipeline.register(
        HookRegistration::new(
            "read-flag",
            HookEventName::ProviderBefore,
            HookHandler::from_sync(|ctx| {
                if ctx.metadata.get("rateLimited") == Some(&json!(true)) {
                    ctx.skip = Some(true);
                }
                Ok(HookSignal::Continue)
            }),
        )
        .priority(20),
    );
    let mut ctx = provider_before();
    pipeline.run(&mut ctx).await;
    assert_eq!(ctx.metadata.get("rateLimited"), Some(&json!(true)));
    assert_eq!(ctx.skip, Some(true));
}

#[tokio::test]
async fn hooks_reassign_messages_instead_of_sharing_the_old_vec() {
    let pipeline = HookPipeline::new();
    pipeline.register(HookRegistration::new(
        "inject-system-msg",
        HookEventName::ProviderBefore,
        HookHandler::from_sync(|ctx| {
            let mut messages = ctx.messages.clone().unwrap_or_default();
            messages.push(json!({"role": "system", "content": "injected"}));
            ctx.messages = Some(messages);
            Ok(HookSignal::Continue)
        }),
    ));
    let mut ctx = HookContext::provider_before(
        "google",
        "gemini-2.5-pro",
        vec![json!({"role": "user", "content": "hi"})],
    );
    pipeline.run(&mut ctx).await;
    let messages = ctx.messages.expect("messages");
    assert_eq!(messages.len(), 2);
    assert_eq!(
        messages[1],
        json!({"role": "system", "content": "injected"})
    );
}

#[tokio::test]
async fn abort_and_skip_stop_the_pipeline() {
    let pipeline = HookPipeline::new();
    let seen = calls();
    pipeline.register(
        HookRegistration::new(
            "blocker",
            HookEventName::ToolBefore,
            HookHandler::from_sync({
                let seen = Arc::clone(&seen);
                move |ctx| {
                    ctx.blocked = Some(true);
                    ctx.block_reason = Some("Dangerous command".to_string());
                    seen.lock()
                        .unwrap_or_else(|err| err.into_inner())
                        .push("blocker".to_string());
                    Ok(HookSignal::Abort)
                }
            }),
        )
        .priority(10),
    );
    pipeline.register(
        HookRegistration::new(
            "logger",
            HookEventName::ToolBefore,
            push_call(&seen, "logger"),
        )
        .priority(20),
    );
    let mut ctx = tool_before("shell", json!({"command": "rm -rf /"}));
    let result = pipeline.run(&mut ctx).await;
    assert_eq!(
        seen.lock()
            .unwrap_or_else(|err| err.into_inner())
            .as_slice(),
        ["blocker"]
    );
    assert!(result.aborted);
    assert!(!result.skipped);
    assert_eq!(ctx.blocked, Some(true));
    assert!(!result.ran.iter().any(|id| id == "logger"));

    let pipeline = HookPipeline::new();
    let seen = calls();
    pipeline.register(
        HookRegistration::new(
            "skipper",
            HookEventName::ProviderBefore,
            HookHandler::from_sync({
                let seen = Arc::clone(&seen);
                move |_| {
                    seen.lock()
                        .unwrap_or_else(|err| err.into_inner())
                        .push("skipper".to_string());
                    Ok(HookSignal::Skip)
                }
            }),
        )
        .priority(10),
    );
    pipeline.register(
        HookRegistration::new(
            "after-skip",
            HookEventName::ProviderBefore,
            push_call(&seen, "after-skip"),
        )
        .priority(20),
    );
    let mut ctx = provider_before();
    let result = pipeline.run(&mut ctx).await;
    assert_eq!(
        seen.lock()
            .unwrap_or_else(|err| err.into_inner())
            .as_slice(),
        ["skipper"]
    );
    assert!(!result.aborted);
    assert!(result.skipped);
}

#[tokio::test]
async fn error_modes_continue_abort_and_retry() {
    let pipeline = HookPipeline::new();
    let seen = calls();
    pipeline.register(
        HookRegistration::new(
            "throws",
            HookEventName::ProviderBefore,
            HookHandler::from_sync(|_| Err(HookFailure::new("boom"))),
        )
        .priority(10),
    );
    pipeline.register(
        HookRegistration::new(
            "survives",
            HookEventName::ProviderBefore,
            push_call(&seen, "survives"),
        )
        .priority(20),
    );
    let mut ctx = provider_before();
    let result = pipeline.run(&mut ctx).await;
    assert_eq!(
        seen.lock()
            .unwrap_or_else(|err| err.into_inner())
            .as_slice(),
        ["survives"]
    );
    assert_eq!(result.errors.len(), 1);
    assert_eq!(result.errors[0].hook_id, "throws");
    assert_eq!(result.errors[0].error.message, "boom");
    assert!(result.ran.iter().any(|id| id == "throws"));
    assert!(!result.aborted);

    let pipeline = HookPipeline::new();
    let seen = calls();
    pipeline.register(
        HookRegistration::new(
            "critical",
            HookEventName::ProviderBefore,
            HookHandler::from_sync(|_| Err(HookFailure::new("critical failure"))),
        )
        .priority(10)
        .on_error(HookErrorMode::Abort),
    );
    pipeline.register(
        HookRegistration::new(
            "never-runs",
            HookEventName::ProviderBefore,
            push_call(&seen, "never-runs"),
        )
        .priority(20),
    );
    let mut ctx = provider_before();
    let result = pipeline.run(&mut ctx).await;
    assert!(
        seen.lock()
            .unwrap_or_else(|err| err.into_inner())
            .is_empty()
    );
    assert!(result.aborted);
    assert_eq!(result.errors[0].error.message, "critical failure");
    assert!(!result.ran.iter().any(|id| id == "critical"));

    let attempts = Arc::new(Mutex::new(0_i32));
    let pipeline = HookPipeline::new();
    pipeline.register(
        HookRegistration::new(
            "flaky",
            HookEventName::ProviderBefore,
            HookHandler::from_sync({
                let attempts = Arc::clone(&attempts);
                move |_| {
                    let mut count = attempts.lock().unwrap_or_else(|err| err.into_inner());
                    *count += 1;
                    if *count == 1 {
                        Err(HookFailure::new("transient"))
                    } else {
                        Ok(HookSignal::Continue)
                    }
                }
            }),
        )
        .on_error(HookErrorMode::Retry),
    );
    let mut ctx = provider_before();
    let result = pipeline.run(&mut ctx).await;
    assert_eq!(*attempts.lock().unwrap_or_else(|err| err.into_inner()), 2);
    assert!(result.errors.is_empty());
    assert!(!result.aborted);
    assert!(result.ran.iter().any(|id| id == "flaky"));

    let pipeline = HookPipeline::new();
    let seen = calls();
    pipeline.register(
        HookRegistration::new(
            "always-fails",
            HookEventName::ProviderBefore,
            HookHandler::from_sync(|_| Err(HookFailure::new("permanent"))),
        )
        .priority(10)
        .on_error(HookErrorMode::Retry),
    );
    pipeline.register(
        HookRegistration::new(
            "after-retry",
            HookEventName::ProviderBefore,
            push_call(&seen, "after-retry"),
        )
        .priority(20),
    );
    let mut ctx = provider_before();
    let result = pipeline.run(&mut ctx).await;
    assert_eq!(
        seen.lock()
            .unwrap_or_else(|err| err.into_inner())
            .as_slice(),
        ["after-retry"]
    );
    assert_eq!(result.errors.len(), 1);
    assert_eq!(result.errors[0].error.message, "permanent");
    assert!(!result.ran.iter().any(|id| id == "always-fails"));
    assert!(!result.aborted);
}

#[tokio::test]
async fn filters_agents_and_tools_and_skips_disabled_hooks() {
    let pipeline = HookPipeline::new();
    let seen = calls();
    pipeline.register(
        HookRegistration::new(
            "opus-only",
            HookEventName::ProviderBefore,
            push_call(&seen, "opus-only"),
        )
        .agent_filter(["opus"]),
    );
    pipeline.register(HookRegistration::new(
        "all-agents",
        HookEventName::ProviderBefore,
        push_call(&seen, "all-agents"),
    ));
    let mut opus = provider_before().with_agent("opus");
    pipeline.run(&mut opus).await;
    assert_eq!(
        seen.lock()
            .unwrap_or_else(|err| err.into_inner())
            .as_slice(),
        ["opus-only", "all-agents"]
    );
    seen.lock().unwrap_or_else(|err| err.into_inner()).clear();
    let mut grok = provider_before().with_agent("grok");
    pipeline.run(&mut grok).await;
    assert_eq!(
        seen.lock()
            .unwrap_or_else(|err| err.into_inner())
            .as_slice(),
        ["all-agents"]
    );
    seen.lock().unwrap_or_else(|err| err.into_inner()).clear();
    let mut blank = provider_before().with_agent("");
    pipeline.run(&mut blank).await;
    assert_eq!(
        seen.lock()
            .unwrap_or_else(|err| err.into_inner())
            .as_slice(),
        ["opus-only", "all-agents"]
    );

    let pipeline = HookPipeline::new();
    let seen = calls();
    pipeline.register(
        HookRegistration::new(
            "shell-guard",
            HookEventName::ToolBefore,
            push_call(&seen, "shell-guard"),
        )
        .tool_filter(["shell"]),
    );
    let mut shell = tool_before("shell", json!({"command": "echo hi"}));
    pipeline.run(&mut shell).await;
    assert_eq!(
        seen.lock()
            .unwrap_or_else(|err| err.into_inner())
            .as_slice(),
        ["shell-guard"]
    );
    seen.lock().unwrap_or_else(|err| err.into_inner()).clear();
    let mut file = tool_before("file_read", json!({"command": "echo hi"}));
    pipeline.run(&mut file).await;
    assert!(
        seen.lock()
            .unwrap_or_else(|err| err.into_inner())
            .is_empty()
    );
    let mut provider = provider_before();
    pipeline.register(
        HookRegistration::new(
            "provider-tool-filter",
            HookEventName::ProviderBefore,
            push_call(&seen, "provider"),
        )
        .tool_filter(["shell"]),
    );
    pipeline.run(&mut provider).await;
    assert_eq!(
        seen.lock()
            .unwrap_or_else(|err| err.into_inner())
            .as_slice(),
        ["provider"]
    );

    let pipeline = HookPipeline::new();
    let seen = calls();
    pipeline.register(
        HookRegistration::new(
            "disabled",
            HookEventName::ProviderBefore,
            push_call(&seen, "disabled"),
        )
        .enabled(false),
    );
    pipeline.register(HookRegistration::new(
        "enabled",
        HookEventName::ProviderBefore,
        push_call(&seen, "enabled"),
    ));
    let mut ctx = provider_before();
    pipeline.run(&mut ctx).await;
    assert_eq!(
        seen.lock()
            .unwrap_or_else(|err| err.into_inner())
            .as_slice(),
        ["enabled"]
    );
    assert_eq!(pipeline.get_hooks(None).len(), 2);
}

#[tokio::test]
async fn registration_replace_keeps_position_and_logs_the_warning() {
    let log = Arc::new(CaptureLog::new());
    let pipeline = HookPipeline::with_logger(Some(log.clone()));
    let seen = calls();
    pipeline.register(HookRegistration::new(
        "dupe",
        HookEventName::ProviderBefore,
        push_call(&seen, "first"),
    ));
    pipeline.register(HookRegistration::new(
        "kept",
        HookEventName::ProviderBefore,
        push_call(&seen, "kept"),
    ));
    pipeline.register(HookRegistration::new(
        "dupe",
        HookEventName::ProviderBefore,
        push_call(&seen, "second"),
    ));
    assert_eq!(
        log.messages("warn"),
        vec!["Hook \"dupe\" already registered — replacing".to_string()]
    );
    let ids: Vec<_> = pipeline
        .get_hooks(None)
        .into_iter()
        .map(|hook| hook.id)
        .collect();
    assert_eq!(ids, vec!["dupe".to_string(), "kept".to_string()]);
    let mut ctx = provider_before();
    pipeline.run(&mut ctx).await;
    assert_eq!(
        seen.lock()
            .unwrap_or_else(|err| err.into_inner())
            .as_slice(),
        ["second", "kept"]
    );
    assert!(pipeline.unregister("dupe"));
    assert!(!pipeline.unregister("missing"));
    pipeline.clear();
    assert!(pipeline.get_hooks(None).is_empty());
    let _ = HookPipeline::default();
}

#[tokio::test]
async fn lists_hooks_by_event_and_runs_async_work_in_series() {
    let pipeline = HookPipeline::new();
    pipeline.register(HookRegistration::new(
        "provider-hook",
        HookEventName::ProviderBefore,
        HookHandler::from_sync(|_| Ok(HookSignal::Continue)),
    ));
    pipeline.register(HookRegistration::new(
        "tool-hook",
        HookEventName::ToolBefore,
        HookHandler::from_sync(|_| Ok(HookSignal::Continue)),
    ));
    let provider = pipeline.get_hooks(Some(HookEventName::ProviderBefore));
    assert_eq!(provider.len(), 1);
    assert_eq!(provider[0].id, "provider-hook");
    assert_eq!(pipeline.get_hooks(None).len(), 2);

    let pipeline = HookPipeline::new();
    let seen = calls();
    let slow = Arc::clone(&seen);
    pipeline.register(
        HookRegistration::new(
            "slow",
            HookEventName::ProviderBefore,
            HookHandler::from_future(move |_| {
                let slow = Arc::clone(&slow);
                Box::pin(async move {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    slow.lock()
                        .unwrap_or_else(|err| err.into_inner())
                        .push("slow".to_string());
                    Ok(HookSignal::Continue)
                })
            }),
        )
        .priority(10),
    );
    pipeline.register(
        HookRegistration::new(
            "fast",
            HookEventName::ProviderBefore,
            push_call(&seen, "fast"),
        )
        .priority(20),
    );
    let mut ctx = provider_before();
    pipeline.run(&mut ctx).await;
    assert_eq!(
        seen.lock()
            .unwrap_or_else(|err| err.into_inner())
            .as_slice(),
        ["slow", "fast"]
    );

    let pipeline = HookPipeline::new();
    let mut ctx = provider_before();
    let result = pipeline.run(&mut ctx).await;
    assert!(!result.aborted);
    assert!(!result.skipped);
    assert!(result.errors.is_empty());
    assert!(result.ran.is_empty());
}

#[tokio::test]
async fn provider_error_is_observational_and_safety_can_abort_before_audit() {
    let pipeline = HookPipeline::new();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen_hook = Arc::clone(&seen);
    pipeline.register(HookRegistration::new(
        "error-logger",
        HookEventName::ProviderError,
        HookHandler::from_sync(move |ctx| {
            seen_hook
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .push((ctx.provider_id.clone(), ctx.status_code));
            Ok(HookSignal::Continue)
        }),
    ));
    let mut ctx = HookContext::provider_error("google", "gemini-2.5-pro", "RESOURCE_EXHAUSTED");
    ctx.status_code = Some(429);
    let result = pipeline.run(&mut ctx).await;
    assert_eq!(
        seen.lock()
            .unwrap_or_else(|err| err.into_inner())
            .as_slice(),
        [(Some("google".to_string()), Some(429))]
    );
    assert!(!result.aborted);

    let pipeline = HookPipeline::new();
    let audit = calls();
    pipeline.register(
        HookRegistration::new(
            "safety-gate",
            HookEventName::ToolBefore,
            HookHandler::from_sync(|ctx| {
                let command = ctx
                    .args
                    .as_ref()
                    .and_then(|args| args.get("command"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                if command.contains("rm -rf") {
                    ctx.blocked = Some(true);
                    ctx.block_reason =
                        Some("Destructive command blocked by safety hook".to_string());
                    return Ok(HookSignal::Abort);
                }
                Ok(HookSignal::Continue)
            }),
        )
        .priority(10)
        .tool_filter(["shell"]),
    );
    pipeline.register(
        HookRegistration::new(
            "audit-log",
            HookEventName::ToolBefore,
            push_call(&audit, "audit"),
        )
        .priority(90),
    );
    let mut safe = tool_before("shell", json!({"command": "ls -la"}));
    let safe_result = pipeline.run(&mut safe).await;
    assert!(!safe_result.aborted);
    assert_eq!(audit.lock().unwrap_or_else(|err| err.into_inner()).len(), 1);
    let mut danger = tool_before("shell", json!({"command": "rm -rf /"}));
    let danger_result = pipeline.run(&mut danger).await;
    assert!(danger_result.aborted);
    assert_eq!(danger.blocked, Some(true));
    assert_eq!(audit.lock().unwrap_or_else(|err| err.into_inner()).len(), 1);
}

#[tokio::test]
async fn logger_records_the_pipeline_phrases() {
    let log = Arc::new(CaptureLog::new());
    let pipeline = HookPipeline::with_logger(Some(log.clone()));
    pipeline.register(HookRegistration::new(
        "hook-a",
        HookEventName::ProviderBefore,
        HookHandler::from_sync(|_| Ok(HookSignal::Abort)),
    ));
    let mut ctx = provider_before();
    pipeline.run(&mut ctx).await;
    let debug = log.messages("debug");
    assert_eq!(debug[0], "Hook \"hook-a\" running for provider:before");
    assert_eq!(debug[1], "Hook \"hook-a\" aborted pipeline");
}
