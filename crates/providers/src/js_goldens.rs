use serde_json::Value;

use crate::cli_machine::{clip_utf16, clip_utf16_tail};

fn golden() -> Value {
    let path =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/js-semantics.json");
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

fn whole_units(value: f64) -> Option<usize> {
    if value.is_finite() && value >= 0.0 && value.fract() == 0.0 && value <= usize::MAX as f64 {
        Some(value as usize)
    } else {
        None
    }
}

#[test]
fn trim_and_slice_follow_the_js_goldens() {
    let root = golden();
    for case in root["trim"].as_array().unwrap() {
        let text_units = units_of(&case["text"]);
        let Ok(utf8) = String::from_utf16(&text_units) else {
            continue;
        };
        let trimmed = protocol::js::js_trim(&utf8);
        assert_eq!(
            trimmed.encode_utf16().collect::<Vec<u16>>(),
            units_of(&case["trim"])
        );
    }
    let mut kept_surrogate = false;
    for case in root["utf16"]["slice"].as_array().unwrap() {
        let text_units = units_of(&case["text"]);
        let Ok(utf8) = String::from_utf16(&text_units) else {
            continue;
        };
        let start = optional_number(case, "start_undefined", "start");
        let end = optional_number(case, "end_undefined", "end");
        let actual = protocol::js::js_slice(&utf8, start, end);
        assert_eq!(actual.units(), units_of(&case["result"]).as_slice());
        if actual
            .units()
            .iter()
            .any(|unit| (0xD800..=0xDFFF).contains(unit))
        {
            kept_surrogate = true;
        }
        if start == Some(0.0)
            && let Some(end) = end
            && let Some(limit) = whole_units(end)
        {
            assert_eq!(clip_utf16(&utf8, limit), actual.to_utf8());
        }
        if end.is_none()
            && let Some(start) = start
            && start < 0.0
            && let Some(keep) = whole_units(-start)
        {
            assert_eq!(clip_utf16_tail(&utf8, keep), actual.to_utf8());
        }
    }
    assert!(kept_surrogate);
    assert_eq!(clip_utf16_tail("a😀b", 0), "");
}
