mod config_resolve;
mod engine;
mod error;
mod lock;
mod migrate;
mod paths;
mod process;
mod sql_compat;
mod status;

pub use config_resolve::{
    DEFAULT_DATA_DIR, DEFAULT_MAX_CONNECTIONS, DEFAULT_PORT, EmbeddedPgEnv, ResolvedEmbeddedPg,
    apply_embedded_pg_url, assert_embedded_port, embedded_pg_env, embedded_pg_url,
    read_embedded_config, require_listen_port, require_max_connections, resolve_embedded_pg,
    resolve_embedded_pg_from_env,
};
pub use engine::{
    ATTACH_BACKUP_ERROR, BACKUP_TIMEOUT, EMBEDDED_NOT_CONFIGURED, EmbeddedPg, SETUP_TIMEOUT,
    acquire_embedded_pg, assert_under_rivet, backup_stamp, backup_wrote_line, default_backup_path,
    reset_engine, with_embedded_pg,
};
pub use error::{LocalDbError, Result};
pub use lock::{
    EMBEDDED_PG_LOCKFILE, EmbeddedPgLock, EmbeddedPgLog, LockClaim, PidProbe, TracingLog,
    claim_owner_lock, embedded_pg_lock_alive, read_embedded_pg_lock, release_owner_lock,
    wait_for_port,
};
pub use migrate::{
    DumpRequest, MIGRATE_PENDING_FILE, MigrationPlan, SkipReason, node_missing_message,
    package_entry, pending_marker, pgdata_dir, plan_migration,
};
pub use paths::user_home;
pub use sql_compat::{filter_pglite_dump, quote_ident};
pub use status::{
    STATUS_NOT_CONFIGURED, STATUS_PREFIX_OK, STATUS_PREFIX_WARN, db_status_lines, dir_size_bytes,
    format_bytes, format_local_status, local_status_line, local_status_line_async,
};
