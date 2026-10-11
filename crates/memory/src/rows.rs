use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::postgres::PgArguments;
use sqlx::{Column, PgConnection, Postgres, Row, TypeInfo};

use crate::report::format_js_iso;

#[derive(Debug, Clone)]
pub enum Bind {
    Null,
    NullTexts,
    Bool(bool),
    I64(i64),
    F64(f64),
    Text(String),
    Texts(Vec<String>),
}

#[derive(Debug, Clone)]
pub enum Cell {
    Null,
    Bool(bool),
    I64(i64),
    F64(f64),
    Text(String),
    Json(Value),
}

impl Cell {
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Self::Text(text) => Some(text),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Self::F64(n) if n.is_finite() => Some(*n),
            Self::I64(n) => Some(*n as f64),
            Self::Text(text) => text.parse::<f64>().ok().filter(|n| n.is_finite()),
            Self::Json(Value::Number(n)) => n.as_f64().filter(|v| v.is_finite()),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Self::I64(n) => Some(*n),
            Self::F64(n) if n.is_finite() && n.fract() == 0.0 => Some(*n as i64),
            Self::Text(text) => text.parse::<i64>().ok(),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(v) => Some(*v),
            Self::Text(text) if text == "true" || text == "t" => Some(true),
            Self::Text(text) if text == "false" || text == "f" => Some(false),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct QueryResult {
    pub rows: Vec<HashMap<String, Cell>>,
    pub row_count: i64,
}

impl QueryResult {
    pub fn empty() -> Self {
        Self {
            rows: Vec::new(),
            row_count: 0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct DbFail {
    pub message: String,
    pub code: Option<String>,
    pub connect: bool,
}

impl std::fmt::Display for DbFail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl DbFail {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
            connect: false,
        }
    }

    pub fn from_sqlx(err: sqlx::Error) -> Self {
        let code = err
            .as_database_error()
            .and_then(|db| db.code().map(|c| c.to_string()));
        let message = err
            .as_database_error()
            .map(|db| db.message().to_string())
            .unwrap_or_else(|| err.to_string());
        let lowered = message.to_ascii_lowercase();
        let connect = matches!(
            err,
            sqlx::Error::Io(_) | sqlx::Error::Tls(_) | sqlx::Error::PoolTimedOut
        ) || lowered.contains("connect")
            || lowered.contains("timed out");
        Self {
            message,
            code,
            connect,
        }
    }
}

pub fn collapse_ws(sql: &str) -> String {
    let mut out = String::new();
    let mut spaced = false;
    for ch in sql.chars() {
        if ch.is_whitespace() {
            if !spaced && !out.is_empty() {
                out.push(' ');
                spaced = true;
            }
        } else {
            out.push(ch);
            spaced = false;
        }
    }
    out.trim().to_string()
}

fn returns_rows(sql: &str) -> bool {
    let flat = collapse_ws(sql).to_ascii_uppercase();
    flat.starts_with("SELECT")
        || flat.starts_with("WITH")
        || flat.starts_with("SHOW")
        || flat.contains(" RETURNING")
}

fn bind_query<'q>(
    sql: &'q str,
    params: &'q [Bind],
) -> sqlx::query::Query<'q, Postgres, PgArguments> {
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
    for param in params {
        query = match param {
            Bind::Null => query.bind(None::<String>),
            Bind::NullTexts => query.bind(None::<Vec<String>>),
            Bind::Bool(value) => query.bind(*value),
            Bind::I64(value) => query.bind(*value),
            Bind::F64(value) => query.bind(*value),
            Bind::Text(value) => query.bind(value.as_str()),
            Bind::Texts(value) => query.bind(value),
        };
    }
    query
}

