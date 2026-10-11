use std::path::PathBuf;

use protocol::host::MapEnv;
use protocol::js::{
    js_boolean_json, js_slice, js_to_string_json, js_trim, number_to_locale_string_en_us, to_fixed,
    to_iso_string, to_locale_time_string_en_us_hour24, utc_day, utf16_len,
};
use serde_json::Value;

fn golden() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/js-semantics.json");
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|err| panic!("{}: {err}", path.display()));
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

fn number_case(case: &Value) -> f64 {
    if case.get("neg_zero").and_then(Value::as_bool) == Some(true)
        || case.get("is_neg_zero").and_then(Value::as_bool) == Some(true)
    {
        return -0.0;
    }
    let payload = case.get("value").cloned().unwrap_or(Value::Null);
    match payload {
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

#[test]
fn slices_strings_and_truthiness_follow_the_recorded_cases() {
    let root = golden();
    let mut slices = 0usize;
    for case in root["utf16"]["slice"].as_array().unwrap() {
        let text = units_of(&case["text"]);
        let Ok(utf8) = String::from_utf16(&text) else {
            continue;
        };
        let start = optional_number(case, "start_undefined", "start");
        let end = optional_number(case, "end_undefined", "end");
        assert_eq!(
            js_slice(&utf8, start, end).units(),
            units_of(&case["result"]).as_slice()
        );
        slices += 1;
    }
    assert!(slices > 0);
    let mut trimmed = 0usize;
    for case in root["trim"].as_array().unwrap() {
        let text = units_of(&case["text"]);
        let Ok(utf8) = String::from_utf16(&text) else {
            continue;
        };
        let actual: Vec<u16> = js_trim(&utf8).encode_utf16().collect();
        assert_eq!(actual, units_of(&case["trim"]));
        trimmed += 1;
    }
    assert!(trimmed > 0);
    for case in root["to_string"].as_array().unwrap() {
        if case["is_nan"].as_bool() == Some(true) || case["is_inf"].as_i64().unwrap_or(0) != 0 {
            continue;
        }
        let parsed: Value = serde_json::from_str(case["json"].as_str().unwrap()).unwrap();
        assert_eq!(js_to_string_json(&parsed), case["string"].as_str().unwrap());
    }
    for case in root["truthy"].as_array().unwrap() {
        if case["is_nan"].as_bool() == Some(true)
            || case["is_inf"].as_i64().unwrap_or(0) != 0
            || case["is_neg_zero"].as_bool() == Some(true)
        {
            continue;
        }
        let parsed: Value = serde_json::from_str(case["json"].as_str().unwrap()).unwrap();
        assert_eq!(js_boolean_json(&parsed), case["truthy"].as_bool().unwrap());
    }
    let emoji = "a😀b";
    assert_eq!(utf16_len(emoji), 4);
    assert_eq!(js_slice(emoji, Some(1.0), Some(2.0)).units(), &[0xD83D]);
}

#[test]
fn fixed_grouping_and_clocks_follow_the_recorded_cases() {
    let root = golden();
    for case in root["to_fixed"].as_array().unwrap() {
        let digits = case["digits"].as_f64().unwrap();
        if digits != 1.0 {
            continue;
        }
        let value = number_case(case);
        assert_eq!(
            to_fixed(value, 1.0).unwrap(),
            case["result"].as_str().unwrap()
        );
        assert_eq!(hooks::fixed_1(value), case["result"].as_str().unwrap());
    }
    for case in root["number_locale"].as_array().unwrap() {
        let value = number_case(case);
        assert_eq!(
            number_to_locale_string_en_us(value),
            case["en_us"].as_str().unwrap()
        );
    }
    for case in root["iso"].as_array().unwrap() {
        let ms = match &case["ms"] {
            Value::Number(number) => number.as_f64().unwrap(),
            Value::String(text) if text == "NaN" => f64::NAN,
            Value::String(text) => text.parse().unwrap(),
            _ => panic!("ms"),
        };
        if let Some(error) = case.get("error").and_then(Value::as_str) {
            assert_eq!(to_iso_string(ms).unwrap_err().to_string(), error);
            assert_eq!(utc_day(ms).unwrap_err().to_string(), error);
        } else {
            assert_eq!(to_iso_string(ms).unwrap(), case["iso"].as_str().unwrap());
            assert_eq!(utc_day(ms).unwrap(), case["day"].as_str().unwrap());
        }
    }
    let mut clocks = 0usize;
    for block in root["dates"].as_array().unwrap() {
        let mut env = MapEnv::new();
        env.set("TZ", block["tz"].as_str().unwrap());
        for row in block["rows"].as_array().unwrap() {
            let ms = row["ms"].as_f64().unwrap();
            assert_eq!(
                to_locale_time_string_en_us_hour24(ms, &env),
                row["time_hhmm_h12false"].as_str().unwrap()
            );
            clocks += 1;
        }
    }
    assert!(clocks > 0);
}
