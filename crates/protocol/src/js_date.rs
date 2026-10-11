use chrono::{Offset, TimeZone};

use crate::host::Env;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("RangeError: Invalid time value")]
pub struct InvalidTime;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalParts {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

const MS_PER_DAY: i64 = 86_400_000;
const MS_PER_HOUR: i64 = 3_600_000;
const MS_PER_MINUTE: i64 = 60_000;
const MS_PER_SECOND: i64 = 1_000;
const MONTH_START: [i64; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

pub fn date_now() -> f64 {
    chrono::Utc::now().timestamp_millis() as f64
}

pub fn default_locale() -> &'static str {
    "en-US"
}

pub fn system_time_zone() -> Option<chrono_tz::Tz> {
    let name = iana_time_zone::get_timezone().ok()?;
    name.parse().ok()
}

pub fn time_zone(env: &dyn Env) -> chrono_tz::Tz {
    if let Some(raw) = env.var("TZ") {
        let name = crate::js::js_trim(&raw);
        if !name.is_empty()
            && let Ok(zone) = name.parse::<chrono_tz::Tz>()
        {
            return zone;
        }
    }
    system_time_zone().unwrap_or(chrono_tz::UTC)
}

pub fn resolved_time_zone(env: &dyn Env) -> String {
    canonical_zone_name(time_zone(env).name())
}

pub fn to_iso_string(ms: f64) -> Result<String, InvalidTime> {
    let time = time_clip(ms)?;
    let parts = parts_from_time(time);
    let milli = clock(time).3;
    Ok(format!(
        "{}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        format_year(parts.year),
        parts.month,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
        milli
    ))
}

pub fn utc_day(ms: f64) -> Result<String, InvalidTime> {
    let iso = to_iso_string(ms)?;
    match iso.split_once('T') {
        Some((day, _)) => Ok(day.to_string()),
        None => Ok(iso),
    }
}

pub fn local_date_parts(ms: f64, env: &dyn Env) -> Option<LocalParts> {
    Some(zoned_env(ms, env)?.parts)
}

pub fn local_timestamp(ms: f64, env: &dyn Env) -> Option<String> {
    let zoned = zoned_env(ms, env)?;
    Some(stamp(&zoned.parts))
}

pub fn timezone_offset_minutes(ms: f64, env: &dyn Env) -> Option<i32> {
    let zoned = zoned_env(ms, env)?;
    Some(-zoned.offset_seconds / 60)
}

pub fn to_locale_string(ms: f64, env: &dyn Env) -> String {
    match zoned_env(ms, env) {
        Some(zoned) => format_datetime(&zoned.parts),
        None => "Invalid Date".to_string(),
    }
}

pub fn to_locale_string_en_us_time_zone(ms: f64, time_zone_name: &str) -> String {
    let Ok(zone) = time_zone_name.parse::<chrono_tz::Tz>() else {
        return "Invalid Date".to_string();
    };
    match zoned_ms(ms, zone) {
        Some(zoned) => format_datetime(&zoned.parts),
        None => "Invalid Date".to_string(),
    }
}

pub fn to_locale_time_string_en_us_hour24(ms: f64, env: &dyn Env) -> String {
    match zoned_env(ms, env) {
        Some(zoned) => format!("{:02}:{:02}", zoned.parts.hour, zoned.parts.minute),
        None => "Invalid Date".to_string(),
    }
}

pub fn time_zone_name_short(ms: f64, env: &dyn Env) -> String {
    match zoned_env(ms, env) {
        Some(zoned) => short_zone_name(time_zone(env), zoned.offset_seconds),
        None => String::new(),
    }
}

pub fn to_locale_date_string(ms: f64, env: &dyn Env) -> String {
    match zoned_env(ms, env) {
        Some(zoned) => format!(
            "{}/{}/{}",
            zoned.parts.month, zoned.parts.day, zoned.parts.year
        ),
        None => "Invalid Date".to_string(),
    }
}

pub fn to_locale_string_month_short(ms: f64, env: &dyn Env) -> String {
    match zoned_env(ms, env) {
        Some(zoned) => {
            let (hour, suffix) = hour_ampm(zoned.parts.hour);
            let month = MONTHS
                .get(zoned.parts.month.saturating_sub(1) as usize)
                .copied()
                .unwrap_or("Jan");
            format!(
                "{month} {}, {hour:02}:{:02} {suffix}",
                zoned.parts.day, zoned.parts.minute
            )
        }
        None => "Invalid Date".to_string(),
    }
}

pub fn to_locale_time_string(ms: f64, env: &dyn Env) -> String {
    match zoned_env(ms, env) {
        Some(zoned) => {
            let (hour, suffix) = hour_ampm(zoned.parts.hour);
            format!(
                "{hour}:{:02}:{:02} {suffix}",
                zoned.parts.minute, zoned.parts.second
            )
        }
        None => "Invalid Date".to_string(),
    }
}

pub fn to_locale_time_string_hhmm(ms: f64, env: &dyn Env) -> String {
    match zoned_env(ms, env) {
        Some(zoned) => {
            let (hour, suffix) = hour_ampm(zoned.parts.hour);
            format!("{hour:02}:{:02} {suffix}", zoned.parts.minute)
        }
        None => "Invalid Date".to_string(),
    }
}

pub fn to_locale_time_string_hhmmss(ms: f64, env: &dyn Env) -> String {
    match zoned_env(ms, env) {
        Some(zoned) => {
            let (hour, suffix) = hour_ampm(zoned.parts.hour);
            format!(
                "{hour:02}:{:02}:{:02} {suffix}",
                zoned.parts.minute, zoned.parts.second
            )
        }
        None => "Invalid Date".to_string(),
    }
}

pub fn fmt_local_date(ms: f64, env: &dyn Env) -> String {
    match zoned_env(ms, env) {
        Some(zoned) => format!(
            "{:04}-{:02}-{:02}",
            zoned.parts.year, zoned.parts.month, zoned.parts.day
        ),
        None => "?".to_string(),
    }
}

pub fn fmt_local_ts(ms: f64, env: &dyn Env) -> String {
    match zoned_env(ms, env) {
        Some(zoned) => {
            let label = short_zone_name(time_zone(env), zoned.offset_seconds);
            format!("{} {label}", stamp(&zoned.parts))
        }
        None => "?".to_string(),
    }
}

struct Zoned {
    parts: LocalParts,
    offset_seconds: i32,
}

fn zoned_env(ms: f64, env: &dyn Env) -> Option<Zoned> {
    zoned_ms(ms, time_zone(env))
}

fn zoned_ms(ms: f64, zone: chrono_tz::Tz) -> Option<Zoned> {
    let time = time_clip(ms).ok()?;
    let utc = chrono::DateTime::from_timestamp_millis(time)?;
    let offset = zone.offset_from_utc_datetime(&utc.naive_utc());
    let seconds = offset.fix().local_minus_utc();
    let local = time.checked_add(i64::from(seconds).saturating_mul(1000))?;
    Some(Zoned {
        parts: parts_from_time(local),
        offset_seconds: seconds,
    })
}

fn time_clip(ms: f64) -> Result<i64, InvalidTime> {
    if !ms.is_finite() || ms.abs() > 8.64e15 {
        return Err(InvalidTime);
    }
    Ok(ms.trunc() as i64)
}

fn format_year(year: i32) -> String {
    if (0..10_000).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:06}", year.unsigned_abs())
    } else {
        format!("+{year:06}")
    }
}

