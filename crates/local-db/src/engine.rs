use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::time::Duration;

use protocol::host::{Env, MapEnv};
use serde_json::Value;
use sqlx::ConnectOptions;
use sqlx::Row;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

use crate::config_resolve::{
    EmbeddedPgEnv, ResolvedEmbeddedPg, apply_embedded_pg_url, embedded_pg_env, embedded_pg_url,
    require_listen_port, require_max_connections, resolve_embedded_pg_from_env,
};
use crate::error::{LocalDbError, Result, engine_error, extension_error};
use crate::lock::{
    EmbeddedPgLog, FileLock, LockClaim, PidProbe, claim_owner_lock, embedded_pg_lock_alive,
    probe_lock_pid, read_embedded_pg_lock, release_owner_lock,
};
use crate::migrate::{
    BoundInsert, CopiedJob, DestColumn, ExportAction, MigrationPlan, SkipReason, TypedName,
    clear_store_work, copy_this_table, export_pglite_source, install_graphile_schema,
    keep_copied_job, mask_self_link_columns, missing_relation_message, parse_export_line,
    pending_marker, pgdata_dir, plan_insert, plan_migration, plan_self_link_updates,
    record_migrated_sources, setval_statement, source_is_migrated,
};
use crate::paths::{
    backups_dir, cluster_dir_for, expand_tilde, lexical_absolute, real_of_nearest, rivet_dir,
    shell_quote,
};
use crate::process::{clear_stale_postmaster, read_postmaster_pid};
use crate::schema_sql::{MIGRATIONS_TABLE_SQL, migration_batch, product_migrations};
use crate::sql_compat::quote_ident;
use crate::supervisor::{ClusterStart, SupervisorProcess, find_pg_ctl, spawn_supervisor};

pub const ATTACH_BACKUP_ERROR: &str = "stop the node or run backup from it";
pub const EMBEDDED_NOT_CONFIGURED: &str =
    "memory.postgres.embedded is not configured — run rivetos local init";
pub const SETUP_TIMEOUT: Duration = Duration::from_secs(600);
pub const BACKUP_TIMEOUT: Duration = Duration::from_secs(600);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const PGVECTOR_NAMESPACE: &str = "portal-corp";
const PGVECTOR_NAME: &str = "pgvector_compiled";
const POSTGRES_VERSION_REQ: &str = "=16.10.0";
const POSTGRES_VERSION: &str = "16.10.0";
const THESEUS_RELEASES: &str = "https://github.com/theseus-rs/postgresql-binaries";
const INSTALL_LOCK: &str = ".install.lock";

struct OwnedServer {
    supervisor: SupervisorProcess,
    pg_ctl: PathBuf,
    pgdata: PathBuf,
    settings: postgresql_embedded::Settings,
}

pub struct EmbeddedPg {
    resolved: ResolvedEmbeddedPg,
    pg_url: String,
    owned: bool,
    lock_path: Option<PathBuf>,
    owned_server: Option<OwnedServer>,
    closed: bool,
}

struct ConfigureFailure {
    error: LocalDbError,
    wipe_pgdata: bool,
}

impl EmbeddedPg {
    pub fn pg_url(&self) -> &str {
        &self.pg_url
    }

    pub fn owned(&self) -> bool {
        self.owned
    }

    pub fn auto_migrate(&self) -> bool {
        self.resolved.auto_migrate
    }

    pub fn lite_mode(&self) -> bool {
        self.resolved.lite_mode
    }

    pub fn env(&self) -> EmbeddedPgEnv {
        embedded_pg_env(&self.pg_url)
    }

    pub fn engine_data_dir(&self) -> &Path {
        &self.resolved.engine_data_dir
    }

    pub async fn close(&mut self) -> Result<()> {
        if self.closed {
            return Ok(());
        }
        self.stop_owned().await?;
        let released = self.release_lock().await;
        self.closed = true;
        released
    }

    pub async fn backup(&self, out: &Path) -> Result<()> {
        let owned = self
            .owned_server
            .as_ref()
            .ok_or_else(|| LocalDbError::message(ATTACH_BACKUP_ERROR))?;
        if !self.owned {
            return Err(LocalDbError::message(ATTACH_BACKUP_ERROR));
        }
        dump_database(&owned.settings, out).await
    }

    pub async fn backup_default(&self, home: &Path) -> Result<PathBuf> {
        let out = default_backup_path(home, &backup_stamp(chrono::Utc::now()));
        self.backup(&out).await?;
        Ok(out)
    }

    async fn stop_owned(&mut self) -> Result<()> {
        let Some(mut owned) = self.owned_server.take() else {
            return Ok(());
        };
        let stopped = owned
            .supervisor
            .shutdown(&owned.pg_ctl, &owned.pgdata)
            .await;
        if stopped.is_err() {
            self.owned_server = Some(owned);
        }
        stopped
    }

    async fn release_lock(&mut self) -> Result<()> {
        if let Some(path) = self.lock_path.take() {
            release_owner_lock(&path).await
        } else {
            Ok(())
        }
    }
}

impl Drop for EmbeddedPg {
    fn drop(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        if let Some(mut owned) = self.owned_server.take() {
            owned.supervisor.lifeline.take();
        }
    }
}

pub async fn acquire_embedded_pg(
    resolved: ResolvedEmbeddedPg,
    log: &dyn EmbeddedPgLog,
) -> Result<EmbeddedPg> {
    let env = boot_env_for_export(&protocol::host::ProcessEnv);
    acquire_embedded_pg_with(resolved, log, None, &env).await
}

fn boot_env_for_export(boot: &dyn Env) -> MapEnv {
    let mut env = MapEnv::new();
    if let Some(root) = boot.var("RIVETOS_ROOT").filter(|value| !value.is_empty()) {
        env.set("RIVETOS_ROOT", root);
    }
    env
}

pub async fn acquire_embedded_pg_with(
    resolved: ResolvedEmbeddedPg,
    log: &dyn EmbeddedPgLog,
    port_hold: Option<std::net::TcpListener>,
    env: &dyn Env,
) -> Result<EmbeddedPg> {
    let port = require_listen_port(&resolved)?;
    let max = require_max_connections(&resolved)?;
    let pgdata = pgdata_dir(&resolved.engine_data_dir);
    let pending = pending_marker(&resolved.engine_data_dir);
    let already = source_is_migrated(&resolved.home, &resolved.data_dir)?;
    if matches!(
        plan_migration(&resolved.data_dir, &pgdata, &pending, already),
        MigrationPlan::PendingSourceMissing
    ) {
        return Err(pending_source_missing(&pending, &resolved.data_dir));
    }
    let claim = claim_owner_lock(
        &resolved.engine_data_dir,
        port,
        log,
        crate::lock::attach_timeout(),
    )
    .await?;
    match claim {
        LockClaim::Attached { pid, port, pg_url } => {
            drop(port_hold);
            log.info(&format!(
                "embedded postgres: attached to owner pid {pid} at 127.0.0.1:{port}"
            ));
            Ok(EmbeddedPg {
                resolved,
                pg_url,
                owned: false,
                lock_path: None,
                owned_server: None,
                closed: false,
            })
        }
        LockClaim::Owned { lock_path } => {
            let booted =
                boot_owned(resolved, port, max, lock_path.clone(), port_hold, env, log).await;
            if let Err(error) = &booted {
                tracing::error!(
                    "embedded postgres: boot failed: {}",
                    scrub_secret(&error.to_string())
                );
                let _ = release_owner_lock(&lock_path).await;
            }
            booted
        }
    }
}

pub async fn with_embedded_pg<T, F, Fut>(
    config: &mut Value,
    home: &Path,
    env: &dyn Env,
    log: &dyn EmbeddedPgLog,
    body: F,
) -> Result<T>
where
    F: FnOnce(&mut EmbeddedPg, &EmbeddedPgEnv) -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let Some(resolved) = resolve_embedded_pg_from_env(config, home, env) else {
        return Err(LocalDbError::message(
            "withEmbeddedPg: memory.postgres.embedded is not configured",
        ));
    };
    let mut handle = acquire_embedded_pg_with(resolved, log, None, env).await?;
    let applied = match apply_embedded_pg_url(config, handle.pg_url()) {
        Ok(applied) => applied,
        Err(error) => {
            let _ = handle.close().await;
            return Err(error);
        }
    };
    let result = body(&mut handle, &applied).await;
    let closed = handle.close().await;
    match (result, closed) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

pub async fn reset_engine(home: &Path, target: &Path) -> Result<()> {
    reset_engine_with(home, target, None).await
}

pub async fn reset_engine_with(home: &Path, target: &Path, config: Option<&Value>) -> Result<()> {
    let lexical = lexical_absolute(target);
    let (cluster, sources) = if is_cluster_name(&lexical) {
        let resolved = assert_under_rivet(home, target)?;
        (resolved, sources_for_cluster(home, &lexical, config))
    } else {
        assert_under_rivet(home, target)?;
        let cluster_lexical = cluster_dir_for(&lexical);
        let resolved = assert_under_rivet(home, &cluster_lexical)?;
        let mut sources = vec![lexical];
        for extra in sources_for_cluster(home, &cluster_lexical, config) {
            push_source(&mut sources, extra);
        }
        (resolved, sources)
    };
    refuse_if_running(&cluster)?;
    record_migrated_sources(home, &sources).await?;
    clear_dir(&cluster).await?;
    for source in &sources {
        clear_store_work(home, source).await?;
    }
    Ok(())
}

pub fn assert_under_rivet(home: &Path, target: &Path) -> Result<PathBuf> {
    let base = real_of_nearest(&rivet_dir(home));
    let resolved = resolve_reset_target(&lexical_absolute(target));
    if resolved != base && !resolved.starts_with(&base) {
        return Err(LocalDbError::message(format!(
            "reset refuses to delete {} (outside ~/.rivetos)",
            target.display()
        )));
    }
    Ok(resolved)
}

pub fn backup_stamp(time: chrono::DateTime<chrono::Utc>) -> String {
    let ms = time.timestamp_millis() as f64;
    let iso = match protocol::js::to_iso_string(ms) {
        Ok(iso) => iso,
        Err(_) => return String::new(),
    };
    let replaced = match protocol::js::js_replace(
        &protocol::js::JsString::from_text(&iso),
        "[:.]",
        "g",
        "-",
    ) {
        Ok(value) => value,
        Err(_) => return iso,
    };
    protocol::js::js_slice(replaced.to_utf8(), Some(0.0), Some(19.0))
        .to_utf8()
        .to_string()
}

pub fn default_backup_path(home: &Path, stamp: &str) -> PathBuf {
    backups_dir(home).join(format!("postgres-{stamp}.sql"))
}

pub fn backup_wrote_line(path: &Path) -> String {
    format!("✅ backup wrote {}", path.display())
}

fn superuser_reserved(max: u32) -> u32 {
    max.saturating_sub(1).min(3)
}

fn server_configuration(resolved: &ResolvedEmbeddedPg, max: u32) -> BTreeMap<String, String> {
    let mut configuration = BTreeMap::new();
    configuration.insert("listen_addresses".to_string(), "127.0.0.1".to_string());
    configuration.insert("max_connections".to_string(), max.to_string());
    configuration.insert(
        "superuser_reserved_connections".to_string(),
        superuser_reserved(max).to_string(),
    );
    configuration.insert("reserved_connections".to_string(), "0".to_string());
    #[cfg(unix)]
    {
        configuration.insert(
            "unix_socket_directories".to_string(),
            resolved.engine_data_dir.to_string_lossy().to_string(),
        );
    }
    #[cfg(not(unix))]
    {
        let _ = resolved;
    }
    configuration
}

async fn boot_owned(
    resolved: ResolvedEmbeddedPg,
    port: u16,
    max: u32,
    lock_path: PathBuf,
    port_hold: Option<std::net::TcpListener>,
    env: &dyn Env,
    log: &dyn EmbeddedPgLog,
) -> Result<EmbeddedPg> {
    let started = std::time::Instant::now();
    let export = match prepare_migration(&resolved, port, env, log).await {
        Ok(export) => export,
        Err(error) => {
            let _ = release_owner_lock(&lock_path).await;
            return Err(error);
        }
    };
    let owned = match start_server(&resolved, port, max, port_hold, env, log).await {
        Ok(owned) => owned,
        Err(error) => {
            let _ = release_owner_lock(&lock_path).await;
            return Err(error);
        }
    };
    let url = embedded_pg_url(i64::from(port));
    if let Err(failure) = configure_started(&url, &resolved, export.as_deref(), env, log).await {
        abandon(owned, failure.wipe_pgdata, &lock_path).await;
        return Err(failure.error);
    }
    if resolved.auto_migrate {
        log.info(
            "embedded postgres: auto_migrate is set; schema migration is left to the memory store",
        );
    }
    let elapsed = started.elapsed().as_millis();
    log.info(&format!("embedded postgres ready in {elapsed}ms"));
    Ok(EmbeddedPg {
        resolved,
        pg_url: url,
        owned: true,
        lock_path: Some(lock_path),
        owned_server: Some(owned),
        closed: false,
    })
}

async fn prepare_migration(
    resolved: &ResolvedEmbeddedPg,
    port: u16,
    env: &dyn Env,
    log: &dyn EmbeddedPgLog,
) -> Result<Option<PathBuf>> {
    let pgdata = pgdata_dir(&resolved.engine_data_dir);
    let pending = pending_marker(&resolved.engine_data_dir);
    let already = source_is_migrated(&resolved.home, &resolved.data_dir)?;
    let plan = plan_migration(&resolved.data_dir, &pgdata, &pending, already);
    match plan {
        MigrationPlan::PendingSourceMissing => {
            Err(pending_source_missing(&pending, &resolved.data_dir))
        }
        MigrationPlan::Skip(SkipReason::AlreadyMigrated) => {
            remove_file_if(&pending).await?;
            Ok(None)
        }
        MigrationPlan::Migrate | MigrationPlan::Retry => {
            export_for_plan(resolved, &pgdata, &pending, port, env, log, plan).await
        }
        MigrationPlan::Skip(_) => Ok(None),
    }
}

async fn export_for_plan(
    resolved: &ResolvedEmbeddedPg,
    pgdata: &Path,
    pending: &Path,
    port: u16,
    env: &dyn Env,
    log: &dyn EmbeddedPgLog,
    plan: MigrationPlan,
) -> Result<Option<PathBuf>> {
    if matches!(plan, MigrationPlan::Retry) {
        log.info("embedded postgres: retrying an incomplete PGlite migration");
        stop_and_remove_pgdata(pgdata, &resolved.installation_dir, log).await?;
    }
    log.info(&format!(
        "embedded postgres: migrating PGlite data from {} to {}",
        resolved.data_dir.display(),
        pgdata.display()
    ));
    let root = env.var("RIVETOS_ROOT");
    let exported = export_pglite_source(
        &resolved.home,
        &resolved.data_dir,
        port,
        root.as_deref(),
        log,
    )
    .await?;
    write_pending(pending).await?;
    Ok(Some(exported))
}

