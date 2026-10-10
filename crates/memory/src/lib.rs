mod capture_client;
mod cowork;
mod error;
mod get_full;
mod migrate;
mod pgmigrate;
mod postgres;
mod project;
mod report;
mod routing;
mod schema_sql;
mod slug;
mod store;
mod text;
mod width;
mod window;
mod writers;

pub use capture_client::{
    apply_capture_guards, capture_guard_statements, checkout_capture, open_capture_pool,
    with_capture_client, CAPTURE_POOL_MAX, IDLE_IN_TRANSACTION_TIMEOUT,
    IDLE_IN_TRANSACTION_TIMEOUT_MS, STATEMENT_TIMEOUT, STATEMENT_TIMEOUT_MS,
};
pub use error::{now_ms, StoreError};
pub use migrate::{
    apply_migration, apply_session_guards, assert_lock_timeout, embedded_as_migrations,
    ensure_migrations_table, list_migrations_dir, reset_session_guards, run_migrations,
    Migration, MigrateClient, MigrateFault, MigrateRows, MIGRATION_LOCK_BACKOFF_MS,
    MIGRATION_LOCK_TIMEOUT,
};
pub use pgmigrate::{
    format_applied_at, migrate_connection, migrate_database, migration_status, AppliedMigration,
    MigrationStatus,
};
pub use postgres::PostgresMemory;
pub use routing::{user_from_session_key, RoutingMemory, StoreHandle};
pub use store::{
    BrowseFilter, CaptureBatch, CaptureMessage, CaptureOptions, CaptureResult, HealthReport,
    HistoryMessage, IngestInput, IngestMessage, IngestOutput, MemoryEntry, MemoryStore,
    ProjectChoice, SearchOptions, StatsReport, ToolCallIn, ToolDescriptor,
};
pub use text::{
    append_event_id, capture_cap, ingest_event_id, resolve_memory_write_tags, truncate_content,
    utf16_len, utf16_prefix, MemoryWriteTags, MAX_CONTENT, TRUNCATION_MARKER,
};

pub mod cowork_hash {
    pub use crate::cowork::{cowork_content_hash, pick_cowork_hook_rewrite, CoworkHookRow};
}

pub mod full {
    pub use crate::get_full::*;
}

pub mod rules {
    pub use crate::project::*;
}

pub mod sql_report {
    pub use crate::report::*;
}

pub mod names {
    pub use crate::slug::*;
}

pub mod spans {
    pub use crate::window::*;
}

pub mod columns {
    pub use crate::width::*;
}

pub mod prepare {
    pub use crate::writers::*;
}
