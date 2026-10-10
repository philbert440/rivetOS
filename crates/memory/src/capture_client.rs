use std::time::Duration;

use sqlx::postgres::PgPoolOptions;
use sqlx::PgConnection;

use crate::error::StoreError;

pub const IDLE_IN_TRANSACTION_TIMEOUT: &str = "30s";
pub const IDLE_IN_TRANSACTION_TIMEOUT_MS: u64 = 30_000;
pub const STATEMENT_TIMEOUT: &str = "60s";
pub const STATEMENT_TIMEOUT_MS: u64 = 60_000;
pub const CAPTURE_POOL_MAX: u32 = 1;

pub fn capture_guard_statements() -> [&'static str; 2] {
    [
        "SET idle_in_transaction_session_timeout = '30s'",
        "SET statement_timeout = '60s'",
    ]
}

pub async fn apply_capture_guards(conn: &mut PgConnection) -> Result<(), StoreError> {
    for sql in capture_guard_statements() {
        sqlx::query(sql).execute(&mut *conn).await.map_err(|err| {
            eprintln!("[PostgresMemory] Pool error: {err}");
            StoreError::connection(err)
        })?;
    }
    Ok(())
}

pub async fn open_capture_pool(url: &str) -> Result<sqlx::PgPool, StoreError> {
    PgPoolOptions::new()
        .max_connections(CAPTURE_POOL_MAX)
        .acquire_timeout(Duration::from_millis(10_000))
        .idle_timeout(Duration::from_millis(IDLE_IN_TRANSACTION_TIMEOUT_MS))
        .connect(url)
        .await
        .map_err(|err| {
            eprintln!("[PostgresMemory] Pool error: {err}");
            StoreError::connection(err)
        })
}

pub async fn checkout_capture(pool: &sqlx::PgPool) -> Result<sqlx::pool::PoolConnection<sqlx::Postgres>, StoreError> {
    let mut conn = pool.acquire().await.map_err(|err| {
        eprintln!("[PostgresMemory] Pool error: {err}");
        StoreError::connection(err)
    })?;
    apply_capture_guards(&mut conn).await?;
    Ok(conn)
}

pub async fn with_capture_client<T, F, Fut>(pool: &sqlx::PgPool, f: F) -> Result<T, StoreError>
where
    F: FnOnce(&mut PgConnection) -> Fut,
    Fut: std::future::Future<Output = Result<T, StoreError>>,
{
    let mut conn = checkout_capture(pool).await?;
    f(&mut conn).await
}
