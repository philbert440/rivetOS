use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use tokio::io::AsyncWriteExt;

use crate::error::{LocalDbError, Result};
use crate::lock::{
    EmbeddedPgLog, LockClaim, claim_owner_lock, embedded_pg_lock_alive, read_embedded_pg_lock,
    release_owner_lock,
};
use crate::paths::{lexical_absolute, migrate_dir, shell_quote};
use crate::process::wait_child;
use crate::sql_compat::{quote_ident, safe_pg_type};

pub const MIGRATE_PENDING_FILE: &str = "rivetos-migrate-pending";
pub const EXPORT_TIMEOUT: Duration = Duration::from_secs(600);
const NODE_PROBE_TIMEOUT: Duration = Duration::from_secs(30);
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
pub struct ExportRequest {
    pub source_copy: PathBuf,
    pub script: PathBuf,
    pub export_out: PathBuf,
    pub pglite_entry: PathBuf,
    pub vector_entry: Option<PathBuf>,
    pub trgm_entry: Option<PathBuf>,
    pub command: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundInsert {
    pub sql: String,
    pub params: Vec<Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExportAction {
    Exec(String),
    Insert(BoundInsert),
    Count {
        schema: String,
        table: String,
        expected: i64,
    },
    Done,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Cell {
    Null,
    Text(String),
    Bool(bool),
    Json(String),
    Bytea(String),
}

#[derive(Debug, Serialize, Deserialize)]
struct MigratedFile {
    sources: Vec<String>,
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
    write_private(&path, &body).await
}

pub async fn clear_work(home: &Path) -> Result<()> {
    remove_dir_if_present(&work_dir(home)).await
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
        "extension" => ExportAction::Exec(create_extension(&required_str(&value, "name")?)?),
        "schema" => ExportAction::Exec(format!(
            "CREATE SCHEMA IF NOT EXISTS {}",
            quote_ident(&required_str(&value, "name")?)
        )),
        "table" => ExportAction::Exec(create_table(&value)?),
        "pk" => ExportAction::Exec(add_primary_key(&value)?),
        "begin" => ExportAction::Exec("BEGIN".to_string()),
        "commit" => ExportAction::Exec("COMMIT".to_string()),
        "insert" => {
            let insert = build_insert(&value)?;
            if insert.params.is_empty() {
                return Ok(None);
            }
            ExportAction::Insert(insert)
        }
        "count" => ExportAction::Count {
            schema: required_str(&value, "schema")?,
            table: required_str(&value, "table")?,
            expected: required_i64(&value, "n")?,
        },
        "sql" => ExportAction::Exec(required_str(&value, "sql")?),
        "setval" => ExportAction::Exec(setval_sql(&value)?),
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
    clear_work(home).await?;
    let snap = work_dir(home).join("snapshot");
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
    let request = prepare_export(home, &snap, rivet_root, log).await?;
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

async fn prepare_export(
    home: &Path,
    source_copy: &Path,
    rivet_root: Option<&str>,
    log: &dyn EmbeddedPgLog,
) -> Result<ExportRequest> {
    let Some(root) = rivet_root.filter(|value| !value.is_empty()) else {
        let command = fallback_command(home, source_copy);
        return Err(LocalDbError::message(format!(
            "embedded postgres: RIVETOS_ROOT is not set, so @electric-sql/pglite cannot be located. {}",
            node_missing_message(&command)
        )));
    };
    let root = PathBuf::from(root);
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
        &root,
        &["node_modules/@electric-sql/pglite", pglite_boot.as_str()],
    )?;
    let pglite_entry = package_entry(&pglite_dir, ".")?;
    let vector_entry = find_package(
        &root,
        &[
            "node_modules/@electric-sql/pglite-pgvector",
            vector_boot.as_str(),
        ],
    )
    .ok()
    .and_then(|dir| package_entry(&dir, ".").ok());
    let trgm_entry = package_entry(&pglite_dir, "./contrib/pg_trgm").ok();
    let migrate = migrate_dir(home);
    tokio::fs::create_dir_all(&migrate).await?;
    let script = migrate.join("pglite_export.mjs");
    write_script(&script).await?;
    let request = ExportRequest {
        source_copy: source_copy.to_path_buf(),
        script,
        export_out: work_dir(home).join("pglite-export.jsonl"),
        pglite_entry,
        vector_entry,
        trgm_entry,
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

fn create_extension(name: &str) -> Result<String> {
    if name.is_empty()
        || !name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
    {
        return Err(LocalDbError::message(format!(
            "embedded postgres: refusing PGlite extension name {name}"
        )));
    }
    Ok(format!("CREATE EXTENSION IF NOT EXISTS {name}"))
}

fn create_table(value: &Value) -> Result<String> {
    let schema = required_str(value, "schema")?;
    let name = required_str(value, "name")?;
    let columns = value
        .get("columns")
        .and_then(Value::as_array)
        .ok_or_else(|| LocalDbError::message("embedded postgres: PGlite table has no columns"))?;
    if columns.is_empty() {
        return Err(LocalDbError::message(format!(
            "embedded postgres: PGlite table {schema}.{name} has no columns"
        )));
    }
    let mut parts = Vec::new();
    for column in columns {
        let column_name = required_str(column, "name")?;
        let column_type = required_str(column, "type")?;
        if !safe_pg_type(&column_type) {
            return Err(LocalDbError::message(format!(
                "embedded postgres: refusing PGlite column type {column_type}"
            )));
        }
        let mut part = format!("{} {}", quote_ident(&column_name), column_type);
        let nullable = column
            .get("nullable")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        if !nullable {
            part.push_str(" NOT NULL");
        }
        parts.push(part);
    }
    Ok(format!(
        "CREATE TABLE {}.{} ({})",
        quote_ident(&schema),
        quote_ident(&name),
        parts.join(", ")
    ))
}

fn add_primary_key(value: &Value) -> Result<String> {
    let schema = required_str(value, "schema")?;
    let table = required_str(value, "table")?;
    let columns = string_list(value, "columns")?;
    if columns.is_empty() {
        return Err(LocalDbError::message(
            "embedded postgres: PGlite primary key has no columns",
        ));
    }
    let listed = columns
        .iter()
        .map(|column| quote_ident(column))
        .collect::<Vec<_>>()
        .join(", ");
    Ok(format!(
        "ALTER TABLE {}.{} ADD PRIMARY KEY ({listed})",
        quote_ident(&schema),
        quote_ident(&table)
    ))
}

fn setval_sql(value: &Value) -> Result<String> {
    let schema = required_str(value, "schema")?;
    let name = required_str(value, "name")?;
    let last = required_str(value, "last")?;
    if last.is_empty() || !last.chars().all(|ch| ch.is_ascii_digit()) {
        return Err(LocalDbError::message(format!(
            "embedded postgres: PGlite sequence {schema}.{name} last value is not an integer"
        )));
    }
    let called = value
        .get("called")
        .and_then(Value::as_bool)
        .ok_or_else(|| LocalDbError::message("embedded postgres: PGlite setval needs called"))?;
    let flag = if called { "true" } else { "false" };
    Ok(format!(
        "SELECT setval('{}.{}', {last}, {flag})",
        quote_ident(&schema),
        quote_ident(&name)
    ))
}

fn build_insert(value: &Value) -> Result<BoundInsert> {
    let schema = required_str(value, "schema")?;
    let table = required_str(value, "table")?;
    let columns = string_list(value, "columns")?;
    let types = string_list(value, "types")?;
    if columns.len() != types.len() || columns.is_empty() {
        return Err(LocalDbError::message(format!(
            "embedded postgres: PGlite insert for {schema}.{table} has mismatched columns"
        )));
    }
    let rows = value
        .get("rows")
        .and_then(Value::as_array)
        .ok_or_else(|| LocalDbError::message("embedded postgres: PGlite insert has no rows"))?;
    let mut params = Vec::new();
    let mut tuples = Vec::new();
    let mut index = 1usize;
    for row in rows {
        let cells = row.as_array().ok_or_else(|| {
            LocalDbError::message("embedded postgres: PGlite insert row is not an array")
        })?;
        if cells.len() != columns.len() {
            return Err(LocalDbError::message(format!(
                "embedded postgres: PGlite insert row for {schema}.{table} has the wrong width"
            )));
        }
        let mut places = Vec::new();
        for (cell, udt) in cells.iter().zip(types.iter()) {
            places.push(cast_place(index, udt)?);
            params.push(cell_param(&cell_from_json(cell)?)?);
            index += 1;
        }
        tuples.push(format!("({})", places.join(", ")));
    }
    if tuples.is_empty() {
        return Ok(BoundInsert {
            sql: String::new(),
            params: Vec::new(),
        });
    }
    let listed = columns
        .iter()
        .map(|column| quote_ident(column))
        .collect::<Vec<_>>()
        .join(", ");
    Ok(BoundInsert {
        sql: format!(
            "INSERT INTO {}.{} ({listed}) VALUES {}",
            quote_ident(&schema),
            quote_ident(&table),
            tuples.join(", ")
        ),
        params,
    })
}

fn cast_place(index: usize, udt: &str) -> Result<String> {
    if udt.eq_ignore_ascii_case("bytea") {
        return Ok(format!("decode(${index}, 'hex')"));
    }
    if !safe_pg_type(udt) {
        return Err(LocalDbError::message(format!(
            "embedded postgres: refusing PGlite column type {udt}"
        )));
    }
    Ok(format!("${index}::{udt}"))
}

fn cell_from_json(value: &Value) -> Result<Cell> {
    if value.is_null() {
        return Ok(Cell::Null);
    }
    let Some(object) = value.as_object() else {
        return Err(LocalDbError::message(
            "embedded postgres: PGlite cell is not an object or null",
        ));
    };
    if let Some(flag) = object.get("b").and_then(Value::as_bool) {
        return Ok(Cell::Bool(flag));
    }
    if let Some(hex) = object.get("x").and_then(Value::as_str) {
        return Ok(Cell::Bytea(hex.to_string()));
    }
    if let Some(json) = object.get("j") {
        let text =
            serde_json::to_string(json).map_err(|error| LocalDbError::Json(error.to_string()))?;
        return Ok(Cell::Json(text));
    }
    if let Some(text) = object.get("t").and_then(Value::as_str) {
        return Ok(Cell::Text(text.to_string()));
    }
    Err(LocalDbError::message(
        "embedded postgres: PGlite cell has no value",
    ))
}

fn cell_param(cell: &Cell) -> Result<Option<String>> {
    Ok(match cell {
        Cell::Null => None,
        Cell::Text(text) | Cell::Json(text) | Cell::Bytea(text) => Some(text.clone()),
        Cell::Bool(true) => Some("true".to_string()),
        Cell::Bool(false) => Some("false".to_string()),
    })
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

fn join_rel(parts: &[&str]) -> String {
    parts.join("/")
}

fn fallback_command(home: &Path, source: &Path) -> String {
    let script = migrate_dir(home).join("pglite_export.mjs");
    format!(
        "node {} --data-dir {} --out {} --pglite {}",
        shell_quote(&script.display().to_string()),
        shell_quote(&source.display().to_string()),
        shell_quote(
            &work_dir(home)
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
    if let Some(exports) = value.get("exports")
        && let Some(target) = exports.get(export_key).and_then(export_target)
    {
        return Some(target);
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
    Ok(())
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
    fn export_script_reads_rows_instead_of_rewriting_a_dump() {
        assert!(EXPORT_SCRIPT.contains("PGlite"));
        assert!(EXPORT_SCRIPT.contains("ORDER BY ctid"));
        assert!(EXPORT_SCRIPT.contains("LIMIT"));
        assert!(EXPORT_SCRIPT.contains("op: 'insert'"));
        assert!(!EXPORT_SCRIPT.contains("pgDump"));
        assert!(!EXPORT_SCRIPT.contains("pglite-tools"));
        let line = r#"{"op":"insert","schema":"public","table":"ros_messages","columns":["body"],"types":["text"],"rows":[[{"t":"hello\n\\restrict\nSET transaction_timeout = 0;"}]]}"#;
        let action = parse_export_line(line).expect("line").expect("action");
        match action {
            ExportAction::Insert(insert) => {
                assert_eq!(
                    insert.params,
                    vec![Some(
                        "hello\n\\restrict\nSET transaction_timeout = 0;".to_string()
                    )]
                );
                assert!(insert.sql.contains("$1::text"));
                assert!(!insert.sql.contains("\\restrict"));
            }
            other => panic!("unexpected {other:?}"),
        }
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
        let _ = std::fs::remove_dir_all(&dir);
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
        assert!(!source_is_migrated(&home, &source).expect("empty"));
        record_migrated_sources(&home, std::slice::from_ref(&source))
            .await
            .expect("record");
        assert!(source_is_migrated(&home, &source).expect("marked"));
        record_migrated_sources(&home, std::slice::from_ref(&source))
            .await
            .expect("again");
        assert_eq!(load_migrated(&home).expect("load").len(), 1);
        let _ = std::fs::remove_dir_all(&home);
    }
}