async fn start_server(
    resolved: &ResolvedEmbeddedPg,
    port: u16,
    max: u32,
    port_hold: Option<std::net::TcpListener>,
    env: &dyn Env,
    log: &dyn EmbeddedPgLog,
) -> Result<OwnedServer> {
    let pgdata = pgdata_dir(&resolved.engine_data_dir);
    let early = find_pg_ctl(&resolved.installation_dir);
    clear_stale_postmaster(&pgdata, early.as_deref(), log).await?;
    remove_incomplete(&pgdata, log).await?;
    let guard = prepare_shared_install(&resolved.installation_dir, log).await?;
    let settings = engine_settings(resolved, port, max, env).await?;
    write_password_file(&settings.password_file, &settings.password).await?;
    ensure_crypto_provider();
    let mut server = postgresql_embedded::PostgreSQL::new(settings);
    setup_cluster(&mut server, &pgdata, log).await?;
    install_pgvector(server.settings()).await?;
    drop(guard);
    let backup_settings = server.settings().clone();
    let pg_ctl = match find_pg_ctl(&backup_settings.installation_dir) {
        Some(path) => path,
        None => {
            return Err(LocalDbError::message(format!(
                "embedded postgres: pg_ctl not found under {}",
                backup_settings.installation_dir.display()
            )));
        }
    };
    clear_stale_postmaster(&pgdata, Some(&pg_ctl), log).await?;
    drop(server);
    launch_supervisor(
        backup_settings,
        pg_ctl,
        pgdata,
        port,
        max,
        resolved,
        port_hold,
    )
    .await
}

async fn launch_supervisor(
    settings: postgresql_embedded::Settings,
    pg_ctl: PathBuf,
    pgdata: PathBuf,
    port: u16,
    max: u32,
    resolved: &ResolvedEmbeddedPg,
    port_hold: Option<std::net::TcpListener>,
) -> Result<OwnedServer> {
    let configuration = server_configuration(resolved, max);
    drop(port_hold);
    let supervisor = spawn_supervisor(&ClusterStart {
        pg_ctl: pg_ctl.clone(),
        pgdata: pgdata.clone(),
        port,
        timeout: COMMAND_TIMEOUT,
        configuration,
    })
    .await?;
    Ok(OwnedServer {
        supervisor,
        pg_ctl,
        pgdata,
        settings,
    })
}

async fn setup_cluster(
    server: &mut postgresql_embedded::PostgreSQL,
    pgdata: &Path,
    log: &dyn EmbeddedPgLog,
) -> Result<()> {
    let install_dir = server.settings().installation_dir.clone();
    let releases = server.settings().releases_url.clone();
    let setup = with_timeout(SETUP_TIMEOUT, async {
        server.setup().await.map_err(engine_error)
    })
    .await;
    if let Err(error) = setup {
        if pgdata.exists() && !cluster_complete(pgdata) {
            log.info(&format!(
                "embedded postgres: removing incomplete cluster at {}",
                pgdata.display()
            ));
            let _ = clear_dir(pgdata).await;
        }
        if offline_without_binaries(&install_dir, &releases) {
            return Err(binaries_offline_error(&install_dir, &error.to_string()));
        }
        return Err(error);
    }
    Ok(())
}

async fn configure_started(
    url: &str,
    resolved: &ResolvedEmbeddedPg,
    export_path: Option<&Path>,
    env: &dyn Env,
    log: &dyn EmbeddedPgLog,
) -> std::result::Result<(), ConfigureFailure> {
    let mut client = match PgClient::connect(url).await {
        Ok(client) => client,
        Err(error) => return Err(configure_failure(error, export_path.is_some())),
    };
    if let Err(error) = prepare_database(&mut client, resolved.lite_mode).await {
        return Err(configure_failure(error, export_path.is_some()));
    }
    if let Some(path) = export_path {
        finish_migration(&mut client, resolved, path, url, env, log).await?;
    }
    Ok(())
}

async fn prepare_database(client: &mut PgClient, lite: bool) -> Result<()> {
    client
        .batch(
            "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;",
            COMMAND_TIMEOUT,
        )
        .await?;
    ensure_halfvec(client).await?;
    apply_guc(client, lite).await
}

async fn finish_migration(
    client: &mut PgClient,
    resolved: &ResolvedEmbeddedPg,
    export_path: &Path,
    url: &str,
    env: &dyn Env,
    log: &dyn EmbeddedPgLog,
) -> std::result::Result<(), ConfigureFailure> {
    if let Err(error) = apply_product_schema(client).await {
        return Err(configure_failure(error, true));
    }
    let jobs = match apply_export(client, export_path, &resolved.data_dir, log).await {
        Ok(jobs) => jobs,
        Err(error) => return Err(configure_failure(error, true)),
    };
    let root = env.var("RIVETOS_ROOT");
    if let Err(error) = install_graphile_schema(
        &resolved.home,
        &resolved.data_dir,
        root.as_deref(),
        url,
        log,
    )
    .await
    {
        return Err(configure_failure(error, true));
    }
    if let Err(error) = restore_worker_backlog(client, &jobs, wiki_extraction_enabled(env)).await {
        return Err(configure_failure(error, true));
    }
    if let Err(error) =
        record_migrated_sources(&resolved.home, std::slice::from_ref(&resolved.data_dir)).await
    {
        let pending = pending_marker(&resolved.engine_data_dir);
        let _ = remove_file_if(&pending).await;
        return Err(configure_failure(error, false));
    }
    let pending = pending_marker(&resolved.engine_data_dir);
    if let Err(error) = remove_file_if(&pending).await {
        return Err(configure_failure(error, false));
    }
    Ok(())
}

fn wiki_extraction_enabled(env: &dyn Env) -> bool {
    env.var("WIKI_EXTRACTION").as_deref() == Some("1")
}

const ADD_JOB_SQL: &str = "SELECT graphile_worker.add_job(\
     $1::text, \
     $2::text::json, \
     $3::text, \
     CASE WHEN $4::text IS NULL THEN NULL::timestamptz ELSE $4::text::timestamptz END, \
     CASE WHEN $5::text IS NULL THEN NULL::integer ELSE $5::text::integer END, \
     $6::text, \
     CASE WHEN $7::text IS NULL THEN NULL::integer ELSE $7::text::integer END, \
     CASE WHEN $8::text IS NULL THEN NULL::text[] \
          ELSE ARRAY(SELECT item FROM json_array_elements_text($8::text::json) AS item) END, \
     $9::text)";

const NULL_EMBED_ERROR: &str = "Embedding returned null";
const EMBED_SWEEP_LIMIT: i64 = 200;
const EMBED_MAX_ATTEMPTS: i64 = 5;
const COMPACT_MAX_ATTEMPTS: i64 = 3;
const WIKI_MAX_ATTEMPTS: i64 = 2;
const WIKI_PRIORITY: i64 = 10;
const WIKI_PIPELINE_VERSION: i64 = 4;

struct EmbedSweep {
    table: &'static str,
    id_column: &'static str,
    predicate: &'static str,
}

const EMBED_SWEEPS: &[EmbedSweep] = &[
    EmbedSweep {
        table: "ros_messages",
        id_column: "id",
        predicate: "(content IS NOT NULL AND LENGTH(content) > 20) OR (tool_result IS NOT NULL AND LENGTH(tool_result) > 20)",
    },
    EmbedSweep {
        table: "ros_summaries",
        id_column: "id",
        predicate: "content IS NOT NULL AND LENGTH(content) > 20",
    },
    EmbedSweep {
        table: "ros_wiki_topics",
        id_column: "slug",
        predicate: "search_text IS NOT NULL AND LENGTH(search_text) > 20",
    },
];

const CHUNK_SELECT_SQL: &str = "SELECT id::text FROM public.ros_message_chunks \
     WHERE embedding IS NULL AND embed_status IS NULL \
       AND content IS NOT NULL AND LENGTH(btrim(content)) > 0 \
     ORDER BY created_at DESC LIMIT 200";

const COMPACT_SELECT_SQL: &str = "SELECT c.id::text AS conversation_id, \
            CASE WHEN COUNT(m.id) >= 5 THEN 'session_idle' ELSE 'session_stale' END AS trigger \
       FROM public.ros_conversations c \
       JOIN public.ros_messages m ON m.conversation_id = c.id \
       LEFT JOIN public.ros_summary_sources ss ON ss.message_id = m.id \
      WHERE ss.summary_id IS NULL \
        AND ((m.content IS NOT NULL AND LENGTH(m.content) > 10) OR m.tool_name IS NOT NULL) \
        AND (c.session_key IS NULL OR c.session_key NOT LIKE 'heartbeat:%') \
      GROUP BY c.id \
     HAVING (COUNT(m.id) >= 5 AND (COUNT(m.id) >= 10 OR c.updated_at < NOW() - (15 || ' minutes')::interval)) \
         OR (COUNT(m.id) >= 2 AND c.updated_at < NOW() - (5760 || ' minutes')::interval) \
      ORDER BY c.updated_at ASC \
      LIMIT 10";

fn wiki_select_sql() -> String {
    format!(
        "SELECT s.id::text AS id, s.conversation_id::text AS conversation_id \
         FROM public.ros_summaries s \
         LEFT JOIN public.ros_wiki_extractions e ON e.summary_id = s.id \
         LEFT JOIN public.ros_conversations c ON c.id = s.conversation_id \
         WHERE s.kind = 'leaf' \
           AND (c.session_key IS NULL OR c.session_key NOT LIKE 'heartbeat:%') \
           AND (e.summary_id IS NULL \
                OR (e.status = 'failed' AND e.extracted_at < now() - interval '24 hours') \
                OR (e.status = 'done' AND e.pipeline_version < {WIKI_PIPELINE_VERSION})) \
         ORDER BY CASE WHEN e.summary_id IS NULL THEN 0 WHEN e.status = 'failed' THEN 1 ELSE 2 END, \
                  s.created_at ASC \
         LIMIT 25"
    )
}

fn embed_heal_sql(table: &str, predicate: &str) -> String {
    format!(
        "UPDATE public.{table} SET embed_status = NULL, embed_error = NULL, embed_failures = 0 \
         WHERE embedding IS NULL AND embed_status = 'failed' AND embed_error = $1::text AND ({predicate})",
        table = quote_ident(table),
    )
}

fn embed_select_sql(table: &str, id_column: &str, predicate: &str) -> String {
    format!(
        "SELECT {id}::text FROM public.{table} \
         WHERE embedding IS NULL AND embed_status IS NULL AND ({predicate}) \
         ORDER BY created_at DESC LIMIT {EMBED_SWEEP_LIMIT}",
        id = quote_ident(id_column),
        table = quote_ident(table),
    )
}

fn embed_job(table: &str, id: &str) -> CopiedJob {
    CopiedJob {
        identifier: "embed-target".to_string(),
        payload: serde_json::json!({
            "targetTable": table,
            "targetId": id,
        })
        .to_string(),
        job_key: Some(format!("embed-{table}-{id}")),
        max_attempts: Some(EMBED_MAX_ATTEMPTS),
        priority: None,
        queue_name: None,
        run_at: None,
        flags: None,
    }
}

async fn enqueue_copied(client: &mut PgClient, job: &CopiedJob) -> Result<()> {
    client
        .exec(
            ADD_JOB_SQL,
            &[
                Some(job.identifier.clone()),
                Some(job.payload.clone()),
                job.queue_name.clone(),
                job.run_at.clone(),
                job.max_attempts.map(|value| value.to_string()),
                job.job_key.clone(),
                job.priority.map(|value| value.to_string()),
                job.flags.clone(),
                Some("preserve_run_at".to_string()),
            ],
            SETUP_TIMEOUT,
        )
        .await
}

async fn rederive_embeddings(client: &mut PgClient) -> Result<()> {
    for sweep in EMBED_SWEEPS {
        client
            .exec(
                &embed_heal_sql(sweep.table, sweep.predicate),
                &[Some(NULL_EMBED_ERROR.to_string())],
                SETUP_TIMEOUT,
            )
            .await?;
        let rows = client
            .query_optional_columns(
                &embed_select_sql(sweep.table, sweep.id_column, sweep.predicate),
                &[],
                1,
            )
            .await?;
        for row in rows {
            let Some(id) = row.first().cloned().flatten() else {
                return Err(LocalDbError::message(format!(
                    "embedded postgres: embed sweep for {} returned a null id",
                    sweep.table
                )));
            };
            enqueue_copied(client, &embed_job(sweep.table, &id)).await?;
        }
    }
    if relation_exists(client, "public", "ros_message_chunks").await? {
        let rows = client
            .query_optional_columns(CHUNK_SELECT_SQL, &[], 1)
            .await?;
        for row in rows {
            let Some(id) = row.first().cloned().flatten() else {
                return Err(LocalDbError::message(
                    "embedded postgres: chunk sweep returned a null id",
                ));
            };
            enqueue_copied(client, &embed_job("ros_message_chunks", &id)).await?;
        }
    }
    Ok(())
}

async fn rederive_compaction(client: &mut PgClient) -> Result<()> {
    let rows = client
        .query_optional_columns(COMPACT_SELECT_SQL, &[], 2)
        .await?;
    for row in rows {
        let conversation_id = row.first().cloned().flatten().ok_or_else(|| {
            LocalDbError::message(
                "embedded postgres: compaction sweep returned a null conversation",
            )
        })?;
        let trigger = row.get(1).cloned().flatten().ok_or_else(|| {
            LocalDbError::message("embedded postgres: compaction sweep returned a null trigger")
        })?;
        if trigger != "session_idle" && trigger != "session_stale" {
            return Err(LocalDbError::message(format!(
                "embedded postgres: compaction sweep returned trigger {trigger}"
            )));
        }
        enqueue_copied(
            client,
            &CopiedJob {
                identifier: "compact-conversation".to_string(),
                payload: serde_json::json!({
                    "conversationId": conversation_id,
                    "triggerType": trigger,
                })
                .to_string(),
                job_key: Some(conversation_id),
                max_attempts: Some(COMPACT_MAX_ATTEMPTS),
                priority: None,
                queue_name: None,
                run_at: None,
                flags: None,
            },
        )
        .await?;
    }
    Ok(())
}

async fn rederive_wiki(client: &mut PgClient) -> Result<()> {
    let rows = client
        .query_optional_columns(&wiki_select_sql(), &[], 2)
        .await?;
    for row in rows {
        let summary_id = row.first().cloned().flatten().ok_or_else(|| {
            LocalDbError::message("embedded postgres: wiki sweep returned a null summary")
        })?;
        let conversation_id = row.get(1).cloned().flatten();
        let payload = match &conversation_id {
            Some(conversation_id) => serde_json::json!({
                "summaryId": summary_id,
                "conversationId": conversation_id,
            })
            .to_string(),
            None => serde_json::json!({
                "summaryId": summary_id,
            })
            .to_string(),
        };
        enqueue_copied(
            client,
            &CopiedJob {
                identifier: "extract-wiki".to_string(),
                payload,
                job_key: Some(format!("wiki-ext-{summary_id}")),
                max_attempts: Some(WIKI_MAX_ATTEMPTS),
                priority: Some(WIKI_PRIORITY),
                queue_name: None,
                run_at: None,
                flags: None,
            },
        )
        .await?;
    }
    Ok(())
}

async fn restore_worker_backlog(
    client: &mut PgClient,
    jobs: &[CopiedJob],
    wiki_extraction: bool,
) -> Result<()> {
    rederive_embeddings(client).await?;
    rederive_compaction(client).await?;
    if wiki_extraction {
        rederive_wiki(client).await?;
    }
    for job in jobs {
        if keep_copied_job(&job.identifier, wiki_extraction) {
            enqueue_copied(client, job).await?;
        }
    }
    Ok(())
}

