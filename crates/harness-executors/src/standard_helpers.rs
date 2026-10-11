use protocol::host::Env;

pub fn clock_ms() -> i64 {
    protocol::js::date_now() as i64
}

pub fn home_path(env: &dyn Env) -> std::path::PathBuf {
    match protocol::host::home_dir(env) {
        Some(home) => std::path::PathBuf::from(home),
        None => std::path::PathBuf::from("."),
    }
}

pub fn finite_f64(value: &serde_json::Value) -> Option<f64> {
    value.as_f64().filter(|number| number.is_finite())
}

pub fn num_value(value: Option<&serde_json::Value>) -> f64 {
    value.and_then(finite_f64).unwrap_or(0.0)
}

pub fn json_str(value: Option<&serde_json::Value>) -> Option<String> {
    value
        .and_then(serde_json::Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

pub fn object_str<'a>(
    object: &'a serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Option<&'a str> {
    object
        .get(key)
        .and_then(serde_json::Value::as_str)
        .filter(|text| !text.is_empty())
}
