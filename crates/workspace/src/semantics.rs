#![cfg(test)]

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use protocol::host::fs_error;
use protocol::js::{
    self, JsValue, from_serde, js_slice_units, posix_basename, posix_dirname, posix_is_absolute,
    posix_join, posix_resolve,
};
use serde_json::Value;

use crate::error::WorkspaceError;
use crate::text::{cap_utf16, js_split_whitespace, kib_one_decimal};
use crate::timefmt::format_en_us_new_york;

fn golden() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/js-semantics.json");
    let text = std::fs::read_to_string(&path).expect("golden");
    serde_json::from_str(&text).expect("json")
}

fn units_of(value: &Value) -> Vec<u16> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_u64().unwrap() as u16)
        .collect()
}

fn optional_number(value: &Value, undefined_key: &str, value_key: &str) -> Option<f64> {
    if value[undefined_key].as_bool() == Some(true) {
        None
    } else {
        match &value[value_key] {
            Value::Null => Some(f64::NAN),
            Value::Number(number) => number.as_f64(),
            _ => Some(f64::NAN),
        }
    }
}

fn case_payload(case: &Value) -> Value {
    if let Some(value) = case.get("value") {
        value.clone()
    } else {
        serde_json::from_str(case["json"].as_str().unwrap_or("null")).unwrap()
    }
}

fn number_case(case: &Value) -> f64 {
    if case.get("neg_zero").and_then(Value::as_bool) == Some(true)
        || case.get("is_neg_zero").and_then(Value::as_bool) == Some(true)
    {
        return -0.0;
    }
    match &case_payload(case) {
        Value::String(text) if text == "NaN" => f64::NAN,
        Value::String(text) if text == "Infinity" => f64::INFINITY,
        Value::String(text) if text == "-Infinity" => f64::NEG_INFINITY,
        Value::Number(number) => number.as_f64().unwrap(),
        Value::Null => {
            if case.get("is_nan").and_then(Value::as_bool) == Some(true) {
                f64::NAN
            } else {
                match case.get("is_inf").and_then(Value::as_i64).unwrap_or(0) {
                    1 => f64::INFINITY,
                    -1 => f64::NEG_INFINITY,
                    _ => 0.0,
                }
            }
        }
        _ => panic!("number"),
    }
}

fn js_value(case: &Value) -> JsValue {
    let payload = case_payload(case);
    match case["kind"].as_str().unwrap() {
        "number" => JsValue::Number(number_case(case)),
        "string" => JsValue::from_text(payload.as_str().unwrap()),
        "boolean" => JsValue::Bool(payload.as_bool().unwrap()),
        "null" => JsValue::Null,
        "array" | "object" => from_serde(&payload),
        other => panic!("{other}"),
    }
}

fn fixed_number(case: &Value) -> f64 {
    if case.get("neg_zero").and_then(Value::as_bool) == Some(true) {
        return -0.0;
    }
    match &case["value"] {
        Value::String(text) if text == "NaN" => f64::NAN,
        Value::String(text) if text == "Infinity" => f64::INFINITY,
        Value::String(text) if text == "-Infinity" => f64::NEG_INFINITY,
        Value::Number(number) => number.as_f64().unwrap(),
        other => panic!("{other}"),
    }
}

fn millis(value: &Value) -> f64 {
    match value {
        Value::Number(number) => number.as_f64().unwrap(),
        Value::String(text) if text == "NaN" => f64::NAN,
        Value::String(text) => text.parse().unwrap(),
        other => panic!("{other}"),
    }
}

fn static_syscall(name: &str) -> &'static str {
    match name {
        "read" => "read",
        "open" => "open",
        "mkdir" => "mkdir",
        "rmdir" => "rmdir",
        "scandir" => "scandir",
        "stat" => "stat",
        "lstat" => "lstat",
        "unlink" => "unlink",
        "rename" => "rename",
        "copyfile" => "copyfile",
        "access" => "access",
        "readlink" => "readlink",
        "symlink" => "symlink",
        "write" => "write",
        other => panic!("{other}"),
    }
}

