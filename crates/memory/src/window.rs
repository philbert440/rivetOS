use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc};

pub const MS_PER_DAY: i64 = 86_400_000;
pub const WINDOW_CHOICES: [&str; 7] = [
    "today",
    "yesterday",
    "this_morning",
    "this_week",
    "last_24h",
    "last_7d",
    "last_14d",
];

pub fn is_window_choice(value: &str) -> bool {
    WINDOW_CHOICES.contains(&value)
}

pub fn format_window_choices() -> String {
    WINDOW_CHOICES
        .iter()
        .map(|c| format!("\"{c}\""))
        .collect::<Vec<_>>()
        .join(", ")
}

fn replace_all(text: &str, pattern: &str, replacement: &str) -> String {
    let source = protocol::js::JsString::from_text(text);
    match protocol::js::js_replace(&source, pattern, "g", replacement) {
        Ok(value) => value.to_utf8().to_string(),
        Err(_) => text.to_string(),
    }
}

pub fn normalize_window_input(raw: &str) -> Option<String> {
    let mut s = protocol::js::js_trim(raw).to_lowercase();
    if s.is_empty() {
        return None;
    }
    let steps: [(&str, &str); 12] = [
        (r"\blast\s*24\s*(?:h(?:ours?)?)?\b", "last_24h"),
        (r"\blast\s+day\b", "last_24h"),
        (r"\blast\s*(?:7|seven)\s*d(?:ays?)?\b", "last_7d"),
        (r"\blast\s*(?:14|fourteen)\s*d(?:ays?)?\b", "last_14d"),
        (r"\bpast\s*(?:7|seven)\s*d(?:ays?)?\b", "last_7d"),
        (r"\bpast\s*(?:14|fourteen)\s*d(?:ays?)?\b", "last_14d"),
        (r"\blast\s+week\b", "last_7d"),
        (r"\bpast\s+week\b", "last_7d"),
        (r"\blast\s+two\s+weeks?\b", "last_14d"),
        (r"\bpast\s+two\s+weeks?\b", "last_14d"),
        (r"\bthis\s+morning\b", "this_morning"),
        (r"\bthis\s+week\b", "this_week"),
    ];
    for (pattern, replacement) in steps {
        s = replace_all(&s, pattern, replacement);
    }
    let mut out = String::new();
    let mut prev_us = false;
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            prev_us = false;
        } else if (ch.is_whitespace() || ch == '-' || ch == '_') && !prev_us && !out.is_empty() {
            out.push('_');
            prev_us = true;
        }
    }
    let s = out.trim_matches('_').to_string();
    if s.is_empty() {
        return None;
    }
    let aliases = [
        ("last24h", "last_24h"),
        ("last_24_hours", "last_24h"),
        ("last_24hours", "last_24h"),
        ("last_day", "last_24h"),
        ("past_24h", "last_24h"),
        ("morning", "this_morning"),
        ("week", "this_week"),
        ("last_week", "last_7d"),
        ("past_week", "last_7d"),
        ("last7d", "last_7d"),
        ("last_7_days", "last_7d"),
        ("last_7days", "last_7d"),
        ("past_7d", "last_7d"),
        ("past_7_days", "last_7d"),
        ("last14d", "last_14d"),
        ("last_14_days", "last_14d"),
        ("last_14days", "last_14d"),
        ("past_14d", "last_14d"),
        ("past_14_days", "last_14d"),
        ("last_two_weeks", "last_14d"),
        ("past_two_weeks", "last_14d"),
    ];
    for (key, value) in aliases {
        if s == key {
            return Some(value.to_string());
        }
    }
    Some(s)
}

fn iso<Tz: TimeZone>(dt: DateTime<Tz>) -> String {
    dt.to_utc().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn zoned_midnight<Tz: TimeZone>(date: NaiveDate, tz: &Tz) -> Option<DateTime<Tz>> {
    let naive = date.and_hms_opt(0, 0, 0)?;
    match tz.from_local_datetime(&naive) {
        chrono::LocalResult::Single(dt) => Some(dt),
        chrono::LocalResult::Ambiguous(earliest, _) => Some(earliest),
        chrono::LocalResult::None => None,
    }
}

pub fn parse_js_date(raw: &str) -> Option<DateTime<Utc>> {
    parse_js_date_with(raw, &protocol::host::ProcessEnv)
}

pub fn parse_js_date_with(raw: &str, env: &dyn protocol::host::Env) -> Option<DateTime<Utc>> {
    let ms = protocol::js::date_parse(raw, env)?;
    DateTime::from_timestamp_millis(ms as i64)
}

pub fn resolve_window<Tz: TimeZone>(
    window: &str,
    now: DateTime<Tz>,
) -> Result<(Option<String>, Option<String>), String> {
    let normalized = normalize_window_input(window).ok_or_else(|| {
        format!(
            "Invalid window=\"\" — expected one of: {}",
            format_window_choices()
        )
    })?;
    if !is_window_choice(&normalized) {
        let shown = if normalized != window.trim().to_lowercase() {
            format!(" (normalized to \"{normalized}\")")
        } else {
            String::new()
        };
        return Err(format!(
            "Unknown window=\"{window}\"{shown}. Expected one of: {}",
            format_window_choices()
        ));
    }
    let zone = now.timezone();
    let today = zoned_midnight(now.date_naive(), &zone).unwrap_or_else(|| now.clone());
    match normalized.as_str() {
        "today" | "this_morning" => Ok((Some(iso(today)), None)),
        "yesterday" => {
            let yest = today
                .date_naive()
                .checked_sub_days(chrono::Days::new(1))
                .and_then(|date| zoned_midnight(date, &zone))
                .unwrap_or_else(|| today.clone());
            Ok((Some(iso(yest)), Some(iso(today))))
        }
        "this_week" => {
            let day = today.weekday().num_days_from_sunday();
            let from_monday = if day == 0 { 6 } else { day - 1 };
            let monday = today
                .date_naive()
                .checked_sub_days(chrono::Days::new(u64::from(from_monday)))
                .and_then(|date| zoned_midnight(date, &zone))
                .unwrap_or(today);
            Ok((Some(iso(monday)), None))
        }
        "last_24h" => Ok((Some(iso(now - Duration::hours(24))), None)),
        "last_7d" => Ok((
            Some(iso(now - Duration::milliseconds(7 * MS_PER_DAY))),
            None,
        )),
        "last_14d" => Ok((
            Some(iso(now - Duration::milliseconds(14 * MS_PER_DAY))),
            None,
        )),
        _ => Err(format!(
            "Unknown window=\"{normalized}\". Expected one of: {}",
            format_window_choices()
        )),
    }
}

pub fn apply_window_args<Tz: TimeZone>(
    window: Option<&str>,
    since: Option<&str>,
    before: Option<&str>,
    now: DateTime<Tz>,
) -> Result<(Option<String>, Option<String>), String> {
    let explicit_since = since.filter(|s| !s.is_empty()).map(str::to_string);
    let explicit_before = before.filter(|s| !s.is_empty()).map(str::to_string);
    if explicit_since.is_some() || explicit_before.is_some() {
        return Ok((explicit_since, explicit_before));
    }
    if let Some(window) = window.filter(|s| !s.is_empty()) {
        let (since, before) = resolve_window(window, now)?;
        return Ok((since, before));
    }
    Ok((None, None))
}
