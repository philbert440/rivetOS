pub fn parse_date_ms(text: &str) -> Option<i64> {
    let s = text.trim();
    if s.is_empty() {
        return None;
    }
    parse_rfc3339(s).or_else(|| parse_date_only(s))
}

fn parse_date_only(s: &str) -> Option<i64> {
    if s.len() < 10 {
        return None;
    }
    let year = s.get(0..4)?.parse::<i32>().ok()?;
    if s.as_bytes().get(4) != Some(&b'-') || s.as_bytes().get(7) != Some(&b'-') {
        return None;
    }
    let month = s.get(5..7)?.parse::<u32>().ok()?;
    let day = s.get(8..10)?.parse::<u32>().ok()?;
    if s.len() == 10 {
        return ymd_hms_ms(year, month, day, 0, 0, 0, 0);
    }
    None
}

fn parse_rfc3339(s: &str) -> Option<i64> {
    if s.len() < 20 {
        return None;
    }
    let year = s.get(0..4)?.parse::<i32>().ok()?;
    if s.as_bytes().get(4) != Some(&b'-') || s.as_bytes().get(7) != Some(&b'-') {
        return None;
    }
    let month = s.get(5..7)?.parse::<u32>().ok()?;
    let day = s.get(8..10)?.parse::<u32>().ok()?;
    if s.as_bytes().get(10) != Some(&b'T')
        && s.as_bytes().get(10) != Some(&b't')
        && s.as_bytes().get(10) != Some(&b' ')
    {
        return None;
    }
    let hour = s.get(11..13)?.parse::<u32>().ok()?;
    if s.as_bytes().get(13) != Some(&b':') {
        return None;
    }
    let min = s.get(14..16)?.parse::<u32>().ok()?;
    if s.as_bytes().get(16) != Some(&b':') {
        return None;
    }
    let sec = s.get(17..19)?.parse::<u32>().ok()?;
    let mut idx = 19;
    let mut millis = 0_i64;
    if s.as_bytes().get(idx) == Some(&b'.') {
        idx += 1;
        let start = idx;
        while s.as_bytes().get(idx).is_some_and(|b| b.is_ascii_digit()) {
            idx += 1;
        }
        let frac = &s[start..idx];
        if frac.is_empty() {
            return None;
        }
        let mut padded = frac.to_string();
        if padded.len() < 3 {
            padded.push_str(&"0".repeat(3 - padded.len()));
        }
        millis = padded.get(0..3)?.parse::<i64>().ok()?;
    }
    let rest = &s[idx..];
    let offset_ms = if rest.is_empty() || rest == "Z" || rest == "z" {
        0
    } else {
        parse_offset_ms(rest)?
    };
    ymd_hms_ms(year, month, day, hour, min, sec, millis).map(|ms| ms - offset_ms)
}

fn parse_offset_ms(rest: &str) -> Option<i64> {
    let bytes = rest.as_bytes();
    let sign = match bytes.first()? {
        b'+' => 1_i64,
        b'-' => -1,
        _ => return None,
    };
    let hour = rest.get(1..3)?.parse::<i64>().ok()?;
    let min = if bytes.get(3) == Some(&b':') {
        rest.get(4..6)?.parse::<i64>().ok()?
    } else if rest.len() >= 5 {
        rest.get(3..5)?.parse::<i64>().ok()?
    } else {
        0
    };
    Some(sign * (hour * 60 + min) * 60 * 1000)
}

fn ymd_hms_ms(
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    min: u32,
    sec: u32,
    millis: i64,
) -> Option<i64> {
    if !(1..=12).contains(&month) || hour > 23 || min > 59 || sec > 60 {
        return None;
    }
    let mdays = days_in_month(year, month)?;
    if day == 0 || day > mdays {
        return None;
    }
    let mut days = days_from_civil(year, month, day)?;
    days -= days_from_civil(1970, 1, 1)?;
    let secs = days * 86_400 + i64::from(hour) * 3600 + i64::from(min) * 60 + i64::from(sec);
    Some(secs * 1000 + millis)
}

fn days_in_month(year: i32, month: u32) -> Option<u32> {
    Some(match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap(year) {
                29
            } else {
                28
            }
        }
        _ => return None,
    })
}

fn is_leap(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_from_civil(year: i32, month: u32, day: u32) -> Option<i64> {
    let y = if month <= 2 {
        i64::from(year) - 1
    } else {
        i64::from(year)
    };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if month > 2 {
        i64::from(month) - 3
    } else {
        i64::from(month) + 9
    };
    let doy = (153 * mp + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

pub fn iso_from_ms(ms: i64) -> String {
    let day = ms.div_euclid(86_400_000);
    let tod = ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(day);
    let hour = tod / 3_600_000;
    let min = (tod % 3_600_000) / 60_000;
    let sec = (tod % 60_000) / 1000;
    let millis = tod % 1000;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}.{millis:03}Z")
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32)
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