fn stamp(parts: &LocalParts) -> String {
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second
    )
}

fn format_datetime(parts: &LocalParts) -> String {
    let (hour, suffix) = hour_ampm(parts.hour);
    format!(
        "{}/{}/{}, {}:{:02}:{:02} {}",
        parts.month, parts.day, parts.year, hour, parts.minute, parts.second, suffix
    )
}

fn hour_ampm(hour: u32) -> (u32, &'static str) {
    let suffix = if hour < 12 { "AM" } else { "PM" };
    let shown = match hour % 12 {
        0 => 12,
        value => value,
    };
    (shown, suffix)
}

fn canonical_zone_name(name: &str) -> String {
    match name {
        "Asia/Kolkata" | "Asia/Calcutta" => "Asia/Calcutta".to_string(),
        other => other.to_string(),
    }
}

fn short_zone_name(zone: chrono_tz::Tz, offset_seconds: i32) -> String {
    let name = zone.name();
    if is_utc_zone(name) {
        return "UTC".to_string();
    }
    if let Some(abbr) = us_abbreviation(name, offset_seconds) {
        return abbr.to_string();
    }
    gmt_offset(offset_seconds)
}

fn is_utc_zone(name: &str) -> bool {
    matches!(
        name,
        "UTC"
            | "Etc/UTC"
            | "Etc/GMT"
            | "GMT"
            | "Etc/GMT+0"
            | "Etc/GMT-0"
            | "Etc/GMT0"
            | "Etc/Universal"
            | "Etc/Zulu"
    )
}

