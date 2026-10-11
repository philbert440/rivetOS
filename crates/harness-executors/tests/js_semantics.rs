use protocol::digest::{sha256_hex, sha256_hex_js};
use protocol::host::{MapEnv, home_dir};
use protocol::js::{JsString, js_slice, js_slice_units, js_trim, js_trim_units, utf16_len};
use serde_json::Value;
use transcripts::value::{jtrim, slice_text, text_units};

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

fn isize_bound(value: Option<f64>) -> Option<isize> {
    let number = value?;
    if !number.is_finite() {
        return None;
    }
    let truncated = number as isize;
    if truncated as f64 == number {
        Some(truncated)
    } else {
        None
    }
}

#[test]
fn utf16_length_slice_and_trim() {
    let root = golden();
    for case in root["utf16"]["length"].as_array().unwrap() {
        let text = units_of(&case["text"]);
        assert_eq!(
            JsString::from_units(text.clone()).len(),
            case["length"].as_u64().unwrap() as usize
        );
        if let Ok(utf8) = String::from_utf16(&text) {
            assert_eq!(text_units(&utf8), utf16_len(&utf8));
            assert_eq!(text_units(&utf8), case["length"].as_u64().unwrap() as usize);
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
        let Some(from) = isize_bound(start.or(Some(0.0))) else {
            continue;
        };
        let clipped = if end.is_none() {
            slice_text(&utf8, from, None)
        } else if let Some(to) = isize_bound(end) {
            slice_text(&utf8, from, Some(to))
        } else {
            continue;
        };
        assert_eq!(clipped, js_slice(&utf8, start, end).to_utf8());
    }
    for case in root["trim"].as_array().unwrap() {
        let text = units_of(&case["text"]);
        assert_eq!(js_trim_units(&text), units_of(&case["trim"]).as_slice());
        if let Ok(utf8) = String::from_utf16(&text) {
            assert_eq!(jtrim(&utf8), js_trim(&utf8));
            assert_eq!(
                JsString::from_text(js_trim(&utf8)).units(),
                units_of(&case["trim"]).as_slice()
            );
        }
    }
}

#[test]
fn sha256_and_home() {
    let root = golden();
    for case in root["sha256"].as_array().unwrap() {
        let text = JsString::from_units(units_of(&case["text"]));
        assert_eq!(sha256_hex_js(&text), case["hex"].as_str().unwrap());
        assert_eq!(
            sha256_hex(text.to_utf8().as_bytes()),
            case["hex"].as_str().unwrap()
        );
    }
    for case in root["homedir"].as_array().unwrap() {
        let mut env = MapEnv::new();
        let expected = if case["home"].is_null() {
            account_home()
        } else {
            env.set("HOME", case["home"].as_str().unwrap());
            Some(case["result"].as_str().unwrap().to_string())
        };
        assert_eq!(home_dir(&env), expected, "{}", case["label"]);
    }
}

fn account_home() -> Option<String> {
    let user = nix::unistd::User::from_uid(nix::unistd::Uid::current())
        .ok()
        .flatten()?;
    Some(user.dir.to_string_lossy().into_owned())
}