fn cell_of(row: &sqlx::postgres::PgRow, idx: usize) -> Cell {
    let name = row.column(idx).type_info().name().to_ascii_uppercase();
    match name.as_str() {
        "BOOL" => row
            .try_get::<Option<bool>, _>(idx)
            .ok()
            .flatten()
            .map(Cell::Bool)
            .unwrap_or(Cell::Null),
        "INT2" | "INT4" => row
            .try_get::<Option<i32>, _>(idx)
            .ok()
            .flatten()
            .map(|n| Cell::I64(i64::from(n)))
            .unwrap_or(Cell::Null),
        "INT8" => row
            .try_get::<Option<i64>, _>(idx)
            .ok()
            .flatten()
            .map(Cell::I64)
            .unwrap_or(Cell::Null),
        "FLOAT4" => row
            .try_get::<Option<f32>, _>(idx)
            .ok()
            .flatten()
            .map(|n| Cell::F64(f64::from(n)))
            .unwrap_or(Cell::Null),
        "FLOAT8" => row
            .try_get::<Option<f64>, _>(idx)
            .ok()
            .flatten()
            .map(Cell::F64)
            .unwrap_or(Cell::Null),
        "TEXT" | "VARCHAR" | "NAME" | "BPCHAR" | "CITEXT" => row
            .try_get::<Option<String>, _>(idx)
            .ok()
            .flatten()
            .map(Cell::Text)
            .unwrap_or(Cell::Null),
        "UUID" => row
            .try_get::<Option<uuid::Uuid>, _>(idx)
            .ok()
            .flatten()
            .map(|id| Cell::Text(id.to_string()))
            .unwrap_or(Cell::Null),
        "TIMESTAMPTZ" => row
            .try_get::<Option<DateTime<Utc>>, _>(idx)
            .ok()
            .flatten()
            .map(|dt| Cell::Text(format_js_iso(dt)))
            .unwrap_or(Cell::Null),
        "JSON" | "JSONB" => row
            .try_get::<Option<Value>, _>(idx)
            .ok()
            .flatten()
            .map(Cell::Json)
            .unwrap_or(Cell::Null),
        "TEXT[]" | "_TEXT" => row
            .try_get::<Option<Vec<String>>, _>(idx)
            .ok()
            .flatten()
            .map(|items| Cell::Json(Value::Array(items.into_iter().map(Value::String).collect())))
            .unwrap_or(Cell::Null),
        _ => {
            if let Ok(Some(text)) = row.try_get::<Option<String>, _>(idx) {
                Cell::Text(text)
            } else if let Ok(Some(n)) = row.try_get::<Option<f64>, _>(idx) {
                Cell::F64(n)
            } else if let Ok(Some(n)) = row.try_get::<Option<i64>, _>(idx) {
                Cell::I64(n)
            } else if let Ok(Some(v)) = row.try_get::<Option<bool>, _>(idx) {
                Cell::Bool(v)
            } else if let Ok(Some(value)) = row.try_get::<Option<Value>, _>(idx) {
                Cell::Json(value)
            } else {
                Cell::Null
            }
        }
    }
}

fn map_row(row: &sqlx::postgres::PgRow) -> HashMap<String, Cell> {
    let mut out = HashMap::new();
    for idx in 0..row.columns().len() {
        let name = row.column(idx).name().to_string();
        out.insert(name, cell_of(row, idx));
    }
    out
}

pub async fn exec_query(
    conn: &mut PgConnection,
    sql: &str,
    params: &[Bind],
) -> Result<QueryResult, DbFail> {
    let query = bind_query(sql, params);
    if returns_rows(sql) {
        let rows = query
            .fetch_all(&mut *conn)
            .await
            .map_err(DbFail::from_sqlx)?;
        let mapped = rows.iter().map(map_row).collect::<Vec<_>>();
        let row_count = i64::try_from(mapped.len()).unwrap_or(i64::MAX);
        Ok(QueryResult {
            rows: mapped,
            row_count,
        })
    } else {
        let done = query.execute(&mut *conn).await.map_err(DbFail::from_sqlx)?;
        Ok(QueryResult {
            rows: Vec::new(),
            row_count: i64::try_from(done.rows_affected()).unwrap_or(i64::MAX),
        })
    }
}

pub fn cell<'a>(row: &'a HashMap<String, Cell>, name: &str) -> Option<&'a Cell> {
    row.get(name)
}

pub fn text_cell(row: &HashMap<String, Cell>, name: &str) -> String {
    cell(row, name)
        .and_then(Cell::as_text)
        .unwrap_or("")
        .to_string()
}

pub fn opt_text(row: &HashMap<String, Cell>, name: &str) -> Option<String> {
    match cell(row, name) {
        Some(Cell::Null) | None => None,
        Some(Cell::Text(text)) if text.is_empty() => Some(text.clone()),
        Some(cell) => cell.as_text().map(str::to_string).or_else(|| {
            cell.as_f64().map(|n| {
                if n.fract() == 0.0 {
                    format!("{}", n as i64)
                } else {
                    format!("{n}")
                }
            })
        }),
    }
}