fn us_abbreviation(name: &str, offset_seconds: i32) -> Option<&'static str> {
    match (name, offset_seconds) {
        ("America/New_York", -18_000) => Some("EST"),
        ("America/New_York", -14_400) => Some("EDT"),
        ("America/Detroit", -18_000) => Some("EST"),
        ("America/Detroit", -14_400) => Some("EDT"),
        ("America/Indiana/Indianapolis", -18_000) => Some("EST"),
        ("America/Indiana/Indianapolis", -14_400) => Some("EDT"),
        ("America/Chicago", -21_600) => Some("CST"),
        ("America/Chicago", -18_000) => Some("CDT"),
        ("America/Denver", -25_200) => Some("MST"),
        ("America/Denver", -21_600) => Some("MDT"),
        ("America/Boise", -25_200) => Some("MST"),
        ("America/Boise", -21_600) => Some("MDT"),
        ("America/Phoenix", -25_200) => Some("MST"),
        ("America/Los_Angeles", -28_800) => Some("PST"),
        ("America/Los_Angeles", -25_200) => Some("PDT"),
        ("America/Anchorage", -32_400) => Some("AKST"),
        ("America/Anchorage", -28_800) => Some("AKDT"),
        ("Pacific/Honolulu", -36_000) => Some("HST"),
        ("America/Adak", -36_000) => Some("HST"),
        ("America/Adak", -32_400) => Some("HDT"),
        _ => None,
    }
}

fn gmt_offset(seconds: i32) -> String {
    if seconds == 0 {
        return "GMT".to_string();
    }
    let sign = if seconds > 0 { '+' } else { '-' };
    let abs = seconds.unsigned_abs();
    let hours = abs / 3600;
    let minutes = (abs % 3600) / 60;
    if minutes == 0 {
        format!("GMT{sign}{hours}")
    } else {
        format!("GMT{sign}{hours}:{minutes:02}")
    }
}

fn parts_from_time(time: i64) -> LocalParts {
    let year = year_from_time(time);
    let leap = leap_year(year);
    let within = day(time) - day_from_year(year);
    let (month, date) = month_and_date(within, leap);
    let (hour, minute, second, _) = clock(time);
    LocalParts {
        year: year as i32,
        month,
        day: date,
        hour,
        minute,
        second,
    }
}

fn clock(time: i64) -> (u32, u32, u32, u32) {
    let within = modulo(time, MS_PER_DAY);
    let hour = within / MS_PER_HOUR;
    let minute = modulo(time, MS_PER_HOUR) / MS_PER_MINUTE;
    let second = modulo(time, MS_PER_MINUTE) / MS_PER_SECOND;
    let milli = modulo(time, MS_PER_SECOND);
    (hour as u32, minute as u32, second as u32, milli as u32)
}

fn month_and_date(day_within: i64, leap: i64) -> (u32, u32) {
    let mut month = 11i64;
    while month > 0 {
        let mut start = MONTH_START[month as usize];
        if month > 1 {
            start += leap;
        }
        if day_within >= start {
            return ((month as u32) + 1, (day_within - start + 1) as u32);
        }
        month -= 1;
    }
    (1, (day_within + 1) as u32)
}

fn year_from_time(time: i64) -> i64 {
    let day_number = day(time);
    let mut year = 1970 + floor_div(day_number.saturating_mul(400), 146_097);
    for _ in 0..16 {
        if day_from_year(year) > day_number {
            year -= 1;
            continue;
        }
        if day_from_year(year + 1) <= day_number {
            year += 1;
            continue;
        }
        return year;
    }
    year
}

fn day(time: i64) -> i64 {
    floor_div(time, MS_PER_DAY)
}

fn day_from_year(year: i64) -> i64 {
    365 * (year - 1970) + floor_div(year - 1969, 4) - floor_div(year - 1901, 100)
        + floor_div(year - 1601, 400)
}

fn leap_year(year: i64) -> i64 {
    if modulo(year, 4) == 0 && (modulo(year, 100) != 0 || modulo(year, 400) == 0) {
        1
    } else {
        0
    }
}

