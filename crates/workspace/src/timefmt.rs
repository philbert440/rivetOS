use chrono::{DateTime, Utc};

pub(crate) fn format_en_us_new_york(instant: DateTime<Utc>) -> String {
    protocol::js::to_locale_string_en_us_time_zone(
        instant.timestamp_millis() as f64,
        "America/New_York",
    )
}

#[cfg(test)]
mod tests {
    use chrono::{DateTime, Utc};

    use super::format_en_us_new_york;

    fn at(seconds: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(seconds, 0).unwrap()
    }

    fn iso_day(instant: DateTime<Utc>) -> String {
        protocol::js::utc_day(instant.timestamp_millis() as f64).unwrap()
    }

    #[test]
    fn summer_afternoon_is_eastern_daylight() {
        let instant = at(1_791_647_112);
        assert_eq!(iso_day(instant), "2026-10-10");
        assert_eq!(format_en_us_new_york(instant), "10/10/2026, 11:45:12 AM");
    }

    #[test]
    fn winter_afternoon_is_eastern_standard() {
        let instant = at(1_768_491_912);
        assert_eq!(iso_day(instant), "2026-01-15");
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
}
