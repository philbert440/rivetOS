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
        "{}/{}/{}, {}:{:02}:{:02}\u{202f}{}",
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
        assert_eq!(
            format_en_us_new_york(instant),
            "10/10/2026, 11:45:12\u{202f}AM"
        );
    }

    #[test]
    fn winter_afternoon_is_eastern_standard() {
        let instant = at(1_768_491_912);
        assert_eq!(utc_day(instant), "2026-01-15");
        assert_eq!(
            format_en_us_new_york(instant),
            "1/15/2026, 10:45:12\u{202f}AM"
        );
    }

    #[test]
    fn local_midnight_uses_12_am() {
        let instant = at(1_768_453_200);
        assert_eq!(
            format_en_us_new_york(instant),
            "1/15/2026, 12:00:00\u{202f}AM"
        );
    }

    #[test]
    fn afternoon_uses_pm_without_a_padded_hour() {
        let instant = at(1_791_662_400);
        assert_eq!(
            format_en_us_new_york(instant),
            "10/10/2026, 4:00:00\u{202f}PM"
        );
    }
}
