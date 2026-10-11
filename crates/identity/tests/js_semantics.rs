use protocol::js::js_trim;
use serde_json::Value;

fn golden() -> Value {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/js-semantics.json");
    let text = std::fs::read_to_string(&path).expect("golden");
    serde_json::from_str(&text).expect("json")
}

#[test]
fn registry_trim_follows_the_js_whitespace_golden() {
    let doc = golden();
    for case in doc["trim"].as_array().expect("trim") {
        let text = case["text"].as_str().expect("text");
        assert_eq!(js_trim(text), case["trim"].as_str().expect("trim"));
    }
}
