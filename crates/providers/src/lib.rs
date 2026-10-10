mod aisdk;
mod catalog;
mod chunks;
mod cli;
mod client;
mod decode;
mod embed;
mod error;
mod http;
mod jsonutil;
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
    PERMISSION_PROMPT_TIMEOUT_MAX_MS, PERMISSION_PROMPT_TIMEOUT_MS, PiArgs, QwenArgs, claude_args,
    codex_agent_text, codex_args, codex_prompt, default_skip_git_repo_check, grok_args,
    hermes_args, hermes_model_args, hermes_session_id, kimi_args, opencode_args,
    opencode_xdg_data_home, parse_cli_timeout_ms, parse_codex_line, parse_kimi_line,
    parse_permission_prompts, parse_permission_timeout_ms, permission_prompt_tool_id, pi_args,
    qwen_args, resolve_grok_binary, scrub_claude_env, scrub_codex_env, scrub_grok_env,
    variant_for_effort,
};
pub use client::{HttpProvider, ManifestConfig};
pub use embed::{
    EMBEDDING_COLUMN_DIMS, EmbedRequest, EmbedWireParse, EmbedWireShape, build_embed_request,
    normalize_embed_vector, parse_embed_response, parse_embed_wire_shape,
};
pub use error::ProviderError;
pub use jsonutil::{canonical_json, is_claude_4, js_norm, map_xai_reasoning_effort};
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
