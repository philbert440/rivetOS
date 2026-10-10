use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Map, Value};
use tokio::io::AsyncWriteExt;

use crate::config_resolve::{
    EmbeddedPgEnv, ResolvedEmbeddedPg, apply_embedded_pg_url, embedded_pg_env, embedded_pg_url,
    require_listen_port, require_max_connections, resolve_embedded_pg_from_env,
};
use crate::error::{LocalDbError, Result, engine_error, extension_error};
use crate::lock::{
    EmbeddedPgLog, LockClaim, PidProbe, claim_owner_lock, embedded_pg_lock_alive, probe_lock_pid,
    read_embedded_pg_lock, release_owner_lock,
};
use crate::migrate::{
    DumpRequest, MigrationPlan, pending_marker, pgdata_dir, plan_migration, prepare_dump, run_dump,
};
use crate::paths::{backups_dir, lexical_absolute, rivet_dir};
use crate::process::{clear_stale_postmaster, read_postmaster_pid, wait_child};
use crate::sql_compat::{filter_pglite_dump, quote_ident};

pub const ATTACH_BACKUP_ERROR: &str = "stop the node or run backup from it";
pub const EMBEDDED_NOT_CONFIGURED: &str =
    "memory.postgres.embedded is not configured — run rivetos local init";
pub const SETUP_TIMEOUT: Duration = Duration::from_secs(600);
pub const BACKUP_TIMEOUT: Duration = Duration::from_secs(600);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const PGVECTOR_NAMESPACE: &str = "portal-corp";
const PGVECTOR_NAME: &str = "pgvector_compiled";

pub struct EmbeddedPg {
    resolved: ResolvedEmbeddedPg,
    pg_url: String,
    owned: bool,
    lock_path: Option<PathBuf>,
    server: Option<postgresql_embedded::PostgreSQL>,
    closed: bool,
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
        if let Some(server) = self.server.as_ref() {
            server.stop().await.map_err(engine_error)?;
            self.server = None;
        }
        if let Some(path) = self.lock_path.take() {
            release_owner_lock(&path).await?;
        }
        self.closed = true;
        Ok(())
    }

    pub async fn backup(&self, out: &Path) -> Result<()> {
        let server = self
            .server
            .as_ref()
            .ok_or_else(|| LocalDbError::message(ATTACH_BACKUP_ERROR))?;
        if !self.owned {
            return Err(LocalDbError::message(ATTACH_BACKUP_ERROR));
        }
        dump_database(server.settings(), out).await
    }

    pub async fn backup_default(&self, home: &Path) -> Result<PathBuf> {
        let out = default_backup_path(home, &backup_stamp(chrono::Utc::now()));
        self.backup(&out).await?;
        Ok(out)
    }
}

impl Drop for EmbeddedPg {
    fn drop(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        let server = self.server.take();
        let lock_path = self.lock_path.take();
        if server.is_none() && lock_path.is_none() {
            return;
        }
        let _ = std::thread::Builder::new()
            .name("pg-stop".to_string())
            .spawn(move || {
                drop(server);
                if let Some(path) = lock_path {
                    let _ = std::fs::remove_file(path);
                }
            });
    }
}

pub async fn acquire_embedded_pg(
    resolved: ResolvedEmbeddedPg,
    log: &dyn EmbeddedPgLog,
) -> Result<EmbeddedPg> {
    let port = require_listen_port(&resolved)?;
    let max = require_max_connections(&resolved)?;
    let pgdata = pgdata_dir(&resolved.engine_data_dir);
    let pending = pending_marker(&resolved.engine_data_dir);
    let plan = plan_migration(&resolved.data_dir, &pgdata, &pending);
    if matches!(plan, MigrationPlan::Migrate | MigrationPlan::Retry) {
        prepare_dump_parent(&resolved, log).await?;
    }
    if matches!(plan, MigrationPlan::PendingSourceMissing) {
        return Err(LocalDbError::message(format!(
            "embedded postgres: migration is pending at {} but {} is not a PGlite data directory. Run: node {} --data-dir {} --out <sql> --counts <json> --pglite <pglite-entry> --tools <tools-entry>",
            pending.display(),
            resolved.data_dir.display(),
            crate::paths::shell_quote("pglite_dump.mjs"),
            crate::paths::shell_quote(&resolved.data_dir.display().to_string())
        )));
    }
    let claim = claim_owner_lock(
        &resolved.engine_data_dir,
        port,
        log,
        crate::lock::attach_timeout(),
    )
    .await?;
    match claim {
        LockClaim::Attached {
            pid,
            port: _,
            pg_url,
        } => {
            log.info(&format!(
                "embedded postgres: attached to owner pid {pid} at {pg_url}"
            ));
            Ok(EmbeddedPg {
                resolved,
                pg_url,
                owned: false,
                lock_path: None,
                server: None,
                closed: false,
            })
        }
        LockClaim::Owned { lock_path } => {
            let booted = boot_owned(resolved, port, max, lock_path.clone(), log).await;
            if let Err(error) = &booted {
                tracing::error!("embedded postgres: boot failed: {error}");
                let _ = release_owner_lock(&lock_path).await;
            }
            booted
        }
    }
}