fn floor_div(value: i64, divisor: i64) -> i64 {
    let quotient = value / divisor;
    let remainder = value % divisor;
    if remainder < 0 {
        quotient - 1
    } else {
        quotient
    }
}

fn modulo(value: i64, divisor: i64) -> i64 {
    let remainder = value % divisor;
    if remainder < 0 {
        remainder + divisor
    } else {
        remainder
    }
}

pub fn date_parse(text: &str, env: &dyn Env) -> Option<f64> {
    parse_iso(text, env)
        .or_else(|| parse_slash(text, env))
        .or_else(|| parse_named(text, env))
}

fn parse_iso(text: &str, env: &dyn Env) -> Option<f64> {
    let bytes = text.as_bytes();
    let mut index = 0usize;
    let year = parse_year(bytes, &mut index)?;
    let mut month = 1i64;
    let mut day = 1i64;
    let mut has_day = false;
    if index < bytes.len() && bytes[index] == b'-' {
        index += 1;
        month = parse_width(bytes, &mut index, 2)?;
        if !(1..=12).contains(&month) {
            return None;
        }
        if index < bytes.len() && bytes[index] == b'-' {
            index += 1;
            day = parse_width(bytes, &mut index, 2)?;
            if !(1..=31).contains(&day) {
                return None;
            }
            has_day = true;
        } else if index != bytes.len() {
            return None;
        }
    } else if index != bytes.len() {
        return None;
    }
    if index == bytes.len() {
        return clip_ms(civil_utc_ms(year, month, day, 0, 0, 0, 0));
    }
    if !has_day {
        return None;
    }
    let sep = bytes[index];
    if sep != b'T' && sep != b't' && sep != b' ' {
        return None;
    }
    index += 1;
    let hour = parse_width(bytes, &mut index, 2)?;
    if index >= bytes.len() || bytes[index] != b':' {
        return None;
    }
    index += 1;
    let minute = parse_width(bytes, &mut index, 2)?;
    let mut second = 0i64;
    let mut milli = 0i64;
    if index < bytes.len() && bytes[index] == b':' {
        index += 1;
        second = parse_width(bytes, &mut index, 2)?;
        if index < bytes.len() && bytes[index] == b'.' {
            index += 1;
            let start = index;
            if index >= bytes.len() || !bytes[index].is_ascii_digit() {
                return None;
            }
            while index < bytes.len() && bytes[index].is_ascii_digit() {
                index += 1;
            }
            milli = fraction_millis(&bytes[start..index]);
        }
    }
    if minute > 59 || second > 59 || hour > 24 {
        return None;
    }
    if hour == 24 && (minute != 0 || second != 0 || milli != 0) {
        return None;
    }
    let utc = civil_utc_ms(year, month, day, hour, minute, second, milli);
    if index == bytes.len() {
        return zoned_civil(utc, env);
    }
    let mark = bytes[index];
    if mark == b'Z' || mark == b'z' {
        index += 1;
        if index != bytes.len() {
            return None;
        }
        return clip_ms(utc);
    }
    if mark == b'+' || mark == b'-' {
        let sign = if mark == b'+' { 1i64 } else { -1 };
        index += 1;
        let offset_hour = parse_width(bytes, &mut index, 2)?;
        let mut offset_minute = 0i64;
        if index < bytes.len() && bytes[index] == b':' {
            index += 1;
            offset_minute = parse_width(bytes, &mut index, 2)?;
        } else if index < bytes.len() && bytes[index].is_ascii_digit() {
            offset_minute = parse_width(bytes, &mut index, 2)?;
        }
        if index != bytes.len() || offset_hour > 23 || offset_minute > 59 {
            return None;
        }
        let offset_ms = sign * (offset_hour * 60 + offset_minute) * MS_PER_MINUTE;
        return clip_ms(utc - offset_ms);
    }
    None
}

