use protocol::js::{JsString, js_slice_units};
use serde_json::Value;
use session_events::{initial_room_state, parse_event_str, reduce_room};

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

#[test]
fn thought_window_follows_negative_slice_goldens() {
    let mut seen = 0usize;
    for case in golden()["utf16"]["slice"].as_array().unwrap() {
        if case["end_undefined"].as_bool() != Some(true) {
            continue;
        }
        let Some(start) = case["start"].as_f64() else {
            continue;
        };
        if start >= 0.0 {
            continue;
        }
        let text = units_of(&case["text"]);
        assert_eq!(
            js_slice_units(&text, Some(start), None),
            units_of(&case["result"])
        );
        if text.len() < 220 && start <= -(text.len() as f64) {
            let owned = JsString::from_units(text);
            let raw = format!(
                "{{\"v\":1,\"session\":\"s\",\"type\":\"thinking.delta\",\"text\":{}}}",
                protocol::js::stringify(&protocol::js::JsValue::String(owned.clone()))
            );
            let state = reduce_room(initial_room_state(), &parse_event_str(&raw).unwrap());
            assert_eq!(state.thought.units(), owned.units());
        }
        seen += 1;
    }
    assert!(seen > 0);
    let count = 300usize;
    let letters = "a".repeat(count);
    let raw =
        format!("{{\"v\":1,\"session\":\"s\",\"type\":\"thinking.delta\",\"text\":\"{letters}\"}}");
    let state = reduce_room(initial_room_state(), &parse_event_str(&raw).unwrap());
    let units: Vec<u16> = letters.encode_utf16().collect();
    assert_eq!(
        state.thought.units(),
        js_slice_units(&units, Some(-220.0), None).as_slice()
    );
}