pub async fn with_embedded_pg<T, F, Fut>(
    config: &mut Value,
    home: &Path,
    log: &dyn EmbeddedPgLog,
    body: F,
) -> Result<T>
where
    F: FnOnce(&mut EmbeddedPg) -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let Some(resolved) = resolve_embedded_pg_from_env(config, home) else {
        return Err(LocalDbError::message(
            "withEmbeddedPg: memory.postgres.embedded is not configured",
        ));
    };
    let mut handle = acquire_embedded_pg(resolved, log).await?;
    apply_embedded_pg_url(config, handle.pg_url())?;
    let result = body(&mut handle).await;
    let closed = handle.close().await;
    match (result, closed) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

pub async fn reset_engine(home: &Path, target: &Path) -> Result<()> {
    assert_under_rivet(home, target)?;
    if let Some(lock) = read_embedded_pg_lock(target)
        && embedded_pg_lock_alive(&lock)
    {
        return Err(LocalDbError::message(format!(
            "embedded PGlite is still running (pid {}) — stop the node first",
            lock.pid
        )));
    }
    let pgdata = pgdata_dir(target);
    if let Some(pid) = read_postmaster_pid(&pgdata)
        && probe_lock_pid(pid) != PidProbe::Dead
    {
        return Err(LocalDbError::message(format!(
            "embedded PGlite is still running (pid {pid}) — stop the node first"
        )));
    }
    match tokio::fs::remove_dir_all(target).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub fn assert_under_rivet(home: &Path, target: &Path) -> Result<()> {
    let base = lexical_absolute(&rivet_dir(home));
    let resolved = lexical_absolute(target);
    if !resolved.starts_with(&base) {
        return Err(LocalDbError::message(format!(
            "reset refuses to delete {} (outside ~/.rivetos)",
            target.display()
        )));
    }
    Ok(())
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

async fn prepare_dump_parent(resolved: &ResolvedEmbeddedPg, log: &dyn EmbeddedPgLog) -> Result<()> {
    let home = resolved
        .engine_data_dir
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| {
            LocalDbError::message("embedded postgres: engine data dir has no home parent")
        })?;
    prepare_dump(home, &resolved.data_dir, log).await?;
    Ok(())
}

async fn boot_owned(
    resolved: ResolvedEmbeddedPg,
    port: u16,
    max: u32,
    lock_path: PathBuf,
    log: &dyn EmbeddedPgLog,
) -> Result<EmbeddedPg> {
    let pgdata = pgdata_dir(&resolved.engine_data_dir);
    let pending = pending_marker(&resolved.engine_data_dir);
    let plan = plan_migration(&resolved.data_dir, &pgdata, &pending);
    let mut dumped: Option<DumpRequest> = None;
    if matches!(plan, MigrationPlan::Migrate | MigrationPlan::Retry) {
        if matches!(plan, MigrationPlan::Retry) {
            log.info("embedded postgres: retrying an incomplete PGlite migration");
            clear_dir(&pgdata).await?;
        }
        log.info(&format!(
            "embedded postgres: migrating PGlite data from {} to {}",
            resolved.data_dir.display(),
            pgdata.display()
        ));
        let home = home_from_engine(&resolved.engine_data_dir)?;
        let request = prepare_dump(home, &resolved.data_dir, log).await?;
        if let Err(error) = run_dump(&request, log).await {
            let _ = release_owner_lock(&lock_path).await;
            return Err(error);
        }
        write_pending(&pending).await?;
        dumped = Some(request);
    }
    let started = std::time::Instant::now();
    let server = match start_server(&resolved, port, max, log).await {
        Ok(server) => server,
        Err(error) => {
            let _ = release_owner_lock(&lock_path).await;
            return Err(error);
        }
    };
    let url = embedded_pg_url(i64::from(server.settings().port));
    let configured = configure_server(&url, resolved.lite_mode, dumped.as_ref(), log).await;
    if let Err(error) = configured {
        let _ = server.stop().await;
        if dumped.is_some() {
            let _ = clear_dir(&pgdata).await;
        }
        drop(server);
        let _ = release_owner_lock(&lock_path).await;
        return Err(error);
    }
    if dumped.is_some() {
        let _ = tokio::fs::remove_file(&pending).await;
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
        server: Some(server),
        closed: false,
    })
}