fn configure_failure(error: LocalDbError, wipe_pgdata: bool) -> ConfigureFailure {
    ConfigureFailure { error, wipe_pgdata }
}

async fn abandon(mut owned: OwnedServer, wipe: bool, lock_path: &Path) {
    let _ = owned
        .supervisor
        .shutdown(&owned.pg_ctl, &owned.pgdata)
        .await;
    if wipe {
        let _ = clear_dir(&owned.pgdata).await;
    }
    let _ = release_owner_lock(lock_path).await;
}

async fn engine_settings(
    resolved: &ResolvedEmbeddedPg,
    port: u16,
    max: u32,
    env: &dyn Env,
) -> Result<postgresql_embedded::Settings> {
    let defaults = postgresql_embedded::Settings::new();
    let leaked_data = defaults.data_dir.clone();
    let leaked_pass = defaults.password_file.parent().map(Path::to_path_buf);
    let default_releases = defaults.releases_url.clone();
    discard_leaked(&leaked_data).await;
    if let Some(dir) = leaked_pass {
        discard_leaked(&dir).await;
    }
    let version =
        postgresql_embedded::VersionReq::parse(POSTGRES_VERSION_REQ).map_err(|error| {
            LocalDbError::message(format!("embedded postgres: postgres version: {error}"))
        })?;
    let releases_url = match env.var("RIVETOS_PG_RELEASES_URL") {
        Some(value) if !value.is_empty() => value,
        _ => default_releases,
    };
    if offline_without_binaries(&resolved.installation_dir, &releases_url) {
        return Err(binaries_offline_error(
            &resolved.installation_dir,
            "releases URL is not the theseus PostgreSQL archive",
        ));
    }
    let configuration: HashMap<String, String> =
        server_configuration(resolved, max).into_iter().collect();
    Ok(postgresql_embedded::Settings {
        releases_url,
        version,
        installation_dir: resolved.installation_dir.clone(),
        password_file: resolved.engine_data_dir.join(".pgpass"),
        data_dir: pgdata_dir(&resolved.engine_data_dir),
        host: "127.0.0.1".to_string(),
        port,
        username: "postgres".to_string(),
        password: "postgres".to_string(),
        temporary: false,
        timeout: Some(COMMAND_TIMEOUT),
        configuration,
        trust_installation_dir: false,
        socket_dir: None,
    })
}

fn pinned_version_dir(installation_dir: &Path) -> PathBuf {
    if installation_dir.file_name().and_then(|name| name.to_str()) == Some(POSTGRES_VERSION) {
        installation_dir.to_path_buf()
    } else {
        installation_dir.join(POSTGRES_VERSION)
    }
}

fn postgres_binaries_present(installation_dir: &Path) -> bool {
    find_pg_ctl(&pinned_version_dir(installation_dir)).is_some()
}

fn offline_without_binaries(installation_dir: &Path, releases_url: &str) -> bool {
    !postgres_binaries_present(installation_dir) && !theseus_releases(releases_url)
}

fn binary_install_required(installation_dir: &Path) -> bool {
    !postgres_binaries_present(installation_dir) || !pgvector_recorded(installation_dir)
}

fn pgvector_recorded(installation_dir: &Path) -> bool {
    let root = pinned_version_dir(installation_dir);
    marker_lists_pgvector(&root.join("share").join("postgresql_extensions.json"))
        || marker_lists_pgvector(
            &root
                .join("share")
                .join("postgresql")
                .join("postgresql_extensions.json"),
        )
}

fn marker_lists_pgvector(path: &Path) -> bool {
    protocol::host::read_text(path)
        .ok()
        .is_some_and(|text| text.contains("pgvector_compiled"))
}

async fn remove_incomplete_install(installation_dir: &Path, log: &dyn EmbeddedPgLog) -> Result<()> {
    let dir = pinned_version_dir(installation_dir);
    if !dir.is_dir() || find_pg_ctl(&dir).is_some() {
        return Ok(());
    }
    log.info(&format!(
        "embedded postgres: removing incomplete PostgreSQL {POSTGRES_VERSION} install at {}",
        dir.display()
    ));
    clear_dir(&dir).await
}

fn theseus_releases(url: &str) -> bool {
    url.starts_with(THESEUS_RELEASES)
}

fn binaries_offline_error(installation_dir: &Path, detail: &str) -> LocalDbError {
    let dir = pinned_version_dir(installation_dir);
    LocalDbError::message(format!(
        "embedded postgres: PostgreSQL {POSTGRES_VERSION} binaries are not installed under {} and were not downloaded because the network path is unavailable ({detail}). Retry while online, or place bin/pg_ctl in that directory; later boots stay offline and do not query the network.",
        dir.display()
    ))
}

async fn prepare_shared_install(
    installation_dir: &Path,
    log: &dyn EmbeddedPgLog,
) -> Result<Option<FileLock>> {
    if !binary_install_required(installation_dir) {
        return Ok(None);
    }
    let guard = acquire_install_lock(installation_dir).await?;
    remove_incomplete_install(installation_dir, log).await?;
    if !binary_install_required(installation_dir) {
        return Ok(None);
    }
    Ok(Some(guard))
}

async fn acquire_install_lock(installation_dir: &Path) -> Result<FileLock> {
    let path = installation_dir.join(INSTALL_LOCK);
    FileLock::acquire(
        &path,
        SETUP_TIMEOUT,
        format!(
            "embedded postgres: timed out waiting for the PostgreSQL binary install lock {}",
            path.display()
        ),
    )
    .await
}

async fn install_pgvector(settings: &postgresql_embedded::Settings) -> Result<()> {
    let installed = with_timeout(SETUP_TIMEOUT, async {
        postgresql_extensions::get_installed_extensions(settings)
            .await
            .map_err(extension_error)
    })
    .await?;
    let present = installed.iter().any(|extension| {
        extension.namespace() == PGVECTOR_NAMESPACE && extension.name() == PGVECTOR_NAME
    });
    if present {
        return Ok(());
    }
    let version = postgresql_extensions::VersionReq::STAR;
    with_timeout(SETUP_TIMEOUT, async {
        postgresql_extensions::install(settings, PGVECTOR_NAMESPACE, PGVECTOR_NAME, &version)
            .await
            .map_err(|error| pgvector_install_error(&error))
    })
    .await
}

fn pgvector_install_error(error: &postgresql_extensions::Error) -> LocalDbError {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    LocalDbError::message(format!(
        "embedded postgres: pgvector install failed on {os} {arch} (postgresql_extensions portal-corp pgvector_compiled matches a .zip whose name contains pg{{major}} and the target triple, or the os and arch; macos also matches darwin and aarch64 also matches arm64; the crate lifecycle test is disabled on linux aarch64 and macos x86_64, and every other platform returns this install error when no zip matches): {error}"
    ))
}

async fn ensure_halfvec(client: &mut PgClient) -> Result<()> {
    let version = client
        .query_text("SELECT extversion FROM pg_extension WHERE extname = 'vector'")
        .await?;
    let Some(version) = version else {
        return Err(LocalDbError::message(
            "embedded postgres: pgvector extension is not installed",
        ));
    };
    if !pgvector_supports_halfvec(&version) {
        return Err(LocalDbError::message(format!(
            "embedded postgres: pgvector {version} does not provide halfvec (need >= 0.7)"
        )));
    }
    let found = client
        .query_text("SELECT typname FROM pg_type WHERE typname = 'halfvec'")
        .await?;
    if found.as_deref() != Some("halfvec") {
        return Err(LocalDbError::message(
            "embedded postgres: pgvector did not create the halfvec type",
        ));
    }
    Ok(())
}

fn pgvector_supports_halfvec(version: &str) -> bool {
    let mut parts = version.split(['.', '-']);
    let major = parts.next().and_then(|part| part.parse::<u64>().ok());
    let minor = parts.next().and_then(|part| part.parse::<u64>().ok());
    match (major, minor) {
        (Some(0), Some(minor)) => minor >= 7,
        (Some(major), _) => major > 0,
        _ => false,
    }
}

async fn apply_guc(client: &mut PgClient, lite: bool) -> Result<()> {
    if lite {
        client
            .batch(
                "ALTER DATABASE postgres SET rivet.defer_embed_enqueue = 'on'; ALTER ROLE postgres SET rivet.defer_embed_enqueue = 'on'; SET rivet.defer_embed_enqueue = 'on';",
                COMMAND_TIMEOUT,
            )
            .await
    } else {
        match client
            .batch(
                "ALTER DATABASE postgres RESET rivet.defer_embed_enqueue; ALTER ROLE postgres RESET rivet.defer_embed_enqueue; RESET rivet.defer_embed_enqueue;",
                COMMAND_TIMEOUT,
            )
            .await
        {
            Ok(()) => Ok(()),
            Err(error) if error.to_string().contains("unrecognized configuration parameter") => {
                Ok(())
            }
            Err(error) => Err(error),
        }
    }
}

async fn apply_product_schema(client: &mut PgClient) -> Result<()> {
    client
        .batch("SET lock_timeout = '3s'", COMMAND_TIMEOUT)
        .await?;
    let applied = apply_product_migrations(client).await;
    let reset = client.batch("RESET lock_timeout", COMMAND_TIMEOUT).await;
    applied?;
    reset
}

async fn apply_product_migrations(client: &mut PgClient) -> Result<()> {
    let exists = client
        .query_one_text(
            "SELECT CASE WHEN to_regclass('_rivetos_migrations') IS NULL THEN 'f' ELSE 't' END",
            &[],
        )
        .await?;
    if exists.as_deref() != Some("t") {
        client.batch(MIGRATIONS_TABLE_SQL, COMMAND_TIMEOUT).await?;
    }
    for migration in product_migrations() {
        let seen = client
            .query_one_text(
                "SELECT CASE WHEN EXISTS (SELECT 1 FROM _rivetos_migrations WHERE name = $1::text) THEN 't' ELSE 'f' END",
                &[Some(migration.name.to_string())],
            )
            .await?;
        if seen.as_deref() == Some("t") {
            continue;
        }
        let batch = migration_batch(migration.name, migration.sql);
        client.batch(&batch, SETUP_TIMEOUT).await?;
    }
    Ok(())
}

struct CopyState {
    verified: u64,
    saw_done: bool,
    triggers: Option<(String, String)>,
    defer: Option<TableDefer>,
    jobs: Vec<CopiedJob>,
}

struct TableDefer {
    schema: String,
    table: String,
    keys: Vec<TypedName>,
    links: Vec<TypedName>,
    updates: Vec<BoundInsert>,
    restore: Vec<String>,
}

struct SelfConstraint {
    name: String,
    columns: Vec<TypedName>,
    not_null: bool,
}

async fn apply_export(
    client: &mut PgClient,
    path: &Path,
    source: &Path,
    log: &dyn EmbeddedPgLog,
) -> Result<Vec<CopiedJob>> {
    log.info(&format!(
        "embedded postgres: restoring PGlite rows from {}",
        path.display()
    ));
    let file = tokio::fs::File::open(path).await?;
    let reader = tokio::io::BufReader::new(file);
    let mut lines = reader.lines();
    let mut state = CopyState {
        verified: 0,
        saw_done: false,
        triggers: None,
        defer: None,
        jobs: Vec::new(),
    };
    while let Some(line) = lines.next_line().await? {
        let Some(action) = parse_export_line(&line)? else {
            continue;
        };
        match apply_action(client, action, &mut state).await {
            Ok(true) => break,
            Ok(false) => {}
            Err(error) => {
                let _ = client.batch("ROLLBACK", COMMAND_TIMEOUT).await;
                return Err(error);
            }
        }
    }
    if !state.saw_done {
        let _ = client.batch("ROLLBACK", COMMAND_TIMEOUT).await;
        return Err(LocalDbError::message(
            "embedded postgres: PGlite export ended before done",
        ));
    }
    log.info(&format!(
        "embedded postgres: verified {} tables",
        state.verified
    ));
    log.info(&format!(
        "embedded postgres: PGlite directory left in place at {}",
        source.display()
    ));
    Ok(state.jobs)
}

async fn apply_action(
    client: &mut PgClient,
    action: ExportAction,
    state: &mut CopyState,
) -> Result<bool> {
    match action {
        ExportAction::Exec(sql) => {
            if sql == "COMMIT" {
                flush_self_links(client, state).await?;
                if let Some((schema, table)) = state.triggers.take() {
                    client
                        .exec(
                            &trigger_change(&schema, &table, "ENABLE"),
                            &[],
                            SETUP_TIMEOUT,
                        )
                        .await?;
                }
            } else if sql != "BEGIN" {
                return Err(LocalDbError::message(format!(
                    "embedded postgres: PGlite export cannot execute {sql}"
                )));
            }
            client.exec(&sql, &[], SETUP_TIMEOUT).await?;
            Ok(false)
        }
        ExportAction::Ddl(sql) => {
            client.exec(&sql, &[], SETUP_TIMEOUT).await?;
            Ok(false)
        }
        ExportAction::Insert(batch) => {
            if !copy_this_table(&batch.table) {
                return Ok(false);
            }
            if !relation_exists(client, &batch.schema, &batch.table).await? {
                return Err(LocalDbError::message(missing_relation_message(
                    &batch.schema,
                    &batch.table,
                )));
            }
            let dest = dest_columns(client, &batch.schema, &batch.table).await?;
            ensure_self_links(client, state, &batch.schema, &batch.table, &batch.columns).await?;
            let link_names = self_link_names(state, &batch.schema, &batch.table);
            let rows = if link_names.is_empty() {
                batch.rows.clone()
            } else {
                let planned = plan_self_link_updates(
                    &batch.schema,
                    &batch.table,
                    &state
                        .defer
                        .as_ref()
                        .map(|defer| defer.keys.clone())
                        .unwrap_or_default(),
                    &state
                        .defer
                        .as_ref()
                        .map(|defer| defer.links.clone())
                        .unwrap_or_default(),
                    &batch.columns,
                    &batch.rows,
                )?;
                if let Some(defer) = state.defer.as_mut() {
                    defer.updates.extend(planned);
                }
                mask_self_link_columns(&batch.columns, &batch.rows, &link_names)?
            };
            let Some(bound) =
                plan_insert(&batch.schema, &batch.table, &batch.columns, &dest, &rows)?
            else {
                return Ok(false);
            };
            disable_user_triggers(client, state, &batch.schema, &batch.table).await?;
            client
                .exec(&bound.sql, &bound.params, SETUP_TIMEOUT)
                .await?;
            Ok(false)
        }
        ExportAction::Count {
            schema,
            table,
            expected,
        } => {
            if !copy_this_table(&table) {
                return Ok(false);
            }
            if !relation_exists(client, &schema, &table).await? {
                return Err(LocalDbError::message(missing_relation_message(
                    &schema, &table,
                )));
            }
            check_count(client, &schema, &table, expected).await?;
            state.verified += 1;
            Ok(false)
        }
        ExportAction::Setval {
            schema,
            name,
            last,
            called,
        } => {
            if !relation_exists(client, &schema, &name).await? {
                return Err(LocalDbError::message(missing_relation_message(
                    &schema, &name,
                )));
            }
            let called_text = if called { "true" } else { "false" };
            client
                .exec(
                    setval_statement(),
                    &[
                        Some(schema),
                        Some(name),
                        Some(last),
                        Some(called_text.to_string()),
                    ],
                    SETUP_TIMEOUT,
                )
                .await?;
            Ok(false)
        }
        ExportAction::Job(job) => {
            state.jobs.push(job);
            Ok(false)
        }
        ExportAction::Done => {
            state.saw_done = true;
            Ok(true)
        }
    }
}

