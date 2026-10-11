use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use tokio::io::AsyncWriteExt;

use crate::config_resolve::{embedded_pg_env, embedded_pg_url};
use crate::error::{LocalDbError, Result};
use crate::lock::{
    EmbeddedPgLog, FileLock, LockClaim, claim_owner_lock, embedded_pg_lock_alive,
    read_embedded_pg_lock, release_owner_lock,
};
use crate::paths::{lexical_absolute, migrate_dir, shell_quote};
use crate::process::wait_child;
use crate::sql_compat::quote_ident;

pub const MIGRATE_PENDING_FILE: &str = "rivetos-migrate-pending";
pub const EXPORT_TIMEOUT: Duration = Duration::from_secs(600);
const NODE_PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const LEDGER_LOCK_TIMEOUT: Duration = Duration::from_secs(30);
const LOCKFILE: &str = "rivetos-owner.lock";

const EXPORT_SCRIPT: &str = include_str!("pglite_export.mjs");

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkipReason {
    SamePath,
    SourceMissing,
    SourceNotPglite,
    DestinationInitialized,
    AlreadyMigrated,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MigrationPlan {
    Skip(SkipReason),
    Migrate,
    Retry,
    PendingSourceMissing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PglitePaths {
    pub entry: PathBuf,
    pub vector: Option<PathBuf>,
    pub trgm: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportRequest {
    pub source_copy: PathBuf,
    pub script: PathBuf,
    pub export_out: PathBuf,
    pub pglite_entry: PathBuf,
    pub vector_entry: Option<PathBuf>,
    pub trgm_entry: Option<PathBuf>,
    pub pg_url: String,
    pub command: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundInsert {
    pub sql: String,
    pub params: Vec<Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowBatch {
    pub schema: String,
    pub table: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DestColumn {
    pub name: String,
    pub type_name: String,
    pub generated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExportAction {
    Exec(String),
    Insert(RowBatch),
    Count {
        schema: String,
        table: String,
        expected: i64,
    },
    Setval {
        schema: String,
        name: String,
        last: String,
        called: bool,
    },
    Ddl(String),
    Done,
}

#[derive(Debug, Serialize, Deserialize)]
struct MigratedFile {
    sources: Vec<String>,
}

struct LedgerLock {
    _held: FileLock,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypedName {
    pub name: String,
    pub type_name: String,
}

pub fn pending_marker(engine_dir: &Path) -> PathBuf {
    engine_dir.join(MIGRATE_PENDING_FILE)
}

pub fn pgdata_dir(engine_dir: &Path) -> PathBuf {
    engine_dir.join("pgdata")
}

pub fn migrated_record(home: &Path) -> PathBuf {
    migrate_dir(home).join("migrated-sources.json")
}

pub fn work_dir(home: &Path) -> PathBuf {
    migrate_dir(home).join("work")
}

pub fn store_work_dir(home: &Path, source: &Path) -> PathBuf {
    work_dir(home).join(store_slug(source))
}

pub fn plan_migration(
    source: &Path,
    pgdata: &Path,
    pending: &Path,
    already_migrated: bool,
) -> MigrationPlan {
    if same_path(source, pgdata)
        || pgdata
            .parent()
            .is_some_and(|parent| same_path(source, parent))
    {
        return MigrationPlan::Skip(SkipReason::SamePath);
    }
    if already_migrated {
        return MigrationPlan::Skip(SkipReason::AlreadyMigrated);
    }
    let source_is_pg = source.join("PG_VERSION").is_file();
    if pending.is_file() {
        if source_is_pg {
            MigrationPlan::Retry
        } else {
            MigrationPlan::PendingSourceMissing
        }
    } else if !source.exists() {
        MigrationPlan::Skip(SkipReason::SourceMissing)
    } else if !source_is_pg {
        MigrationPlan::Skip(SkipReason::SourceNotPglite)
    } else if pgdata.join("PG_VERSION").is_file() || pgdata.join("postgresql.conf").is_file() {
        MigrationPlan::Skip(SkipReason::DestinationInitialized)
    } else {
        MigrationPlan::Migrate
    }
}

pub fn node_missing_message(command: &str) -> String {
    format!("embedded postgres: no node available to export PGlite. Run: {command}")
}

pub fn load_migrated(home: &Path) -> Result<Vec<String>> {
    let path = migrated_record(home);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let parsed: MigratedFile = serde_json::from_str(&text)
        .map_err(|error| LocalDbError::Json(format!("{}: {error}", path.display())))?;
    Ok(parsed.sources)
}

pub fn source_is_migrated(home: &Path, source: &Path) -> Result<bool> {
    let key = source_key(source);
    Ok(load_migrated(home)?.iter().any(|item| item == &key))
}

pub async fn record_migrated_sources(home: &Path, sources: &[PathBuf]) -> Result<()> {
    let _lock = LedgerLock::acquire(home).await?;
    let mut existing = load_migrated(home)?;
    for source in sources {
        let key = source_key(source);
        if !existing.iter().any(|item| item == &key) {
            existing.push(key);
        }
    }
    let body = serde_json::to_vec(&MigratedFile { sources: existing })
        .map_err(|error| LocalDbError::Json(error.to_string()))?;
    let path = migrated_record(home);
    tokio::task::spawn_blocking(move || protocol::host::atomic_replace(&path, &body))
        .await
        .map_err(|error| LocalDbError::message(error.to_string()))?
        .map_err(LocalDbError::from)
}

pub async fn clear_store_work(home: &Path, source: &Path) -> Result<()> {
    remove_dir_if_present(&store_work_dir(home, source)).await
}

pub fn copy_this_table(table: &str) -> bool {
    table != "_rivetos_migrations"
}

pub fn missing_relation_message(schema: &str, name: &str) -> String {
    format!(
        "embedded postgres: PGlite migration refused: destination has no relation {schema}.{name}; refusing to record a partial migration"
    )
}

pub fn mask_self_link_columns(
    columns: &[String],
    rows: &[Vec<Option<String>>],
    self_columns: &[String],
) -> Result<Vec<Vec<Option<String>>>> {
    let indexes = column_indexes(columns, self_columns)?;
    let mut masked = Vec::with_capacity(rows.len());
    for row in rows {
        if row.len() != columns.len() {
            return Err(LocalDbError::message(
                "embedded postgres: PGlite self-link row has the wrong width",
            ));
        }
        let mut next = row.clone();
        for index in &indexes {
            next[*index] = None;
        }
        masked.push(next);
    }
    Ok(masked)
}

pub fn plan_self_link_updates(
    schema: &str,
    table: &str,
    keys: &[TypedName],
    links: &[TypedName],
    columns: &[String],
    rows: &[Vec<Option<String>>],
) -> Result<Vec<BoundInsert>> {
    if keys.is_empty() || links.is_empty() {
        return Ok(Vec::new());
    }
    let key_names = keys
        .iter()
        .map(|column| column.name.clone())
        .collect::<Vec<_>>();
    let link_names = links
        .iter()
        .map(|column| column.name.clone())
        .collect::<Vec<_>>();
    let key_indexes = column_indexes(columns, &key_names)?;
    let link_indexes = column_indexes(columns, &link_names)?;
    let mut pending = Vec::new();
    for row in rows {
        if row.len() != columns.len() {
            return Err(LocalDbError::message(
                "embedded postgres: PGlite self-link row has the wrong width",
            ));
        }
        if link_indexes.iter().all(|index| row[*index].is_none()) {
            continue;
        }
        let mut values = Vec::with_capacity(keys.len() + links.len());
        for index in &key_indexes {
            values.push(row[*index].clone());
        }
        for index in &link_indexes {
            values.push(row[*index].clone());
        }
        pending.push(values);
    }
    let mut plans = Vec::new();
    for chunk in pending.chunks(100) {
        plans.push(self_link_update(schema, table, keys, links, chunk));
    }
    Ok(plans)
}

fn column_indexes(columns: &[String], wanted: &[String]) -> Result<Vec<usize>> {
    let mut indexes = Vec::with_capacity(wanted.len());
    for name in wanted {
        let Some(index) = columns.iter().position(|column| column == name) else {
            return Err(LocalDbError::message(format!(
                "embedded postgres: PGlite export is missing column {name}"
            )));
        };
        indexes.push(index);
    }
    Ok(indexes)
}

fn self_link_update(
    schema: &str,
    table: &str,
    keys: &[TypedName],
    links: &[TypedName],
    rows: &[Vec<Option<String>>],
) -> BoundInsert {
    let mut params = Vec::new();
    let mut tuples = Vec::new();
    let mut number = 1usize;
    let width = keys.len() + links.len();
    for row in rows {
        let mut places = Vec::with_capacity(width);
        for (offset, column) in keys.iter().chain(links.iter()).enumerate() {
            places.push(format!("(${number}::text)::{}", column.type_name));
            params.push(row.get(offset).cloned().flatten());
            number += 1;
        }
        tuples.push(format!("({})", places.join(", ")));
    }
    let value_names = keys
        .iter()
        .chain(links.iter())
        .map(|column| quote_ident(&column.name))
        .collect::<Vec<_>>()
        .join(", ");
    let assignments = links
        .iter()
        .map(|column| {
            let quoted = quote_ident(&column.name);
            format!("{quoted} = v.{quoted}")
        })
        .collect::<Vec<_>>()
        .join(", ");
    let predicate = keys
        .iter()
        .map(|column| {
            let quoted = quote_ident(&column.name);
            format!("t.{quoted} = v.{quoted}")
        })
        .collect::<Vec<_>>()
        .join(" AND ");
    BoundInsert {
        sql: format!(
            "UPDATE {}.{} AS t SET {assignments} FROM (VALUES {}) AS v({value_names}) WHERE {predicate}",
            quote_ident(schema),
            quote_ident(table),
            tuples.join(", ")
        ),
        params,
    }
}

pub fn setval_statement() -> &'static str {
    "SELECT setval(format('%I.%I', $1::text, $2::text)::regclass, $3::text::bigint, $4::text::boolean)"
}

pub fn plan_insert(
    schema: &str,
    table: &str,
    export_columns: &[String],
    dest: &[DestColumn],
    rows: &[Vec<Option<String>>],
) -> Result<Option<BoundInsert>> {
    let mut kept = Vec::new();
    for (index, name) in export_columns.iter().enumerate() {
        let Some(column) = dest.iter().find(|column| &column.name == name) else {
            continue;
        };
        if column.generated {
            continue;
        }
        kept.push((index, name.clone(), column.type_name.clone()));
    }
    if kept.is_empty() || rows.is_empty() {
        return Ok(None);
    }
    let mut params = Vec::new();
    let mut tuples = Vec::new();
    let mut number = 1usize;
    for row in rows {
        if row.len() != export_columns.len() {
            return Err(LocalDbError::message(format!(
                "embedded postgres: PGlite insert row for {schema}.{table} has the wrong width"
            )));
        }
        let mut places = Vec::new();
        for (index, _, type_name) in &kept {
            places.push(format!("(${number}::text)::{type_name}"));
            params.push(row[*index].clone());
            number += 1;
        }
        tuples.push(format!("({})", places.join(", ")));
    }
    let listed = kept
        .iter()
        .map(|(_, name, _)| quote_ident(name))
        .collect::<Vec<_>>()
        .join(", ");
    Ok(Some(BoundInsert {
        sql: format!(
            "INSERT INTO {}.{} ({listed}) VALUES {}",
            quote_ident(schema),
            quote_ident(table),
            tuples.join(", ")
        ),
        params,
    }))
}

pub fn parse_export_line(line: &str) -> Result<Option<ExportAction>> {
    let line = line.trim();
    if line.is_empty() {
        return Ok(None);
    }
    let value: Value = serde_json::from_str(line)
        .map_err(|error| LocalDbError::Json(format!("PGlite export line: {error}")))?;
    let op = value
        .get("op")
        .and_then(Value::as_str)
        .ok_or_else(|| LocalDbError::message("embedded postgres: PGlite export line has no op"))?;
    let action = match op {
        "begin" => ExportAction::Exec("BEGIN".to_string()),
        "commit" => ExportAction::Exec("COMMIT".to_string()),
        "insert" => ExportAction::Insert(parse_insert(&value)?),
        "count" => ExportAction::Count {
            schema: required_str(&value, "schema")?,
            table: required_str(&value, "table")?,
            expected: required_i64(&value, "n")?,
        },
        "setval" => ExportAction::Setval {
            schema: required_str(&value, "schema")?,
            name: required_str(&value, "name")?,
            last: sequence_last(&value)?,
            called: value
                .get("called")
                .and_then(Value::as_bool)
                .ok_or_else(|| {
                    LocalDbError::message("embedded postgres: PGlite setval needs called")
                })?,
        },
        "ddl" => ExportAction::Ddl(required_str(&value, "sql")?),
        "done" => ExportAction::Done,
        other => {
            return Err(LocalDbError::message(format!(
                "embedded postgres: unknown PGlite export op {other}"
            )));
        }
    };
    Ok(Some(action))
}

pub async fn guard_pglite_source(
    source: &Path,
    port: u16,
    log: &dyn EmbeddedPgLog,
) -> Result<Option<PathBuf>> {
    if let Some(lock) = read_embedded_pg_lock(source)
        && embedded_pg_lock_alive(&lock)
    {
        return Err(still_running(lock.pid));
    }
    match claim_owner_lock(source, port, log, Duration::from_millis(300)).await? {
        LockClaim::Owned { lock_path } => Ok(Some(lock_path)),
        LockClaim::Attached { pid, .. } => Err(still_running(pid)),
    }
}

pub async fn snapshot_source(source: &Path, dest: &Path) -> Result<()> {
    copy_tree(source, dest).await
}

pub async fn export_pglite_source(
    home: &Path,
    source: &Path,
    port: u16,
    rivet_root: Option<&str>,
    log: &dyn EmbeddedPgLog,
) -> Result<PathBuf> {
    let held = guard_pglite_source(source, port, log).await?;
    clear_store_work(home, source).await?;
    let snap = store_work_dir(home, source).join("snapshot");
    let copied = snapshot_source(source, &snap).await;
    if let Some(path) = &held {
        release_owner_lock(path).await?;
    }
    copied?;
    log.info(&format!(
        "embedded postgres: copied PGlite source {} to {} without modifying the source",
        source.display(),
        snap.display()
    ));
    let request = prepare_export(home, source, &snap, rivet_root, port, log).await?;
    run_export(&request, log).await?;
    Ok(request.export_out)
}

pub fn package_entry(dir: &Path, export_key: &str) -> Result<PathBuf> {
    let text = std::fs::read_to_string(dir.join("package.json")).map_err(|error| {
        LocalDbError::message(format!(
            "embedded postgres: cannot read {}/package.json: {error}",
            dir.display()
        ))
    })?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| LocalDbError::Json(format!("{}: {error}", dir.display())))?;
    let relative = entry_relative(&value, export_key).ok_or_else(|| {
        LocalDbError::message(format!(
            "embedded postgres: {} has no entry for {export_key}",
            dir.display()
        ))
    })?;
    Ok(dir.join(relative))
}

pub fn locate_pglite(root: &Path) -> Result<PglitePaths> {
    let pglite_boot = join_rel(&[
        "packages",
        "boot",
        "node_modules",
        "@electric-sql",
        "pglite",
    ]);
    let vector_boot = join_rel(&[
        "packages",
        "boot",
        "node_modules",
        "@electric-sql",
        "pglite-pgvector",
    ]);
    let pglite_dir = find_package(
        root,
        &["node_modules/@electric-sql/pglite", pglite_boot.as_str()],
    )?;
    let entry = package_entry(&pglite_dir, ".")?;
    let vector = find_package(
        root,
        &[
            "node_modules/@electric-sql/pglite-pgvector",
            vector_boot.as_str(),
        ],
    )
    .ok()
    .and_then(|dir| package_entry(&dir, ".").ok());
    let trgm = package_entry(&pglite_dir, "./contrib/pg_trgm").ok();
    Ok(PglitePaths {
        entry,
        vector,
        trgm,
    })
}

async fn prepare_export(
    home: &Path,
    source: &Path,
    source_copy: &Path,
    rivet_root: Option<&str>,
    port: u16,
    log: &dyn EmbeddedPgLog,
) -> Result<ExportRequest> {
    let Some(root) = rivet_root.filter(|value| !value.is_empty()) else {
        let command = fallback_command(home, source);
        return Err(LocalDbError::message(format!(
            "embedded postgres: RIVETOS_ROOT is not set, so @electric-sql/pglite cannot be located. {}",
            node_missing_message(&command)
        )));
    };
    let paths = locate_pglite(Path::new(root))?;
    let work = store_work_dir(home, source);
    tokio::fs::create_dir_all(&work).await?;
    let script = work.join("pglite_export.mjs");
    write_script(&script).await?;
    let request = ExportRequest {
        source_copy: source_copy.to_path_buf(),
        script,
        export_out: work.join("pglite-export.jsonl"),
        pglite_entry: paths.entry,
        vector_entry: paths.vector,
        trgm_entry: paths.trgm,
        pg_url: embedded_pg_url(i64::from(port)),
        command: String::new(),
    };
    let command = export_command(&request);
    let request = ExportRequest { command, ..request };
    ensure_node(&request.command).await?;
    log.info(&format!(
        "embedded postgres: PGlite export command prepared: {}",
        request.command
    ));
    Ok(request)
}

async fn run_export(request: &ExportRequest, log: &dyn EmbeddedPgLog) -> Result<()> {
    log.info(&format!(
        "embedded postgres: exporting PGlite rows from {}",
        request.source_copy.display()
    ));
    let mut command = tokio::process::Command::new("node");
    command
        .arg(&request.script)
        .arg("--data-dir")
        .arg(&request.source_copy)
        .arg("--out")
        .arg(&request.export_out)
        .arg("--pglite")
        .arg(&request.pglite_entry)
        .kill_on_drop(true)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if let Some(vector) = &request.vector_entry {
        command.arg("--vector").arg(vector);
    }
    if let Some(trgm) = &request.trgm_entry {
        command.arg("--trgm").arg(trgm);
    }
    embedded_pg_env(&request.pg_url).apply_to_tokio(&mut command);
    let child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            LocalDbError::message(node_missing_message(&request.command))
        } else {
            LocalDbError::Io(error)
        }
    })?;
    wait_child(child, EXPORT_TIMEOUT)
        .await
        .map_err(|error| match error {
            LocalDbError::Message(text) => LocalDbError::message(format!(
                "embedded postgres: PGlite export failed. Run: {} ({text})",
                request.command
            )),
            other => other,
        })?;
    if !request.export_out.is_file() {
        return Err(LocalDbError::message(format!(
            "embedded postgres: PGlite export did not write {}. Run: {}",
            request.export_out.display(),
            request.command
        )));
    }
    set_mode(&request.export_out, 0o600).await?;
    log.info(&format!(
        "embedded postgres: wrote PGlite export {}",
        request.export_out.display()
    ));
    Ok(())
}

fn export_command(request: &ExportRequest) -> String {
    let mut parts = vec![
        "node".to_string(),
        shell_quote(&request.script.display().to_string()),
        "--data-dir".to_string(),
        shell_quote(&request.source_copy.display().to_string()),
        "--out".to_string(),
        shell_quote(&request.export_out.display().to_string()),
        "--pglite".to_string(),
        shell_quote(&request.pglite_entry.display().to_string()),
    ];
    if let Some(vector) = &request.vector_entry {
        parts.push("--vector".to_string());
        parts.push(shell_quote(&vector.display().to_string()));
    }
    if let Some(trgm) = &request.trgm_entry {
        parts.push("--trgm".to_string());
        parts.push(shell_quote(&trgm.display().to_string()));
    }
    parts.join(" ")
}

fn parse_insert(value: &Value) -> Result<RowBatch> {
    let schema = required_str(value, "schema")?;
    let table = required_str(value, "table")?;
    let columns = string_list(value, "columns")?;
    if columns.is_empty() {
        return Err(LocalDbError::message(format!(
            "embedded postgres: PGlite insert for {schema}.{table} has no columns"
        )));
    }
    let rows = value
        .get("rows")
        .and_then(Value::as_array)
        .ok_or_else(|| LocalDbError::message("embedded postgres: PGlite insert has no rows"))?;
    let mut parsed = Vec::new();
    for row in rows {
        let cells = row.as_array().ok_or_else(|| {
            LocalDbError::message("embedded postgres: PGlite insert row is not an array")
        })?;
        if cells.len() != columns.len() {
            return Err(LocalDbError::message(format!(
                "embedded postgres: PGlite insert row for {schema}.{table} has the wrong width"
            )));
        }
        let mut values = Vec::new();
        for cell in cells {
            values.push(cell_text(cell)?);
        }
        parsed.push(values);
    }
    Ok(RowBatch {
        schema,
        table,
        columns,
        rows: parsed,
    })
}

fn sequence_last(value: &Value) -> Result<String> {
    let schema = required_str(value, "schema")?;
    let name = required_str(value, "name")?;
    let last = required_str(value, "last")?;
    if last.is_empty() || !last.chars().all(|ch| ch.is_ascii_digit()) {
        return Err(LocalDbError::message(format!(
            "embedded postgres: PGlite sequence {schema}.{name} last value is not an integer"
        )));
    }
    Ok(last)
}

fn cell_text(value: &Value) -> Result<Option<String>> {
    if value.is_null() {
        return Ok(None);
    }
    let Some(object) = value.as_object() else {
        return Err(LocalDbError::message(
            "embedded postgres: PGlite cell is not an object or null",
        ));
    };
    if let Some(text) = object.get("t").and_then(Value::as_str) {
        return Ok(Some(text.to_string()));
    }
    Err(LocalDbError::message(
        "embedded postgres: PGlite cell has no text value",
    ))
}

fn required_str(value: &Value, key: &str) -> Result<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            LocalDbError::message(format!("embedded postgres: PGlite export missing {key}"))
        })
}