fn parse_slash(text: &str, env: &dyn Env) -> Option<f64> {
    let bytes = text.as_bytes();
    let mut index = 0usize;
    let first = parse_int(bytes, &mut index)?;
    if index >= bytes.len() || bytes[index] != b'/' {
        return None;
    }
    index += 1;
    let second = parse_int(bytes, &mut index)?;
    if index >= bytes.len() || bytes[index] != b'/' {
        return None;
    }
    index += 1;
    let third = parse_int(bytes, &mut index)?;
    let (year, month, day) = if first > 31 {
        (first, second, third)
    } else {
        (third, first, second)
    };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    skip_space_comma(bytes, &mut index);
    let (hour, minute, second) = if index < bytes.len() {
        let clock = parse_clock(bytes, &mut index)?;
        skip_space(bytes, &mut index);
        if index != bytes.len() {
            return None;
        }
        clock
    } else {
        (0, 0, 0)
    };
    zoned_civil(civil_utc_ms(year, month, day, hour, minute, second, 0), env)
}

fn parse_named(text: &str, env: &dyn Env) -> Option<f64> {
    let mut lex = Lex::new(text.as_bytes());
    let first = lex.word()?;
    let first = if is_weekday(first) {
        lex.word()?.to_string()
    } else {
        first.to_string()
    };
    let (month, day) = if let Some(month) = month_of(&first) {
        (month, lex.int()?)
    } else {
        let day = first.parse::<i64>().ok()?;
        let month = month_of(lex.word()?)?;
        (month, day)
    };
    let year = lex.int()?;
    let mut hour = 0i64;
    let mut minute = 0i64;
    let mut second = 0i64;
    let mut offset = None;
    if let Some(next) = lex.word() {
        if next.contains(':') {
            (hour, minute, second) = parse_hms(next)?;
            if let Some(marker) = lex.peek_word()
                && (marker.eq_ignore_ascii_case("am") || marker.eq_ignore_ascii_case("pm"))
            {
                hour = apply_ampm(hour, lex.word()?)?;
            }
            if let Some(zone) = lex.word() {
                offset = Some(parse_zone(zone)?);
            }
        } else {
            offset = Some(parse_zone(next)?);
        }
    }
    if lex.word().is_some() {
        return None;
    }
    let utc = civil_utc_ms(year, month, day, hour, minute, second, 0);
    match offset {
        Some(seconds) => clip_ms(utc - i64::from(seconds) * MS_PER_SECOND),
        None => zoned_civil(utc, env),
    }
}

fn zoned_civil(utc_assumption: i64, env: &dyn Env) -> Option<f64> {
    let parts = parts_from_time(utc_assumption);
    let offset = local_offset_seconds(time_zone(env), &parts)?;
    clip_ms(utc_assumption - i64::from(offset) * MS_PER_SECOND)
}

fn local_offset_seconds(zone: chrono_tz::Tz, parts: &LocalParts) -> Option<i32> {
    let naive = chrono::NaiveDate::from_ymd_opt(parts.year, parts.month, parts.day)?.and_hms_opt(
        parts.hour,
        parts.minute,
        parts.second,
    )?;
    match zone.offset_from_local_datetime(&naive) {
        chrono::LocalResult::Single(offset) => Some(offset.fix().local_minus_utc()),
        chrono::LocalResult::Ambiguous(earlier, _) => Some(earlier.fix().local_minus_utc()),
        chrono::LocalResult::None => {
            let mut probe = naive;
            for _ in 0..(24 * 60) {
                probe = probe.checked_sub_signed(chrono::TimeDelta::minutes(1))?;
                match zone.offset_from_local_datetime(&probe) {
                    chrono::LocalResult::Single(offset)
                    | chrono::LocalResult::Ambiguous(offset, _) => {
                        return Some(offset.fix().local_minus_utc());
                    }
                    chrono::LocalResult::None => {}
                }
            }
            None
        }
    }
}

fn civil_utc_ms(
    year: i64,
    month: i64,
    day: i64,
    hour: i64,
    minute: i64,
    second: i64,
    milli: i64,
) -> i64 {
    make_day(year, month - 1, day) * MS_PER_DAY
        + ((hour * 60 + minute) * 60 + second) * MS_PER_SECOND
        + milli
}

fn make_day(year: i64, month: i64, date: i64) -> i64 {
    let year = year + floor_div(month, 12);
    let month = modulo(month, 12);
    let mut start = MONTH_START[month as usize];
    if month > 1 {
        start += leap_year(year);
    }
    day_from_year(year) + start + date - 1
}

fn clip_ms(ms: i64) -> Option<f64> {
    if ms.unsigned_abs() > 8_640_000_000_000_000 {
        None
    } else {
        Some(ms as f64)
    }
}

