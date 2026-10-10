mod hooks;
mod logging;
mod transcript;

pub use capture::{
    CaptureRole, EnvLookup, HttpExchange, HttpReply, MapEnv, OccurrenceKey, content_tuple_hash,
    sha256_hex,
};
pub use hooks::{
    CAPTURE_EVENTS, DEFAULT_SPOOL_MAX_ATTEMPTS, DEFAULT_WORKER_DEADLINE_MS, DeadlineHandle,
    DeadlineOptions, HOOK_MARKER_LEGACY, HOOK_MARKER_RUST, HookIngestFn, MAX_SWEEP_FILES,
    TranscriptIngestFn, WorkerDeps, arm_worker_deadline, claim_spool, hook_command,
    ingest_spool_file, install_hooks, is_direct_cli, log_fatal, log_path, run_hook, run_replay,
    run_worker, settings_path, spool_attempt, spool_dir, spool_max_attempts, spool_stem,
    status_text, sweep_stale_spools, uninstall_hooks, with_spool_attempt, worker_deadline_ms,
    write_spool_payload,
};
pub use logging::init as init_logging;
pub use transcript::{
    CAPTURE_CHANNEL, CapturePoolOptions, ConversationKeyParts, HerdrPane, HookEventOptions,
    HookEventResult, IDLE_IN_TRANSACTION_TIMEOUT, IDLE_IN_TRANSACTION_TIMEOUT_MS, IngestOptions,
    IngestResult, LEGACY_TASK_KEY_PREFIX, ParsedTranscript, SET_IDLE_IN_TRANSACTION_TIMEOUT_SQL,
    SET_STATEMENT_TIMEOUT_SQL, STATEMENT_TIMEOUT, STATEMENT_TIMEOUT_MS, TaskCaptureContext,
    apply_capture_guards, capture_agent, create_capture_pool, derive_session_key,
    ingest_hook_event, ingest_transcript, is_task_id, parse_transcript, resolve_conversation_key,
    resolve_hook_event_id, resolve_task_context, session_key_from_id,
};