fn required_i64(value: &Value, key: &str) -> Result<i64> {
    let Some(child) = value.get(key) else {
        return Err(LocalDbError::message(format!(
            "embedded postgres: PGlite export missing {key}"
        )));
    };
    if let Some(text) = child.as_str() {
        return text.parse::<i64>().map_err(|_| {
            LocalDbError::message(format!(
                "embedded postgres: PGlite export {key} is not an integer"
            ))
        });
    }
    child.as_i64().ok_or_else(|| {
        LocalDbError::message(format!(
            "embedded postgres: PGlite export {key} is not an integer"
        ))
    })
}

fn string_list(value: &Value, key: &str) -> Result<Vec<String>> {
    let items = value.get(key).and_then(Value::as_array).ok_or_else(|| {
        LocalDbError::message(format!("embedded postgres: PGlite export missing {key}"))
    })?;
    let mut out = Vec::new();
    for item in items {
        let Some(text) = item.as_str() else {
            return Err(LocalDbError::message(format!(
                "embedded postgres: PGlite export {key} contains a non-string"
            )));
        };
        out.push(text.to_string());
    }
    Ok(out)
}

fn still_running(pid: i64) -> LocalDbError {
    LocalDbError::message(format!(
        "embedded PGlite is still running (pid {pid}) — stop the node first"
    ))
}

