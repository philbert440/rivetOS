mod aisdk;
mod catalog;
mod chunks;
mod cli;
mod cli_machine;
mod client;
mod decode;
mod embed;
mod error;
mod fold;
mod hermes_db;
mod http;
mod jsonutil;
mod session;
mod sse;
mod token;
mod turn;
mod types;

pub use aisdk::{
    AiImage, AiModelContent, AiModelMessage, AiModelPart, AiSdkAccumulator, AiSdkError, AiSdkPart,
    AiUsage, AiUserPart, LooseMessage, LooseToolCall, build_done_chunk, convert_messages_to_ai_sdk,
    extract_text_message, extract_text_value, parts_to_ai_sdk_user_content, translate_ai_sdk_part,
};
pub use catalog::{DEFAULT_CATALOG_TIMEOUT_MS, DEFAULT_CATALOG_TTL_MS, FetchIds, ModelCatalog};
pub use cli::{
    CLAUDE_DEFAULT_TOOLS, CLAUDE_PROBE_TIMEOUT_MS, ClaudeArgs, CliProvider, CodexArgs, GrokArgs,
    HermesArgs, KimiArgs, LooseNumber, NO_INSTRUCTION, OpencodeArgs, PERMISSION_PROMPT_SERVER,
    PERMISSION_PROMPT_TIMEOUT_MAX_MS, PERMISSION_PROMPT_TIMEOUT_MS, PermissionAnswer,
    PermissionAsk, PermissionEvent, PiArgs, QwenArgs, claude_args, codex_agent_text, codex_args,
    codex_prompt, default_skip_git_repo_check, execute_permission_prompt, grok_args, hermes_args,
    hermes_model_args, hermes_session_id, kimi_args, opencode_args, opencode_xdg_data_home,
    parse_cli_timeout_ms, parse_codex_line, parse_kimi_line, parse_permission_prompts,
    parse_permission_timeout_ms, permission_decision_text, permission_prompt_tool_id, pi_args,
    qwen_args, resolve_grok_binary, scrub_claude_env, scrub_codex_env, scrub_grok_env,
    variant_for_effort,
};
pub use client::{
    HttpProvider, ManifestConfig, chat_completions_url, models_probe_url, normalize_api_prefix,
    process_env, strip_openai_base,
};
pub use embed::{
    EMBEDDING_COLUMN_DIMS, EmbedRequest, EmbedWireParse, EmbedWireShape, build_embed_request,
    normalize_embed_vector, parse_embed_response, parse_embed_wire_shape,
};
pub use error::ProviderError;
pub use fold::{FoldContent, FoldMessage, split_and_fold_system};
pub use hermes_db::{
    Cell, HermesTokenCounts, HermesTokenKind, HermesTokenSnapshot, HermesUsage,
    read_hermes_session_tokens, tokens_for_turn, tokens_from_row, unknown_tokens, usage_delta,
    usage_from_tokens,
};
pub use jsonutil::{canonical_json, is_claude_4, js_norm, map_xai_reasoning_effort};
pub use session::{
    CODEX_SESSION_MAP, GROK_SESSION_MAP, HERMES_SESSION_MAP, KIMI_SESSION_MAP,
    OPENCODE_SESSION_MAP, PI_SESSION_MAP, QWEN_SESSION_MAP, delete_session_map_key,
    delete_session_map_key_merge, load_session_map, qwen_resume_rejected, qwen_saw_init,
    random_uuid_v4, save_session_map, save_session_map_merge, session_map_strings,
    session_not_found, sha1_hex, uuid_for_conversation,
};
pub use token::{
    DEFAULT_TOKEN_COMMAND_TIMEOUT_MS, DEFAULT_TOKEN_TTL_MS, ParsedArgv, Runner, RunnerFuture,
    TOKEN_COMMAND_MAX_BUFFER, TokenCommandInput, TokenEntry, TokenError, TokenSource,
    authorized_call, default_run_command, parse_token_command_argv,
};
pub use turn::{TurnOutput, run_agent_turn};
pub use types::{
    ChatRequest, Provider, TURN_TIMEOUT_MS, ToolDef, TurnMessage, compact_tool, echo_tool,
    execute_tool, text_event, tool_result_event, tool_start_event, with_compact,
};