fn parse_year(bytes: &[u8], index: &mut usize) -> Option<i64> {
    if *index >= bytes.len() {
        return None;
    }
    let sign = if bytes[*index] == b'+' {
        *index += 1;
        1
    } else if bytes[*index] == b'-' {
        *index += 1;
        -1
    } else {
        0
    };
    let width = if sign == 0 { 4 } else { 6 };
    Some(if sign == 0 { 1 } else { sign } * parse_width(bytes, index, width)?)
}

fn parse_width(bytes: &[u8], index: &mut usize, width: usize) -> Option<i64> {
    if *index + width > bytes.len() {
        return None;
    }
    let mut value = 0i64;
    for _ in 0..width {
        let code = bytes[*index];
        if !code.is_ascii_digit() {
            return None;
        }
        value = value * 10 + i64::from(code - b'0');
        *index += 1;
    }
    Some(value)
}

fn parse_int(bytes: &[u8], index: &mut usize) -> Option<i64> {
    if *index >= bytes.len() || !bytes[*index].is_ascii_digit() {
        return None;
    }
    let mut value = 0i64;
    while *index < bytes.len() && bytes[*index].is_ascii_digit() {
        value = value * 10 + i64::from(bytes[*index] - b'0');
        *index += 1;
    }
    Some(value)
}

fn fraction_millis(digits: &[u8]) -> i64 {
    let mut value = 0i64;
    let mut place = 100i64;
    for digit in digits.iter().take(3) {
        value += i64::from(digit - b'0') * place;
        place /= 10;
    }
    value
}

fn skip_space(bytes: &[u8], index: &mut usize) {
    while *index < bytes.len() && bytes[*index] == b' ' {
        *index += 1;
    }
}

fn skip_space_comma(bytes: &[u8], index: &mut usize) {
    skip_space(bytes, index);
    if *index < bytes.len() && bytes[*index] == b',' {
        *index += 1;
        skip_space(bytes, index);
    }
}

fn parse_clock(bytes: &[u8], index: &mut usize) -> Option<(i64, i64, i64)> {
    let hour = parse_int(bytes, index)?;
    if *index >= bytes.len() || bytes[*index] != b':' {
        return None;
    }
    *index += 1;
    let minute = parse_int(bytes, index)?;
    let mut second = 0i64;
    if *index < bytes.len() && bytes[*index] == b':' {
        *index += 1;
        second = parse_int(bytes, index)?;
    }
    skip_space(bytes, index);
    let hour = if *index + 1 < bytes.len()
        && bytes[*index].eq_ignore_ascii_case(&b'a')
        && bytes[*index + 1].eq_ignore_ascii_case(&b'm')
        || *index + 1 < bytes.len()
            && bytes[*index].eq_ignore_ascii_case(&b'p')
            && bytes[*index + 1].eq_ignore_ascii_case(&b'm')
    {
        let marker = if bytes[*index].eq_ignore_ascii_case(&b'p') {
            "pm"
        } else {
            "am"
        };
        *index += 2;
        apply_ampm(hour, marker)?
    } else {
        hour
    };
    if minute > 59 || second > 59 {
        return None;
    }
    Some((hour, minute, second))
}

fn parse_hms(token: &str) -> Option<(i64, i64, i64)> {
    let mut parts = token.split(':');
    let hour = parts.next()?.parse().ok()?;
    let minute = parts.next()?.parse().ok()?;
    let second = match parts.next() {
        Some(text) => text.parse().ok()?,
        None => 0,
    };
    if parts.next().is_some() || minute > 59 || second > 59 {
        return None;
    }
    Some((hour, minute, second))
}

fn apply_ampm(hour: i64, marker: &str) -> Option<i64> {
    if !(0..=12).contains(&hour) {
        return None;
    }
    if marker.eq_ignore_ascii_case("am") {
        Some(if hour == 12 { 0 } else { hour })
    } else if marker.eq_ignore_ascii_case("pm") {
        Some(if hour == 12 { 12 } else { hour + 12 })
    } else {
        None
    }
}