fn source_key(source: &Path) -> String {
    lexical_absolute(source).display().to_string()
}

fn same_path(left: &Path, right: &Path) -> bool {
    lexical_absolute(left) == lexical_absolute(right)
}

fn store_slug(source: &Path) -> String {
    let text = source_key(source);
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn join_rel(parts: &[&str]) -> String {
    parts.join("/")
}

fn fallback_command(home: &Path, source: &Path) -> String {
    let script = store_work_dir(home, source).join("pglite_export.mjs");
    format!(
        "node {} --data-dir {} --out {} --pglite {}",
        shell_quote(&script.display().to_string()),
        shell_quote(&source.display().to_string()),
        shell_quote(
            &store_work_dir(home, source)
                .join("pglite-export.jsonl")
                .display()
                .to_string()
        ),
        shell_quote("$RIVETOS_ROOT/node_modules/@electric-sql/pglite")
    )
}

fn find_package(root: &Path, relatives: &[&str]) -> Result<PathBuf> {
    for relative in relatives {
        let path = root.join(relative);
        if path.join("package.json").is_file() {
            return Ok(path);
        }
    }
    Err(LocalDbError::message(format!(
        "embedded postgres: none of [{}] exist under {} (set RIVETOS_ROOT to the TypeScript install that contains @electric-sql/pglite)",
        relatives.join(", "),
        root.display()
    )))
}

fn entry_relative(value: &Value, export_key: &str) -> Option<String> {
    if let Some(exports) = value.get("exports") {
        if let Some(target) = exports.get(export_key).and_then(export_target) {
            return Some(target);
        }
        if let Some(target) = wildcard_export(exports, export_key) {
            return Some(target);
        }
    }
    if export_key == "." {
        if let Some(module) = value.get("module").and_then(Value::as_str) {
            return Some(module.to_string());
        }
        if let Some(main) = value.get("main").and_then(Value::as_str) {
            return Some(main.to_string());
        }
    }
    None
}

fn wildcard_export(exports: &Value, export_key: &str) -> Option<String> {
    let map = exports.as_object()?;
    for (pattern, target) in map {
        let Some((prefix, suffix)) = pattern.split_once('*') else {
            continue;
        };
        if !export_key.starts_with(prefix) || !export_key.ends_with(suffix) {
            continue;
        }
        let middle_end = export_key.len() - suffix.len();
        if middle_end < prefix.len() {
            continue;
        }
        let middle = &export_key[prefix.len()..middle_end];
        if middle.is_empty() || middle.contains('*') {
            continue;
        }
        let resolved = export_target(target)?;
        return Some(resolved.replace('*', middle));
    }
    None
}

fn export_target(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Object(map) => {
            for key in ["import", "node", "default"] {
                if let Some(child) = map.get(key)
                    && let Some(target) = export_target(child)
                {
                    return Some(target);
                }
            }
            None
        }
        _ => None,
    }
}

