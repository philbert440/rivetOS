use chrono::{TimeZone, Utc};
use memory::capped_prefix;
use memory::spans::parse_js_date_with;
use memory::sql_report::{en_us, fmt_local_ts_in};
use protocol::host::MapEnv;
use protocol::js::{js_trim, utf16_len};
use serde_json::Value;

fn golden() -> Value {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/js-semantics.json");
    let text = std::fs::read_to_string(&path).expect("golden");
    serde_json::from_str(&text).expect("json")
}

fn zone(name: &str) -> MapEnv {
    let mut env = MapEnv::new();
    env.set("TZ", name);
    env
}

#[test]
fn copied_js_semantics_drive_the_helpers_memory_uses() {
    let doc = golden();
    for case in doc["trim"].as_array().expect("trim") {
        let text = case["text"].as_str().expect("text");
        assert_eq!(js_trim(text), case["trim"].as_str().expect("trim"));
    }
    for case in doc["utf16"].as_array().expect("utf16") {
        let text = case["text"].as_str().expect("text");
        assert_eq!(
            utf16_len(text),
            case["length"].as_u64().expect("len") as usize
        );
    }
    for case in doc["sha256"].as_array().expect("sha256") {
        let text = case["text"].as_str().expect("text");
        assert_eq!(
            protocol::digest::sha256_hex(text.as_bytes()),
            case["hex"].as_str().expect("hex")
        );
    }
    for case in doc["number_locale"].as_array().expect("numbers") {
        let value = case["value"].as_i64().expect("value");
        assert_eq!(en_us(value), case["en_us"].as_str().expect("en_us"));
    }
    for block in doc["dates"].as_array().expect("dates") {
        let env = zone(block["tz"].as_str().expect("tz"));
        for row in block["rows"].as_array().expect("rows") {
            let ms = row["ms"].as_i64().expect("ms");
            let dt = Utc.timestamp_millis_opt(ms).single().expect("instant");
            let stamp = row["local_ts"].as_str().expect("stamp");
            let short = row["time_zone_short"].as_str().expect("zone");
            assert_eq!(fmt_local_ts_in(dt, &env), format!("{stamp} {short}"));
        }
        for row in block["date_parse"].as_array().expect("parse") {
            let text = row["text"].as_str().expect("text");
            let parsed = parse_js_date_with(text, &env).map(|dt| dt.timestamp_millis());
            let expected = row["ms"].as_i64();
            assert_eq!(parsed, expected, "{text}");
        }
    }
    let long = format!("{}😀tail", "x".repeat(15999));
    assert_eq!(utf16_len(&long), 16005);
    assert_eq!(capped_prefix(&long, 16000), "x".repeat(15999));
}
