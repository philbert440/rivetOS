use std::collections::HashMap;
use std::path::PathBuf;

use serde_json::{Map, Value};

use crate::db::{self, query_maps};
use crate::fsutil::node_resolve;
use crate::opencode::opencode_turns_from_messages;
use crate::roots::Roots;
use crate::timeutil::{opencode_epoch_number, parse_date_ms};
use crate::turn::{SessionRow, Turn};
use crate::value::{Obj, jtrim, js_slice, whitespace_collapse};

pub fn list(roots: &Roots, limit: usize) -> Vec<SessionRow> {
    let Some(conn) = db::open_readonly(&db_path(roots)) else {
        return Vec::new();
    };
    let Ok(limit_i64) = i64::try_from(limit) else {
        return Vec::new();
    };
    let sql = "SELECT id, title, model, time_created, time_updated FROM session ORDER BY time_updated DESC LIMIT ?";
    let Some(rows) = query_maps(&conn, sql, &[&limit_i64]) else {
        return Vec::new();
    };
    rows.iter().map(row_to_session).collect()
}

pub fn describe(roots: &Roots, id: &str) -> Option<SessionRow> {
    if !id_safe(id) {
        return None;
    }
    let conn = db::open_readonly(&db_path(roots))?;
    let sql = "SELECT id, title, model, time_created, time_updated FROM session WHERE id = ? LIMIT 1";
    let rows = query_maps(&conn, sql, &[&id])?;
    rows.first().map(row_to_session)
}

pub fn exists_session(roots: &Roots, id: &str) -> bool {
    if !id_safe(id) {
        return false;
    }
    let Some(conn) = db::open_readonly(&db_path(roots)) else {
        return false;
    };
    query_maps(&conn, "SELECT 1 FROM session WHERE id = ? LIMIT 1", &[&id]).is_some_and(|rows| !rows.is_empty())
}

pub fn newest_after(roots: &Roots, cwd: &str, since_ms: i64) -> Option<String> {
    let conn = db::open_readonly(&db_path(roots))?;
    let sql = "SELECT id, directory, time_created FROM session WHERE time_created >= ? ORDER BY time_created DESC, time_updated DESC";
    let rows = query_maps(&conn, sql, &[&since_ms])?;
    let cwd_resolved = if cwd.is_empty() { String::new() } else { node_resolve(&roots.cwd, cwd).to_string_lossy().into_owned() };
    for row in rows {
        let id = row.get("id").and_then(Value::as_str).unwrap_or("");
        if id.is_empty() {
            continue;
        }
        if let Some(dir) = row.get("directory").and_then(Value::as_str)
            && !cwd_resolved.is_empty() {
                let resolved = node_resolve(&roots.cwd, dir).to_string_lossy().into_owned();
                if resolved != cwd_resolved {
                    continue;
                }
            }
        return Some(id.to_string());
    }
    None
}

pub fn turns(roots: &Roots, id: &str) -> Vec<Turn> {
    let Some(conn) = db::open_readonly(&db_path(roots)) else {
        return Vec::new();
    };
    let messages = query_maps(
        &conn,
        "SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC",
        &[&id],
    )
    .unwrap_or_default();
    let parts = query_maps(
        &conn,
        "SELECT id, message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created ASC",
        &[&id],
    )
    .unwrap_or_default();
    let mut by_message: HashMap<String, Vec<Obj>> = HashMap::new();
    for part in parts {
        let Some(mid) = part.get("message_id").and_then(Value::as_str) else {
            continue;
        };
        let mut rec = json_object(part.get("data"));
        if let Some(id) = part.get("id").and_then(Value::as_str) {
            rec.insert("id".into(), Value::String(id.to_string()));
        }
        if let Some(time) = part.get("time_created").cloned() {
            rec.insert("time_created".into(), time);
        }
        by_message.entry(mid.to_string()).or_default().push(rec);
    }
    let msgs: Vec<Obj> = messages
        .into_iter()
        .map(|message| {
            let mut rec = json_object(message.get("data"));
            if let Some(id) = message.get("id").and_then(Value::as_str) {
                rec.insert("id".into(), Value::String(id.to_string()));
            }
            if let Some(time) = message.get("time_created").cloned() {
                rec.insert("time_created".into(), time);
            }
            rec
        })
        .collect();
    opencode_turns_from_messages(&msgs, &by_message)
}

pub fn data_dir(roots: &Roots) -> PathBuf {
    let base = roots
        .env_trim("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| roots.join_home(&[".local", "share"]));
    base.join("opencode")
}

pub fn db_path(roots: &Roots) -> PathBuf {
    data_dir(roots).join("opencode.db")
}

fn id_safe(id: &str) -> bool {
    !id.is_empty() && !id.contains('/') && !id.contains("..")
}

fn row_to_session(row: &Obj) -> SessionRow {
    let id = row.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let title_raw = row.get("title").and_then(Value::as_str).unwrap_or("");
    let collapsed_owned = whitespace_collapse(title_raw);
    let collapsed = jtrim(&collapsed_owned);
    let title = if collapsed.is_empty() { id.clone() } else { js_slice(collapsed, 0, Some(120)) };
    let created = epoch_of(row.get("time_created"));
    let updated = epoch_of(row.get("time_updated"));
    let model = model_label(row.get("model"));
    SessionRow {
        id,
        command: "opencode".into(),
        title,
        updated_at: if updated == 0 { created } else { updated },
        created_at: if created == 0 { None } else { Some(created) },
        cwd: None,
        model,
        parent_session_id: None,
        agent_name: None,
        task_id: None,
    }
}

fn model_label(raw: Option<&Value>) -> Option<String> {
    let mut value = raw?.clone();
    if let Value::String(text) = &value {
        let trimmed = jtrim(text);
        if trimmed.is_empty() {
            return None;
        }
        value = serde_json::from_str(trimmed).unwrap_or(Value::String(trimmed.to_string()));
    }
    let Value::Object(obj) = value else {
        return None;
    };
    let id = obj.get("id").and_then(Value::as_str).unwrap_or("");
    let provider = obj.get("providerID").and_then(Value::as_str).unwrap_or("");
    if !provider.is_empty() && !id.is_empty() {
        return Some(format!("{provider}/{id}"));
    }
    if id.is_empty() { None } else { Some(id.to_string()) }
}

fn epoch_of(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::Number(number)) => number.as_f64().map(opencode_epoch_number).unwrap_or(0),
        Some(Value::String(text)) => parse_date_ms(text).unwrap_or(0),
        _ => 0,
    }
}

fn json_object(value: Option<&Value>) -> Obj {
    let Some(value) = value else {
        return Map::new();
    };
    if let Some(obj) = value.as_object() {
        return obj.clone();
    }
    if let Some(text) = value.as_str()
        && let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(text) {
            return obj;
        }
    Map::new()
}
