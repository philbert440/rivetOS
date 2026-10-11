use std::collections::{HashMap, HashSet};
use std::path::Path;

use protocol::host::MapEnv;
use protocol::js::{
    JsString, date_parse, js_slice, js_slice_units, js_trim_units, posix_join, posix_normalize,
    posix_resolve, to_iso_string, utf16_len,
};
use serde_json::Value;

fn golden() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/js-semantics.json");
    let text = std::fs::read_to_string(path).expect("golden");
    serde_json::from_str(&text).expect("golden json")
}

fn units_of(value: &Value) -> Vec<u16> {
    value
        .as_array()
        .expect("units")
        .iter()
        .map(|item| item.as_u64().expect("unit") as u16)
        .collect()
}

fn optional_number(value: &Value, undefined_key: &str, value_key: &str) -> Option<f64> {
    if value[undefined_key].as_bool() == Some(true) {
        None
    } else {
        match &value[value_key] {
            Value::Null => Some(f64::NAN),
            Value::Number(number) => Some(number.as_f64().expect("number")),
            _ => Some(f64::NAN),
        }
    }
}

fn integer_bound(value: &Value, undefined_key: &str, value_key: &str) -> Option<Option<isize>> {
    if value[undefined_key].as_bool() == Some(true) {
        return Some(None);
    }
    let Value::Number(number) = &value[value_key] else {
        return None;
    };
    let parsed = number.as_f64().expect("number");
    if parsed.is_finite()
        && parsed.fract() == 0.0
        && parsed >= isize::MIN as f64
        && parsed <= isize::MAX as f64
    {
        Some(Some(parsed as isize))
    } else {
        None
    }
}

fn parts_of(case: &Value) -> Vec<&str> {
    case["a"]
        .as_array()
        .expect("parts")
        .iter()
        .map(|item| item.as_str().expect("part"))
        .collect()
}

#[test]
fn utf16_length_and_slice_follow_the_golden() {
    let root = golden();
    for case in root["utf16"]["length"].as_array().expect("length") {
        let units = units_of(&case["text"]);
        let length = case["length"].as_u64().expect("length") as usize;
        assert_eq!(JsString::from_units(units.clone()).len(), length);
        if let Ok(text) = String::from_utf16(&units) {
            assert_eq!(utf16_len(&text), length);
        }
    }
    for case in root["utf16"]["slice"].as_array().expect("slice") {
        let units = units_of(&case["text"]);
        let start = optional_number(case, "start_undefined", "start");
        let end = optional_number(case, "end_undefined", "end");
        let expected = units_of(&case["result"]);
        assert_eq!(js_slice_units(&units, start, end), expected);
        let Ok(text) = String::from_utf16(&units) else {
            continue;
        };
        assert_eq!(js_slice(&text, start, end).units(), expected.as_slice());
        let (Some(Some(start_index)), Some(end_index)) = (
            integer_bound(case, "start_undefined", "start"),
            integer_bound(case, "end_undefined", "end"),
        ) else {
            continue;
        };
        assert_eq!(
            transcripts::value::slice_text(&text, start_index, end_index),
            js_slice(
                &text,
                Some(start_index as f64),
                end_index.map(|value| value as f64)
            )
            .to_utf8()
        );
    }
}

#[test]
fn trim_follows_the_golden_for_utf8_text() {
    for case in golden()["trim"].as_array().expect("trim") {
        let units = units_of(&case["text"]);
        let Ok(text) = String::from_utf16(&units) else {
            continue;
        };
        let trimmed = String::from_utf16(js_trim_units(&units)).expect("trimmed utf8");
        assert_eq!(transcripts::value::jtrim(&text), trimmed);
    }
}

#[test]
fn iso_strings_and_iso_from_ms_follow_the_golden() {
    for case in golden()["iso"].as_array().expect("iso") {
        let (float_ms, int_ms) = match &case["ms"] {
            Value::Number(number) => {
                let ms = number.as_f64().expect("ms");
                let int_ms = integer_millis(ms);
                (Some(ms), int_ms)
            }
            Value::String(text) if text == "NaN" => (Some(f64::NAN), None),
            Value::String(text) => match text.parse::<i64>() {
                Ok(ms) => (Some(ms as f64), Some(ms)),
                Err(_) => (Some(text.parse().expect("ms")), None),
            },
            _ => panic!("ms"),
        };
        let ms = float_ms.expect("ms");
        if let Some(error) = case.get("error").and_then(Value::as_str) {
            assert_eq!(to_iso_string(ms).unwrap_err().to_string(), error);
            if let Some(int_ms) = int_ms {
                assert_eq!(transcripts::timeutil::iso_from_ms(int_ms), "");
            }
        } else if let Some(int_ms) = int_ms {
            let iso = case["iso"].as_str().expect("iso");
            assert_eq!(to_iso_string(ms).expect("iso"), iso);
            assert_eq!(transcripts::timeutil::iso_from_ms(int_ms), iso);
        } else {
            assert_eq!(
                to_iso_string(ms).expect("iso"),
                case["iso"].as_str().expect("iso")
            );
        }
    }
}

fn integer_millis(ms: f64) -> Option<i64> {
    if ms.is_finite() && ms.fract() == 0.0 && ms >= i64::MIN as f64 && ms <= i64::MAX as f64 {
        Some(ms as i64)
    } else {
        None
    }
}

#[test]
fn date_parse_follows_every_recorded_zone() {
    let root = golden();
    let mut agreed: HashMap<String, Option<f64>> = HashMap::new();
    let mut conflict = HashSet::new();
    let mut order = Vec::new();
    for block in root["dates"].as_array().expect("dates") {
        let mut env = MapEnv::new();
        env.set("TZ", block["tz"].as_str().expect("tz"));
        for item in block["date_parse"].as_array().expect("date_parse") {
            let text = item["text"].as_str().expect("text");
            let parsed = date_parse(text, &env);
            match item["ms"].as_f64() {
                Some(ms) => assert_eq!(parsed, Some(ms), "{text}"),
                None => assert!(parsed.is_none(), "{text}"),
            }
            let ms = item["ms"].as_f64();
            if let Some(previous) = agreed.get(text) {
                if *previous != ms {
                    conflict.insert(text.to_string());
                }
            } else {
                order.push(text.to_string());
                agreed.insert(text.to_string(), ms);
            }
        }
    }
    for text in order {
        if conflict.contains(&text) || protocol::js::js_trim(&text) != text {
            continue;
        }
        let expected = agreed[&text].map(|ms| ms as i64);
        assert_eq!(
            transcripts::timeutil::parse_date_ms(&text),
            expected,
            "{text}"
        );
    }
}

#[test]
fn node_path_join_resolve_and_normalize_follow_the_golden() {
    let node = golden()["node_path"].clone();
    let cwd = node["cwd"].as_str().expect("cwd");
    for case in node["normalize"].as_array().expect("normalize") {
        assert_eq!(
            posix_normalize(case["p"].as_str().expect("path")),
            case["r"].as_str().expect("result"),
            "{}",
            case["p"]
        );
    }
    for case in node["join"].as_array().expect("join") {
        let parts = parts_of(case);
        assert_eq!(posix_join(&parts), case["r"].as_str().expect("result"));
    }
    for case in node["resolve"].as_array().expect("resolve") {
        let parts = parts_of(case);
        let expected = case["r"].as_str().expect("result");
        assert_eq!(posix_resolve(cwd, &parts), expected);
        if let [input] = parts.as_slice() {
            assert_eq!(
                transcripts::fsutil::node_resolve(Path::new(cwd), input).to_string_lossy(),
                expected
            );
        }
    }
}
