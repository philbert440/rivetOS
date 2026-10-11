use std::future::Future;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{Connection, PgConnection, PgPool};

static SCHEMA_SEQ: AtomicU64 = AtomicU64::new(0);

pub struct Db {
    pub pool: PgPool,
    pub name: String,
    pub url: String,
    pub scoped_url: String,
}

enum Setup {
    Skip(String),
    Fail(String),
}

pub fn scoped_search_path(url: &str, path: &str) -> String {
    let sep = if url.contains('?') { '&' } else { '?' };
    format!("{url}{sep}options[search_path]={path}")
}

pub fn scoped_url(url: &str, schema: &str) -> String {
    scoped_search_path(url, &format!("{schema},public"))
}

pub async fn with_db<F, Fut>(
    test_name: &str,
    prefix: &str,
    migrate: bool,
    max_connections: u32,
    body: F,
) where
    F: FnOnce(Db) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    let Some(url) = std::env::var("RIVETOS_PG_URL")
        .ok()
        .filter(|value| !value.is_empty())
    else {
        eprintln!("rr-2a db test {test_name} skipped: RIVETOS_PG_URL is unset");
        return;
    };
    let name = schema_name(prefix);
    let max_connections = max_connections.max(2);
    let prepared = prepare(&url, &name, migrate, max_connections).await;
    let db = match prepared {
        Ok(db) => db,
        Err(Setup::Skip(reason)) => {
            eprintln!("rr-2a db test {test_name} skipped: {reason}");
            return;
        }
        Err(Setup::Fail(reason)) => {
            panic!("rr-2a db test {test_name} setup failed: {reason}");
        }
    };
    if !db.scoped_url.contains("search_path") {
        panic!("rr-2a db test {test_name} setup failed: search_path was not pinned");
    }
    let pool = db.pool.clone();
    let schema = db.name.clone();
    let raw_url = db.url.clone();
    let result = body(db).await;
    pool.close().await;
    cleanup(&raw_url, &schema).await;
    if let Err(err) = result {
        panic!("rr-2a db test {test_name} failed: {err}");
    }
}

fn schema_name(prefix: &str) -> String {
    let seq = SCHEMA_SEQ.fetch_add(1, Ordering::Relaxed);
    let mut raw = format!("{prefix}_{}_{seq}", std::process::id());
    raw.retain(|ch| ch.is_ascii_alphanumeric() || ch == '_');
    let mut name = raw.to_ascii_lowercase();
    if name.chars().next().is_some_and(|ch| ch.is_ascii_digit()) {
        name.insert_str(0, "s_");
    }
    if name.len() > 63 {
        name.truncate(63);
    }
    while name.ends_with('_') {
        name.pop();
    }
    if name.is_empty() {
        name = format!("rr2a_{}_{seq}", std::process::id());
    }
    name
}

