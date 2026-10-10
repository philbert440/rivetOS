use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

use crate::error::{LocalDbError, Result};
use crate::lock::EmbeddedPgLog;
use crate::paths::{lexical_absolute, migrate_dir, shell_quote};
use crate::process::wait_child;

pub const MIGRATE_PENDING_FILE: &str = "rivetos-migrate-pending";
pub const DUMP_TIMEOUT: Duration = Duration::from_secs(600);
const NODE_PROBE_TIMEOUT: Duration = Duration::from_secs(30);

const DUMP_SCRIPT: &str = include_str!("pglite_dump.mjs");

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkipReason {
    SamePath,
    SourceMissing,
    SourceNotPglite,
    DestinationInitialized,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MigrationPlan {
    Skip(SkipReason),
    Migrate,
    Retry,
    PendingSourceMissing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DumpRequest {
    pub source: PathBuf,
    pub script: PathBuf,
    pub sql_out: PathBuf,
    pub counts_out: PathBuf,
    pub pglite_entry: PathBuf,
    pub tools_entry: PathBuf,
    pub vector_entry: Option<PathBuf>,
    pub trgm_entry: Option<PathBuf>,
    pub command: String,
}

pub fn pending_marker(engine_dir: &Path) -> PathBuf {
    engine_dir.join(MIGRATE_PENDING_FILE)
}

pub fn pgdata_dir(engine_dir: &Path) -> PathBuf {
    engine_dir.join("pgdata")
}

pub fn plan_migration(source: &Path, pgdata: &Path, pending: &Path) -> MigrationPlan {
    if same_path(source, pgdata)
        || pgdata
            .parent()
            .is_some_and(|parent| same_path(source, parent))
    {
        return MigrationPlan::Skip(SkipReason::SamePath);
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
    format!("embedded postgres: no node available to dump PGlite. Run: {command}")
}

pub fn dump_command(request: &DumpRequest) -> String {
    let mut parts = vec![
        "node".to_string(),
        shell_quote(&request.script.display().to_string()),
        "--data-dir".to_string(),
        shell_quote(&request.source.display().to_string()),
        "--out".to_string(),
        shell_quote(&request.sql_out.display().to_string()),
        "--counts".to_string(),
        shell_quote(&request.counts_out.display().to_string()),
        "--pglite".to_string(),
        shell_quote(&request.pglite_entry.display().to_string()),
        "--tools".to_string(),
        shell_quote(&request.tools_entry.display().to_string()),
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

pub async fn prepare_dump(
    home: &Path,
    source: &Path,
    log: &dyn EmbeddedPgLog,
) -> Result<DumpRequest> {
    let root = std::env::var("RIVETOS_ROOT").map_err(|_| {
        let command = fallback_command(home, source);
        LocalDbError::message(format!(
            "embedded postgres: RIVETOS_ROOT is not set, so the TypeScript install's pgDump cannot be located. {}",
            node_missing_message(&command)
        ))
    })?;
    let root = PathBuf::from(root);
    let pglite_boot = join_rel(&[
        "packages",
        "boot",
        "node_modules",
        "@electric-sql",
        "pglite",
    ]);
    let tools_boot = join_rel(&[
        "packages",
        "boot",
        "node_modules",
        "@electric-sql",
        "pglite-tools",
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
    let tools_dir = find_package(
        &root,
        &[
            "node_modules/@electric-sql/pglite-tools",
            tools_boot.as_str(),
        ],
    )?;
    let pglite_entry = package_entry(&pglite_dir, ".")?;
    let tools_entry = package_entry(&tools_dir, ".")?;
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
    let script = migrate.join("pglite_dump.mjs");
    write_script(&script).await?;
    let request = DumpRequest {
        source: source.to_path_buf(),
        script,
        sql_out: migrate.join("pglite-dump.sql"),
        counts_out: migrate.join("pglite-counts.json"),
        pglite_entry,
        tools_entry,
        vector_entry,
        trgm_entry,
        command: String::new(),
    };
    let command = dump_command(&request);
    let request = DumpRequest { command, ..request };
    ensure_node(&request.command).await?;
    log.info(&format!(
        "embedded postgres: PGlite dump command prepared: {}",
        request.command
    ));
    Ok(request)
}

pub async fn run_dump(request: &DumpRequest, log: &dyn EmbeddedPgLog) -> Result<()> {
    log.info(&format!(
        "embedded postgres: dumping PGlite from {} with node",
        request.source.display()
    ));
    let mut command = tokio::process::Command::new("node");
    command
        .arg(&request.script)
        .arg("--data-dir")
        .arg(&request.source)
        .arg("--out")
        .arg(&request.sql_out)
        .arg("--counts")
        .arg(&request.counts_out)
        .arg("--pglite")
        .arg(&request.pglite_entry)
        .arg("--tools")
        .arg(&request.tools_entry)
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
    wait_child(child, DUMP_TIMEOUT)
        .await
        .map_err(|error| match error {
            LocalDbError::Message(text) => LocalDbError::message(format!(
                "embedded postgres: PGlite dump failed. Run: {} ({text})",
                request.command
            )),
            other => other,
        })?;
    if !request.sql_out.is_file() || !request.counts_out.is_file() {
        return Err(LocalDbError::message(format!(
            "embedded postgres: PGlite dump did not write SQL and counts. Run: {}",
            request.command
        )));
    }
    log.info(&format!(
        "embedded postgres: wrote PGlite dump {} and counts {}",
        request.sql_out.display(),
        request.counts_out.display()
    ));
    Ok(())
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

fn join_rel(parts: &[&str]) -> String {
    parts.join("/")
}

fn fallback_command(home: &Path, source: &Path) -> String {
    let script = migrate_dir(home).join("pglite_dump.mjs");
    format!(
        "node {} --data-dir {} --out {} --counts {} --pglite {} --tools {}",
        shell_quote(&script.display().to_string()),
        shell_quote(&source.display().to_string()),
        shell_quote(
            &migrate_dir(home)
                .join("pglite-dump.sql")
                .display()
                .to_string()
        ),
        shell_quote(
            &migrate_dir(home)
                .join("pglite-counts.json")
                .display()
                .to_string()
        ),
        shell_quote("$RIVETOS_ROOT/node_modules/@electric-sql/pglite"),
        shell_quote("$RIVETOS_ROOT/node_modules/@electric-sql/pglite-tools")
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
        "embedded postgres: none of [{}] exist under {} (set RIVETOS_ROOT to the TypeScript install). Run: node {} --data-dir <pglite> --out <sql> --counts <json> --pglite <pglite-entry> --tools <tools-entry>",
        relatives.join(", "),
        root.display(),
        shell_quote(&root.join("pglite_dump.mjs").display().to_string())
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

async fn write_script(path: &Path) -> Result<()> {
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        options.mode(0o700);
    }
    let mut file = options.open(path).await?;
    use tokio::io::AsyncWriteExt;
    file.write_all(DUMP_SCRIPT.as_bytes()).await?;
    Ok(())
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

fn same_path(left: &Path, right: &Path) -> bool {
    lexical_absolute(left) == lexical_absolute(right)
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
            plan_migration(&source, &pgdata, &pending),
            MigrationPlan::Skip(SkipReason::SourceMissing)
        );
        std::fs::create_dir_all(&source).expect("source");
        std::fs::write(source.join("postmaster.opts"), b"x").expect("file");
        assert_eq!(
            plan_migration(&source, &pgdata, &pending),
            MigrationPlan::Skip(SkipReason::SourceNotPglite)
        );
        std::fs::write(source.join("PG_VERSION"), b"18\n").expect("version");
        assert_eq!(
            plan_migration(&source, &pgdata, &pending),
            MigrationPlan::Migrate
        );
        std::fs::create_dir_all(&pgdata).expect("pgdata");
        std::fs::write(pgdata.join("PG_VERSION"), b"16\n").expect("version");
        assert_eq!(
            plan_migration(&source, &pgdata, &pending),
            MigrationPlan::Skip(SkipReason::DestinationInitialized)
        );
        std::fs::create_dir_all(&engine).expect("engine");
        std::fs::write(&pending, b"1").expect("pending");
        assert_eq!(
            plan_migration(&source, &pgdata, &pending),
            MigrationPlan::Retry
        );
        assert_eq!(
            plan_migration(&engine, &pgdata, &pending_marker(&root.join("other"))),
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
            plan_migration(&root.join("missing"), &pgdata_dir(&engine), &pending),
            MigrationPlan::PendingSourceMissing
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn dump_command_names_node_and_the_script_flags() {
        let request = DumpRequest {
            source: PathBuf::from("/data/pglite"),
            script: PathBuf::from("/opt/pglite_dump.mjs"),
            sql_out: PathBuf::from("/data/dump.sql"),
            counts_out: PathBuf::from("/data/counts.json"),
            pglite_entry: PathBuf::from("/opt/pglite/dist/index.js"),
            tools_entry: PathBuf::from("/opt/tools/dist/index.js"),
            vector_entry: None,
            trgm_entry: None,
            command: String::new(),
        };
        let command = dump_command(&request);
        assert!(command.starts_with("node "));
        assert!(command.contains("--data-dir"));
        assert!(command.contains("--out"));
        assert!(command.contains("--counts"));
        assert!(command.contains("--pglite"));
        assert!(command.contains("--tools"));
        assert!(command.contains("pglite_dump.mjs"));
        let message = node_missing_message(&command);
        assert!(message.contains("no node available"));
        assert!(message.contains(&command));
        let script = DUMP_SCRIPT;
        assert!(script.contains("pgDump"));
        assert!(script.contains("--inserts"));
        assert!(script.contains("pathToFileURL"));
        assert!(script.contains("relkind"));
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
}
