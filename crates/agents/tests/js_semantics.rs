use protocol::js::{
    JsString, js_slice, js_slice_units, js_trim_end_units, js_trim_start_units, js_trim_units,
    posix_join, posix_normalize, posix_resolve,
};
use serde_json::Value;

fn golden() -> Value {
    serde_json::from_str(include_str!("golden/js-semantics.json")).unwrap()
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
fn utf16_length_and_slice_match_the_golden() {
    let root = golden();
    for case in root["utf16"]["length"].as_array().unwrap() {
        let text = units_of(&case["text"]);
        assert_eq!(
            JsString::from_units(text).len(),
            case["length"].as_u64().unwrap() as usize
        );
    }
    for case in root["utf16"]["slice"].as_array().unwrap() {
        let text = units_of(&case["text"]);
        let start = optional_number(case, "start_undefined", "start");
        let end = optional_number(case, "end_undefined", "end");
        let actual = js_slice_units(&text, start, end);
        assert_eq!(actual, units_of(&case["result"]));
        if let Ok(utf8) = String::from_utf16(&text) {
            assert_eq!(js_slice(&utf8, start, end).units(), actual.as_slice());
        }
    }
}

#[test]
fn trim_matches_the_golden() {
    for case in golden()["trim"].as_array().unwrap() {
        let text = units_of(&case["text"]);
        assert_eq!(js_trim_units(&text), units_of(&case["trim"]).as_slice());
        assert_eq!(
            js_trim_start_units(&text),
            units_of(&case["trim_start"]).as_slice()
        );
        assert_eq!(
            js_trim_end_units(&text),
            units_of(&case["trim_end"]).as_slice()
        );
    }
}

#[test]
fn node_path_normalize_join_and_resolve_match_the_golden() {
    let node = &golden()["node_path"];
    let cwd = node["cwd"].as_str().unwrap();
    for case in node["normalize"].as_array().unwrap() {
        assert_eq!(
            posix_normalize(case["p"].as_str().unwrap()),
            case["r"].as_str().unwrap(),
            "{}",
            case["p"]
        );
    }
    for case in node["join"].as_array().unwrap() {
        let parts: Vec<&str> = case["a"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap())
            .collect();
        assert_eq!(posix_join(&parts), case["r"].as_str().unwrap());
    }
    for case in node["resolve"].as_array().unwrap() {
        let parts: Vec<&str> = case["a"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap())
            .collect();
        assert_eq!(posix_resolve(cwd, &parts), case["r"].as_str().unwrap());
    }
}
