use mesh::path_join;
use protocol::js::{js_trim, posix_join, posix_normalize};
use serde_json::Value;

fn golden() -> Value {
    serde_json::from_str(include_str!("golden/js-semantics.json")).unwrap()
}

fn units(value: &Value) -> Vec<u16> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_u64().unwrap() as u16)
        .collect()
}

#[test]
fn trim_matches_recorded_javascript_cases() {
    let mut checked = 0_usize;
    for case in golden()["trim"].as_array().unwrap() {
        let text_units = units(&case["text"]);
        let expected_units = units(&case["trim"]);
        let Ok(text) = String::from_utf16(&text_units) else {
            continue;
        };
        let Ok(expected) = String::from_utf16(&expected_units) else {
            continue;
        };
        assert_eq!(js_trim(&text), expected, "{text:?}");
        checked += 1;
    }
    assert!(checked > 0);
}

#[test]
fn path_join_matches_recorded_javascript_cases() {
    let node = &golden()["node_path"];
    let normalize = node["normalize"].as_array().unwrap();
    assert!(!normalize.is_empty());
    for case in normalize {
        let path = case["p"].as_str().unwrap();
        assert_eq!(posix_normalize(path), case["r"].as_str().unwrap(), "{path}");
    }
    let join = node["join"].as_array().unwrap();
    assert!(!join.is_empty());
    for case in join {
        let parts: Vec<&str> = case["a"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap())
            .collect();
        let expected = case["r"].as_str().unwrap();
        assert_eq!(posix_join(&parts), expected, "{parts:?}");
        if let Some((root, rest)) = parts.split_first() {
            assert_eq!(path_join(root, rest), expected, "{parts:?}");
        }
    }
}