fn parse_zone(token: &str) -> Option<i32> {
    let lower = token.to_ascii_lowercase();
    let rest = if let Some(rest) = lower.strip_prefix("gmt") {
        rest
    } else if lower == "utc" || lower == "ut" || lower == "z" {
        ""
    } else if lower.starts_with('+') || lower.starts_with('-') {
        lower.as_str()
    } else {
        return None;
    };
    if rest.is_empty() {
        return Some(0);
    }
    let bytes = rest.as_bytes();
    let sign = if bytes[0] == b'+' {
        1i32
    } else if bytes[0] == b'-' {
        -1
    } else {
        return None;
    };
    let digits = &rest[1..];
    let (hour, minute) = if let Some((hour, minute)) = digits.split_once(':') {
        (hour.parse::<i32>().ok()?, minute.parse::<i32>().ok()?)
    } else if digits.len() == 4 {
        (digits[..2].parse().ok()?, digits[2..].parse().ok()?)
    } else if digits.len() == 1 || digits.len() == 2 {
        (digits.parse().ok()?, 0)
    } else {
        return None;
    };
    if hour > 23 || minute > 59 {
        return None;
    }
    Some(sign * (hour * 3600 + minute * 60))
}

fn month_of(token: &str) -> Option<i64> {
    const NAMES: [&str; 12] = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    NAMES
        .iter()
        .position(|name| token.eq_ignore_ascii_case(name))
        .map(|index| index as i64 + 1)
}

fn is_weekday(token: &str) -> bool {
    matches!(
        token.to_ascii_lowercase().as_str(),
        "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat"
    )
}

struct Lex<'a> {
    bytes: &'a [u8],
    index: usize,
}

impl<'a> Lex<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, index: 0 }
    }

    fn peek_word(&mut self) -> Option<&'a str> {
        let saved = self.index;
        let word = self.word();
        self.index = saved;
        word
    }

    fn word(&mut self) -> Option<&'a str> {
        loop {
            while self.index < self.bytes.len() && self.bytes[self.index] == b' ' {
                self.index += 1;
            }
            if self.index >= self.bytes.len() {
                return None;
            }
            if self.bytes[self.index] == b'(' {
                self.index += 1;
                while self.index < self.bytes.len() && self.bytes[self.index] != b')' {
                    self.index += 1;
                }
                if self.index < self.bytes.len() {
                    self.index += 1;
                }
                continue;
            }
            let start = self.index;
            while self.index < self.bytes.len() {
                let code = self.bytes[self.index];
                if code == b' ' || code == b',' || code == b'(' {
                    break;
                }
                self.index += 1;
            }
            if self.index == start {
                return None;
            }
            let end = self.index;
            if self.index < self.bytes.len() && self.bytes[self.index] == b',' {
                self.index += 1;
            }
            return std::str::from_utf8(&self.bytes[start..end]).ok();
        }
    }

    fn int(&mut self) -> Option<i64> {
        self.word()?.parse().ok()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        date_now, fmt_local_ts, system_time_zone, time_zone_name_short, to_iso_string,
        to_locale_date_string, to_locale_string, to_locale_string_en_us_time_zone,
        to_locale_string_month_short, to_locale_time_string, to_locale_time_string_en_us_hour24,
        to_locale_time_string_hhmm, to_locale_time_string_hhmmss,
    };
    use crate::host::MapEnv;

    #[test]
    fn utc_shapes_and_system_zone() {
        let mut env = MapEnv::new();
        env.set("TZ", "UTC");
        let ms = 1_768_435_509_000.0;
        assert_eq!(to_iso_string(ms).unwrap(), "2026-01-15T00:05:09.000Z");
        assert_eq!(to_locale_time_string_en_us_hour24(ms, &env), "00:05");
        assert_eq!(to_locale_string(ms, &env), "1/15/2026, 12:05:09 AM");
        assert_eq!(to_locale_date_string(ms, &env), "1/15/2026");
        assert_eq!(to_locale_time_string(ms, &env), "12:05:09 AM");
        assert_eq!(to_locale_time_string_hhmm(ms, &env), "12:05 AM");
        assert_eq!(to_locale_time_string_hhmmss(ms, &env), "12:05:09 AM");
        assert_eq!(to_locale_string_month_short(ms, &env), "Jan 15, 12:05 AM");
        assert_eq!(
            to_locale_string_en_us_time_zone(ms, "America/New_York"),
            "1/14/2026, 7:05:09 PM"
        );
        assert_eq!(time_zone_name_short(ms, &env), "UTC");
        assert_eq!(fmt_local_ts(ms, &env), "2026-01-15 00:05:09 UTC");
        assert!(to_iso_string(f64::NAN).is_err());
        assert!(system_time_zone().is_some());
        assert!(date_now().is_finite());
    }
}
