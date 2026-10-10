use sqlx::postgres::PgRow;
use sqlx::{PgConnection, Row};

use crate::migrate::{embedded_as_migrations, run_migrations, MigrateClient, MigrateFault, MigrateRows};
use crate::report::format_js_iso;

pub struct AppliedMigration {
    pub name: String,
    pub applied_at: chrono::DateTime<chrono::Utc>,
}

pub enum MigrationStatus {
    MissingTable,
    Empty,
    Applied(Vec<AppliedMigration>),
}

pub fn format_applied_at(dt: chrono::DateTime<chrono::Utc>) -> String {
    format_js_iso(dt)
}

fn fault(err: sqlx::Error) -> MigrateFault {
    if let Some(db) = err.as_database_error() {
        return MigrateFault {
            message: db.message().to_string(),
            code: db.code().map(|code| code.into_owned()),
        };
    }
    MigrateFault::new(err.to_string())
}

fn is_select(sql: &str) -> bool {
    let mut rest = sql.trim_start();
    loop {
        if let Some(stripped) = rest.strip_prefix("--") {
            rest = match stripped.find('\n') {
                Some(index) => stripped[index + 1..].trim_start(),
                None => return false,
            };
            continue;
        }
        if let Some(stripped) = rest.strip_prefix("/*") {
            rest = match stripped.find("*/") {
                Some(index) => stripped[index + 2..].trim_start(),
                None => return false,
            };
            continue;
        }
        break;
    }
    rest.len() >= 6 && rest[..6].eq_ignore_ascii_case("select")
}

fn cell_string(row: &PgRow, index: usize) -> Option<String> {
    if let Ok(value) = row.try_get::<Option<String>, _>(index) {
        return value;
    }
    if let Ok(value) = row.try_get::<Option<i64>, _>(index) {
        return value.map(|n| n.to_string());
    }
    if let Ok(value) = row.try_get::<Option<i32>, _>(index) {
        return value.map(|n| n.to_string());
    }
    if let Ok(value) = row.try_get::<Option<bool>, _>(index) {
        return value.map(|flag| flag.to_string());
    }
    if let Ok(value) = row.try_get::<Option<uuid::Uuid>, _>(index) {
        return value.map(|id| id.to_string());
    }
    None
}

fn rows_from(fetched: Vec<PgRow>) -> MigrateRows {
    let mut rows = Vec::new();
    for row in fetched {
        let mut cells = Vec::new();
        for index in 0..row.columns().len() {
            cells.push(cell_string(&row, index));
        }
        rows.push(cells);
    }
    MigrateRows { rows }
}

pub struct SqlxMigrate<'a> {
    pub conn: &'a mut PgConnection,
}

impl MigrateClient for SqlxMigrate<'_> {
    async fn query(&mut self, sql: &str) -> Result<MigrateRows, MigrateFault> {
        self.exec(sql, None).await
    }

    async fn query_bind(&mut self, sql: &str, param: &str) -> Result<MigrateRows, MigrateFault> {
        self.exec(sql, Some(param)).await
    }
}

impl SqlxMigrate<'_> {
    async fn exec(&mut self, sql: &str, param: Option<&str>) -> Result<MigrateRows, MigrateFault> {
        if param.is_some() || is_select(sql) {
            let mut query = sqlx::query(sql);
            if let Some(value) = param {
                query = query.bind(value);
            }
            let fetched = query.fetch_all(&mut *self.conn).await.map_err(fault)?;
            return Ok(rows_from(fetched));
        }
        sqlx::raw_sql(sql).execute(&mut *self.conn).await.map_err(fault)?;
        Ok(MigrateRows::default())
    }
}

pub async fn migrate_connection(conn: &mut PgConnection, baseline: bool) -> Result<(), MigrateFault> {
    let migrations = embedded_as_migrations();
    let mut client = SqlxMigrate { conn };
    run_migrations(&mut client, &migrations, baseline).await
}

pub async fn migrate_database(url: &str, baseline: bool) -> Result<(), MigrateFault> {
    let mut conn = PgConnection::connect(url).await.map_err(fault)?;
    migrate_connection(&mut conn, baseline).await
}

pub async fn migration_status(url: &str) -> Result<MigrationStatus, MigrateFault> {
    let mut conn = PgConnection::connect(url).await.map_err(fault)?;
    let exists: Option<String> =
        sqlx::query_scalar("SELECT to_regclass('_rivetos_migrations')::text")
            .fetch_one(&mut conn)
            .await
            .map_err(fault)?;
    if exists.as_deref().unwrap_or("").is_empty() {
        return Ok(MigrationStatus::MissingTable);
    }
    let rows = sqlx::query("SELECT name, applied_at FROM _rivetos_migrations ORDER BY name")
        .fetch_all(&mut conn)
        .await
        .map_err(fault)?;
    if rows.is_empty() {
        return Ok(MigrationStatus::Empty);
    }
    let mut applied = Vec::new();
    for row in rows {
        let name: String = row.try_get("name").map_err(fault)?;
        let applied_at: chrono::DateTime<chrono::Utc> = row.try_get("applied_at").map_err(fault)?;
        applied.push(AppliedMigration { name, applied_at });
    }
    Ok(MigrationStatus::Applied(applied))
}
