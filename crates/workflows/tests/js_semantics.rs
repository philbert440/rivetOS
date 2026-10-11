use std::path::PathBuf;

use protocol::js::{to_iso_string, utf16_len};
use serde_json::Value;

fn golden() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/js-semantics.json");
    let text = std::fs::read_to_string(path).unwrap();
    serde_json::from_str(&text).unwrap()
}

fn units_of(value: &Value) -> Vec<u16> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_u64().unwrap() as u16)
        .collect()
}

fn iso_ms(value: &Value) -> f64 {
    match value {
        Value::Number(number) => number.as_f64().unwrap(),
        Value::String(text) if text == "NaN" => f64::NAN,
        Value::String(text) => text.parse().unwrap(),
        _ => panic!("ms"),
    }
}

#[test]
fn iso_timestamps_match_the_node_golden() {
    for case in golden()["iso"].as_array().unwrap() {
        let ms = iso_ms(&case["ms"]);
        let result = to_iso_string(ms);
        if let Some(error) = case.get("error").and_then(Value::as_str) {
            assert_eq!(result.unwrap_err().to_string(), error);
        } else {
            assert_eq!(result.unwrap(), case["iso"].as_str().unwrap());
        }
    }
}

#[test]
fn utf16_lengths_match_the_node_golden() {
    for case in golden()["utf16"]["length"].as_array().unwrap() {
        let units = units_of(&case["text"]);
        let Ok(text) = String::from_utf16(&units) else {
            continue;
        };
        assert_eq!(utf16_len(&text), case["length"].as_u64().unwrap() as usize);
    }
}
