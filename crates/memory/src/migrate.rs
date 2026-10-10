use std::future::Future;
use std::path::Path;

use crate::schema_sql::{embedded_migrations, EmbeddedMigration};

pub const MIGRATION_LOCK_TIMEOUT: &str = "3s";
pub const MIGRATION_LOCK_BACKOFF_MS: [u64; 5] = [0, 5_000, 10_000, 20_000, 25_000];

#[derive(Debug, Clone)]
pub struct Migration {
    pub name: String,
    pub path: String,
    pub sql: String,
}

#[derive(Debug, Clone)]
pub struct MigrateFault {
    pub message: String,
    pub code: Option<String>,
}

impl MigrateFault {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
        }
    }

    pub fn coded(message: impl Into<String>, code: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: Some(code.into()),
        }
    }
}

impl std::fmt::Display for MigrateFault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for MigrateFault {}

#[derive(Debug, Clone, Default)]
pub struct MigrateRows {
    pub rows: Vec<Vec<Option<String>>>,
}

pub trait MigrateClient {
    fn query(
        &mut self,
        sql: &str,
    ) -> impl Future<Output = Result<MigrateRows, MigrateFault>> + Send;
    fn query_bind(
        &mut self,
        sql: &str,
        param: &str,
    ) -> impl Future<Output = Result<MigrateRows, MigrateFault>> + Send;
}

pub fn assert_lock_timeout(value: &str) -> Result<&str, MigrateFault> {
    if lock_timeout_ok(value) {
        Ok(value)
    } else {
        Err(MigrateFault::new(format!("invalid lock_timeout: {value}")))
    }
}

fn lock_timeout_ok(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut i = 0;
    if i >= bytes.len() || !bytes[i].is_ascii_digit() {
        return false;
    }
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        if i >= bytes.len() || !bytes[i].is_ascii_digit() {
            return false;
        }
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
    }
    matches!(
        value[i..].to_ascii_lowercase().as_str(),
        "us" | "ms" | "s" | "min" | "h" | "d"
    )
}

pub async fn apply_session_guards<C: MigrateClient>(
    client: &mut C,
    timeout: &str,
) -> Result<(), MigrateFault> {
    let lock_timeout = assert_lock_timeout(timeout)?;
    client
        .query(&format!("SET lock_timeout = '{lock_timeout}'"))
        .await?;
    Ok(())
}

pub async fn reset_session_guards<C: MigrateClient>(client: &mut C) -> Result<(), MigrateFault> {
    client.query("RESET lock_timeout").await?;
    Ok(())
}

const MIGRATIONS_DDL: &str = "
    CREATE TABLE IF NOT EXISTS _rivetos_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      checksum    TEXT
    )
  ";

pub async fn ensure_migrations_table<C: MigrateClient>(client: &mut C) -> Result<(), MigrateFault> {
    let existing = client
        .query("SELECT to_regclass('_rivetos_migrations')::text AS t")
        .await?;
    if existing
        .rows
        .first()
        .and_then(|row| row.first())
        .and_then(|cell| cell.as_deref())
        .is_some_and(|t| !t.is_empty())
    {
        return Ok(());
    }
    client.query(MIGRATIONS_DDL).await?;
    Ok(())
}

pub fn list_migrations_dir(dir: &Path) -> Result<Vec<Migration>, MigrateFault> {
    let entries = std::fs::read_dir(dir).map_err(|err| MigrateFault::new(err.to_string()))?;
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|err| MigrateFault::new(err.to_string()))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".sql") {
            names.push(name);
        }
    }
    names.sort();
    let mut out = Vec::new();
    for name in names {
        let path = dir.join(&name);
        let sql = std::fs::read_to_string(&path).map_err(|err| MigrateFault::new(err.to_string()))?;
        out.push(Migration {
            name,
            path: path.to_string_lossy().to_string(),
            sql,
        });
    }
    Ok(out)
}

