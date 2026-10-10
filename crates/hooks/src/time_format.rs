use std::time::{SystemTime, UNIX_EPOCH};

use chrono::Timelike;

pub fn epoch_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => i64::try_from(duration.as_millis()).unwrap_or(i64::MAX),
        Err(_) => 0,
    }
}

pub fn iso_timestamp() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

pub fn utc_date() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

pub fn local_hhmm() -> String {
    let now = chrono::Local::now();
    protocol::js::en_us_hour24_hhmm(now.hour(), now.minute())
}

pub fn fixed_1(value: f64) -> String {
    match protocol::js::to_fixed(value, 1) {
        Ok(text) => text,
        Err(_) => "NaN".to_string(),
    }
}

pub fn group_en_us(value: i64) -> String {
    let negative = value < 0;
    let digits = value.unsigned_abs().to_string();
    let mut grouped = String::new();
    for (index, ch) in digits.chars().rev().enumerate() {
        if index > 0 && index % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    let mut text: String = grouped.chars().rev().collect();
    if negative {
        text.insert(0, '-');
    }
    text
}

#[cfg(test)]
mod tests {
    use super::{epoch_ms, fixed_1, group_en_us, iso_timestamp, local_hhmm, utc_date};

    #[test]
    fn formats_match_the_javascript_shapes_used_by_hooks() {
        assert_eq!(fixed_1(90.0), "90.0");
        assert_eq!(fixed_1(92.5), "92.5");
        assert_eq!(
            fixed_1(6.25),
            "6.3",
            "exact halfway 6.25 rounds away from zero under toFixed(1)"
        );
        assert_eq!(protocol::js::en_us_hour24_hhmm(0, 0), "24:00");
        assert_eq!(group_en_us(1500), "1,500");
        assert_eq!(group_en_us(1000), "1,000");
        assert_eq!(group_en_us(0), "0");
        assert_eq!(utc_date().len(), 10);
        assert!(iso_timestamp().ends_with('Z'));
        assert!(iso_timestamp().contains('T'));
        assert!(iso_timestamp().contains('.'));
        let clock = local_hhmm();
        assert_eq!(clock.len(), 5);
        assert_eq!(clock.as_bytes().get(2).copied(), Some(b':'));
        assert!(epoch_ms() > 1_000_000_000_000);
        assert_eq!(fixed_1(f64::NAN), "NaN");
        assert_eq!(fixed_1(f64::INFINITY), "Infinity");
        assert_eq!(fixed_1(f64::NEG_INFINITY), "-Infinity");
        assert_eq!(group_en_us(-1500), "-1,500");
    }
}
