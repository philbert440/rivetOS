use protocol::JsNumber;

pub fn current_iso() -> String {
    protocol::js::to_iso_string(protocol::js::date_now())
        .unwrap_or_else(|_| String::from("1970-01-01T00:00:00.000Z"))
}

pub fn js_number_text(value: f64) -> String {
    JsNumber::from(value).to_string()
}

#[cfg(test)]
mod tests {
    use super::js_number_text;

    #[test]
    fn number_text_matches_the_node_golden() {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/js-semantics.json");
        let text = protocol::host::read_text(&path).unwrap();
        let golden: serde_json::Value = serde_json::from_str(&text).unwrap();
        for case in golden["to_string"].as_array().unwrap() {
            if case["kind"].as_str() != Some("number") {
                continue;
            }
            let value = golden_number(case);
            let expected = if case["is_nan"].as_bool() == Some(true) {
                "NaN"
            } else if case["is_inf"].as_i64() == Some(1) {
                "Infinity"
            } else if case["is_inf"].as_i64() == Some(-1) {
                "-Infinity"
            } else {
                case["json"].as_str().unwrap()
            };
            assert_eq!(js_number_text(value), expected);
        }
    }

    fn golden_number(case: &serde_json::Value) -> f64 {
        if case["is_neg_zero"].as_bool() == Some(true) {
            return -0.0;
        }
        if case["is_nan"].as_bool() == Some(true) {
            return f64::NAN;
        }
        match case["is_inf"].as_i64().unwrap_or(0) {
            1 => f64::INFINITY,
            -1 => f64::NEG_INFINITY,
            _ => case["value"].as_f64().unwrap(),
        }
    }
}
