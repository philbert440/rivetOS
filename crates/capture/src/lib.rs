mod base64url;
mod den_url;
mod env;
mod error;
mod event_id;
mod helpers;
mod lock;
mod redaction;
mod spool;
mod timeutil;
mod transport;
mod types;
mod writer;

pub use den_url::{
    DEFAULT_CA_PATH, DEFAULT_DEN_PORT, DenConfigScalars, ExistsFn, GuardedDenUrl, ResolvedDenUrl,
    acceptable_http_url, default_config_reader, den_scheme_is_https, den_settings,
    den_tls_configured, guard_den_url, path_exists, resolve_den_url,
};
pub use env::{EnvLookup, MapEnv, ProcessEnv, trimmed};
pub use error::{CaptureError, ReplayReport, WriteOutcome};
pub use event_id::{
    EventIdParts, OccurrenceKey, content_tuple_hash, event_id_from_content, occurrence_index,
    sha256_hex,
};
pub use helpers::{
    CONTENT_LIMIT, CappedText, as_string, cap_field, cap_for_storage, is_record, json_utf8_len,
    load_env_file, safe_json, split_utf16, utf16_len, utf16_slice,
};
pub use lock::{
    BeforeReaddir, FileLockOptions, LockError, ReadFault, hex_host, pid_dead, system_hostname,
    with_file_lock,
};
pub use redaction::{
    BuiltinDetectorId, OperatorPattern, REDACT_SCAN_LIMIT, RedactionApplyResult,
    ResolvedCaptureRedaction, capture_redaction_from_env, is_unsafe_regex_source,
    keep_metadata_key, redact_message, redact_text, resolve_capture_redaction, secret_key_matches,
};
pub use spool::{dead_letter, spool_batch, spool_files};
pub use timeutil::{iso_from_unix_ms, iso_now, unix_ms_now};
pub use transport::{
    CaptureTransport, CaptureUser, MissingUserToken, capture_user, capture_user_from_env,
    resolve_capture_transport,
};
pub use types::{
    CaptureBatch, CaptureMessage, CaptureRedactionOptions, CaptureResult, CaptureRole,
    CaptureWriterOptions, HttpExchange, HttpReply, LogFn, UserSource,
};
pub use writer::{
    CHUNK_OVER_LIMIT, CaptureWriter, DEFAULT_CHUNK_BYTES, ReplayOptions, SPOOL_REFUSED_MAX_AGE_MS,
    create_capture_writer, spool_name_for,
};
