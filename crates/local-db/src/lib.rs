mod config_resolve;
mod engine;
mod error;
mod lock;
mod migrate;
mod paths;
mod process;
mod schema_sql;
mod sql_compat;
mod status;
mod supervisor;

pub mod cli;

pub use config_resolve::{
    DEFAULT_DATA_DIR, DEFAULT_MAX_CONNECTIONS, DEFAULT_PORT, EmbeddedEnv, EmbeddedPgEnv,
    ResolvedEmbeddedPg, apply_embedded_pg_url, assert_embedded_port, embedded_pg_env,
    embedded_pg_url, process_embedded_env, read_embedded_config, read_embedded_config_with,
    require_listen_port, require_max_connections, resolve_embedded_pg,
    resolve_embedded_pg_from_env,
};
pub use engine::{
    ATTACH_BACKUP_ERROR, BACKUP_TIMEOUT, EMBEDDED_NOT_CONFIGURED, EmbeddedPg, SETUP_TIMEOUT,
    acquire_embedded_pg, acquire_embedded_pg_with, assert_under_rivet, backup_stamp,
    backup_wrote_line, default_backup_path, reset_engine, reset_engine_with, with_embedded_pg,
};
pub use error::{LocalDbError, Result};
pub use lock::{
    EMBEDDED_PG_LOCKFILE, EmbeddedPgLock, EmbeddedPgLog, LockClaim, PidProbe, TracingLog,
    claim_owner_lock, embedded_pg_lock_alive, read_embedded_pg_lock, release_owner_lock,
    wait_for_port,
};
pub use migrate::{
    MIGRATE_PENDING_FILE, MigrationPlan, SkipReason, node_missing_message, package_entry,
    pending_marker, pgdata_dir, plan_migration,
};
pub use paths::{cluster_dir_for, user_home};
pub use sql_compat::quote_ident;
pub use status::{
    STATUS_NOT_CONFIGURED, STATUS_PREFIX_OK, STATUS_PREFIX_WARN, db_status_lines, dir_size_bytes,
    format_bytes, format_local_status, local_status_line, local_status_line_async,
};
