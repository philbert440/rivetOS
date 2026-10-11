use protocol::js::{
    js_boolean_json, js_substring, js_substring_units, js_trim_end_units, js_trim_units, to_fixed,
    to_iso_string, utc_day, utf16_len,
};
use serde_json::Value;

fn golden() -> Value {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/js-semantics.json");
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

#[test]
fn utf16_length_and_substring_follow_the_golden() {
    let root = golden();
    for case in root["utf16"]["length"].as_array().unwrap() {
        let text = units_of(&case["text"]);
        if let Ok(utf8) = String::from_utf16(&text) {
            assert_eq!(utf16_len(&utf8), case["length"].as_u64().unwrap() as usize);
        }
    }
    for case in root["utf16"]["substring"].as_array().unwrap() {
        let text = units_of(&case["text"]);
        let start = optional_number(case, "start_undefined", "start");
        let end = optional_number(case, "end_undefined", "end");
        let actual = js_substring_units(&text, start, end);
        assert_eq!(actual, units_of(&case["result"]));
        if let Ok(utf8) = String::from_utf16(&text) {
            assert_eq!(js_substring(&utf8, start, end).units(), actual.as_slice());
        }
    }
}

#[test]
fn trim_follows_the_golden() {
    for case in golden()["trim"].as_array().unwrap() {
        let text = units_of(&case["text"]);
        assert_eq!(js_trim_units(&text), units_of(&case["trim"]).as_slice());
        assert_eq!(
            js_trim_end_units(&text),
            units_of(&case["trim_end"]).as_slice()
        );
    }
}

#[test]
fn to_fixed_follows_the_golden() {
    for case in golden()["to_fixed"].as_array().unwrap() {
        let digits = case["digits"].as_f64().unwrap();
        let result = to_fixed(number_case(case), digits);
        if let Some(error) = case.get("error").and_then(Value::as_str) {
            assert_eq!(result.unwrap_err().to_string(), error);
        } else {
            assert_eq!(result.unwrap(), case["result"].as_str().unwrap());
        }
    }
}

#[test]
fn iso_day_follows_the_golden() {
    for case in golden()["iso"].as_array().unwrap() {
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
}

#[test]
fn json_truthy_follows_the_golden() {
    for case in golden()["truthy"].as_array().unwrap() {
        if case["kind"].as_str() == Some("number") && case["json"].as_str() == Some("null") {
            continue;
        }
        let value: Value = serde_json::from_str(case["json"].as_str().unwrap()).unwrap();
        assert_eq!(
            js_boolean_json(&value),
            case["truthy"].as_bool().unwrap(),
            "{case}"
        );
    }
}
