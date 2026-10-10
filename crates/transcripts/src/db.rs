use std::path::Path;

use rusqlite::{Connection, OpenFlags, Row, types::ValueRef};
use serde_json::{Map, Number, Value};

use crate::value::Obj;

pub fn open_readonly(path: &Path) -> Option<Connection> {
    if !path.is_file() {
        return None;
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(path, flags).ok()?;
    let _ = conn.pragma_update(None, "query_only", "ON");
    Some(conn)
}

pub fn query_maps(conn: &Connection, sql: &str, params: &[&dyn rusqlite::types::ToSql]) -> Option<Vec<Obj>> {
    let mut stmt = conn.prepare(sql).ok()?;
    let columns: Vec<String> = stmt.column_names().into_iter().map(|name| name.to_string()).collect();
    let mut rows = stmt.query(params).ok()?;
    let mut out = Vec::new();
    loop {
        let row = match rows.next() {
            Ok(Some(row)) => row,
            Ok(None) => break,
            Err(_) => return None,
        };
        out.push(row_obj(row, &columns));
    }
    Some(out)
}

fn row_obj(row: &Row<'_>, columns: &[String]) -> Obj {
    let mut obj = Map::new();
    for (index, name) in columns.iter().enumerate() {
        let Ok(value) = row.get_ref(index) else {
            continue;
        };
        if let Some(json) = value_ref_json(value) {
            obj.insert(name.clone(), json);
        }
    }
    obj
}

fn value_ref_json(value: ValueRef<'_>) -> Option<Value> {
    match value {
        ValueRef::Null => None,
        ValueRef::Integer(n) => Some(Value::Number(n.into())),
        ValueRef::Real(n) => Number::from_f64(n).map(Value::Number),
        ValueRef::Text(bytes) => Some(Value::String(String::from_utf8_lossy(bytes).into_owned())),
        ValueRef::Blob(bytes) => Some(Value::String(String::from_utf8_lossy(bytes).into_owned())),
    }
}