async fn copy_tree(source: &Path, dest: &Path) -> Result<()> {
    let mut stack = vec![(source.to_path_buf(), dest.to_path_buf())];
    while let Some((from_dir, to_dir)) = stack.pop() {
        tokio::fs::create_dir_all(&to_dir).await?;
        let mut entries = tokio::fs::read_dir(&from_dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name();
            if name == LOCKFILE {
                continue;
            }
            let from = entry.path();
            let to = to_dir.join(&name);
            let meta = tokio::fs::symlink_metadata(&from).await?;
            if meta.file_type().is_symlink() {
                copy_symlink(&from, &to).await?;
            } else if meta.is_dir() {
                stack.push((from, to));
            } else if meta.is_file() {
                tokio::fs::copy(&from, &to).await?;
                set_mode_from(&to, &meta).await?;
            }
        }
    }
    Ok(())
}

async fn copy_symlink(from: &Path, to: &Path) -> Result<()> {
    let target = tokio::fs::read_link(from).await?;
    #[cfg(unix)]
    {
        tokio::fs::symlink(&target, to).await?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = (target, to);
        Err(LocalDbError::message(
            "embedded postgres: cannot copy a PGlite symlink on this platform",
        ))
    }
}

async fn set_mode_from(path: &Path, meta: &std::fs::Metadata) -> Result<()> {
    #[cfg(unix)]
    {
        tokio::fs::set_permissions(path, meta.permissions()).await?;
    }
    #[cfg(not(unix))]
    {
        let _ = (path, meta);
    }
    Ok(())
}

