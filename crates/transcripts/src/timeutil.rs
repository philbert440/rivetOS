pub fn parse_date_ms(text: &str, env: &dyn protocol::host::Env) -> Option<i64> {
    let trimmed = protocol::js::js_trim(text);
    if trimmed.is_empty() {
        return None;
    }
    let ms = protocol::js::date_parse(trimmed, env)?;
    ms.is_finite().then_some(ms.trunc() as i64)
}

pub fn iso_from_date_text(text: &str, env: &dyn protocol::host::Env) -> Option<String> {
    if text.is_empty() {
        return None;
    }
    match protocol::js::date_parse(text, env) {
        Some(ms) if ms.is_finite() => match protocol::js::to_iso_string(ms) {
            Ok(iso) => Some(iso),
            Err(_) => Some(text.to_string()),
        },
        _ => Some(text.to_string()),
    }
}

pub fn iso_from_ms(ms: i64) -> String {
    protocol::js::to_iso_string(ms as f64).unwrap_or_default()
}

pub fn to_epoch_ms_number(value: f64) -> i64 {
    if !value.is_finite() {
        return 0;
    }
    if value > 1e12 {
        value as i64
    } else if value > 1e9 {
        (value * 1000.0) as i64
    } else {
        value as i64
    }
}

pub fn kimi_time_number(value: f64) -> i64 {
    if value.is_finite() { value as i64 } else { 0 }
}

pub fn opencode_epoch_number(value: f64) -> i64 {
    if !value.is_finite() {
        return 0;
    }
    if value < 1e12 {
        (value * 1000.0) as i64
    } else {
        value as i64
    }
}