pub fn embedded_as_migrations() -> Vec<Migration> {
    embedded_migrations()
        .iter()
        .map(|m: &EmbeddedMigration| Migration {
            name: m.name.to_string(),
            path: m.name.to_string(),
            sql: m.sql.to_string(),
        })
        .collect()
}

fn is_lock_not_available(err: &MigrateFault) -> bool {
    err.code.as_deref() == Some("55P03")
}

pub async fn apply_migration<C, S, F>(
    client: &mut C,
    migration: &Migration,
    mut sleep: S,
    backoff_ms: &[u64],
) -> Result<(), MigrateFault>
where
    C: MigrateClient,
    S: FnMut(u64) -> F,
    F: Future<Output = ()>,
{
    println!("[migrate] applying {}", migration.name);
    let mut last = MigrateFault::new("migration failed");
    for (attempt, delay) in backoff_ms.iter().copied().enumerate() {
        if delay > 0 {
            sleep(delay).await;
        }
        client.query("BEGIN").await?;
        match async {
            client.query(&migration.sql).await?;
            client
                .query_bind(
                    "INSERT INTO _rivetos_migrations (name) VALUES ($1)",
                    &migration.name,
                )
                .await?;
            client.query("COMMIT").await?;
            Ok::<(), MigrateFault>(())
        }
        .await
        {
            Ok(()) => {
                println!("[migrate]   ✓ {} applied", migration.name);
                return Ok(());
            }
            Err(err) => {
                let _ = client.query("ROLLBACK").await;
                let retry = is_lock_not_available(&err) && attempt + 1 < backoff_ms.len();
                if retry {
                    eprintln!(
                        "[migrate]   lock_timeout on {} (attempt {}/{}); retrying with backoff",
                        migration.name,
                        attempt + 1,
                        backoff_ms.len()
                    );
                    last = err;
                    continue;
                }
                eprintln!("[migrate]   ✗ {} failed: {}", migration.name, err.message);
                return Err(err);
            }
        }
    }
    Err(last)
}

pub async fn run_migrations<C: MigrateClient>(
    client: &mut C,
    migrations: &[Migration],
    baseline: bool,
) -> Result<(), MigrateFault> {
    if migrations.is_empty() {
        println!("[migrate] no migrations found, nothing to do");
        return Ok(());
    }
    let outcome = async {
        apply_session_guards(client, MIGRATION_LOCK_TIMEOUT).await?;
        ensure_migrations_table(client).await?;
        let applied_rows = client
            .query("SELECT name FROM _rivetos_migrations ORDER BY name")
            .await?;
        let mut applied = Vec::new();
        for row in &applied_rows.rows {
            if let Some(Some(name)) = row.first() {
                applied.push(name.clone());
            }
        }
        let pending: Vec<&Migration> = migrations
            .iter()
            .filter(|m| !applied.iter().any(|name| name == &m.name))
            .collect();
        if pending.is_empty() {
            println!(
                "[migrate] up to date ({} migrations recorded, 0 pending)",
                migrations.len()
            );
            return Ok(());
        }
        if baseline {
            println!(
                "[migrate] baseline mode — recording {} migration(s) as applied without running them",
                pending.len()
            );
            for m in &pending {
                client
                    .query_bind(
                        "INSERT INTO _rivetos_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING",
                        &m.name,
                    )
                    .await?;
                println!("[migrate]   ✓ {} marked applied (baseline)", m.name);
            }
            println!("[migrate] baseline complete — {} marked applied", pending.len());
            return Ok(());
        }
        println!("[migrate] {} applied, {} pending", applied.len(), pending.len());
        let pending_len = pending.len();
        for m in pending {
            apply_migration(
                client,
                m,
                |ms| async move {
                    if ms > 0 {
                        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                    }
                },
                &MIGRATION_LOCK_BACKOFF_MS,
            )
            .await?;
        }
        println!("[migrate] done — {pending_len} migration(s) applied");
        Ok(())
    }
    .await;
    let _ = reset_session_guards(client).await;
    outcome
}