fn trigger_change(schema: &str, table: &str, action: &str) -> String {
    format!(
        "ALTER TABLE {}.{} {action} TRIGGER USER",
        quote_ident(schema),
        quote_ident(table)
    )
}

fn self_link_names(state: &CopyState, schema: &str, table: &str) -> Vec<String> {
    state
        .defer
        .as_ref()
        .filter(|defer| defer.schema == schema && defer.table == table)
        .map(|defer| {
            defer
                .links
                .iter()
                .map(|column| column.name.clone())
                .collect()
        })
        .unwrap_or_default()
}

async fn ensure_self_links(
    client: &mut PgClient,
    state: &mut CopyState,
    schema: &str,
    table: &str,
    export_columns: &[String],
) -> Result<()> {
    if state
        .defer
        .as_ref()
        .is_some_and(|defer| defer.schema == schema && defer.table == table)
    {
        return Ok(());
    }
    flush_self_links(client, state).await?;
    let constraints = self_constraints(client, schema, table).await?;
    let keys = primary_key(client, schema, table).await?;
    let keys_ready = !keys.is_empty()
        && keys
            .iter()
            .all(|column| export_columns.iter().any(|name| name == &column.name));
    let mut links = Vec::new();
    let mut restore = Vec::new();
    for constraint in constraints {
        let present = constraint
            .columns
            .iter()
            .all(|column| export_columns.iter().any(|name| name == &column.name));
        if constraint.not_null || !keys_ready || !present {
            client
                .exec(
                    &constraint_deferral(schema, table, &constraint.name, true),
                    &[],
                    SETUP_TIMEOUT,
                )
                .await?;
            client
                .exec(
                    &constraint_timing(schema, &constraint.name, true),
                    &[],
                    SETUP_TIMEOUT,
                )
                .await?;
            restore.push(constraint.name);
        } else {
            links.extend(constraint.columns);
        }
    }
    state.defer = Some(TableDefer {
        schema: schema.to_string(),
        table: table.to_string(),
        keys,
        links,
        updates: Vec::new(),
        restore,
    });
    Ok(())
}

async fn flush_self_links(client: &mut PgClient, state: &mut CopyState) -> Result<()> {
    let Some(defer) = state.defer.as_mut() else {
        return Ok(());
    };
    let updates = std::mem::take(&mut defer.updates);
    let restore = std::mem::take(&mut defer.restore);
    let schema = defer.schema.clone();
    let table = defer.table.clone();
    for update in updates {
        client
            .exec(&update.sql, &update.params, SETUP_TIMEOUT)
            .await?;
    }
    if !restore.is_empty() {
        client
            .exec("SET CONSTRAINTS ALL IMMEDIATE", &[], SETUP_TIMEOUT)
            .await?;
        for name in &restore {
            client
                .exec(
                    &constraint_deferral(&schema, &table, name, false),
                    &[],
                    SETUP_TIMEOUT,
                )
                .await?;
        }
    }
    Ok(())
}

fn constraint_deferral(schema: &str, table: &str, name: &str, deferrable: bool) -> String {
    let mode = if deferrable {
        "DEFERRABLE INITIALLY DEFERRED"
    } else {
        "NOT DEFERRABLE"
    };
    format!(
        "ALTER TABLE {}.{} ALTER CONSTRAINT {} {mode}",
        quote_ident(schema),
        quote_ident(table),
        quote_ident(name)
    )
}

fn constraint_timing(schema: &str, name: &str, deferred: bool) -> String {
    let mode = if deferred { "DEFERRED" } else { "IMMEDIATE" };
    format!(
        "SET CONSTRAINTS {}.{} {mode}",
        quote_ident(schema),
        quote_ident(name)
    )
}

async fn self_constraints(
    client: &mut PgClient,
    schema: &str,
    table: &str,
) -> Result<Vec<SelfConstraint>> {
    let rows = client
        .query_columns(
            "SELECT con.conname::text, a.attname::text, pg_catalog.format_type(a.atttypid, a.atttypmod), \
             CASE WHEN a.attnotnull THEN 't' ELSE 'f' END \
             FROM pg_constraint con \
             JOIN pg_class c ON c.oid = con.conrelid \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             JOIN LATERAL unnest(con.conkey) AS ck(attnum) ON true \
             JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ck.attnum \
             WHERE con.contype = 'f' AND con.conrelid = con.confrelid \
             AND n.nspname = $1::text AND c.relname = $2::text \
             ORDER BY con.conname::text, a.attnum",
            &[Some(schema.to_string()), Some(table.to_string())],
            4,
        )
        .await?;
    let mut grouped = Vec::new();
    for row in rows {
        let column = TypedName {
            name: row[1].clone(),
            type_name: row[2].clone(),
        };
        let not_null = row[3] == "t";
        if let Some(existing) = grouped
            .iter_mut()
            .find(|constraint: &&mut SelfConstraint| constraint.name == row[0])
        {
            existing.not_null |= not_null;
            existing.columns.push(column);
        } else {
            grouped.push(SelfConstraint {
                name: row[0].clone(),
                columns: vec![column],
                not_null,
            });
        }
    }
    Ok(grouped)
}

async fn primary_key(client: &mut PgClient, schema: &str, table: &str) -> Result<Vec<TypedName>> {
    let rows = client
        .query_columns(
            "SELECT a.attname::text, pg_catalog.format_type(a.atttypid, a.atttypmod) \
             FROM pg_index i \
             JOIN pg_class c ON c.oid = i.indrelid \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true \
             JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum AND NOT a.attisdropped \
             WHERE i.indisprimary AND n.nspname = $1::text AND c.relname = $2::text AND k.attnum > 0 \
             ORDER BY k.ord",
            &[Some(schema.to_string()), Some(table.to_string())],
            2,
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| TypedName {
            name: row[0].clone(),
            type_name: row[1].clone(),
        })
        .collect())
}

async fn disable_user_triggers(
    client: &mut PgClient,
    state: &mut CopyState,
    schema: &str,
    table: &str,
) -> Result<()> {
    if state
        .triggers
        .as_ref()
        .is_some_and(|(current_schema, current_table)| {
            current_schema == schema && current_table == table
        })
    {
        return Ok(());
    }
    if let Some((current_schema, current_table)) = state.triggers.take() {
        client
            .exec(
                &trigger_change(&current_schema, &current_table, "ENABLE"),
                &[],
                SETUP_TIMEOUT,
            )
            .await?;
    }
    client
        .exec(
            &trigger_change(schema, table, "DISABLE"),
            &[],
            SETUP_TIMEOUT,
        )
        .await?;
    state.triggers = Some((schema.to_string(), table.to_string()));
    Ok(())
}

async fn relation_exists(client: &mut PgClient, schema: &str, name: &str) -> Result<bool> {
    let found = client
        .query_one_text(
            "SELECT CASE WHEN to_regclass(format('%I.%I', $1::text, $2::text)) IS NULL THEN 'f' ELSE 't' END",
            &[Some(schema.to_string()), Some(name.to_string())],
        )
        .await?;
    Ok(found.as_deref() == Some("t"))
}

async fn dest_columns(client: &mut PgClient, schema: &str, table: &str) -> Result<Vec<DestColumn>> {
    let rows = client
        .query_columns(
            "SELECT a.attname::text, pg_catalog.format_type(a.atttypid, a.atttypmod), a.attgenerated::text, a.attidentity::text \
             FROM pg_catalog.pg_attribute a \
             JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1::text AND c.relname = $2::text AND a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY a.attnum",
            &[Some(schema.to_string()), Some(table.to_string())],
            4,
        )
        .await?;
    let mut columns = Vec::with_capacity(rows.len());
    for row in rows {
        let generated = row[2] == "s";
        let identity = row[3] == "a" || row[3] == "d";
        columns.push(DestColumn {
            name: row[0].clone(),
            type_name: row[1].clone(),
            generated,
            identity,
        });
    }
    Ok(columns)
}

async fn check_count(
    client: &mut PgClient,
    schema: &str,
    table: &str,
    expected: i64,
) -> Result<()> {
    let got = count_table(client, schema, table).await?;
    if got == expected {
        return Ok(());
    }
    Err(LocalDbError::message(format!(
        "embedded postgres: PGlite migration row count mismatch for {schema}.{table}: dump {expected}, restored {got}"
    )))
}

async fn count_table(client: &mut PgClient, schema: &str, table: &str) -> Result<i64> {
    let sql = format!(
        "SELECT count(*)::bigint FROM {}.{}",
        quote_ident(schema),
        quote_ident(table)
    );
    client.query_i64(&sql).await
}

struct PgClient {
    conn: sqlx::PgConnection,
}

impl PgClient {
    async fn connect(url: &str) -> Result<Self> {
        ensure_crypto_provider();
        let options = match url.parse::<sqlx::postgres::PgConnectOptions>() {
            Ok(options) => options
                .ssl_mode(sqlx::postgres::PgSslMode::Disable)
                .extra_float_digits(None),
            Err(error) => return Err(LocalDbError::Postgres(scrub_secret(&error.to_string()))),
        };
        match tokio::time::timeout(CONNECT_TIMEOUT, options.connect()).await {
            Ok(Ok(conn)) => Ok(Self { conn }),
            Ok(Err(error)) => Err(LocalDbError::Postgres(scrub_secret(&error.to_string()))),
            Err(_) => Err(LocalDbError::Timeout(CONNECT_TIMEOUT)),
        }
    }

    async fn batch(&mut self, sql: &str, timeout: Duration) -> Result<()> {
        let run = sqlx::raw_sql(sqlx::AssertSqlSafe(sql)).execute(&mut self.conn);
        match tokio::time::timeout(timeout, run).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(error)) => Err(LocalDbError::Postgres(error.to_string())),
            Err(_) => Err(LocalDbError::Timeout(timeout)),
        }
    }

    async fn exec(
        &mut self,
        sql: &str,
        params: &[Option<String>],
        timeout: Duration,
    ) -> Result<()> {
        let run = async {
            let mut query = sqlx::query::<sqlx::Postgres>(sqlx::AssertSqlSafe(sql));
            for param in params {
                query = query.bind(param.as_deref());
            }
            query.execute(&mut self.conn).await
        };
        match tokio::time::timeout(timeout, run).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(error)) => Err(LocalDbError::Postgres(error.to_string())),
            Err(_) => Err(LocalDbError::Timeout(timeout)),
        }
    }

    async fn query_i64(&mut self, sql: &str) -> Result<i64> {
        let run = async {
            let row = sqlx::query::<sqlx::Postgres>(sqlx::AssertSqlSafe(sql))
                .fetch_one(&mut self.conn)
                .await?;
            let value: i64 = row.try_get(0)?;
            Ok::<i64, sqlx::Error>(value)
        };
        match tokio::time::timeout(COMMAND_TIMEOUT, run).await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(LocalDbError::Postgres(error.to_string())),
            Err(_) => Err(LocalDbError::Timeout(COMMAND_TIMEOUT)),
        }
    }

    async fn query_text(&mut self, sql: &str) -> Result<Option<String>> {
        self.query_one_text(sql, &[]).await
    }

    async fn query_one_text(
        &mut self,
        sql: &str,
        params: &[Option<String>],
    ) -> Result<Option<String>> {
        let rows = self.query_raw(sql, params).await?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        row.try_get(0)
            .map_err(|error| LocalDbError::Postgres(error.to_string()))
    }

    async fn query_columns(
        &mut self,
        sql: &str,
        params: &[Option<String>],
        width: usize,
    ) -> Result<Vec<Vec<String>>> {
        let rows = self.query_raw(sql, params).await?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let mut values = Vec::with_capacity(width);
            for index in 0..width {
                let value: Option<String> = row
                    .try_get(index)
                    .map_err(|error| LocalDbError::Postgres(error.to_string()))?;
                let Some(value) = value else {
                    return Err(LocalDbError::message(
                        "embedded postgres: catalog query returned null",
                    ));
                };
                values.push(value);
            }
            out.push(values);
        }
        Ok(out)
    }

    async fn query_optional_columns(
        &mut self,
        sql: &str,
        params: &[Option<String>],
        width: usize,
    ) -> Result<Vec<Vec<Option<String>>>> {
        let rows = self.query_raw(sql, params).await?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let mut values = Vec::with_capacity(width);
            for index in 0..width {
                let value: Option<String> = row
                    .try_get(index)
                    .map_err(|error| LocalDbError::Postgres(error.to_string()))?;
                values.push(value);
            }
            out.push(values);
        }
        Ok(out)
    }

    async fn query_raw(
        &mut self,
        sql: &str,
        params: &[Option<String>],
    ) -> Result<Vec<sqlx::postgres::PgRow>> {
        let run = async {
            let mut query = sqlx::query::<sqlx::Postgres>(sqlx::AssertSqlSafe(sql));
            for param in params {
                query = query.bind(param.as_deref());
            }
            query.fetch_all(&mut self.conn).await
        };
        match tokio::time::timeout(COMMAND_TIMEOUT, run).await {
            Ok(Ok(rows)) => Ok(rows),
            Ok(Err(error)) => Err(LocalDbError::Postgres(error.to_string())),
            Err(_) => Err(LocalDbError::Timeout(COMMAND_TIMEOUT)),
        }
    }
}

async fn dump_database(settings: &postgresql_embedded::Settings, out: &Path) -> Result<()> {
    if let Some(parent) = out.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let tmp = out.with_extension(format!("sql.{}.tmp", std::process::id()));
    let file = create_mode(&tmp, 0o600).await?;
    let std_file = file.into_std().await;
    let bin = settings
        .binary_dir()
        .join(format!("pg_dump{}", std::env::consts::EXE_SUFFIX));
    let mut command = tokio::process::Command::new(bin);
    command
        .arg("-h")
        .arg(&settings.host)
        .arg("-p")
        .arg(settings.port.to_string())
        .arg("-U")
        .arg(&settings.username)
        .arg("-d")
        .arg("postgres")
        .arg("--inserts")
        .arg("--no-owner")
        .arg("--no-privileges")
        .env("PGPASSWORD", &settings.password)
        .stdout(std::process::Stdio::from(std_file))
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    embedded_pg_env(&embedded_pg_url(i64::from(settings.port))).apply_to_tokio(&mut command);
    let child = command.spawn()?;
    let dumped = crate::process::wait_child(child, BACKUP_TIMEOUT).await;
    if let Err(error) = dumped {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(error);
    }
    set_mode(&tmp, 0o600).await?;
    tokio::fs::rename(&tmp, out).await?;
    set_mode(out, 0o600).await?;
    Ok(())
}

async fn write_password_file(path: &Path, password: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut file = create_mode(path, 0o600).await?;
    file.write_all(password.as_bytes()).await?;
    file.flush().await?;
    Ok(())
}

async fn write_pending(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut file = create_mode(path, 0o600).await?;
    file.write_all(b"pending").await?;
    file.flush().await?;
    Ok(())
}

async fn create_mode(path: &Path, mode: u32) -> Result<tokio::fs::File> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let _ = tokio::fs::remove_file(path).await;
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        options.mode(mode);
    }
    #[cfg(not(unix))]
    {
        let _ = mode;
    }
    Ok(options.open(path).await?)
}

