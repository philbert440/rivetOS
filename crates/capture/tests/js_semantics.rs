use std::collections::HashMap;

use capture::{MapEnv, cap_for_storage, iso_from_unix_ms, sha256_hex};
use protocol::digest::sha256_hex_js;
use protocol::js::{
    JsString, date_parse, is_js_whitespace, js_replace, js_slice, js_slice_units, js_trim,
    js_trim_start, js_trim_start_units, js_trim_units, to_iso_string, utf16_len,
};
use serde_json::Value;

fn golden() -> Value {
    let path =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/js-semantics.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
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
            Value::Number(number) => Some(number.as_f64().unwrap()),
            _ => Some(f64::NAN),
        }
    }
}

#[test]
fn utf16_length_and_slice_drive_storage_caps() {
    let root = golden();
    for case in root["utf16"]["length"].as_array().unwrap() {
        let text = units_of(&case["text"]);
        assert_eq!(
            JsString::from_units(text.clone()).len(),
            case["length"].as_u64().unwrap() as usize
        );
        if let Ok(utf8) = String::from_utf16(&text) {
            assert_eq!(utf16_len(&utf8), case["length"].as_u64().unwrap() as usize);
        }
    }
    for case in root["utf16"]["slice"].as_array().unwrap() {
        let text = units_of(&case["text"]);
        let start = optional_number(case, "start_undefined", "start");
        let end = optional_number(case, "end_undefined", "end");
        let actual = js_slice_units(&text, start, end);
        assert_eq!(actual, units_of(&case["result"]));
        let Ok(utf8) = String::from_utf16(&text) else {
            continue;
        };
        assert_eq!(js_slice(&utf8, start, end).units(), actual.as_slice());
        let from_start = start.is_none_or(|value| value == 0.0);
        let Some(end) = end else {
            continue;
        };
        if !from_start
            || !end.is_finite()
            || end < 0.0
            || end.fract() != 0.0
            || end > usize::MAX as f64
        {
            continue;
        }
        let limit = end as usize;
        let capped = cap_for_storage(&utf8, Some(limit));
        assert_eq!(capped.text.units(), units_of(&case["result"]).as_slice());
        assert_eq!(capped.full_length, utf16_len(&utf8));
        assert_eq!(capped.truncated, utf16_len(&utf8) > limit);
    }
}

#[test]
fn trim_uses_javascript_whitespace() {
    for case in golden()["trim"].as_array().unwrap() {
        let text = units_of(&case["text"]);
        assert_eq!(js_trim_units(&text), units_of(&case["trim"]).as_slice());
        assert_eq!(
            js_trim_start_units(&text),
            units_of(&case["trim_start"]).as_slice()
        );
        if let Ok(utf8) = String::from_utf16(&text) {
            assert_eq!(
                js_trim(&utf8).encode_utf16().collect::<Vec<_>>(),
                units_of(&case["trim"])
            );
            assert_eq!(
                js_trim_start(&utf8).encode_utf16().collect::<Vec<_>>(),
                units_of(&case["trim_start"])
            );
        }
        let code = case["code_point"].as_u64().unwrap();
        let Some(ch) = char::from_u32(code as u32) else {
            continue;
        };
        let lead = format!("{ch}x");
        let units: Vec<u16> = lead.encode_utf16().collect();
        let dropped = js_trim_start_units(&units).len() != units.len();
        assert_eq!(is_js_whitespace(ch), dropped);
    }
}

#[test]
fn iso_and_date_parse_round_trip() {
    let root = golden();
    for case in root["iso"].as_array().unwrap() {
        let ms = match &case["ms"] {
            Value::Number(number) => number.as_f64().unwrap(),
            Value::String(text) if text == "NaN" => f64::NAN,
            Value::String(text) => text.parse().unwrap(),
            _ => panic!("ms"),
        };
        if let Some(error) = case.get("error").and_then(Value::as_str) {
            assert_eq!(to_iso_string(ms).unwrap_err().to_string(), error);
        } else {
            let iso = case["iso"].as_str().unwrap();
            assert_eq!(to_iso_string(ms).unwrap(), iso);
            if let Some(bits) = case["ms"].as_i64() {
                assert_eq!(iso_from_unix_ms(bits), iso);
            }
        }
    }
    for block in root["dates"].as_array().unwrap() {
        let mut values = HashMap::new();
        values.insert("TZ".to_string(), block["tz"].as_str().unwrap().to_string());
        let env = MapEnv::new(values);
        for item in block["date_parse"].as_array().unwrap() {
            let text = item["text"].as_str().unwrap();
            let parsed = date_parse(text, &env);
            match item["ms"].as_f64() {
                Some(ms) => {
                    assert_eq!(parsed, Some(ms), "{text}");
                    let iso = to_iso_string(ms).unwrap();
                    assert_eq!(to_iso_string(parsed.unwrap()).unwrap(), iso);
                    if let Some(bits) = item["ms"].as_i64() {
                        assert_eq!(iso_from_unix_ms(bits), iso);
                    }
                }
                None => assert!(parsed.is_none(), "{text}"),
            }
        }
    }
}

#[test]
fn replace_and_sha256_follow_the_golden() {
    let root = golden();
    let mut saw_dollar = false;
    for case in root["replace"].as_array().unwrap() {
        let replacement = case["replacement"].as_str().unwrap();
        if replacement.contains("$1") {
            saw_dollar = true;
        }
        let text = JsString::from_units(units_of(&case["text"]));
        let replaced = js_replace(
            &text,
            case["source"].as_str().unwrap(),
            case["flags"].as_str().unwrap(),
            replacement,
        )
        .unwrap();
        assert_eq!(replaced.units(), units_of(&case["result"]).as_slice());
    }
    assert!(saw_dollar);
    for case in root["sha256"].as_array().unwrap() {
        let text = JsString::from_units(units_of(&case["text"]));
        let hex = case["hex"].as_str().unwrap();
        assert_eq!(sha256_hex(text.to_utf8().as_bytes()), hex);
        assert_eq!(sha256_hex_js(&text), hex);
    }
}