async fn start_server(
    resolved: &ResolvedEmbeddedPg,
    port: u16,
    max: u32,
    log: &dyn EmbeddedPgLog,
) -> Result<postgresql_embedded::PostgreSQL> {
    let pgdata = pgdata_dir(&resolved.engine_data_dir);
    clear_stale_postmaster(&pgdata, log).await?;
    let settings = engine_settings(resolved, port, max).await?;
    write_password_file(&settings.password_file, &settings.password).await?;
    ensure_crypto_provider();
    let mut server = postgresql_embedded::PostgreSQL::new(settings);
    with_timeout(SETUP_TIMEOUT, async {
        server.setup().await.map_err(engine_error)
    })
    .await?;
    install_pgvector(server.settings()).await?;
    clear_stale_postmaster(&pgdata, log).await?;
    with_timeout(COMMAND_TIMEOUT + Duration::from_secs(30), async {
        server.start().await.map_err(engine_error)
    })
    .await?;
    Ok(server)
}

async fn configure_server(
    url: &str,
    lite: bool,
    dumped: Option<&DumpRequest>,
    log: &dyn EmbeddedPgLog,
) -> Result<()> {
    let client = PgClient::connect(url).await?;
    client
        .batch("CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;")
        .await?;
    ensure_halfvec(&client).await?;
    apply_guc(&client, lite).await?;
    if let Some(dump) = dumped {
        restore_dump(&client, dump, log).await?;
    }
    Ok(())
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
    let mut configuration = HashMap::from([
        ("listen_addresses".to_string(), "127.0.0.1".to_string()),
        ("max_connections".to_string(), max.to_string()),
    ]);
    #[cfg(unix)]
    {
        configuration.insert(
            "unix_socket_directories".to_string(),
            resolved.engine_data_dir.to_string_lossy().to_string(),
        );
    }
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
            )
            .await
    } else {
        match client
            .batch(
                "ALTER DATABASE postgres RESET rivet.defer_embed_enqueue; ALTER ROLE postgres RESET rivet.defer_embed_enqueue; RESET rivet.defer_embed_enqueue;",
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

async fn restore_dump(
    client: &PgClient,
    dump: &DumpRequest,
    log: &dyn EmbeddedPgLog,
) -> Result<()> {
    let sql = tokio::fs::read_to_string(&dump.sql_out).await?;
    let filtered = filter_pglite_dump(&sql);
    log.info(&format!(
        "embedded postgres: restoring {} bytes into embedded postgres",
        filtered.len()
    ));
    client.batch(&filtered).await?;
    let counts_text = tokio::fs::read_to_string(&dump.counts_out).await?;
    let counts: Map<String, Value> = serde_json::from_str(&counts_text)
        .map_err(|error| LocalDbError::Json(error.to_string()))?;
    for (table, expected) in &counts {
        let Some(expected) = json_i64(expected) else {
            return Err(LocalDbError::message(format!(
                "embedded postgres: PGlite migration count for {table} is not an integer"
            )));
        };
        let got = count_table(client, table).await?;
        if got != expected {
            return Err(LocalDbError::message(format!(
                "embedded postgres: PGlite migration row count mismatch for {table}: dump {expected}, restored {got}"
            )));
        }
    }
    log.info(&format!(
        "embedded postgres: verified {} tables",
        counts.len()
    ));
    log.info(&format!(
        "embedded postgres: PGlite directory left in place at {}",
        dump.source.display()
    ));
    Ok(())
}

async fn count_table(client: &PgClient, table: &str) -> Result<i64> {
    let (schema, name) = table
        .split_once('.')
        .ok_or_else(|| LocalDbError::message(format!("embedded postgres: bad table id {table}")))?;
    let sql = format!(
        "SELECT count(*)::bigint FROM {}.{}",
        quote_ident(schema),
        quote_ident(name)
    );
    client.query_i64(&sql).await
}

fn json_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
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
                tracing::warn!("embedded postgres connection ended: {error}");
            }
        });
        Ok(Self { client })
    }

    async fn batch(&self, sql: &str) -> Result<()> {
        self.client
            .batch_execute(sql)
            .await
            .map_err(|error| LocalDbError::Postgres(error.to_string()))
    }

    async fn query_i64(&self, sql: &str) -> Result<i64> {
        let row = self
            .client
            .query_one(sql, &[])
            .await
            .map_err(|error| LocalDbError::Postgres(error.to_string()))?;
        Ok(row.get(0))
    }

    async fn query_text(&self, sql: &str) -> Result<Option<String>> {
        let rows = self
            .client
            .query(sql, &[])
            .await
            .map_err(|error| LocalDbError::Postgres(error.to_string()))?;
        Ok(rows.first().map(|row| row.get(0)))
    }
}

