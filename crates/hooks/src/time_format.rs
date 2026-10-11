pub fn utc_date() -> String {
    protocol::js::utc_day(protocol::js::date_now()).unwrap_or_default()
}

pub fn local_hhmm() -> String {
    protocol::js::to_locale_time_string_en_us_hour24(
        protocol::js::date_now(),
        &protocol::host::ProcessEnv,
    )
}

pub fn fixed_1(value: f64) -> String {
    match protocol::js::to_fixed(value, 1.0) {
        Ok(text) => text,
        Err(_) => "NaN".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::{fixed_1, local_hhmm, utc_date};

    #[test]
    fn formats_match_the_javascript_shapes_used_by_hooks() {
        assert_eq!(fixed_1(90.0), "90.0");
        assert_eq!(fixed_1(92.5), "92.5");
        assert_eq!(fixed_1(6.25), "6.3");
        assert_eq!(fixed_1(f64::NAN), "NaN");
        assert_eq!(fixed_1(f64::INFINITY), "Infinity");
        assert_eq!(fixed_1(f64::NEG_INFINITY), "-Infinity");
        assert_eq!(utc_date().len(), 10);
        let clock = local_hhmm();
        assert_eq!(clock.len(), 5);
        assert_eq!(clock.as_bytes().get(2).copied(), Some(b':'));
    }
}
