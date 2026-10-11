pub fn unix_ms_now() -> i64 {
    let ms = protocol::js::date_now();
    if ms.is_finite() { ms as i64 } else { 0 }
}

pub fn iso_from_unix_ms(ms: i64) -> String {
    protocol::js::to_iso_string(ms as f64).unwrap_or_default()
}

pub fn iso_now() -> String {
    protocol::js::to_iso_string(protocol::js::date_now()).unwrap_or_default()
}