async fn prepare(
    url: &str,
    schema: &str,
    migrate: bool,
    max_connections: u32,
) -> Result<Db, Setup> {
    let mut admin = PgConnection::connect(url)
        .await
        .map_err(|err| Setup::Fail(err.to_string()))?;
    if migrate {
        let jobs: Option<String> =
            sqlx::query_scalar("SELECT to_regclass('graphile_worker._private_jobs')::text")
                .fetch_one(&mut admin)
                .await
                .map_err(|err| Setup::Fail(err.to_string()))?;
        if jobs.as_deref().unwrap_or("").is_empty() {
            return Err(Setup::Skip(
                "graphile_worker._private_jobs is missing".to_string(),
            ));
        }
    }
    let create = format!("CREATE SCHEMA {schema}");
    sqlx::raw_sql(sqlx::AssertSqlSafe(create))
        .execute(&mut admin)
        .await
        .map_err(|err| Setup::Fail(err.to_string()))?;
    drop(admin);

    let scoped_url = scoped_url(url, schema);
    if migrate {
        let mut conn = PgConnection::connect(&scoped_url)
            .await
            .map_err(|err| Setup::Fail(err.to_string()))?;
        if let Err(err) = memory::migrate_connection(&mut conn, false).await {
            let message = err.message.to_ascii_lowercase();
            let drop_sql = format!("DROP SCHEMA IF EXISTS {schema} CASCADE");
            let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(drop_sql))
                .execute(&mut conn)
                .await;
            if message.contains("extension")
                || message.contains("vector")
                || message.contains("pg_trgm")
            {
                return Err(Setup::Skip(format!(
                    "migration needs an extension ({})",
                    err.message
                )));
            }
            return Err(Setup::Fail(err.message));
        }
    }

    let path = format!("{schema},public");
    let options = PgConnectOptions::from_str(url)
        .map_err(|err| Setup::Fail(err.to_string()))?
        .options([("search_path", path.clone())]);
    let statement = format!("SET search_path TO {schema}, public");
    let pool = PgPoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(Duration::from_secs(10))
        .after_connect(move |conn, _meta| {
            let statement = statement.clone();
            Box::pin(async move {
                sqlx::raw_sql(sqlx::AssertSqlSafe(statement))
                    .execute(conn)
                    .await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .map_err(|err| Setup::Fail(err.to_string()))?;

    let mut first = pool
        .acquire()
        .await
        .map_err(|err| Setup::Fail(err.to_string()))?;
    let mut second = pool
        .acquire()
        .await
        .map_err(|err| Setup::Fail(err.to_string()))?;
    let path_a: String = sqlx::query_scalar("SHOW search_path")
        .fetch_one(&mut *first)
        .await
        .map_err(|err| Setup::Fail(err.to_string()))?;
    let path_b: String = sqlx::query_scalar("SHOW search_path")
        .fetch_one(&mut *second)
        .await
        .map_err(|err| Setup::Fail(err.to_string()))?;
    drop(first);
    drop(second);
    if !path_a.contains(schema) || !path_b.contains(schema) {
        pool.close().await;
        cleanup(url, schema).await;
        return Err(Setup::Fail(format!(
            "search_path {path_a:?} / {path_b:?} missing {schema}"
        )));
    }

    Ok(Db {
        pool,
        name: schema.to_string(),
        url: url.to_string(),
        scoped_url,
    })
}

async fn cleanup(url: &str, schema: &str) {
    let Ok(mut conn) = PgConnection::connect(url).await else {
        return;
    };
    let set_path = format!("SET search_path TO {schema}, public");
    let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(set_path))
        .execute(&mut conn)
        .await;
    let messages: Vec<String> = sqlx::query_scalar("SELECT id::text FROM ros_messages")
        .fetch_all(&mut conn)
        .await
        .unwrap_or_default();
    let summaries: Vec<String> = sqlx::query_scalar("SELECT id::text FROM ros_summaries")
        .fetch_all(&mut conn)
        .await
        .unwrap_or_default();
    let mut keys = Vec::new();
    for id in messages {
        keys.push(format!("embed-ros_messages-{id}"));
        keys.push(format!("tool-synth-{id}"));
    }
    for id in summaries {
        keys.push(format!("embed-ros_summaries-{id}"));
    }
    if !keys.is_empty() {
        let _ =
            sqlx::query("DELETE FROM graphile_worker._private_jobs WHERE key = ANY($1::text[])")
                .bind(&keys)
                .execute(&mut conn)
                .await;
    }
    let drop_sql = format!("DROP SCHEMA IF EXISTS {schema} CASCADE");
    let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(drop_sql))
        .execute(&mut conn)
        .await;
}

pub fn migrations_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../plugins/memory/postgres/src/schema/migrations/0001_baseline.sql")
        .parent()
        .expect("migration file")
        .to_path_buf()
}

pub fn read_migration(name: &str) -> Result<String, String> {
    std::fs::read_to_string(migrations_dir().join(name)).map_err(|err| err.to_string())
}

pub async fn apply_file(conn: &mut PgConnection, sql: &str) -> Result<(), String> {
    sqlx::query("BEGIN")
        .execute(&mut *conn)
        .await
        .map_err(|err| err.to_string())?;
    let applied = sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_string()))
        .execute(&mut *conn)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string());
    if applied.is_ok() {
        sqlx::query("COMMIT")
            .execute(&mut *conn)
            .await
            .map_err(|err| err.to_string())?;
    } else {
        let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
    }
    applied
}

pub fn pg_code(err: &sqlx::Error) -> Option<String> {
    err.as_database_error()
        .and_then(|db| db.code().map(|code| code.into_owned()))
}