async fn write_script(path: &Path) -> Result<()> {
    write_private(path, EXPORT_SCRIPT.as_bytes()).await?;
    set_mode(path, 0o700).await
}

async fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    let mut file = options.open(path).await?;
    file.write_all(bytes).await?;
    file.flush().await?;
    file.sync_all().await?;
    Ok(())
}

impl LedgerLock {
    async fn acquire(home: &Path) -> Result<Self> {
        Self::acquire_timeout(home, LEDGER_LOCK_TIMEOUT).await
    }

    async fn acquire_timeout(home: &Path, timeout: Duration) -> Result<Self> {
        let path = migrated_record(home).with_file_name("migrated-sources.lock");
        let held = FileLock::acquire(
            &path,
            timeout,
            "embedded postgres: timed out waiting for the migration ledger lock".to_string(),
        )
        .await?;
        Ok(Self { _held: held })
    }
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

async fn remove_dir_if_present(path: &Path) -> Result<()> {
    match tokio::fs::remove_dir_all(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

async fn ensure_node(command: &str) -> Result<()> {
    let child = tokio::process::Command::new("node")
        .arg("--version")
        .kill_on_drop(true)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                LocalDbError::message(node_missing_message(command))
            } else {
                LocalDbError::Io(error)
            }
        })?;
    wait_child(child, NODE_PROBE_TIMEOUT)
        .await
        .map_err(|error| {
            LocalDbError::message(format!("{}. {error}", node_missing_message(command)))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "local-db-migrate-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("dir");
        dir
    }

    #[test]
    fn plan_skips_until_a_pglite_dir_has_no_engine_yet() {
        let root = temp_dir("plan");
        let source = root.join("pglite");
        let engine = root.join("postgres");
        let pgdata = pgdata_dir(&engine);
        let pending = pending_marker(&engine);
        assert_eq!(
            plan_migration(&source, &pgdata, &pending, false),
            MigrationPlan::Skip(SkipReason::SourceMissing)
        );
        std::fs::create_dir_all(&source).expect("source");
        std::fs::write(source.join("postmaster.opts"), b"x").expect("file");
        assert_eq!(
            plan_migration(&source, &pgdata, &pending, false),
            MigrationPlan::Skip(SkipReason::SourceNotPglite)
        );
        std::fs::write(source.join("PG_VERSION"), b"18\n").expect("version");
        assert_eq!(
            plan_migration(&source, &pgdata, &pending, false),
            MigrationPlan::Migrate
        );
        assert_eq!(
            plan_migration(&source, &pgdata, &pending, true),
            MigrationPlan::Skip(SkipReason::AlreadyMigrated)
        );
        std::fs::create_dir_all(&pgdata).expect("pgdata");
        std::fs::write(pgdata.join("PG_VERSION"), b"16\n").expect("version");
        assert_eq!(
            plan_migration(&source, &pgdata, &pending, false),
            MigrationPlan::Skip(SkipReason::DestinationInitialized)
        );
        std::fs::create_dir_all(&engine).expect("engine");
        std::fs::write(&pending, b"1").expect("pending");
        assert_eq!(
            plan_migration(&source, &pgdata, &pending, false),
            MigrationPlan::Retry
        );
        assert_eq!(
            plan_migration(
                &engine,
                &pgdata,
                &pending_marker(&root.join("other")),
                false
            ),
            MigrationPlan::Skip(SkipReason::SamePath)
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pending_without_source_is_reported() {
        let root = temp_dir("pending");
        let engine = root.join("postgres");
        std::fs::create_dir_all(&engine).expect("engine");
        let pending = pending_marker(&engine);
        std::fs::write(&pending, b"1").expect("pending");
        assert_eq!(
            plan_migration(&root.join("missing"), &pgdata_dir(&engine), &pending, false),
            MigrationPlan::PendingSourceMissing
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn export_script_pages_by_ctid_and_casts_text() {
        assert!(EXPORT_SCRIPT.contains("PGlite"));
        assert!(EXPORT_SCRIPT.contains("ctid >"));
        assert!(EXPORT_SCRIPT.contains("ORDER BY ctid"));
        assert!(!EXPORT_SCRIPT.contains("OFFSET"));
        assert!(EXPORT_SCRIPT.contains("--seed"));
        assert!(EXPORT_SCRIPT.contains("::text"));
        assert!(EXPORT_SCRIPT.contains("op: 'ddl'"));
        assert!(EXPORT_SCRIPT.contains("schema !== 'public'"));
        assert!(EXPORT_SCRIPT.contains("pg_get_functiondef"));
        assert!(EXPORT_SCRIPT.contains("parent_task_id"));
        assert!(EXPORT_SCRIPT.contains("extract-wiki"));
        assert!(EXPORT_SCRIPT.contains("job_count"));
        assert!(!EXPORT_SCRIPT.contains("op: 'table'"));
        assert!(!EXPORT_SCRIPT.contains("pgDump"));
        assert!(!EXPORT_SCRIPT.contains("pglite-tools"));
        let line = r#"{"op":"insert","schema":"public","table":"ros_messages","columns":["body"],"rows":[[{"t":"hello\n\\restrict\nSET transaction_timeout = 0;"}]]}"#;
        let action = parse_export_line(line).expect("line").expect("action");
        match action {
            ExportAction::Insert(batch) => {
                let plan = plan_insert(
                    &batch.schema,
                    &batch.table,
                    &batch.columns,
                    &[DestColumn {
                        name: "body".to_string(),
                        type_name: "text".to_string(),
                        generated: false,
                    }],
                    &batch.rows,
                )
                .expect("plan")
                .expect("insert");
                assert_eq!(
                    plan.params,
                    vec![Some(
                        "hello\n\\restrict\nSET transaction_timeout = 0;".to_string()
                    )]
                );
                assert!(plan.sql.contains("($1::text)::text"));
                assert!(!plan.sql.contains("$1::text::text"));
                assert!(!plan.sql.contains("\\restrict"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn destination_types_include_arrays_and_skip_generated_columns() {
        let columns = vec!["aliases".to_string(), "content_tsv".to_string()];
        let rows = vec![vec![
            Some("{alpha,beta}".to_string()),
            Some("junk".to_string()),
        ]];
        let plan = plan_insert(
            "public",
            "ros_wiki_topics",
            &columns,
            &[
                DestColumn {
                    name: "aliases".to_string(),
                    type_name: "text[]".to_string(),
                    generated: false,
                },
                DestColumn {
                    name: "content_tsv".to_string(),
                    type_name: "tsvector".to_string(),
                    generated: true,
                },
            ],
            &rows,
        )
        .expect("plan")
        .expect("insert");
        assert!(plan.sql.contains("($1::text)::text[]"));
        assert!(!plan.sql.contains("content_tsv"));
        assert_eq!(plan.params, vec![Some("{alpha,beta}".to_string())]);
        let stamped = plan_insert(
            "public",
            "ros_conversations",
            &["created_at".to_string()],
            &[DestColumn {
                name: "created_at".to_string(),
                type_name: "timestamp with time zone".to_string(),
                generated: false,
            }],
            &[vec![Some("2024-01-02 03:04:05+00".to_string())]],
        )
        .expect("stamp")
        .expect("insert");
        assert!(stamped.sql.contains("($1::text)::timestamp with time zone"));
        assert!(!stamped.sql.contains("$1::text::timestamp"));
        assert!(copy_this_table("ros_messages"));
        assert!(!copy_this_table("_rivetos_migrations"));
        assert!(
            missing_relation_message("graphile_worker", "_private_jobs")
                .contains("destination has no relation graphile_worker._private_jobs")
        );
    }

    #[test]
    fn self_links_insert_null_and_update_after_a_child_that_is_stored_first() {
        let columns = vec!["id".to_string(), "parent_id".to_string()];
        let child = "33333333-3333-4333-8333-000000000002";
        let parent = "33333333-3333-4333-8333-000000000001";
        let rows = vec![
            vec![Some(child.to_string()), Some(parent.to_string())],
            vec![Some(parent.to_string()), None],
        ];
        let masked =
            mask_self_link_columns(&columns, &rows, &["parent_id".to_string()]).expect("mask");
        assert_eq!(masked[0][1], None);
        assert_eq!(masked[1][1], None);
        assert_eq!(masked[0][0].as_deref(), Some(child));
        let keys = vec![TypedName {
            name: "id".to_string(),
            type_name: "uuid".to_string(),
        }];
        let links = vec![TypedName {
            name: "parent_id".to_string(),
            type_name: "uuid".to_string(),
        }];
        let plans =
            plan_self_link_updates("public", "ros_summaries", &keys, &links, &columns, &rows)
                .expect("updates");
        assert_eq!(plans.len(), 1);
        assert_eq!(
            plans[0].params,
            vec![Some(child.to_string()), Some(parent.to_string())]
        );
        assert!(plans[0].sql.contains("UPDATE"));
        assert!(plans[0].sql.contains("($1::text)::uuid"));
        assert!(plans[0].sql.contains("($2::text)::uuid"));
        assert!(!plans[0].sql.contains(parent));
        let tasks = plan_self_link_updates(
            "public",
            "ros_tasks",
            &[TypedName {
                name: "id".to_string(),
                type_name: "uuid".to_string(),
            }],
            &[TypedName {
                name: "parent_task_id".to_string(),
                type_name: "uuid".to_string(),
            }],
            &["id".to_string(), "parent_task_id".to_string()],
            &[vec![
                Some("22222222-2222-4222-8222-000000000002".to_string()),
                Some("22222222-2222-4222-8222-000000000001".to_string()),
            ]],
        )
        .expect("tasks");
        assert!(tasks[0].sql.contains("parent_task_id"));
        assert!(
            !tasks[0]
                .sql
                .contains("22222222-2222-4222-8222-000000000001")
        );
        let ddl = parse_export_line(r#"{"op":"ddl","sql":"CREATE SCHEMA graphile_worker"}"#)
            .expect("ddl")
            .expect("action");
        assert_eq!(
            ddl,
            ExportAction::Ddl("CREATE SCHEMA graphile_worker".to_string())
        );
    }

    #[test]
    fn setval_keeps_the_name_out_of_the_sql_text() {
        let line = r#"{"op":"setval","schema":"public","name":"a'b","last":"3","called":true}"#;
        let action = parse_export_line(line).expect("line").expect("action");
        match action {
            ExportAction::Setval {
                schema,
                name,
                last,
                called,
            } => {
                assert_eq!(schema, "public");
                assert_eq!(name, "a'b");
                assert_eq!(last, "3");
                assert!(called);
            }
            other => panic!("unexpected {other:?}"),
        }
        let sql = setval_statement();
        assert!(sql.contains("format('%I.%I'"));
        assert!(sql.contains("$1::text"));
        assert!(!sql.contains("a'b"));
        let error = parse_export_line(r#"{"op":"table","name":"ros_messages"}"#).expect_err("ddl");
        assert!(error.to_string().contains("unknown PGlite export op"));
    }

    #[test]
    fn package_entry_reads_export_import() {
        let dir = temp_dir("pkg");
        std::fs::write(
            dir.join("package.json"),
            r#"{"exports":{"./contrib/pg_trgm":{"import":"./dist/pg_trgm.js"},".":{"import":{"default":"./dist/index.js"}}}}"#,
        )
        .expect("pkg");
        assert_eq!(
            package_entry(&dir, ".").expect("entry"),
            dir.join("dist/index.js")
        );
        assert_eq!(
            package_entry(&dir, "./contrib/pg_trgm").expect("trgm"),
            dir.join("dist/pg_trgm.js")
        );
        std::fs::write(
            dir.join("package.json"),
            r#"{"exports":{"./contrib/*":{"import":"./dist/contrib/*.js"},".":{"import":"./dist/index.js"}}}"#,
        )
        .expect("wildcard");
        assert_eq!(
            package_entry(&dir, "./contrib/pg_trgm").expect("wildcard trgm"),
            dir.join("dist/contrib/pg_trgm.js")
        );
        assert_eq!(
            package_entry(&dir, ".").expect("root"),
            dir.join("dist/index.js")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn each_store_gets_its_own_scratch_directory() {
        let home = temp_dir("scratch");
        let left = home.join("pglite");
        let right = home.join("other");
        assert_ne!(store_work_dir(&home, &left), store_work_dir(&home, &right));
        assert!(store_work_dir(&home, &left).starts_with(work_dir(&home)));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[tokio::test]
    async fn snapshot_leaves_the_source_bytes_unchanged() {
        let root = temp_dir("snap");
        let source = root.join("pglite");
        std::fs::create_dir_all(source.join("base")).expect("dir");
        std::fs::write(source.join("PG_VERSION"), b"18\n").expect("ver");
        std::fs::write(source.join("base").join("row"), b"hello\\restrict").expect("row");
        let dest = root.join("copy");
        snapshot_source(&source, &dest).await.expect("copy");
        std::fs::write(dest.join("PG_VERSION"), b"16\n").expect("mutate");
        assert_eq!(
            std::fs::read(source.join("PG_VERSION")).expect("src"),
            b"18\n"
        );
        assert_eq!(
            std::fs::read(source.join("base").join("row")).expect("row"),
            b"hello\\restrict"
        );
        assert_eq!(
            std::fs::read(dest.join("PG_VERSION")).expect("copy"),
            b"16\n"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_live_source_owner_is_refused_and_the_directory_stays() {
        let root = temp_dir("guard");
        let source = root.join("pglite");
        std::fs::create_dir_all(&source).expect("dir");
        std::fs::write(source.join("PG_VERSION"), b"18\n").expect("ver");
        std::fs::write(
            source.join(LOCKFILE),
            serde_json::json!({
                "pid": i32::MAX,
                "port": 5433,
                "startedAt": "t"
            })
            .to_string(),
        )
        .expect("stale");
        let log = crate::lock::TracingLog;
        let held = guard_pglite_source(&source, 5433, &log)
            .await
            .expect("stale replaced");
        assert!(held.is_some());
        if let Some(path) = held {
            release_owner_lock(&path).await.expect("release");
        }
        std::fs::write(
            source.join(LOCKFILE),
            serde_json::json!({
                "pid": std::process::id(),
                "port": 1,
                "startedAt": "t"
            })
            .to_string(),
        )
        .expect("live");
        let error = guard_pglite_source(&source, 5433, &log)
            .await
            .expect_err("live");
        assert!(error.to_string().contains("still running"));
        assert!(error.to_string().contains("stop the node first"));
        assert_eq!(
            std::fs::read(source.join("PG_VERSION")).expect("ver"),
            b"18\n"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn reset_record_survives_and_marks_the_source() {
        let home = temp_dir("record");
        let source = home.join(".rivetos").join("pglite");
        let other = home.join(".rivetos").join("db");
        assert!(!source_is_migrated(&home, &source).expect("empty"));
        record_migrated_sources(&home, std::slice::from_ref(&source))
            .await
            .expect("record");
        assert!(source_is_migrated(&home, &source).expect("marked"));
        record_migrated_sources(&home, std::slice::from_ref(&other))
            .await
            .expect("second");
        assert_eq!(load_migrated(&home).expect("load").len(), 2);
        assert!(
            !migrated_record(&home)
                .with_file_name("migrated-sources.json.tmp")
                .exists()
        );
        let names = std::fs::read_dir(migrated_record(&home).parent().expect("parent"))
            .expect("dir")
            .map(|entry| entry.expect("entry").file_name())
            .collect::<Vec<_>>();
        assert!(
            names
                .iter()
                .all(|name| !name.to_string_lossy().ends_with(".tmp"))
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(migrated_record(&home))
                .expect("meta")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
        assert!(
            !migrated_record(&home)
                .with_file_name("migrated-sources.lock")
                .exists()
        );
        let text = std::fs::read_to_string(migrated_record(&home)).expect("json");
        let parsed: serde_json::Value = serde_json::from_str(&text).expect("parse");
        assert!(
            parsed
                .get("sources")
                .and_then(|item| item.as_array())
                .is_some()
        );
        let _ = std::fs::remove_dir_all(&home);
    }
}
