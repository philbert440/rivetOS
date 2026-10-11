use std::collections::BTreeMap;
use std::path::Path;

use rusqlite::{Connection, OpenFlags};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HermesTokenKind {
    SessionTotal,
    Message,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct HermesTokenCounts {
    pub input: Option<f64>,
    pub output: Option<f64>,
    pub cache_read: Option<f64>,
    pub cache_write: Option<f64>,
    pub reasoning: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HermesTokenSnapshot {
    pub kind: HermesTokenKind,
    pub counts: HermesTokenCounts,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HermesUsage {
    pub input_total: Option<f64>,
    pub no_cache: Option<f64>,
    pub cache_read: Option<f64>,
    pub cache_write: Option<f64>,
    pub output_total: Option<f64>,
    pub output_text: Option<f64>,
    pub reasoning: Option<f64>,
}

#[derive(Debug, Clone)]
pub enum Cell {
    Number(f64),
    Text(String),
}

pub fn unknown_tokens() -> HermesTokenSnapshot {
    HermesTokenSnapshot {
        kind: HermesTokenKind::Unknown,
        counts: HermesTokenCounts::default(),
    }
}

pub fn tokens_from_row(row: &BTreeMap<String, Cell>) -> HermesTokenCounts {
    let input = token_num(row.get("input_tokens"))
        .or_else(|| token_num(row.get("prompt_tokens")))
        .or_else(|| token_num(row.get("tokens_input")));
    let output = token_num(row.get("output_tokens"))
        .or_else(|| token_num(row.get("completion_tokens")))
        .or_else(|| token_num(row.get("tokens_output")))
        .or_else(|| token_num(row.get("token_count")));
    HermesTokenCounts {
        input,
        output,
        cache_read: token_num(row.get("cache_read_tokens")),
        cache_write: token_num(row.get("cache_write_tokens")),
        reasoning: token_num(row.get("reasoning_tokens")),
    }
}

pub fn usage_from_tokens(counts: &HermesTokenCounts) -> HermesUsage {
    if !has_counts(counts) {
        return HermesUsage {
            input_total: None,
            no_cache: None,
            cache_read: None,
            cache_write: None,
            output_total: None,
            output_text: None,
            reasoning: None,
        };
    }
    HermesUsage {
        input_total: counts.input,
        no_cache: None,
        cache_read: counts.cache_read,
        cache_write: counts.cache_write,
        output_total: counts.output,
        output_text: counts.output,
        reasoning: counts.reasoning,
    }
}

pub fn usage_delta(before: &HermesTokenCounts, after: &HermesTokenCounts) -> HermesTokenCounts {
    HermesTokenCounts {
        input: delta_field(before.input, after.input),
        output: delta_field(before.output, after.output),
        cache_read: delta_field(before.cache_read, after.cache_read),
        cache_write: delta_field(before.cache_write, after.cache_write),
        reasoning: delta_field(before.reasoning, after.reasoning),
    }
}

pub fn tokens_for_turn(
    resumed: bool,
    prior: &HermesTokenSnapshot,
    after: &HermesTokenSnapshot,
) -> HermesTokenCounts {
    if after.kind == HermesTokenKind::Unknown {
        return HermesTokenCounts::default();
    }
    if after.kind == HermesTokenKind::Message || !resumed {
        return after.counts.clone();
    }
    if prior.kind != HermesTokenKind::SessionTotal {
        return HermesTokenCounts::default();
    }
    usage_delta(&prior.counts, &after.counts)
}

pub fn read_hermes_session_tokens(path: &str, session_id: &str) -> HermesTokenSnapshot {
    if session_id.is_empty() || !Path::new(path).exists() {
        return unknown_tokens();
    }
    let Ok(conn) = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return unknown_tokens();
    };
    let session_tokens = match query_map(
        &conn,
        "SELECT * FROM sessions WHERE id = ?1 LIMIT 1",
        session_id,
    ) {
        Ok(Some(row)) => tokens_from_row(&row),
        _ => HermesTokenCounts::default(),
    };
    if has_session_totals(&session_tokens) {
        return HermesTokenSnapshot {
            kind: HermesTokenKind::SessionTotal,
            counts: session_tokens,
        };
    }
    match query_map(
        &conn,
        "SELECT * FROM messages WHERE session_id = ?1 AND role = 'assistant' ORDER BY timestamp DESC, rowid DESC LIMIT 1",
        session_id,
    ) {
        Ok(Some(row)) => {
            let counts = tokens_from_row(&row);
            if has_counts(&counts) {
                HermesTokenSnapshot {
                    kind: HermesTokenKind::Message,
                    counts,
                }
            } else {
                unknown_tokens()
            }
        }
        _ => unknown_tokens(),
    }
}

fn has_counts(counts: &HermesTokenCounts) -> bool {
    counts.input.is_some()
        || counts.output.is_some()
        || counts.cache_read.is_some()
        || counts.cache_write.is_some()
        || counts.reasoning.is_some()
}

fn has_session_totals(counts: &HermesTokenCounts) -> bool {
    counts.input.is_some() || counts.output.is_some()
}

fn delta_field(before: Option<f64>, after: Option<f64>) -> Option<f64> {
    match (before, after) {
        (Some(before), Some(after)) => Some((after - before).max(0.0)),
        _ => None,
    }
}

fn token_num(cell: Option<&Cell>) -> Option<f64> {
    match cell? {
        Cell::Number(value) if value.is_finite() && *value >= 0.0 => Some(*value),
        Cell::Text(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return None;
            }
            let value = trimmed.parse::<f64>().ok()?;
            if value.is_finite() && value >= 0.0 {
                Some(value)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn query_map(
    conn: &Connection,
    sql: &str,
    session_id: &str,
) -> Result<Option<BTreeMap<String, Cell>>, ()> {
    let mut stmt = conn.prepare(sql).map_err(|_| ())?;
    let names: Vec<String> = stmt
        .column_names()
        .into_iter()
        .map(str::to_string)
        .collect();
    let mut rows = stmt.query(rusqlite::params![session_id]).map_err(|_| ())?;
    let Some(row) = rows.next().map_err(|_| ())? else {
        return Ok(None);
    };
    let mut map = BTreeMap::new();
    for (index, name) in names.iter().enumerate() {
        let Ok(value) = row.get_ref(index) else {
            continue;
        };
        if let Some(cell) = cell_from_ref(value) {
            map.insert(name.clone(), cell);
        }
    }
    Ok(Some(map))
}

fn cell_from_ref(value: rusqlite::types::ValueRef<'_>) -> Option<Cell> {
    match value {
        rusqlite::types::ValueRef::Null | rusqlite::types::ValueRef::Blob(_) => None,
        rusqlite::types::ValueRef::Integer(number) => Some(Cell::Number(number as f64)),
        rusqlite::types::ValueRef::Real(number) => Some(Cell::Number(number)),
        rusqlite::types::ValueRef::Text(bytes) => {
            Some(Cell::Text(String::from_utf8_lossy(bytes).into_owned()))
        }
    }
}
