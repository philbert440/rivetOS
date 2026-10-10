use std::path::PathBuf;

use serde_json::Value;

use crate::db::{self, query_maps};
use crate::hermes::hermes_turns_from_rows;
use crate::roots::Roots;
use crate::timeutil::{parse_date_ms, to_epoch_ms_number};
use crate::turn::{SessionRow, Turn};
use crate::value::{jtrim, js_slice};

pub fn list(roots: &Roots, limit: usize) -> Vec<SessionRow> {
    let Some(conn) = db::open_readonly(&db_path(roots)) else {
        return Vec::new();
    };
    let sql = "SELECT s.id AS id, s.started_at AS started, s.ended_at AS ended,
                (SELECT m.content FROM messages m
                  WHERE m.session_id = s.id AND m.role = 'user'
                  ORDER BY m.timestamp ASC LIMIT 1) AS title
         FROM sessions s
         ORDER BY COALESCE(s.ended_at, s.started_at) DESC
         LIMIT ?";
    let Ok(limit_i64) = i64::try_from(limit) else {
        return Vec::new();
    };
    let Some(rows) = query_maps(&conn, sql, &[&limit_i64]) else {
        return Vec::new();
    };
    rows.iter().map(row_from).collect()
}

pub fn describe(roots: &Roots, id: &str) -> Option<SessionRow> {
    if id.is_empty() || id.contains('/') || id.contains("..") {
        return None;
    }
    let conn = db::open_readonly(&db_path(roots))?;
    let sql = "SELECT s.id AS id, s.started_at AS started, s.ended_at AS ended,
                (SELECT m.content FROM messages m
                  WHERE m.session_id = s.id AND m.role = 'user'
                  ORDER BY m.timestamp ASC LIMIT 1) AS title
         FROM sessions s WHERE s.id = ? LIMIT 1";
    let rows = query_maps(&conn, sql, &[&id])?;
    let row = rows.first()?;
    let mut session = row_from(row);
    let started = epoch_of(row.get("started"));
    if started != 0 {
        session.created_at = Some(started);
    }
    Some(session)
}

pub fn exists_session(roots: &Roots, id: &str) -> bool {
    let Some(conn) = db::open_readonly(&db_path(roots)) else {
        return false;
    };
    query_maps(&conn, "SELECT 1 FROM sessions WHERE id = ? LIMIT 1", &[&id]).is_some_and(|rows| !rows.is_empty())
}

pub fn turns(roots: &Roots, id: &str) -> Vec<Turn> {
    let Some(conn) = db::open_readonly(&db_path(roots)) else {
        return Vec::new();
    };
    let sql = "SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC, rowid ASC";
    let Some(rows) = query_maps(&conn, sql, &[&id]) else {
        return Vec::new();
    };
    hermes_turns_from_rows(&rows)
}

pub fn db_path(roots: &Roots) -> PathBuf {
    let base = roots.env_trim("HERMES_HOME").map(PathBuf::from).unwrap_or_else(|| roots.join_home(&[".hermes"]));
    base.join("state.db")
}

fn row_from(row: &serde_json::Map<String, Value>) -> SessionRow {
    let id = row.get("id").map(value_string).unwrap_or_default();
    let title_raw = row.get("title").and_then(Value::as_str).unwrap_or("");
    let title = {
        let trimmed = jtrim(title_raw);
        if trimmed.is_empty() { id.clone() } else { js_slice(trimmed, 0, Some(120)) }
    };
    let updated = epoch_of(row.get("ended").or_else(|| row.get("started")));
    SessionRow {
        id,
        command: "hermes".into(),
        title,
        updated_at: updated,
        created_at: None,
        cwd: None,
        model: None,
        parent_session_id: None,
        agent_name: None,
        task_id: None,
    }
}

fn epoch_of(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::Number(number)) => number.as_f64().map(to_epoch_ms_number).unwrap_or(0),
        Some(Value::String(text)) => parse_date_ms(text).unwrap_or(0),
        _ => 0,
    }
}

fn value_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        other => other.to_string(),
    }
}