async fn dump_database(settings: &postgresql_embedded::Settings, out: &Path) -> Result<()> {
    if let Some(parent) = out.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let tmp = out.with_extension(format!("sql.{}.tmp", std::process::id()));
    let file = create_mode(&tmp, 0o600).await?;
    let std_file = file.into_std().await;
    let bin = settings.binary_dir().join("pg_dump");
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
    let dumped = wait_child(child, BACKUP_TIMEOUT).await;
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
    Ok(())
}

async fn write_pending(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut file = create_mode(path, 0o600).await?;
    file.write_all(b"pending").await?;
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

async fn discard_leaked(path: &Path) {
    if path.starts_with(std::env::temp_dir()) {
        let _ = tokio::fs::remove_dir_all(path).await;
    }
}

fn home_from_engine(engine_dir: &Path) -> Result<&Path> {
    engine_dir.parent().and_then(Path::parent).ok_or_else(|| {
        LocalDbError::message("embedded postgres: engine data dir has no home parent")
    })
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

#[cfg(test)]
mod tests {
    use super::*;
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
    fn reset_refuses_a_path_outside_the_rivet_dir_and_a_live_owner() {
        let home = std::env::temp_dir().join(format!(
            "local-db-reset-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0)
        ));
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
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("rt");
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
    fn not_configured_message_is_embedded_only() {
        assert_eq!(
            EMBEDDED_NOT_CONFIGURED,
            "memory.postgres.embedded is not configured — run rivetos local init"
        );
        assert_eq!(ATTACH_BACKUP_ERROR, "stop the node or run backup from it");
        let config = json!({});
        assert!(resolve_embedded_pg_from_env(&config, Path::new("/tmp")).is_none());
    }

    #[tokio::test]
    async fn boots_embedded_postgres_when_enabled() {
        if std::env::var("RIVETOS_TEST_EMBEDDED_PG").ok().as_deref() != Some("1") {
            return;
        }
        let home = std::env::temp_dir().join(format!(
            "local-db-boot-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("home");
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        drop(listener);
        let config = json!({
            "memory": {"postgres": {"embedded": {"port": port, "max_connections": 16}}}
        });
        let resolved = resolve_embedded_pg_from_env(&config, &home).expect("resolved");
        let mut handle = acquire_embedded_pg(resolved.clone(), &TracingLog)
            .await
            .expect("boot");
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
        let again_config = json!({
            "memory": {"postgres": {"embedded": {"port": port, "max_connections": 16}}}
        });
        let again_resolved = resolve_embedded_pg_from_env(&again_config, &home).expect("resolved");
        let mut again = acquire_embedded_pg(again_resolved, &TracingLog)
            .await
            .expect("restart");
        again.close().await.expect("close again");
        let _ = std::fs::remove_dir_all(&home);
    }
}
