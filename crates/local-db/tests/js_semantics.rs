use std::path::Path;

use local_db::{backup_stamp, format_bytes, resolve_embedded_pg};
use serde_json::{Value, json};

fn golden() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("golden")
        .join("js-semantics.json");
    let text = std::fs::read_to_string(path).expect("golden");
    serde_json::from_str(&text).expect("golden json")
}

fn units(value: &Value) -> Vec<u16> {
    value
        .as_array()
        .expect("units")
        .iter()
        .map(|item| item.as_u64().expect("unit") as u16)
        .collect()
}

fn stamp_from_iso(iso: &str) -> String {
    let replaced: String = iso
        .chars()
        .map(|ch| match ch {
            ':' | '.' => '-',
            other => other,
        })
        .collect();
    let prefix: Vec<u16> = replaced.encode_utf16().take(19).collect();
    String::from_utf16(&prefix).expect("stamp")
}

#[test]
fn backup_stamp_follows_iso_goldens() {
    let mut checked = 0u32;
    for case in golden()["iso"].as_array().expect("iso") {
        if case.get("error").is_some() {
            continue;
        }
        let Some(ms) = case["ms"].as_i64() else {
            continue;
        };
        let Some(time) = chrono::DateTime::from_timestamp_millis(ms) else {
            continue;
        };
        let iso = case["iso"].as_str().expect("iso text");
        assert_eq!(backup_stamp(time), stamp_from_iso(iso), "{iso}");
        checked += 1;
    }
    assert!(checked > 0);
}

#[test]
fn format_bytes_follows_to_fixed_goldens() {
    let mut checked = 0u32;
    for case in golden()["to_fixed"].as_array().expect("to_fixed") {
        if case.get("error").is_some() {
            continue;
        }
        if case["digits"].as_f64() != Some(1.0) {
            continue;
        }
        if case.get("neg_zero").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let Some(value) = case["value"].as_f64() else {
            continue;
        };
        if !value.is_finite() || value < 1.0 {
            continue;
        }
        let result = case["result"].as_str().expect("result");
        let kb = (value * 1024.0).round() as u64;
        if (1024..1024 * 1024).contains(&kb) && (kb as f64) / 1024.0 == value {
            assert_eq!(format_bytes(kb), format!("{result} KB"), "{value}");
            checked += 1;
        }
        let mb = (value * 1024.0 * 1024.0).round() as u64;
        if mb >= 1024 * 1024 && (mb as f64) / (1024.0 * 1024.0) == value {
            assert_eq!(format_bytes(mb), format!("{result} MB"), "{value}");
            checked += 1;
        }
    }
    assert!(checked > 0);
}

#[test]
fn embed_endpoint_trim_follows_trim_goldens() {
    let home = Path::new("/tmp/fakehome");
    let mut checked = 0u32;
    for case in golden()["trim"].as_array().expect("trim") {
        let code_point = case["code_point"].as_u64().expect("code point") as u16;
        let text_units = units(&case["text"]);
        let trim_units = units(&case["trim"]);
        if text_units.first() == Some(&code_point)
            && trim_units.first() != Some(&code_point)
            && let Ok(only) = String::from_utf16(&[code_point])
        {
            let config = json!({
                "memory": {
                    "postgres": {
                        "embedded": {},
                        "embed_endpoint": only
                    }
                }
            });
            let resolved = resolve_embedded_pg(&config, home, None).expect("resolved");
            assert!(resolved.lite_mode, "U+{code_point:04X}");
            checked += 1;
        }
        if let (Ok(text), Ok(trimmed)) = (
            String::from_utf16(&text_units),
            String::from_utf16(&trim_units),
        ) {
            let config = json!({
                "memory": {
                    "postgres": {
                        "embedded": {},
                        "embed_endpoint": text
                    }
                }
            });
            let resolved = resolve_embedded_pg(&config, home, None).expect("resolved");
            assert_eq!(resolved.lite_mode, trimmed.is_empty());
            checked += 1;
        }
    }
    assert!(checked > 0);
}
