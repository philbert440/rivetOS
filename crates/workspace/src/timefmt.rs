use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Datelike, Timelike, Utc};
use chrono_tz::America::New_York;

pub(crate) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

pub(crate) fn format_en_us_new_york(instant: DateTime<Utc>) -> String {
    let local = instant.with_timezone(&New_York);
    let hour24 = local.hour();
    format!(
        "{}/{}/{}, {}:{:02}:{:02} {}",
        local.month(),
        local.day(),
        local.year(),
        hour12(hour24),
        local.minute(),
        local.second(),
        ampm(hour24),
    )
}

pub(crate) fn utc_day(instant: DateTime<Utc>) -> String {
    format!(
        "{:04}-{:02}-{:02}",
        instant.year(),
        instant.month(),
        instant.day()
    )
}

fn hour12(hour24: u32) -> u32 {
    let hour = hour24 % 12;
    if hour == 0 { 12 } else { hour }
}

fn ampm(hour24: u32) -> &'static str {
    if hour24 < 12 { "AM" } else { "PM" }
}

#[cfg(test)]
mod tests {
    use chrono::{DateTime, Utc};

    use super::{format_en_us_new_york, utc_day};

    fn at(seconds: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(seconds, 0).unwrap()
    }

    #[test]
    fn summer_afternoon_is_eastern_daylight() {
        let instant = at(1_791_647_112);
        assert_eq!(utc_day(instant), "2026-10-10");
        assert_eq!(format_en_us_new_york(instant), "10/10/2026, 11:45:12 AM");
    }

    #[test]
    fn winter_afternoon_is_eastern_standard() {
        let instant = at(1_768_491_912);
        assert_eq!(utc_day(instant), "2026-01-15");
        assert_eq!(format_en_us_new_york(instant), "1/15/2026, 10:45:12 AM");
    }

    #[test]
    fn local_midnight_uses_12_am() {
        let instant = at(1_768_453_200);
        assert_eq!(format_en_us_new_york(instant), "1/15/2026, 12:00:00 AM");
    }

    #[test]
    fn afternoon_uses_pm_without_a_padded_hour() {
        let instant = at(1_791_662_400);
        assert_eq!(format_en_us_new_york(instant), "10/10/2026, 4:00:00 PM");
    }

    #[test]
    fn en_us_new_york_matches_the_recorded_node_goldens() {
        let text = std::fs::read_to_string(
            "/rivet-shared/plans/rust-rewrite/standardize/goldens/js-semantics.json",
        )
        .expect("golden");
        let value: serde_json::Value = serde_json::from_str(&text).expect("json");
        let dates = value["dates"].as_array().expect("dates");
        assert_eq!(dates.len(), 8);
        let mut seen = 0usize;
        for zone in dates {
            let rows = zone["rows"].as_array().expect("rows");
            assert_eq!(rows.len(), 14);
            for row in rows {
                let ms = row["ms"].as_i64().expect("ms");
                let expected = row["locale_string_en_us_new_york"]
                    .as_str()
                    .expect("locale");
                let instant = DateTime::from_timestamp_millis(ms).expect("instant");
                assert_eq!(format_en_us_new_york(instant), expected, "{ms}");
                assert!(
                    expected.ends_with(" AM") || expected.ends_with(" PM"),
                    "{expected}"
                );
                assert!(!expected.contains('\u{202f}'), "{expected}");
                seen += 1;
            }
        }
        assert_eq!(seen, 112);
    }
}
