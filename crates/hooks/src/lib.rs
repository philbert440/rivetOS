mod audit;
mod auto_actions;
mod context;
mod deadline;
mod declarative;
mod files;
mod handler;
mod js_text;
mod pipeline;
mod regex_util;
mod safety;
mod session;
mod shell;
mod time_format;
mod tool_events;

pub use audit::{
    AuditEntry, AuditError, AuditWriter, JsonlAuditWriter, create_audit_hooks, sanitize_args,
};
pub use auto_actions::{
    AutoAction, AutoActionConfig, AutoActionsConfig, create_auto_action_hooks,
    create_auto_format_hook, create_auto_git_check_hook, create_auto_lint_hook,
    create_auto_test_hook, create_custom_action_hook,
};
pub use context::{
    DelegationStatus, HookContext, PromptUsage, ReflectSource, SessionTokenTotals, TurnComplexity,
};
pub use declarative::{HookConfig, HookConfigKind};
pub use files::{FileError, FileWriter, FsFileWriter};
pub use handler::{BoxFuture, HookErrorMode, HookFailure, HookHandler, HookSignal};
pub use js_text::{js_replace_all, js_slice, js_string, js_truthy, utf16_len};
pub use pipeline::{
    HookErrorRecord, HookLogger, HookPipeline, HookPipelineResult, HookRegistration,
};
pub use protocol::{
    ContentPart, HookEventName, JsNumber, StreamEvent, StreamEventType, ToolResult,
};
pub use regex_util::{compile_regex, compile_static, is_match};
pub use safety::{
    BLOCKED_SHELL_PATTERNS, SafetyAction, SafetyHooksConfig, SafetyRule, WARN_SHELL_PATTERNS,
    WorkspaceFenceConfig, boot_custom_rules, create_custom_rules_hook, create_safety_hooks,
    create_shell_danger_hook, create_workspace_fence_hook, home_dir, normalize_fence_path,
    push_warning, rule_no_delete_git, rule_npm_dry_run, rule_warn_config_write,
};
pub use session::{
    SessionHooksConfig, SessionHooksContext, create_auto_commit_hook, create_post_compact_hook,
    create_pre_compact_hook, create_session_hooks, create_session_start_hook,
    create_session_summary_hook,
};
pub use shell::{OUTPUT_CAP, ProcessShell, SHELL_TIMEOUT, ShellError, ShellExecutor, ShellOutput};
pub use time_format::{epoch_ms, fixed_1, group_en_us, iso_timestamp, local_hhmm, utc_date};
pub use tool_events::{
    AbortSignal, AiSdkTool, PreparedTool, StreamSink, ToolBinding, ToolCallContext, ToolExecError,
    ToolFn, ToolFuture, ToolImage, ToolResultContent, ToolResultOutput, ToolSession, ToolSet,
    build_local_session, build_local_session_with_env, execute_tool, summarize_args,
    to_ai_sdk_tools, to_tool_result_output, tool_result_has_images, tool_result_images,
    tool_result_is_error, tool_result_text,
};
