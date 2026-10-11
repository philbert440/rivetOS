use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

use crate::config_resolve::{
    EmbeddedEnv, EmbeddedPgEnv, ResolvedEmbeddedPg, apply_embedded_pg_url, embedded_pg_env,
    embedded_pg_url, require_listen_port, require_max_connections, resolve_embedded_pg_from_env,
};
use crate::error::{LocalDbError, Result, engine_error, extension_error};
use crate::lock::{
    EmbeddedPgLog, LockClaim, PidProbe, claim_owner_lock, embedded_pg_lock_alive, probe_lock_pid,
    read_embedded_pg_lock, release_owner_lock,
};
use crate::migrate::{
    ExportAction, MigrationPlan, SkipReason, clear_work, export_pglite_source, parse_export_line,
    pending_marker, pgdata_dir, plan_migration, record_migrated_sources, source_is_migrated,
};
use crate::paths::{
    backups_dir, cluster_dir_for, expand_tilde, lexical_absolute, real_of_nearest, rivet_dir,
    shell_quote,
};
use crate::process::{clear_stale_postmaster, read_postmaster_pid};
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
        let stopped = self.stop_owned().await;
        let released = self.release_lock().await;
        self.closed = true;
        stopped?;
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
        owned
            .supervisor
            .shutdown(&owned.pg_ctl, &owned.pgdata)
            .await
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
        if let Some(path) = self.lock_path.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

pub async fn acquire_embedded_pg(
    resolved: ResolvedEmbeddedPg,
    log: &dyn EmbeddedPgLog,
) -> Result<EmbeddedPg> {
    acquire_embedded_pg_with(resolved, log, None, &EmbeddedEnv::new()).await
}

