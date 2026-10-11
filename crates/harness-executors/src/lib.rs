mod acp_exec;
mod drive;
mod error;
mod install;
mod kimi;
mod model;
mod opencode;
mod pi;
mod prompt;
mod qwen;
mod registry;
mod spawn;
mod standard_helpers;

pub use acp_exec::{
    AcpHarnessExecutor, CODEX_HARNESS_ID, CURSOR_HARNESS_ID, GROK_BUILD_HARNESS_ID,
    HERMES_HARNESS_ID, codex_executor, cursor_executor, grok_build_executor, hermes_executor,
};
pub use drive::{HistorySource, ScaffoldMode, SpawnOutcome};
pub use error::ExecError;
pub use install::{
    ArgvHarnessConfig, HarnessBinaries, HeadlessConfig, codex_missing_binary,
    cursor_missing_binary, grok_missing_binary, hermes_missing_binary, install_headless_executors,
};
pub use kimi::{
    KIMI_HARNESS_ID, KimiCodeExecutor, KimiFlags, SessionIndexEntry, WireTurnEnd, WireTurnFacts,
    build_kimi_args, build_kimi_child_env, canonical_kimi_session_id, find_bucket_dir, kimi_home,
    kimi_resume_rejected, list_session_ids, read_session_index, reconcile_turn,
    resolve_session_dir, wire_files_for, work_dir_hash,
};
pub use model::{
    AbortFlag, AcceptanceCriterion, Capabilities, DenBody, EventQueue, TaskEvent, TaskHandle,
    TaskSpec, UsageAcc, empty_usage, open_handle, publish,
};
pub use opencode::{
    OPENCODE_HARNESS_ID, OpencodeExecutor, OpencodeFlags, OpencodeTurnFacts, ParsedOpencodeEvent,
    build_opencode_args, build_opencode_child_env, canonical_opencode_session_id,
    effective_opencode_home, list_opencode_session_ids, newest_opencode_session_after,
    opencode_db_path, opencode_home, opencode_resume_rejected, parse_opencode_event,
    reconcile_opencode_turn, xdg_data_home_for,
};
pub use pi::{
    PI_HARNESS_ID, PiExecutor, PiFlags, PiTurnFacts, build_pi_args, build_pi_child_env,
    canonical_pi_session_id, find_pi_session_file, is_fatal_pi_stop_reason, is_pi_native_id,
    list_pi_session_ids, pi_home, pi_resume_rejected, pi_sessions_root, pi_transcript_files,
    reconcile_pi_turn, tokens_from_pi_usage,
};
pub use prompt::{
    EMPTY_PROMPT_PLACEHOLDER, HistoryMessage, PROMPT_MAX_BYTES, RESUME_HISTORY_LIMIT,
    build_task_scaffold, build_turn_prompt, canonical_session_id, clamp_prompt,
    render_resume_transcript, task_result_fence_instructions, variant_for_effort,
};
pub use qwen::{
    QWEN_CODE_HARNESS_ID, QwenCodeExecutor, QwenFlags, QwenTurnFacts, build_qwen_args,
    build_qwen_child_env, canonical_qwen_session_id, default_workspace_dir, encode_qwen_bucket,
    find_qwen_session_file, is_fatal_qwen_result, is_qwen_native_id, list_qwen_session_ids,
    qwen_home, qwen_resume_rejected, qwen_transcript_files, reconcile_qwen_turn,
    tokens_from_qwen_usage,
};
pub use registry::{
    COWORK_GAP, CanonicalTarget, DEPRECATED_EXECUTOR_TARGETS, ExecutorRegistry, HarnessCoverage,
    HarnessExecutor, RegistryEntry, UnsupportedError, canonicalize_executor_target,
    claude_missing_binary, claude_package_load, create_executor_registry,
    create_not_implemented_harness_executor, harness_executor_coverage, harness_executor_gap,
    harness_executor_unsupported, is_harness_executor_target, is_not_implemented_harness_executor,
    kimi_missing_binary, kimi_package_load, not_implemented_harness_reason,
    opencode_missing_binary, opencode_package_load, pi_missing_binary, pi_package_load,
    qwen_missing_binary, qwen_package_load,
};
pub use spawn::{
    KILL_GRACE_MS, STDERR_CAP, STDOUT_CAP, SpawnRequest, Spawned, StdinMode, child_env,
    probe_binary, spawn_child, stderr_tail,
};
pub use standard_helpers::{Env, MapEnv, ProcessEnv};