#[test]
fn recorded_node_provenance() {
    let root = golden();
    assert_eq!(root["node"].as_str(), Some("v22.22.2"));
    assert_eq!(root["icu"].as_str(), Some("78.2"));
    assert_eq!(root["unicode"].as_str(), Some("17.0"));
    assert_eq!(root["tz_data"].as_str(), Some("2025c"));
}

#[test]
fn new_york_time_matches_recorded_locale_strings() {
    let root = golden();
    let dates = root["dates"].as_array().unwrap();
    assert_eq!(dates.len(), 8);
    let mut seen = 0usize;
    for zone in dates {
        let rows = zone["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 14);
        for row in rows {
            let ms = row["ms"].as_f64().unwrap();
            let expected = row["locale_string_en_us_new_york"].as_str().unwrap();
            assert_eq!(
                js::to_locale_string_en_us_time_zone(ms, "America/New_York"),
                expected
            );
            let instant = DateTime::<Utc>::from_timestamp_millis(ms as i64).unwrap();
            assert_eq!(instant.timestamp_millis() as f64, ms);
            assert_eq!(format_en_us_new_york(instant), expected);
            assert!(expected.ends_with(" AM") || expected.ends_with(" PM"));
            assert!(!expected.contains('\u{202f}'));
            seen += 1;
        }
    }
    assert_eq!(seen, 112);
}

#[test]
fn iso_day_matches_recorded_dates() {
    let root = golden();
    let rows = root["iso"].as_array().unwrap();
    assert!(!rows.is_empty());
    for row in rows {
        let ms = millis(&row["ms"]);
        let result = js::utc_day(ms);
        if let Some(error) = row.get("error").and_then(Value::as_str) {
            assert_eq!(result.unwrap_err().to_string(), error);
        } else {
            assert_eq!(result.unwrap(), row["day"].as_str().unwrap());
        }
    }
}

#[test]
fn pin_size_uses_recorded_to_fixed() {
    let root = golden();
    let rows = root["to_fixed"].as_array().unwrap();
    assert!(!rows.is_empty());
    let mut digits_one = 0usize;
    for row in rows {
        let digits = row["digits"].as_f64().unwrap();
        let result = js::to_fixed(fixed_number(row), digits);
        if let Some(error) = row.get("error").and_then(Value::as_str) {
            assert_eq!(result.unwrap_err().to_string(), error);
        } else {
            assert_eq!(result.unwrap(), row["result"].as_str().unwrap());
        }
        if digits == 1.0 && row.get("error").is_none() {
            digits_one += 1;
        }
    }
    assert!(digits_one > 0);
    let quarter = rows.iter().find(|row| {
        row["digits"].as_f64() == Some(1.0)
            && row["value"].as_f64() == Some(0.25)
            && row.get("neg_zero").and_then(Value::as_bool) == Some(false)
    });
    let quarter = quarter.unwrap();
    assert_eq!(quarter["result"].as_str(), Some("0.3"));
    assert_eq!(js::to_fixed(51_456.0 / 1024.0, 1.0).unwrap(), "50.3");
    assert_eq!(kib_one_decimal(51_456), "50.3");
}

#[test]
fn daily_cap_matches_recorded_utf16_slice() {
    let root = golden();
    let slice_rows = root["utf16"]["slice"].as_array().unwrap();
    assert!(!slice_rows.is_empty());
    let mut kept_surrogate = false;
    let mut capped = 0usize;
    for row in slice_rows {
        let text = units_of(&row["text"]);
        let start = optional_number(row, "start_undefined", "start");
        let end = optional_number(row, "end_undefined", "end");
        let actual = js_slice_units(&text, start, end);
        let expected = units_of(&row["result"]);
        assert_eq!(actual, expected);
        if expected.len() == 1 && (0xD800..=0xDFFF).contains(&expected[0]) {
            kept_surrogate = true;
        }
        let start_is_zero = row["start_undefined"].as_bool() == Some(true) || start == Some(0.0);
        let Some(end) = end else {
            continue;
        };
        if !start_is_zero || !end.is_finite() || end < 0.0 || end.fract() != 0.0 {
            continue;
        }
        let Ok(utf8) = String::from_utf16(&text) else {
            continue;
        };
        assert_eq!(cap_utf16(&utf8, end as usize).units(), expected.as_slice());
        capped += 1;
    }
    assert!(kept_surrogate);
    assert!(capped > 0);
    let note = format!("{}😀z", "a".repeat(1999));
    let sliced = js::js_slice(&note, Some(0.0), Some(2000.0));
    assert_eq!(sliced.len(), 2000);
    assert_eq!(sliced.units()[1999], 0xD83D);
    assert_eq!(cap_utf16(&note, 2000).units(), sliced.units());
}

#[test]
fn command_split_uses_recorded_whitespace() {
    let root = golden();
    let rows = root["trim"].as_array().unwrap();
    assert!(!rows.is_empty());
    let mut separators = 0usize;
    let mut kept = 0usize;
    for row in rows {
        let code = row["code_point"].as_u64().unwrap() as u32;
        let ch = char::from_u32(code).unwrap();
        let sample = format!("left{ch}right");
        let parts = js_split_whitespace(&sample);
        if js::is_js_whitespace(ch) {
            assert_eq!(parts, ["left", "right"], "U+{code:04X}");
            separators += 1;
        } else {
            assert_eq!(parts, [sample.as_str()], "U+{code:04X}");
            kept += 1;
        }
    }
    assert!(separators > 0);
    assert!(kept > 0);
}

#[test]
fn profile_text_matches_recorded_string_and_truthiness() {
    let root = golden();
    let strings = root["to_string"].as_array().unwrap();
    let flags = root["truthy"].as_array().unwrap();
    assert!(!strings.is_empty());
    assert!(!flags.is_empty());
    for row in strings {
        assert_eq!(
            js::js_string(&js_value(row)).to_utf8(),
            row["string"].as_str().unwrap()
        );
    }
    for row in flags {
        assert_eq!(
            js::js_boolean(&js_value(row)),
            row["truthy"].as_bool().unwrap()
        );
    }
}

#[test]
fn workspace_paths_match_recorded_posix() {
    let node = &golden()["node_path"];
    let cwd = node["cwd"].as_str().unwrap();
    assert!(!node["join"].as_array().unwrap().is_empty());
    for row in node["dirname"].as_array().unwrap() {
        assert_eq!(
            posix_dirname(row["p"].as_str().unwrap()),
            row["r"].as_str().unwrap()
        );
    }
    for row in node["basename"].as_array().unwrap() {
        assert_eq!(
            posix_basename(row["p"].as_str().unwrap(), None),
            row["r"].as_str().unwrap()
        );
    }
    for row in node["is_absolute"].as_array().unwrap() {
        assert_eq!(
            posix_is_absolute(row["p"].as_str().unwrap()),
            row["r"].as_bool().unwrap()
        );
    }
    for row in node["join"].as_array().unwrap() {
        let parts: Vec<&str> = row["a"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap())
            .collect();
        assert_eq!(posix_join(&parts), row["r"].as_str().unwrap());
    }
    for row in node["resolve"].as_array().unwrap() {
        let parts: Vec<&str> = row["a"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap())
            .collect();
        assert_eq!(posix_resolve(cwd, &parts), row["r"].as_str().unwrap());
    }
}

#[test]
fn filesystem_messages_match_recorded_node_text() {
    let root = golden();
    let rows = root["fs_errors"].as_array().unwrap();
    assert!(!rows.is_empty());
    for row in rows {
        let syscall = static_syscall(row["syscall"].as_str().unwrap());
        let raw = i32::try_from(-row["errno"].as_i64().unwrap()).unwrap();
        let source = std::io::Error::from_raw_os_error(raw);
        let path = row["path"].as_str().map(Path::new);
        let dest = row["dest"].as_str().map(Path::new);
        let formatted = fs_error(syscall, path, dest, &source);
        assert_eq!(formatted.to_string(), row["message"].as_str().unwrap());
        assert_eq!(formatted.code, row["code"].as_str().unwrap());
        if path.is_some()
            && dest.is_none()
            && matches!(syscall, "open" | "read" | "mkdir" | "write")
        {
            let shown = WorkspaceError::io(row["path"].as_str().unwrap(), syscall, source);
            assert_eq!(shown.to_string(), row["message"].as_str().unwrap());
        }
    }
}