pub async fn acquire_embedded_pg_with(
    resolved: ResolvedEmbeddedPg,
    log: &dyn EmbeddedPgLog,
    port_hold: Option<std::net::TcpListener>,
    env: &EmbeddedEnv,
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
    env: &EmbeddedEnv,
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
    clear_work(home).await
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
    time.format("%Y-%m-%dT%H-%M-%S").to_string()
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
    env: &EmbeddedEnv,
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
    let owned = match start_server(&resolved, port, max, port_hold, log).await {
        Ok(owned) => owned,
        Err(error) => {
            let _ = release_owner_lock(&lock_path).await;
            return Err(error);
        }
    };
    let url = embedded_pg_url(i64::from(port));
    if let Err(failure) = configure_started(&url, &resolved, export.as_deref(), log).await {
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
    env: &EmbeddedEnv,
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
    env: &EmbeddedEnv,
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
    let exported = export_pglite_source(
        &resolved.home,
        &resolved.data_dir,
        port,
        env.get("RIVETOS_ROOT"),
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
    log: &dyn EmbeddedPgLog,
) -> Result<OwnedServer> {
    let pgdata = pgdata_dir(&resolved.engine_data_dir);
    let early = find_pg_ctl(&resolved.installation_dir);
    clear_stale_postmaster(&pgdata, early.as_deref(), log).await?;
    remove_incomplete(&pgdata, log).await?;
    let settings = engine_settings(resolved, port, max).await?;
    write_password_file(&settings.password_file, &settings.password).await?;
    ensure_crypto_provider();
    let mut server = postgresql_embedded::PostgreSQL::new(settings);
    setup_cluster(&mut server, &pgdata, log).await?;
    install_pgvector(server.settings()).await?;
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
        return Err(error);
    }
    Ok(())
}

async fn configure_started(
    url: &str,
    resolved: &ResolvedEmbeddedPg,
    export_path: Option<&Path>,
    log: &dyn EmbeddedPgLog,
) -> std::result::Result<(), ConfigureFailure> {
    let client = match PgClient::connect(url).await {
        Ok(client) => client,
        Err(error) => return Err(configure_failure(error, export_path.is_some())),
    };
    if let Err(error) = prepare_database(&client, resolved.lite_mode).await {
        return Err(configure_failure(error, export_path.is_some()));
    }
    if let Some(path) = export_path {
        finish_migration(&client, resolved, path, log).await?;
    }
    Ok(())
}

async fn prepare_database(client: &PgClient, lite: bool) -> Result<()> {
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
    client: &PgClient,
    resolved: &ResolvedEmbeddedPg,
    export_path: &Path,
    log: &dyn EmbeddedPgLog,
) -> std::result::Result<(), ConfigureFailure> {
    if let Err(error) = apply_export(client, export_path, &resolved.data_dir, log).await {
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
) -> Result<postgresql_embedded::Settings> {
    let defaults = postgresql_embedded::Settings::new();
    let leaked_data = defaults.data_dir.clone();
    let leaked_pass = defaults.password_file.parent().map(Path::to_path_buf);
    let releases_url = defaults.releases_url.clone();
    discard_leaked(&leaked_data).await;
    if let Some(dir) = leaked_pass {
        discard_leaked(&dir).await;
    }
    let version = postgresql_embedded::VersionReq::parse("=16").map_err(|error| {
        LocalDbError::message(format!("embedded postgres: postgres version: {error}"))
    })?;
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

async fn ensure_halfvec(client: &PgClient) -> Result<()> {
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

async fn apply_guc(client: &PgClient, lite: bool) -> Result<()> {
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

async fn apply_export(
    client: &PgClient,
    path: &Path,
    source: &Path,
    log: &dyn EmbeddedPgLog,
) -> Result<()> {
    log.info(&format!(
        "embedded postgres: restoring PGlite rows from {}",
        path.display()
    ));
    let file = tokio::fs::File::open(path).await?;
    let reader = tokio::io::BufReader::new(file);
    let mut lines = reader.lines();
    let mut verified = 0u64;
    while let Some(line) = lines.next_line().await? {
        let Some(action) = parse_export_line(&line)? else {
            continue;
        };
        match apply_action(client, action, &mut verified).await {
            Ok(true) => break,
            Ok(false) => {}
            Err(error) => {
                let _ = client.batch("ROLLBACK", COMMAND_TIMEOUT).await;
                return Err(error);
            }
        }
    }
    log.info(&format!("embedded postgres: verified {verified} tables"));
    log.info(&format!(
        "embedded postgres: PGlite directory left in place at {}",
        source.display()
    ));
    Ok(())
}

async fn apply_action(client: &PgClient, action: ExportAction, verified: &mut u64) -> Result<bool> {
    match action {
        ExportAction::Exec(sql) => {
            client.exec(&sql, &[], SETUP_TIMEOUT).await?;
            Ok(false)
        }
        ExportAction::Insert(insert) => {
            client
                .exec(&insert.sql, &insert.params, SETUP_TIMEOUT)
                .await?;
            Ok(false)
        }
        ExportAction::Count {
            schema,
            table,
            expected,
        } => {
            check_count(client, &schema, &table, expected).await?;
            *verified += 1;
            Ok(false)
        }
        ExportAction::Done => Ok(true),
    }
}

async fn check_count(client: &PgClient, schema: &str, table: &str, expected: i64) -> Result<()> {
    let got = count_table(client, schema, table).await?;
    if got == expected {
        return Ok(());
    }
    Err(LocalDbError::message(format!(
        "embedded postgres: PGlite migration row count mismatch for {schema}.{table}: dump {expected}, restored {got}"
    )))
}

async fn count_table(client: &PgClient, schema: &str, table: &str) -> Result<i64> {
    let sql = format!(
        "SELECT count(*)::bigint FROM {}.{}",
        quote_ident(schema),
        quote_ident(table)
    );
    client.query_i64(&sql).await
}

struct PgClient {
    client: tokio_postgres::Client,
}

impl PgClient {
    async fn connect(url: &str) -> Result<Self> {
        let connected = tokio::time::timeout(
            CONNECT_TIMEOUT,
            tokio_postgres::connect(url, tokio_postgres::NoTls),
        )
        .await;
        let (client, connection) = match connected {
            Ok(Ok(pair)) => pair,
            Ok(Err(error)) => return Err(LocalDbError::Postgres(error.to_string())),
            Err(_) => return Err(LocalDbError::Timeout(CONNECT_TIMEOUT)),
        };
        tokio::spawn(async move {
            if let Err(error) = connection.await {
                tracing::warn!(
                    "embedded postgres connection ended: {}",
                    scrub_secret(&error.to_string())
                );
            }
        });
        Ok(Self { client })
    }

    async fn batch(&self, sql: &str, timeout: Duration) -> Result<()> {
        match tokio::time::timeout(timeout, self.client.batch_execute(sql)).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(LocalDbError::Postgres(error.to_string())),
            Err(_) => Err(LocalDbError::Timeout(timeout)),
        }
    }

    async fn exec(&self, sql: &str, params: &[Option<String>], timeout: Duration) -> Result<()> {
        let mut refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> =
            Vec::with_capacity(params.len());
        for param in params {
            refs.push(param);
        }
        match tokio::time::timeout(timeout, self.client.execute(sql, &refs)).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(error)) => Err(LocalDbError::Postgres(error.to_string())),
            Err(_) => Err(LocalDbError::Timeout(timeout)),
        }
    }

    async fn query_i64(&self, sql: &str) -> Result<i64> {
        match tokio::time::timeout(COMMAND_TIMEOUT, self.client.query_one(sql, &[])).await {
            Ok(Ok(row)) => row
                .try_get(0)
                .map_err(|error| LocalDbError::Postgres(error.to_string())),
            Ok(Err(error)) => Err(LocalDbError::Postgres(error.to_string())),
            Err(_) => Err(LocalDbError::Timeout(COMMAND_TIMEOUT)),
        }
    }

    async fn query_text(&self, sql: &str) -> Result<Option<String>> {
        match tokio::time::timeout(COMMAND_TIMEOUT, self.client.query(sql, &[])).await {
            Ok(Ok(rows)) => rows
                .first()
                .map(|row| {
                    row.try_get(0)
                        .map_err(|error| LocalDbError::Postgres(error.to_string()))
                })
                .transpose(),
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
        let path = default_backup_path(Path::new("/tmp/home"), "2026-01-02T03-04-05");
        assert_eq!(
            path,
            PathBuf::from("/tmp/home/.rivetos/backups/postgres-2026-01-02T03-04-05.sql")
        );
        assert_eq!(
            backup_wrote_line(&path),
            "✅ backup wrote /tmp/home/.rivetos/backups/postgres-2026-01-02T03-04-05.sql"
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
        let work = home.join(".rivetos").join("migrate").join("work");
        std::fs::create_dir_all(&work).expect("work");
        std::fs::write(work.join("snapshot"), b"copy").expect("snap");
        let runtime = test_runtime();
        runtime
            .block_on(reset_engine(&home, &cluster))
            .expect("reset");
        assert!(!cluster.exists());
        assert_eq!(
            std::fs::read(source.join("PG_VERSION")).expect("kept"),
            b"18\n"
        );
        assert!(!work.exists());
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
        assert!(
            resolve_embedded_pg_from_env(&config, Path::new("/tmp"), &EmbeddedEnv::new()).is_none()
        );
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
        let env = EmbeddedEnv::new();
        let resolved = resolve_embedded_pg(&config, &home, None).expect("resolved");
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
        let client = PgClient::connect(handle.pg_url()).await.expect("connect");
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
        let again_resolved = resolve_embedded_pg(&config, &home, None).expect("resolved");
        let mut again = acquire_embedded_pg_with(again_resolved, &TracingLog, None, &env)
            .await
            .expect("restart");
        again.close().await.expect("close again");
        let home_full = temp_home("boot-full");
        let _ = std::fs::remove_dir_all(&home_full);
        std::fs::create_dir_all(&home_full).expect("full home");
        let listener_full = std::net::TcpListener::bind("127.0.0.1:0").expect("bind full");
        let port_full = listener_full.local_addr().expect("addr").port();
        let mut full_env = EmbeddedEnv::new();
        full_env.insert("RIVETOS_EMBED_URL", "http://127.0.0.1:9402/v1");
        let full_config = json!({
            "memory": {"postgres": {"embedded": {"port": port_full, "max_connections": 16}}}
        });
        let full_resolved =
            resolve_embedded_pg_from_env(&full_config, &home_full, &full_env).expect("full");
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
}
