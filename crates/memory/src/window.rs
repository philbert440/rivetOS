use std::sync::OnceLock;

use chrono::{DateTime, Datelike, Duration, Local, TimeZone, Timelike};
use regex::Regex;

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

fn re(slot: &OnceLock<Option<Regex>>, pat: &str) -> Option<&Regex> {
    slot.get_or_init(|| Regex::new(pat).ok()).as_ref()
}

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

pub fn normalize_window_input(raw: &str) -> Option<String> {
    let mut s = raw.trim().to_lowercase();
    if s.is_empty() {
        return None;
    }
    let steps: [(&str, &str); 12] = [
        (r"(?i)\blast\s*24\s*(?:h(?:ours?)?)?\b", "last_24h"),
        (r"(?i)\blast\s+day\b", "last_24h"),
        (r"(?i)\blast\s*(?:7|seven)\s*d(?:ays?)?\b", "last_7d"),
        (r"(?i)\blast\s*(?:14|fourteen)\s*d(?:ays?)?\b", "last_14d"),
        (r"(?i)\bpast\s*(?:7|seven)\s*d(?:ays?)?\b", "last_7d"),
        (r"(?i)\bpast\s*(?:14|fourteen)\s*d(?:ays?)?\b", "last_14d"),
        (r"(?i)\blast\s+week\b", "last_7d"),
        (r"(?i)\bpast\s+week\b", "last_7d"),
        (r"(?i)\blast\s+two\s+weeks?\b", "last_14d"),
        (r"(?i)\bpast\s+two\s+weeks?\b", "last_14d"),
        (r"(?i)\bthis\s+morning\b", "this_morning"),
        (r"(?i)\bthis\s+week\b", "this_week"),
    ];
    for (pat, repl) in steps {
        static SLOTS: [OnceLock<Option<Regex>>; 12] = [
            OnceLock::new(),
            OnceLock::new(),
            OnceLock::new(),
            OnceLock::new(),
            OnceLock::new(),
            OnceLock::new(),
            OnceLock::new(),
            OnceLock::new(),
            OnceLock::new(),
            OnceLock::new(),
            OnceLock::new(),
            OnceLock::new(),
        ];
        let idx = steps.iter().position(|(p, _)| *p == pat).unwrap_or(0);
        if let Some(compiled) = re(&SLOTS[idx], pat) {
            s = compiled.replace_all(&s, repl).into_owned();
        }
    }
    let mut out = String::new();
    let mut prev_us = false;
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            prev_us = false;
        } else if ch.is_whitespace() || ch == '-' || ch == '_' {
            if !prev_us && !out.is_empty() {
                out.push('_');
                prev_us = true;
            }
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

fn iso(dt: DateTime<Local>) -> String {
    dt.to_utc().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

pub fn resolve_window(window: &str, now: DateTime<Local>) -> Result<(Option<String>, Option<String>), String> {
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
    let today = Local
        .with_ymd_and_hms(now.year(), now.month(), now.day(), 0, 0, 0)
        .single()
        .unwrap_or(now);
    match normalized.as_str() {
        "today" | "this_morning" => Ok((Some(iso(today)), None)),
        "yesterday" => {
            let yest = today - Duration::days(1);
            Ok((Some(iso(yest)), Some(iso(today))))
        }
        "this_week" => {
            let day = today.weekday().num_days_from_sunday();
            let from_monday = if day == 0 { 6 } else { day - 1 };
            let monday = today - Duration::days(i64::from(from_monday));
            Ok((Some(iso(monday)), None))
        }
        "last_24h" => Ok((Some(iso(now - Duration::hours(24))), None)),
        "last_7d" => Ok((Some(iso(now - Duration::milliseconds(7 * MS_PER_DAY))), None)),
        "last_14d" => Ok((Some(iso(now - Duration::milliseconds(14 * MS_PER_DAY))), None)),
        _ => Err(format!(
            "Unknown window=\"{normalized}\". Expected one of: {}",
            format_window_choices()
        )),
    }
}

pub fn apply_window_args(
    window: Option<&str>,
    since: Option<&str>,
    before: Option<&str>,
    now: DateTime<Local>,
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