async fn set_mode(path: &Path, mode: u32) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).await?;
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
    Ok(())
}

async fn clear_dir(path: &Path) -> Result<()> {
    match tokio::fs::remove_dir_all(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

async fn remove_file_if(path: &Path) -> Result<()> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

async fn discard_leaked(path: &Path) {
    if path.starts_with(std::env::temp_dir()) {
        let _ = tokio::fs::remove_dir_all(path).await;
    }
}

async fn with_timeout<T, F>(timeout: Duration, future: F) -> Result<T>
where
    F: std::future::Future<Output = Result<T>>,
{
    match tokio::time::timeout(timeout, future).await {
        Ok(result) => result,
        Err(_) => Err(LocalDbError::Timeout(timeout)),
    }
}

fn ensure_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

fn scrub_secret(text: &str) -> String {
    text.replace("postgres:postgres@", "postgres:***@")
}

fn cluster_complete(pgdata: &Path) -> bool {
    pgdata.join("PG_VERSION").is_file()
        && pgdata.join("postgresql.conf").is_file()
        && pgdata.join("base").is_dir()
}

async fn remove_incomplete(pgdata: &Path, log: &dyn EmbeddedPgLog) -> Result<()> {
    if !pgdata.exists() || cluster_complete(pgdata) {
        return Ok(());
    }
    log.info(&format!(
        "embedded postgres: removing incomplete cluster at {}",
        pgdata.display()
    ));
    clear_dir(pgdata).await
}

async fn stop_and_remove_pgdata(
    pgdata: &Path,
    installation_dir: &Path,
    log: &dyn EmbeddedPgLog,
) -> Result<()> {
    let pg_ctl = find_pg_ctl(installation_dir);
    clear_stale_postmaster(pgdata, pg_ctl.as_deref(), log).await?;
    if let Some(pid) = read_postmaster_pid(pgdata)
        && probe_lock_pid(pid) != PidProbe::Dead
    {
        return Err(still_running(pid));
    }
    clear_dir(pgdata).await
}

fn pending_source_missing(pending: &Path, source: &Path) -> LocalDbError {
    LocalDbError::message(format!(
        "embedded postgres: migration is pending at {} but {} is not a PGlite data directory. Run: node {} --data-dir {} --out <jsonl> --pglite <pglite-entry>",
        pending.display(),
        source.display(),
        shell_quote("pglite_export.mjs"),
        shell_quote(&source.display().to_string())
    ))
}

fn still_running(pid: i64) -> LocalDbError {
    LocalDbError::message(format!(
        "embedded PGlite is still running (pid {pid}) — stop the node first"
    ))
}

fn is_cluster_name(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    name == "postgres" || name.ends_with(".postgres")
}

fn inverse_source(cluster: &Path) -> Option<PathBuf> {
    let name = cluster.file_name()?.to_str()?;
    let parent = cluster.parent()?;
    if parent.as_os_str().is_empty() {
        return None;
    }
    if name == "postgres" {
        return Some(parent.join("pglite"));
    }
    let stem = name.strip_suffix(".postgres")?;
    if stem.is_empty() {
        return None;
    }
    Some(parent.join(stem))
}

fn paths_match(left: &Path, right: &Path) -> bool {
    lexical_absolute(left) == lexical_absolute(right)
        || crate::paths::real_or_lexical(left) == crate::paths::real_or_lexical(right)
}

fn push_source(sources: &mut Vec<PathBuf>, source: PathBuf) {
    if sources.iter().any(|item| paths_match(item, &source)) {
        return;
    }
    sources.push(source);
}

fn configured_data_dir(config: &Value, home: &Path) -> Option<PathBuf> {
    let raw = config
        .get("memory")?
        .get("postgres")?
        .get("embedded")?
        .get("data_dir")?
        .as_str()?;
    Some(lexical_absolute(&expand_tilde(raw, home)))
}

fn sources_for_cluster(home: &Path, cluster: &Path, config: Option<&Value>) -> Vec<PathBuf> {
    let mut sources = Vec::new();
    if let Some(source) = inverse_source(cluster) {
        push_source(&mut sources, source);
    }
    if let Some(config) = config
        && let Some(source) = configured_data_dir(config, home)
        && paths_match(&cluster_dir_for(&source), cluster)
    {
        push_source(&mut sources, source);
    }
    sources
}

fn resolve_reset_target(lexical: &Path) -> PathBuf {
    let Some(name) = lexical.file_name() else {
        return crate::paths::real_or_lexical(lexical);
    };
    let Some(parent) = lexical.parent() else {
        return crate::paths::real_or_lexical(lexical);
    };
    if parent.as_os_str().is_empty() {
        return crate::paths::real_or_lexical(lexical);
    }
    real_of_nearest(parent).join(name)
}

fn refuse_if_running(cluster: &Path) -> Result<()> {
    if let Some(lock) = read_embedded_pg_lock(cluster)
        && embedded_pg_lock_alive(&lock)
    {
        return Err(still_running(lock.pid));
    }
    let pgdata = pgdata_dir(cluster);
    if let Some(pid) = read_postmaster_pid(&pgdata)
        && probe_lock_pid(pid) != PidProbe::Dead
    {
        return Err(still_running(pid));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config_resolve::resolve_embedded_pg;
    use crate::lock::TracingLog;
    use serde_json::json;

    #[test]
    fn backup_stamp_matches_the_typescript_slice() {
        let time = chrono::DateTime::parse_from_rfc3339("2026-01-02T03:04:05.006Z")
            .expect("time")
            .with_timezone(&chrono::Utc);
        assert_eq!(backup_stamp(time), "2026-01-02T03-04-05");
        let path = default_backup_path(Path::new("/tmp/user-home"), "2026-01-02T03-04-05");
        assert_eq!(
            path,
            PathBuf::from("/tmp/user-home/.rivetos/backups/postgres-2026-01-02T03-04-05.sql")
        );
        assert_eq!(
            backup_wrote_line(&path),
            "✅ backup wrote /tmp/user-home/.rivetos/backups/postgres-2026-01-02T03-04-05.sql"
        );
    }

    #[test]
    fn halfvec_needs_pgvector_0_7() {
        assert!(!pgvector_supports_halfvec("0.6.0"));
        assert!(pgvector_supports_halfvec("0.7.0"));
        assert!(pgvector_supports_halfvec("0.8.2"));
        assert!(pgvector_supports_halfvec("1.0.0"));
        assert!(!pgvector_supports_halfvec("nope"));
    }

    #[test]
    fn max_connections_reserves_fewer_slots_than_the_limit() {
        assert_eq!(superuser_reserved(1), 0);
        assert_eq!(superuser_reserved(2), 1);
        assert_eq!(superuser_reserved(3), 2);
        assert_eq!(superuser_reserved(96), 3);
        let resolved = resolve_embedded_pg(
            &json!({"memory": {"postgres": {"embedded": {"max_connections": 1}}}}),
            Path::new("/tmp/fakehome"),
            None,
        )
        .expect("resolved");
        let one = server_configuration(&resolved, 1);
        assert_eq!(one.get("max_connections").map(String::as_str), Some("1"));
        assert_eq!(
            one.get("superuser_reserved_connections")
                .map(String::as_str),
            Some("0")
        );
        assert_eq!(
            one.get("reserved_connections").map(String::as_str),
            Some("0")
        );
        assert!(!format!("{one:?}").contains("postgres:postgres"));
        let wide = server_configuration(&resolved, 96);
        assert_eq!(
            wide.get("superuser_reserved_connections")
                .map(String::as_str),
            Some("3")
        );
    }

    #[test]
    fn reset_refuses_a_path_outside_the_rivet_dir_and_a_live_owner() {
        let home = temp_home("reset");
        let error = assert_under_rivet(&home, Path::new("/tmp/elsewhere")).expect_err("outside");
        assert_eq!(
            error.to_string(),
            "reset refuses to delete /tmp/elsewhere (outside ~/.rivetos)"
        );
        let target = home.join(".rivetos").join("postgres");
        assert!(assert_under_rivet(&home, &target).is_ok());
        std::fs::create_dir_all(&target).expect("dir");
        std::fs::write(
            target.join("rivetos-owner.lock"),
            serde_json::json!({
                "pid": std::process::id(),
                "port": 5433,
                "startedAt": "t"
            })
            .to_string(),
        )
        .expect("lock");
        let runtime = test_runtime();
        let error = runtime
            .block_on(reset_engine(&home, &target))
            .expect_err("live");
        assert!(error.to_string().contains("still running"));
        assert!(error.to_string().contains("stop the node first"));
        assert!(target.exists());
        std::fs::write(
            target.join("rivetos-owner.lock"),
            serde_json::json!({"pid": i32::MAX, "port": 5433, "startedAt": "t"}).to_string(),
        )
        .expect("lock");
        std::fs::write(target.join("keep-me"), b"x").expect("file");
        runtime
            .block_on(reset_engine(&home, &target))
            .expect("reset");
        assert!(!target.exists());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn reset_records_the_source_and_leaves_pglite_bytes() {
        let home = temp_home("reset-source");
        let source = home.join(".rivetos").join("pglite");
        let cluster = home.join(".rivetos").join("postgres");
        std::fs::create_dir_all(&source).expect("source");
        std::fs::write(source.join("PG_VERSION"), b"18\n").expect("version");
        std::fs::create_dir_all(cluster.join("pgdata")).expect("pgdata");
        std::fs::write(cluster.join("rivetos-migrate-pending"), b"pending").expect("pending");
        let mine = crate::migrate::store_work_dir(&home, &source);
        let other_source = home.join(".rivetos").join("other-store");
        let other = crate::migrate::store_work_dir(&home, &other_source);
        std::fs::create_dir_all(&mine).expect("mine");
        std::fs::create_dir_all(&other).expect("other");
        std::fs::write(mine.join("snapshot"), b"copy").expect("snap");
        std::fs::write(other.join("snapshot"), b"keep").expect("other snap");
        let runtime = test_runtime();
        runtime
            .block_on(reset_engine(&home, &cluster))
            .expect("reset");
        assert!(!cluster.exists());
        assert_eq!(
            std::fs::read(source.join("PG_VERSION")).expect("kept"),
            b"18\n"
        );
        assert!(!mine.exists());
        assert_eq!(
            std::fs::read(other.join("snapshot")).expect("other kept"),
            b"keep"
        );
        assert!(source_is_migrated(&home, &source).expect("record"));
        let plan = plan_migration(
            &source,
            &cluster.join("pgdata"),
            &cluster.join("rivetos-migrate-pending"),
            true,
        );
        assert_eq!(plan, MigrationPlan::Skip(SkipReason::AlreadyMigrated));
        std::fs::create_dir_all(&cluster).expect("cluster");
        std::fs::write(cluster.join("again"), b"x").expect("again");
        runtime
            .block_on(reset_engine(&home, &source))
            .expect("reset source path");
        assert!(source.join("PG_VERSION").is_file());
        assert!(!cluster.exists());
        let custom = home.join(".rivetos").join("db");
        let custom_cluster = home.join(".rivetos").join("db.postgres");
        std::fs::create_dir_all(&custom).expect("custom");
        std::fs::write(custom.join("PG_VERSION"), b"18\n").expect("custom version");
        std::fs::create_dir_all(&custom_cluster).expect("custom cluster");
        let config = json!({"memory": {"postgres": {"embedded": {"data_dir": "~/.rivetos/db"}}}});
        runtime
            .block_on(reset_engine_with(&home, &custom_cluster, Some(&config)))
            .expect("custom");
        assert!(custom.join("PG_VERSION").is_file());
        assert!(!custom_cluster.exists());
        assert!(source_is_migrated(&home, &custom).expect("custom record"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[cfg(unix)]
    #[test]
    fn reset_refuses_a_symlink_that_leaves_the_rivet_dir() {
        let home = temp_home("reset-link");
        let base = home.join(".rivetos");
        std::fs::create_dir_all(&base).expect("base");
        let outside = temp_home("outside");
        std::fs::create_dir_all(&outside).expect("outside");
        std::fs::write(outside.join("keep"), b"safe").expect("keep");
        std::os::unix::fs::symlink(&outside, base.join("linked-dir")).expect("link");
        let target = base.join("linked-dir").join("postgres");
        std::fs::create_dir_all(&target).expect("target");
        std::fs::write(target.join("data"), b"x").expect("data");
        let error = test_runtime()
            .block_on(reset_engine(&home, &target))
            .expect_err("symlink");
        assert!(error.to_string().contains("outside ~/.rivetos"));
        assert_eq!(std::fs::read(outside.join("keep")).expect("kept"), b"safe");
        assert!(target.join("data").is_file());
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn not_configured_message_is_embedded_only() {
        assert_eq!(
            EMBEDDED_NOT_CONFIGURED,
            "memory.postgres.embedded is not configured — run rivetos local init"
        );
        assert_eq!(ATTACH_BACKUP_ERROR, "stop the node or run backup from it");
        let config = json!({});
        assert!(resolve_embedded_pg_from_env(&config, Path::new("/tmp"), &MapEnv::new()).is_none());
    }

    #[tokio::test]
    async fn missing_postgres_binaries_while_offline_is_operator_readable() {
        let home = temp_home("offline-bin");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("home");
        let config = json!({
            "memory": {"postgres": {"embedded": {"port": 5433, "max_connections": 16}}}
        });
        let resolved = resolve_embedded_pg(&config, &home, None).expect("resolved");
        let version = resolved.installation_dir.join("16.10.0");
        std::fs::create_dir_all(version.join("share")).expect("incomplete");
        std::fs::write(version.join("share").join("README"), b"partial").expect("partial");
        let failed =
            acquire_embedded_pg_with(resolved, &TracingLog, None, &offline_releases_env()).await;
        let Err(error) = failed else {
            panic!("offline boot succeeded");
        };
        let text = error.to_string();
        assert!(text.contains("PostgreSQL 16.10.0 binaries are not installed"));
        assert!(text.contains("network path is unavailable"));
        assert!(text.contains("later boots stay offline"));
        assert!(!text.contains("api.github.com"));
        assert!(
            !version.exists(),
            "incomplete install remains at {}",
            version.display()
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[tokio::test]
    async fn incomplete_install_is_removed_only_while_the_install_lock_is_held() {
        let home = temp_home("install-lock");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("home");
        let config = json!({
            "memory": {"postgres": {"embedded": {"port": 5433, "max_connections": 16}}}
        });
        let resolved = resolve_embedded_pg(&config, &home, None).expect("resolved");
        let version = resolved.installation_dir.join("16.10.0");
        std::fs::create_dir_all(version.join("share")).expect("incomplete");
        std::fs::write(version.join("share").join("README"), b"partial").expect("partial");
        let installation = resolved.installation_dir.clone();
        let held = FileLock::acquire(
            &installation.join(INSTALL_LOCK),
            Duration::from_secs(2),
            "lock busy".to_string(),
        )
        .await
        .expect("hold");
        let blocked = tokio::time::timeout(
            Duration::from_millis(400),
            prepare_shared_install(&installation, &TracingLog),
        )
        .await;
        assert!(blocked.is_err());
        assert!(version.join("share").join("README").is_file());
        drop(held);
        let guard = prepare_shared_install(&installation, &TracingLog)
            .await
            .expect("prepare");
        assert!(guard.is_some());
        assert!(!version.exists());
        drop(guard);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn install_waits_for_pg_ctl_and_the_pgvector_marker() {
        let root = temp_home("bin-marker");
        let _ = std::fs::remove_dir_all(&root);
        assert!(offline_without_binaries(
            &root,
            "offline://postgresql-binaries"
        ));
        assert!(!offline_without_binaries(
            &root,
            "https://github.com/theseus-rs/postgresql-binaries/releases/download"
        ));
        assert!(binary_install_required(&root));
        let version = root.join("16.10.0");
        let bin = version.join("bin");
        std::fs::create_dir_all(&bin).expect("bin");
        assert!(version.is_dir());
        assert!(binary_install_required(&root));
        assert!(offline_without_binaries(
            &root,
            "offline://postgresql-binaries"
        ));
        std::fs::write(bin.join(crate::supervisor::pg_ctl_name()), b"x").expect("pg_ctl");
        assert!(binary_install_required(&root));
        assert!(!offline_without_binaries(
            &root,
            "offline://postgresql-binaries"
        ));
        let share = version.join("share");
        std::fs::create_dir_all(&share).expect("share");
        std::fs::write(
            share.join("postgresql_extensions.json"),
            r#"{"name":"pgvector_compiled"}"#,
        )
        .expect("marker");
        assert!(!binary_install_required(&root));
        std::fs::remove_file(share.join("postgresql_extensions.json")).expect("remove marker");
        assert!(binary_install_required(&root));
        let nested = share.join("postgresql");
        std::fs::create_dir_all(&nested).expect("nested");
        std::fs::write(
            nested.join("postgresql_extensions.json"),
            "pgvector_compiled",
        )
        .expect("fallback");
        assert!(!binary_install_required(&root));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn export_env_keeps_only_a_non_empty_rivetos_root() {
        let mut boot = MapEnv::new();
        boot.set("RIVETOS_ROOT", "/opt/rivetos");
        boot.set("RIVETOS_EMBED_URL", "http://127.0.0.1:9/v1");
        boot.set("RIVETOS_PG_RELEASES_URL", "offline://postgresql-binaries");
        let env = boot_env_for_export(&boot);
        assert_eq!(env.var("RIVETOS_ROOT").as_deref(), Some("/opt/rivetos"));
        assert!(env.var("RIVETOS_EMBED_URL").is_none());
        assert!(env.var("RIVETOS_PG_RELEASES_URL").is_none());
        let mut empty = MapEnv::new();
        empty.set("RIVETOS_ROOT", "");
        assert!(boot_env_for_export(&empty).var("RIVETOS_ROOT").is_none());
    }

    #[tokio::test]
    async fn boots_embedded_postgres_when_enabled() {
        if std::env::var("RIVETOS_TEST_EMBEDDED_PG").ok().as_deref() != Some("1") {
            return;
        }
        let home = temp_home("boot");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("home");
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let config = json!({
            "memory": {"postgres": {"embedded": {"port": port, "max_connections": 16}}}
        });
        let env = MapEnv::new();
        let mut resolved = resolve_embedded_pg(&config, &home, None).expect("resolved");
        use_shared_binaries(&mut resolved);
        assert!(resolved.lite_mode);
        let mut handle =
            acquire_embedded_pg_with(resolved.clone(), &TracingLog, Some(listener), &env)
                .await
                .expect("boot");
        let pairs = handle.env();
        assert_eq!(pairs.pg_url_key, "RIVETOS_PG_URL");
        assert_eq!(pairs.pg_url, handle.pg_url());
        assert_eq!(pairs.embedded_key, "RIVETOS_PG_EMBEDDED");
        assert_eq!(pairs.embedded, "1");
        assert!(handle.lite_mode());
        let mut client = PgClient::connect(handle.pg_url()).await.expect("connect");
        assert_eq!(
            client.query_i64("SELECT 1::bigint").await.expect("select"),
            1
        );
        let half = client
            .query_text("SELECT typname FROM pg_type WHERE typname = 'halfvec'")
            .await
            .expect("halfvec");
        assert_eq!(half.as_deref(), Some("halfvec"));
        let guc = client
            .query_text("SHOW rivet.defer_embed_enqueue")
            .await
            .expect("guc");
        assert_eq!(guc.as_deref(), Some("on"));
        let backup = handle.backup_default(&home).await.expect("backup");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&backup)
                .expect("meta")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
        let attached = acquire_embedded_pg(resolved, &TracingLog)
            .await
            .expect("attach");
        assert!(!attached.owned());
        let refused = attached.backup(&backup).await.expect_err("attach backup");
        assert_eq!(refused.to_string(), ATTACH_BACKUP_ERROR);
        drop(attached);
        handle.close().await.expect("close");
        let engine = home.join(".rivetos").join("postgres");
        let pgdata = engine.join("pgdata");
        assert!(!pgdata.join("postmaster.pid").exists());
        assert!(!engine.join("rivetos-owner.lock").exists());
        std::fs::create_dir_all(&pgdata).expect("pgdata");
        std::fs::write(pgdata.join("postmaster.pid"), format!("{}\n", i32::MAX)).expect("pid");
        let mut again_resolved = resolve_embedded_pg(&config, &home, None).expect("resolved");
        use_shared_binaries(&mut again_resolved);
        let pinned = shared_pg_bin()
            .join("16.10.0")
            .join("bin")
            .join(crate::supervisor::pg_ctl_name());
        assert!(
            pinned.is_file(),
            "pinned binaries missing at {}",
            pinned.display()
        );
        let offline = offline_releases_env();
        let mut again = acquire_embedded_pg_with(again_resolved, &TracingLog, None, &offline)
            .await
            .expect("restart");
        again.close().await.expect("close again");
        let home_full = temp_home("boot-full");
        let _ = std::fs::remove_dir_all(&home_full);
        std::fs::create_dir_all(&home_full).expect("full home");
        let listener_full = std::net::TcpListener::bind("127.0.0.1:0").expect("bind full");
        let port_full = listener_full.local_addr().expect("addr").port();
        let mut full_env = offline_releases_env();
        full_env.set("RIVETOS_EMBED_URL", "http://127.0.0.1:9402/v1");
        let full_config = json!({
            "memory": {"postgres": {"embedded": {"port": port_full, "max_connections": 16}}}
        });
        let mut full_resolved =
            resolve_embedded_pg_from_env(&full_config, &home_full, &full_env).expect("full");
        use_shared_binaries(&mut full_resolved);
        assert!(!full_resolved.lite_mode);
        let mut full =
            acquire_embedded_pg_with(full_resolved, &TracingLog, Some(listener_full), &full_env)
                .await
                .expect("full boot");
        assert!(!full.lite_mode());
        full.close().await.expect("close full");
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&home_full);
    }

    fn pglite_root() -> PathBuf {
        if let Some(value) = std::env::var_os("RIVETOS_TEST_PGLITE_ROOT") {
            let path = PathBuf::from(value);
            if path
                .join("node_modules/@electric-sql/pglite/package.json")
                .is_file()
            {
                return path;
            }
        }
        if let Some(value) = std::env::var_os("RIVETOS_ROOT") {
            let path = PathBuf::from(value);
            if !path.as_os_str().is_empty() {
                return path;
            }
        }
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    fn shared_pg_bin() -> PathBuf {
        std::env::temp_dir().join("rivetos-local-db-pg-bin")
    }

    fn use_shared_binaries(resolved: &mut ResolvedEmbeddedPg) {
        resolved.installation_dir = shared_pg_bin();
    }

    fn offline_releases_env() -> MapEnv {
        let mut env = MapEnv::new();
        env.set("RIVETOS_PG_RELEASES_URL", "offline://postgresql-binaries");
        env
    }

    fn temp_home(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "local-db-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0)
        ))
    }

    fn test_runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("rt")
    }

    fn lane_database_url() -> Option<String> {
        if std::env::var("RIVETOS_TEST_LANE_PG").ok().as_deref() != Some("1") {
            return None;
        }
        std::env::var("RIVETOS_TEST_PG_URL")
            .ok()
            .filter(|url| !url.is_empty())
    }

    #[tokio::test]
    async fn applies_product_schema_and_text_casts_on_the_lane_database() {
        let Some(url) = lane_database_url() else {
            return;
        };
        let mut client = PgClient::connect(&url).await.expect("connect lane");
        let schema = format!(
            "rr9l_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        );
        let ident = quote_ident(&schema);
        client
            .batch(&format!("CREATE SCHEMA {ident}"), COMMAND_TIMEOUT)
            .await
            .expect("create schema");
        let result = lane_checks(&mut client, &schema, &ident).await;
        let dropped = client
            .batch(
                &format!("DROP SCHEMA IF EXISTS {ident} CASCADE"),
                SETUP_TIMEOUT,
            )
            .await;
        result.expect("lane checks");
        dropped.expect("drop schema");
    }

    async fn lane_checks(client: &mut PgClient, schema: &str, ident: &str) -> Result<()> {
        client
            .batch(
                &format!("SET search_path TO {ident}, public"),
                COMMAND_TIMEOUT,
            )
            .await?;
        client
            .batch(
                &format!(
                    "CREATE TABLE IF NOT EXISTS {ident}._rivetos_migrations (\
                        name TEXT PRIMARY KEY, \
                        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), \
                        checksum TEXT)"
                ),
                COMMAND_TIMEOUT,
            )
            .await?;
        apply_product_schema(client).await?;
        let generated = client
            .query_one_text(
                "SELECT a.attgenerated::text FROM pg_attribute a \
                 JOIN pg_class c ON c.oid = a.attrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1::text AND c.relname = 'ros_messages' AND a.attname = 'content_tsv'",
                &[Some(schema.to_string())],
            )
            .await?;
        if generated.as_deref() != Some("s") {
            return Err(LocalDbError::message(format!(
                "content_tsv generated marker is {generated:?}"
            )));
        }
        let defaulted = client
            .query_one_text(
                "SELECT column_default FROM information_schema.columns \
                 WHERE table_schema = $1::text AND table_name = 'ros_conversations' AND column_name = 'id'",
                &[Some(schema.to_string())],
            )
            .await?;
        if !defaulted
            .as_deref()
            .is_some_and(|text| text.contains("gen_random_uuid()"))
        {
            return Err(LocalDbError::message(format!(
                "conversation id default is {defaulted:?}"
            )));
        }
        let index = client
            .query_one_text(
                "SELECT indexname FROM pg_indexes \
                 WHERE schemaname = $1::text AND indexname = 'ux_ros_conversations_session_agent'",
                &[Some(schema.to_string())],
            )
            .await?;
        if index.as_deref() != Some("ux_ros_conversations_session_agent") {
            return Err(LocalDbError::message(
                "unique conversation index is missing".to_string(),
            ));
        }
        let function = client
            .query_one_text(
                "SELECT p.proname FROM pg_proc p \
                 JOIN pg_namespace n ON n.oid = p.pronamespace \
                 WHERE n.nspname = $1::text AND p.proname = 'notify_embedding_queue'",
                &[Some(schema.to_string())],
            )
            .await?;
        if function.as_deref() != Some("notify_embedding_queue") {
            return Err(LocalDbError::message(
                "notify_embedding_queue is missing".to_string(),
            ));
        }
        let applied = client
            .query_i64("SELECT count(*)::bigint FROM _rivetos_migrations")
            .await?;
        if applied != 20 {
            return Err(LocalDbError::message(format!(
                "migration ledger has {applied} rows"
            )));
        }
        for name in ["0001_baseline.sql", "0019_tags.sql"] {
            let found = client
                .query_one_text(
                    "SELECT name FROM _rivetos_migrations WHERE name = $1::text",
                    &[Some(name.to_string())],
                )
                .await?;
            if found.as_deref() != Some(name) {
                return Err(LocalDbError::message(format!("{name} was not applied")));
            }
        }
        client
            .exec(
                "INSERT INTO ros_tag_taxonomy (key, value, aliases) VALUES ('topic', 'direct', $1::text::text[])",
                &[Some("{alpha,beta}".to_string())],
                COMMAND_TIMEOUT,
            )
            .await?;
        let aliases = client
            .query_text(
                "SELECT aliases::text FROM ros_tag_taxonomy WHERE key = 'topic' AND value = 'direct'",
            )
            .await?;
        if aliases.as_deref() != Some("{alpha,beta}") {
            return Err(LocalDbError::message(format!(
                "text[] round trip returned {aliases:?}"
            )));
        }
        client
            .batch(
                "DELETE FROM ros_tag_taxonomy WHERE key = 'topic' AND value = 'direct'",
                COMMAND_TIMEOUT,
            )
            .await?;
        client
            .batch(
                &format!("CREATE SEQUENCE {}", quote_ident("a'b")),
                COMMAND_TIMEOUT,
            )
            .await?;
        let incomplete = temp_home("lane-partial");
        std::fs::create_dir_all(&incomplete).expect("partial dir");
        let partial = incomplete.join("partial.jsonl");
        std::fs::write(
            &partial,
            export_line(&json!({
                "op": "begin"
            })) + &export_line(&json!({
                "op": "insert",
                "schema": schema,
                "table": "ros_conversations",
                "columns": ["id", "session_key", "agent", "created_at"],
                "rows": [[
                    cell("11111111-1111-4111-8111-0000000000aa"),
                    cell("partial-session"),
                    cell("sample-agent"),
                    cell("2024-01-02 03:04:05+00")
                ]]
            })),
        )
        .expect("partial");
        let missing = apply_export(client, &partial, Path::new("source"), &TracingLog).await;
        let Err(error) = missing else {
            return Err(LocalDbError::message(
                "export without done was accepted".to_string(),
            ));
        };
        if !error.to_string().contains("ended before done") {
            return Err(error);
        }
        let leftover = count_table(client, schema, "ros_conversations").await?;
        if leftover != 0 {
            return Err(LocalDbError::message(format!(
                "rolled back conversation count is {leftover}"
            )));
        }
        let absent = incomplete.join("absent.jsonl");
        std::fs::write(
            &absent,
            export_line(&json!({"op": "begin"}))
                + &export_line(&json!({
                    "op": "insert",
                    "schema": schema,
                    "table": "not_in_product",
                    "columns": ["id"],
                    "rows": [[cell("1")]]
                })),
        )
        .expect("absent");
        let refused = apply_export(client, &absent, Path::new("source"), &TracingLog).await;
        let Err(error) = refused else {
            return Err(LocalDbError::message(
                "missing relation was accepted".to_string(),
            ));
        };
        let refused_text = error.to_string();
        if !refused_text.contains("no relation") || !refused_text.contains("not_in_product") {
            return Err(LocalDbError::message(refused_text));
        }
        let still = count_table(client, schema, "ros_conversations").await?;
        if still != 0 {
            return Err(LocalDbError::message(format!(
                "missing relation left conversation count {still}"
            )));
        }
        let good = incomplete.join("good.jsonl");
        std::fs::write(&good, lane_export(schema)).expect("good");
        apply_export(client, &good, Path::new("source"), &TracingLog).await?;
        let id = client
            .query_text("SELECT id::text FROM ros_conversations")
            .await?;
        if id.as_deref() != Some("11111111-1111-4111-8111-0000000000aa") {
            return Err(LocalDbError::message(format!("conversation id is {id:?}")));
        }
        let created = client
            .query_text("SELECT created_at::text FROM ros_conversations")
            .await?;
        if !created
            .as_deref()
            .is_some_and(|text| text.starts_with("2024-01-02 03:04:05"))
        {
            return Err(LocalDbError::message(format!(
                "conversation created_at is {created:?}"
            )));
        }
        let content = client
            .query_text("SELECT content FROM ros_messages")
            .await?;
        if content.as_deref() != Some("sample message") {
            return Err(LocalDbError::message(format!(
                "message content is {content:?}"
            )));
        }
        let tsv = client
            .query_text("SELECT content_tsv::text FROM ros_messages")
            .await?;
        if !tsv.as_deref().is_some_and(|text| !text.is_empty()) {
            return Err(LocalDbError::message("content_tsv was empty".to_string()));
        }
        let copied = client
            .query_text("SELECT aliases::text FROM ros_tag_taxonomy WHERE key = 'topic'")
            .await?;
        if copied.as_deref() != Some("{alpha,beta}") {
            return Err(LocalDbError::message(format!(
                "copied aliases are {copied:?}"
            )));
        }
        let ledger = client
            .query_i64("SELECT count(*)::bigint FROM _rivetos_migrations")
            .await?;
        if ledger != 20 {
            return Err(LocalDbError::message(format!(
                "ledger grew to {ledger} after the skipped copy"
            )));
        }
        let extra = client
            .query_text("SELECT name FROM _rivetos_migrations WHERE name = 'extra.sql'")
            .await?;
        if extra.is_some() {
            return Err(LocalDbError::message(
                "source ledger row was copied".to_string(),
            ));
        }
        let last = client
            .query_text(&format!(
                "SELECT last_value::text FROM {}",
                quote_ident("a'b")
            ))
            .await?;
        if last.as_deref() != Some("7") {
            return Err(LocalDbError::message(format!("setval last is {last:?}")));
        }
        let called = client
            .query_text(&format!(
                "SELECT is_called::text FROM {}",
                quote_ident("a'b")
            ))
            .await?;
        if called.as_deref() != Some("true") {
            return Err(LocalDbError::message(format!(
                "setval called is {called:?}"
            )));
        }
        lane_self_links(client, schema, &incomplete).await?;
        lane_identity(client, schema, &incomplete).await?;
        let _ = std::fs::remove_dir_all(&incomplete);
        Ok(())
    }

    async fn lane_identity(client: &mut PgClient, schema: &str, dir: &Path) -> Result<()> {
        let qualified = format!("{}.{}", quote_ident(schema), quote_ident("identity_jobs"));
        let sequence = format!(
            "{}.{}",
            quote_ident(schema),
            quote_ident("identity_jobs_id_seq")
        );
        let create = format!(
            "CREATE TABLE {qualified} (id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY, payload json NOT NULL)"
        );
        let mut out = String::new();
        out.push_str(&export_line(&json!({"op": "begin"})));
        out.push_str(&export_line(&json!({"op": "ddl", "sql": create})));
        out.push_str(&export_line(&json!({"op": "commit"})));
        out.push_str(&export_line(&json!({"op": "begin"})));
        out.push_str(&export_line(&json!({
            "op": "insert",
            "schema": schema,
            "table": "identity_jobs",
            "columns": ["id", "payload"],
            "rows": [[cell("7"), cell(r#"{"task":"extract-wiki"}"#)]]
        })));
        out.push_str(&export_line(&json!({
            "op": "count",
            "schema": schema,
            "table": "identity_jobs",
            "n": 1
        })));
        out.push_str(&export_line(&json!({"op": "commit"})));
        out.push_str(&export_line(&json!({
            "op": "setval",
            "schema": schema,
            "name": "identity_jobs_id_seq",
            "last": "7",
            "called": true
        })));
        out.push_str(&export_line(&json!({"op": "done"})));
        let path = dir.join("identity.jsonl");
        std::fs::write(&path, out).expect("identity");
        apply_export(client, &path, Path::new("source"), &TracingLog).await?;
        let id = client
            .query_text(&format!("SELECT id::text FROM {qualified}"))
            .await?;
        if id.as_deref() != Some("7") {
            return Err(LocalDbError::message(format!("identity id is {id:?}")));
        }
        let marker = client
            .query_one_text(
                "SELECT a.attidentity::text FROM pg_attribute a \
                 JOIN pg_class c ON c.oid = a.attrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1::text AND c.relname = 'identity_jobs' AND a.attname = 'id'",
                &[Some(schema.to_string())],
            )
            .await?;
        if marker.as_deref() != Some("a") {
            return Err(LocalDbError::message(format!(
                "identity marker is {marker:?}"
            )));
        }
        let last = client
            .query_text(&format!("SELECT last_value::text FROM {sequence}"))
            .await?;
        if last.as_deref() != Some("7") {
            return Err(LocalDbError::message(format!(
                "identity sequence last is {last:?}"
            )));
        }
        let called = client
            .query_text(&format!("SELECT is_called::text FROM {sequence}"))
            .await?;
        if called.as_deref() != Some("true") {
            return Err(LocalDbError::message(format!(
                "identity sequence called is {called:?}"
            )));
        }
        client
            .batch(
                &format!(
                    "INSERT INTO {qualified} (payload) VALUES ('{{\"task\":\"again\"}}'::json)"
                ),
                COMMAND_TIMEOUT,
            )
            .await?;
        let next = client
            .query_text(&format!("SELECT id::text FROM {qualified} WHERE id <> 7"))
            .await?;
        if next.as_deref() != Some("8") {
            return Err(LocalDbError::message(format!(
                "next identity id is {next:?}"
            )));
        }
        Ok(())
    }

    async fn lane_self_links(client: &mut PgClient, schema: &str, dir: &Path) -> Result<()> {
        let summaries = dir.join("summaries.jsonl");
        std::fs::write(&summaries, summary_hierarchy_export(schema)).expect("summaries");
        apply_export(client, &summaries, Path::new("source"), &TracingLog).await?;
        let summary_links = client
            .query_i64("SELECT count(*)::bigint FROM ros_summaries WHERE parent_id IS NOT NULL")
            .await?;
        if summary_links != 100 {
            return Err(LocalDbError::message(format!(
                "summary parent links are {summary_links}"
            )));
        }
        let summary_parent = client
            .query_text(
                "SELECT parent_id::text FROM ros_summaries WHERE id = '55555555-5555-4555-8555-000000000002'::uuid",
            )
            .await?;
        if summary_parent.as_deref() != Some("55555555-5555-4555-8555-000000000001") {
            return Err(LocalDbError::message(format!(
                "first summary child points at {summary_parent:?}"
            )));
        }
        let tasks = dir.join("tasks.jsonl");
        std::fs::write(&tasks, task_hierarchy_export(schema)).expect("tasks");
        apply_export(client, &tasks, Path::new("source"), &TracingLog).await?;
        let task_links = client
            .query_i64("SELECT count(*)::bigint FROM ros_tasks WHERE parent_task_id IS NOT NULL")
            .await?;
        if task_links != 1 {
            return Err(LocalDbError::message(format!(
                "task parent links are {task_links}"
            )));
        }
        let task_parent = client
            .query_text(
                "SELECT parent_task_id::text FROM ros_tasks WHERE id = '66666666-6666-4666-8666-000000000002'::uuid",
            )
            .await?;
        if task_parent.as_deref() != Some("66666666-6666-4666-8666-000000000001") {
            return Err(LocalDbError::message(format!(
                "task child points at {task_parent:?}"
            )));
        }
        let nodes = dir.join("nodes.jsonl");
        std::fs::write(&nodes, not_null_self_export(schema)).expect("nodes");
        apply_export(client, &nodes, Path::new("source"), &TracingLog).await?;
        let node_parent = client
            .query_text(
                "SELECT parent_id::text FROM self_node WHERE id = '44444444-4444-4444-8444-000000000002'::uuid",
            )
            .await?;
        if node_parent.as_deref() != Some("44444444-4444-4444-8444-000000000001") {
            return Err(LocalDbError::message(format!(
                "not-null self link points at {node_parent:?}"
            )));
        }
        let deferrable = client
            .query_one_text(
                "SELECT CASE WHEN con.condeferrable THEN 't' ELSE 'f' END \
                 FROM pg_constraint con \
                 JOIN pg_class c ON c.oid = con.conrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1::text AND c.relname = 'self_node' AND con.contype = 'f'",
                &[Some(schema.to_string())],
            )
            .await?;
        if deferrable.as_deref() != Some("f") {
            return Err(LocalDbError::message(format!(
                "self_node foreign key stayed deferrable ({deferrable:?})"
            )));
        }
        Ok(())
    }

    fn summary_hierarchy_export(schema: &str) -> String {
        let parent = "55555555-5555-4555-8555-000000000001";
        let mut rows = Vec::new();
        for index in 2..=101 {
            let id = format!("55555555-5555-4555-8555-{index:012x}");
            rows.push(json!([cell(&id), cell(parent), cell("child summary")]));
        }
        let mut out = String::new();
        out.push_str(&export_line(&json!({"op": "begin"})));
        out.push_str(&export_line(&json!({
            "op": "insert",
            "schema": schema,
            "table": "ros_summaries",
            "columns": ["id", "parent_id", "content"],
            "rows": rows
        })));
        out.push_str(&export_line(&json!({
            "op": "insert",
            "schema": schema,
            "table": "ros_summaries",
            "columns": ["id", "parent_id", "content"],
            "rows": [[cell(parent), Value::Null, cell("parent summary")]]
        })));
        out.push_str(&export_line(&json!({
            "op": "count",
            "schema": schema,
            "table": "ros_summaries",
            "n": 101
        })));
        out.push_str(&export_line(&json!({"op": "commit"})));
        out.push_str(&export_line(&json!({"op": "done"})));
        out
    }

    fn task_hierarchy_export(schema: &str) -> String {
        let parent = "66666666-6666-4666-8666-000000000001";
        let child = "66666666-6666-4666-8666-000000000002";
        let mut out = String::new();
        out.push_str(&export_line(&json!({"op": "begin"})));
        out.push_str(&export_line(&json!({
            "op": "insert",
            "schema": schema,
            "table": "ros_tasks",
            "columns": ["id", "goal", "executor", "agent_id", "origin", "parent_task_id"],
            "rows": [[
                cell(child),
                cell("child goal"),
                cell("chat-loop"),
                cell("sample-agent"),
                cell("chat"),
                cell(parent)
            ]]
        })));
        out.push_str(&export_line(&json!({
            "op": "insert",
            "schema": schema,
            "table": "ros_tasks",
            "columns": ["id", "goal", "executor", "agent_id", "origin", "parent_task_id"],
            "rows": [[
                cell(parent),
                cell("parent goal"),
                cell("chat-loop"),
                cell("sample-agent"),
                cell("chat"),
                Value::Null
            ]]
        })));
        out.push_str(&export_line(&json!({
            "op": "count",
            "schema": schema,
            "table": "ros_tasks",
            "n": 2
        })));
        out.push_str(&export_line(&json!({"op": "commit"})));
        out.push_str(&export_line(&json!({"op": "done"})));
        out
    }

    fn not_null_self_export(schema: &str) -> String {
        let parent = "44444444-4444-4444-8444-000000000001";
        let child = "44444444-4444-4444-8444-000000000002";
        let qualified = format!("{}.{}", quote_ident(schema), quote_ident("self_node"));
        let create = format!(
            "CREATE TABLE {qualified} (id uuid PRIMARY KEY, parent_id uuid NOT NULL REFERENCES {qualified} (id))"
        );
        let mut out = String::new();
        out.push_str(&export_line(&json!({"op": "begin"})));
        out.push_str(&export_line(&json!({
            "op": "ddl",
            "sql": create
        })));
        out.push_str(&export_line(&json!({"op": "commit"})));
        out.push_str(&export_line(&json!({"op": "begin"})));
        out.push_str(&export_line(&json!({
            "op": "insert",
            "schema": schema,
            "table": "self_node",
            "columns": ["id", "parent_id"],
            "rows": [[cell(child), cell(parent)]]
        })));
        out.push_str(&export_line(&json!({
            "op": "insert",
            "schema": schema,
            "table": "self_node",
            "columns": ["id", "parent_id"],
            "rows": [[cell(parent), cell(parent)]]
        })));
        out.push_str(&export_line(&json!({
            "op": "count",
            "schema": schema,
            "table": "self_node",
            "n": 2
        })));
        out.push_str(&export_line(&json!({"op": "commit"})));
        out.push_str(&export_line(&json!({"op": "done"})));
        out
    }

    fn cell(text: &str) -> Value {
        json!({"t": text})
    }

    fn export_line(value: &Value) -> String {
        format!("{value}\n")
    }

    fn lane_export(schema: &str) -> String {
        let mut out = String::new();
        out.push_str(&export_line(&json!({"op": "begin"})));
        out.push_str(&export_line(&json!({
            "op": "insert",
            "schema": schema,
            "table": "ros_conversations",
            "columns": ["id", "session_key", "agent", "created_at"],
            "rows": [[
                cell("11111111-1111-4111-8111-0000000000aa"),
                cell("sample-session"),
                cell("sample-agent"),
                cell("2024-01-02 03:04:05+00")
            ]]
        })));
        out.push_str(&export_line(&json!({
            "op": "count",
            "schema": schema,
            "table": "ros_conversations",
            "n": 1
        })));
        out.push_str(&export_line(&json!({"op": "commit"})));
        out.push_str(&export_line(&json!({"op": "begin"})));
        out.push_str(&export_line(&json!({
            "op": "insert",
            "schema": schema,
            "table": "ros_messages",
            "columns": ["conversation_id", "agent", "channel", "role", "content", "content_tsv"],
            "rows": [[
                cell("11111111-1111-4111-8111-0000000000aa"),
                cell("sample-agent"),
                cell("sample-channel"),
                cell("user"),
                cell("sample message"),
                cell("sample")
            ]]
        })));
        out.push_str(&export_line(&json!({
            "op": "count",
            "schema": schema,
            "table": "ros_messages",
            "n": 1
        })));
        out.push_str(&export_line(&json!({"op": "commit"})));
        out.push_str(&export_line(&json!({"op": "begin"})));
        out.push_str(&export_line(&json!({
            "op": "insert",
            "schema": schema,
            "table": "ros_tag_taxonomy",
            "columns": ["key", "value", "aliases"],
            "rows": [[
                cell("topic"),
                cell("alpha"),
                cell("{alpha,beta}")
            ]]
        })));
        out.push_str(&export_line(&json!({
            "op": "count",
            "schema": schema,
            "table": "ros_tag_taxonomy",
            "n": 1
        })));
        out.push_str(&export_line(&json!({"op": "commit"})));
        out.push_str(&export_line(&json!({"op": "begin"})));
        out.push_str(&export_line(&json!({
            "op": "insert",
            "schema": schema,
            "table": "_rivetos_migrations",
            "columns": ["name"],
            "rows": [[cell("extra.sql")]]
        })));
        out.push_str(&export_line(&json!({
            "op": "count",
            "schema": schema,
            "table": "_rivetos_migrations",
            "n": 21
        })));
        out.push_str(&export_line(&json!({"op": "commit"})));
        out.push_str(&export_line(&json!({
            "op": "setval",
            "schema": schema,
            "name": "a'b",
            "last": "7",
            "called": true
        })));
        out.push_str(&export_line(&json!({"op": "done"})));
        out
    }

    #[tokio::test]
    async fn migrates_a_current_memory_database_from_pglite() {
        if std::env::var("RIVETOS_TEST_EMBEDDED_PG").ok().as_deref() != Some("1") {
            return;
        }
        let root = pglite_root();
        let paths = crate::migrate::locate_pglite(&root).unwrap_or_else(|error| {
            panic!("PGlite package is required when RIVETOS_TEST_EMBEDDED_PG=1 ({error})")
        });
        let home = temp_home("pglite-migrate");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("home");
        let data_dir = home.join(".rivetos").join("pglite");
        let manifest = home.join("manifest.json");
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/pglite_export.mjs");
        let migrations = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../plugins/memory/postgres/src/schema/migrations");
        assert!(
            migrations.join("0001_baseline.sql").is_file(),
            "memory migrations are missing at {}",
            migrations.display()
        );
        let mut command = tokio::process::Command::new("node");
        command
            .arg(&script)
            .arg("--seed")
            .arg("--data-dir")
            .arg(&data_dir)
            .arg("--pglite")
            .arg(&paths.entry)
            .arg("--migrations")
            .arg(&migrations)
            .arg("--manifest")
            .arg(&manifest)
            .kill_on_drop(true)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if let Some(vector) = &paths.vector {
            command.arg("--vector").arg(vector);
        }
        if let Some(trgm) = &paths.trgm {
            command.arg("--trgm").arg(trgm);
        }
        let child = command.spawn().expect("node");
        crate::process::wait_child(child, SETUP_TIMEOUT)
            .await
            .expect("seed");
        let manifest_text = std::fs::read_to_string(&manifest).expect("manifest");
        let manifest_value: Value = serde_json::from_str(&manifest_text).expect("manifest json");
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let config = json!({
            "memory": {"postgres": {"embedded": {
                "port": port,
                "max_connections": 16,
                "data_dir": data_dir.display().to_string()
            }}}
        });
        let mut env = MapEnv::new();
        env.set("RIVETOS_ROOT", root.display().to_string());
        let mut resolved = resolve_embedded_pg(&config, &home, None).expect("resolved");
        use_shared_binaries(&mut resolved);
        let mut handle = acquire_embedded_pg_with(resolved, &TracingLog, Some(listener), &env)
            .await
            .expect("migrate");
        let mut client = PgClient::connect(handle.pg_url()).await.expect("connect");
        let database = client
            .query_text("SELECT current_database()")
            .await
            .expect("database");
        assert_eq!(database.as_deref(), Some("postgres"));
        let search_path = client.query_text("SHOW search_path").await.expect("search");
        assert_eq!(search_path.as_deref(), Some("\"$user\", public"));
        let content = client
            .query_text("SELECT content FROM ros_messages WHERE content = 'sample message'")
            .await
            .expect("content");
        assert_eq!(content.as_deref(), Some("sample message"));
        let tsv = client
            .query_text("SELECT content_tsv::text FROM ros_messages")
            .await
            .expect("tsv");
        assert!(tsv.as_deref().is_some_and(|text| !text.is_empty()));
        let ledger = client
            .query_i64("SELECT count(*)::bigint FROM _rivetos_migrations")
            .await
            .expect("ledger");
        assert_eq!(ledger, 20);
        for name in ["0001_baseline.sql", "0019_tags.sql"] {
            let found = client
                .query_one_text(
                    "SELECT name FROM _rivetos_migrations WHERE name = $1::text",
                    &[Some(name.to_string())],
                )
                .await
                .expect("name");
            assert_eq!(found.as_deref(), Some(name));
        }
        let tables = manifest_value
            .get("tables")
            .and_then(Value::as_object)
            .expect("tables");
        for (key, entry) in tables {
            let name = entry.get("name").and_then(Value::as_str).expect("name");
            let schema = entry.get("schema").and_then(Value::as_str).expect("schema");
            if name == "_rivetos_migrations" || schema == "graphile_worker" {
                continue;
            }
            let expected = entry
                .get("count")
                .and_then(Value::as_str)
                .expect("count")
                .parse::<i64>()
                .expect("count int");
            let got = count_table(&mut client, schema, name).await.expect("count");
            assert_eq!(got, expected, "{key}");
            if let Some(sample) = entry.get("sample").and_then(|value| value.as_object())
                && let Some(aliases) = sample.get("aliases").and_then(Value::as_str)
            {
                let copied = client
                    .query_text(&format!(
                        "SELECT aliases::text FROM {}.{}",
                        quote_ident(schema),
                        quote_ident(name)
                    ))
                    .await
                    .expect("aliases");
                assert_eq!(copied.as_deref(), Some(aliases));
            }
        }
        let generated = client
            .query_one_text(
                "SELECT a.attgenerated::text FROM pg_attribute a \
                 JOIN pg_class c ON c.oid = a.attrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = 'public' AND c.relname = 'ros_messages' AND a.attname = 'content_tsv'",
                &[],
            )
            .await
            .expect("generated");
        assert_eq!(generated.as_deref(), Some("s"));
        client
            .batch(
                "INSERT INTO ros_conversations (session_key, agent) VALUES ('default-session', 'default-agent')",
                COMMAND_TIMEOUT,
            )
            .await
            .expect("default insert");
        let fresh = client
            .query_text(
                "SELECT id::text FROM ros_conversations WHERE session_key = 'default-session'",
            )
            .await
            .expect("fresh id");
        assert!(fresh.as_deref().is_some_and(|id| !id.is_empty()));
        let links = manifest_value
            .get("links")
            .and_then(Value::as_object)
            .expect("links");
        assert_eq!(links.get("ros_tasks").and_then(Value::as_str), Some("1"));
        assert_eq!(
            links.get("ros_summaries").and_then(Value::as_str),
            Some("100")
        );
        let task_links = client
            .query_i64("SELECT count(*)::bigint FROM ros_tasks WHERE parent_task_id IS NOT NULL")
            .await
            .expect("task links");
        assert_eq!(task_links, 1);
        let summary_links = client
            .query_i64("SELECT count(*)::bigint FROM ros_summaries WHERE parent_id IS NOT NULL")
            .await
            .expect("summary links");
        assert_eq!(summary_links, 100);
        let joined = client
            .query_i64(
                "SELECT count(*)::bigint FROM ros_summaries c JOIN ros_summaries p ON p.id = c.parent_id",
            )
            .await
            .expect("joined summaries");
        assert_eq!(joined, 100);
        let job_count = client
            .query_text("SELECT to_regprocedure('graphile_worker.job_count()')::text")
            .await
            .expect("job_count");
        assert_eq!(job_count, None);
        let revision = client
            .query_text("SELECT max(id)::text FROM graphile_worker.migrations")
            .await
            .expect("revision");
        assert_eq!(revision.as_deref(), Some("19"));
        let view_kind = client
            .query_text(
                "SELECT c.relkind::text FROM pg_class c \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = 'graphile_worker' AND c.relname = 'jobs'",
            )
            .await
            .expect("jobs view");
        assert_eq!(view_kind.as_deref(), Some("v"));
        let main_index = client
            .query_text(
                "SELECT indexname FROM pg_indexes WHERE schemaname = 'graphile_worker' AND indexname = 'jobs_main_index'",
            )
            .await
            .expect("jobs_main_index");
        assert_eq!(main_index.as_deref(), Some("jobs_main_index"));
        let old_index = client
            .query_text(
                "SELECT indexname FROM pg_indexes WHERE schemaname = 'graphile_worker' AND indexname = 'jobs_state'",
            )
            .await
            .expect("jobs_state");
        assert_eq!(old_index, None);
        for (table, expected) in [
            ("_private_jobs", "graphile_worker.jobs_id_seq1"),
            ("_private_tasks", "graphile_worker.tasks_id_seq"),
            ("_private_job_queues", "graphile_worker.job_queues_id_seq"),
        ] {
            let sequence = client
                .query_one_text(
                    "SELECT pg_get_serial_sequence(format('%I.%I', 'graphile_worker', $1::text), 'id')",
                    &[Some(table.to_string())],
                )
                .await
                .expect("sequence");
            assert_eq!(sequence.as_deref(), Some(expected), "{table}");
            let marker = client
                .query_text(&format!(
                    "SELECT a.attidentity::text FROM pg_attribute a \
                     JOIN pg_class c ON c.oid = a.attrelid \
                     JOIN pg_namespace n ON n.oid = c.relnamespace \
                     WHERE n.nspname = 'graphile_worker' AND c.relname = '{table}' AND a.attname = 'id'"
                ))
                .await
                .expect("identity");
            assert_eq!(marker.as_deref(), Some("a"), "{table}");
        }
        for name in ["jobs_id_seq1", "tasks_id_seq", "job_queues_id_seq"] {
            let last = client
                .query_text(&format!(
                    "SELECT last_value::text FROM graphile_worker.{}",
                    quote_ident(name)
                ))
                .await
                .expect("last_value");
            assert_ne!(last.as_deref(), Some("50"), "{name}");
            assert!(
                last.as_deref().is_some_and(|value| !value.is_empty()),
                "{name}"
            );
        }
        let export_text =
            std::fs::read_to_string(crate::migrate::export_file(&home, &data_dir)).expect("export");
        assert!(export_text.contains("\"op\":\"job\""));
        assert!(export_text.contains("suggest-tags-kept"));
        assert!(!export_text.contains("tasks_id_seq"));
        assert!(!export_text.contains("graphile_worker"));
        assert!(!export_text.contains("should-not-survive"));
        assert!(!export_text.contains("enqueue-unembedded"));
        assert!(!export_text.contains("dead"));
        let message_id = client
            .query_one_text(
                "SELECT id::text FROM ros_messages WHERE content = $1::text",
                &[Some("unembedded backlog message text".to_string())],
            )
            .await
            .expect("backlog id")
            .expect("backlog row");
        let embed = client
            .query_one_text(
                "SELECT j.payload::text FROM graphile_worker._private_jobs j \
                 JOIN graphile_worker._private_tasks t ON t.id = j.task_id \
                 WHERE t.identifier = 'embed-target' AND position($1::text in j.payload::text) > 0",
                &[Some(message_id.clone())],
            )
            .await
            .expect("embed");
        assert!(
            embed
                .as_deref()
                .is_some_and(|text| text.contains(&message_id))
        );
        let leaked = client
            .query_i64(
                "SELECT count(*)::bigint FROM graphile_worker._private_jobs WHERE payload::text LIKE '%should-not-survive%'",
            )
            .await
            .expect("leaked embed");
        assert_eq!(leaked, 0);
        let dead = client
            .query_i64(
                "SELECT count(*)::bigint FROM graphile_worker._private_jobs WHERE payload::text LIKE '%dead%'",
            )
            .await
            .expect("dead");
        assert_eq!(dead, 0);
        let cron = client
            .query_i64(
                "SELECT count(*)::bigint FROM graphile_worker._private_tasks WHERE identifier = 'enqueue-unembedded'",
            )
            .await
            .expect("cron");
        assert_eq!(cron, 0);
        let tags = client
            .query_one_text(
                "SELECT j.payload::text FROM graphile_worker._private_jobs j \
                 JOIN graphile_worker._private_tasks t ON t.id = j.task_id \
                 WHERE t.identifier = 'suggest-tags'",
                &[],
            )
            .await
            .expect("suggest-tags")
            .expect("suggest-tags payload");
        assert!(tags.contains("suggest-tags-kept"));
        let tag_priority = client
            .query_one_text(
                "SELECT j.priority::text FROM graphile_worker._private_jobs j \
                 JOIN graphile_worker._private_tasks t ON t.id = j.task_id \
                 WHERE t.identifier = 'suggest-tags'",
                &[],
            )
            .await
            .expect("suggest priority");
        assert_eq!(tag_priority.as_deref(), Some("6"));
        let copied_wiki = client
            .query_one_text(
                "SELECT j.payload::text FROM graphile_worker._private_jobs j \
                 JOIN graphile_worker._private_tasks t ON t.id = j.task_id \
                 WHERE t.identifier = 'extract-wiki'",
                &[],
            )
            .await
            .expect("extract-wiki")
            .expect("extract-wiki payload");
        assert!(copied_wiki.contains("extract-wiki"));
        let conversation_id = client
            .query_one_text(
                "SELECT id::text FROM ros_conversations WHERE session_key = 'sample-session'",
                &[],
            )
            .await
            .expect("conversation")
            .expect("conversation id");
        let compact = client
            .query_one_text(
                "SELECT j.payload::text FROM graphile_worker._private_jobs j \
                 JOIN graphile_worker._private_tasks t ON t.id = j.task_id \
                 WHERE t.identifier = 'compact-conversation' AND j.key = $1::text",
                &[Some(conversation_id.clone())],
            )
            .await
            .expect("compact")
            .expect("compact payload");
        assert!(compact.contains(&conversation_id));
        assert!(compact.contains("session_stale"));
        client
            .exec(
                "SELECT graphile_worker.add_job($1::text, $2::text::json, NULL::text, NULL::timestamptz, 5, $3::text, NULL::integer, NULL::text[], 'preserve_run_at')",
                &[
                    Some("embed-target".to_string()),
                    Some(r#"{"targetTable":"ros_messages","targetId":"second-boot"}"#.to_string()),
                    Some("second-boot-marker".to_string()),
                ],
                COMMAND_TIMEOUT,
            )
            .await
            .expect("marker");
        drop(client);
        handle.close().await.expect("close");
        assert!(source_is_migrated(&home, &data_dir).expect("recorded"));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind later");
        let port = listener.local_addr().expect("addr").port();
        let config = json!({
            "memory": {"postgres": {"embedded": {
                "port": port,
                "max_connections": 16,
                "data_dir": data_dir.display().to_string()
            }}}
        });
        let mut resolved = resolve_embedded_pg(&config, &home, None).expect("resolved later");
        use_shared_binaries(&mut resolved);
        let mut again = acquire_embedded_pg_with(resolved, &TracingLog, Some(listener), &env)
            .await
            .expect("later boot");
        let mut client = PgClient::connect(again.pg_url())
            .await
            .expect("connect later");
        let later_revision = client
            .query_text("SELECT max(id)::text FROM graphile_worker.migrations")
            .await
            .expect("later revision");
        assert_eq!(later_revision.as_deref(), Some("19"));
        let kept = client
            .query_one_text(
                "SELECT j.payload::text FROM graphile_worker._private_jobs j WHERE j.key = 'second-boot-marker'",
                &[],
            )
            .await
            .expect("marker later")
            .expect("marker payload");
        assert!(kept.contains("second-boot"));
        let kept_tags = client
            .query_one_text(
                "SELECT j.payload::text FROM graphile_worker._private_jobs j \
                 JOIN graphile_worker._private_tasks t ON t.id = j.task_id \
                 WHERE t.identifier = 'suggest-tags'",
                &[],
            )
            .await
            .expect("tags later")
            .expect("tags payload");
        assert!(kept_tags.contains("suggest-tags-kept"));
        let kept_embed = client
            .query_one_text(
                "SELECT j.payload::text FROM graphile_worker._private_jobs j \
                 JOIN graphile_worker._private_tasks t ON t.id = j.task_id \
                 WHERE t.identifier = 'embed-target' AND position($1::text in j.payload::text) > 0",
                &[Some(message_id)],
            )
            .await
            .expect("embed later");
        assert!(kept_embed.is_some());
        drop(client);
        again.close().await.expect("close later");
        let _ = std::fs::remove_dir_all(&home);
    }
}
