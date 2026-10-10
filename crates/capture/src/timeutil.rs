use std::time::{SystemTime, UNIX_EPOCH};

pub fn unix_ms_now() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => i64::try_from(duration.as_millis()).unwrap_or(i64::MAX),
        Err(error) => -i64::try_from(error.duration().as_millis()).unwrap_or(i64::MAX),
    }
}

pub fn iso_from_unix_ms(ms: i64) -> String {
    let negative = ms < 0;
    let abs = ms.unsigned_abs();
    let day_ms = 86_400_000u64;
    let (days, tod) = if negative {
        let mut days = (abs / day_ms) as i64;
        let mut tod = abs % day_ms;
        if tod != 0 {
            days += 1;
            tod = day_ms - tod;
        }
        (-days, tod)
    } else {
        ((abs / day_ms) as i64, abs % day_ms)
    };
    let (year, month, day) = civil_from_days(days);
    let hour = tod / 3_600_000;
    let minute = (tod % 3_600_000) / 60_000;
    let second = (tod % 60_000) / 1_000;
    let millis = tod % 1_000;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

pub fn iso_now() -> String {
    iso_from_unix_ms(unix_ms_now())
}

fn civil_from_days(days_in: i64) -> (i64, u32, u32) {
    let z = days_in + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    if month <= 2 {
        year += 1;
    }
    (year, month as u32, day as u32)
}
