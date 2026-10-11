use std::collections::BTreeMap;
use std::path::PathBuf;

pub const DEFAULT_SHARED_DIR: &str = "/rivet-shared";

pub fn homedir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
}

pub fn homedir_from(env: &BTreeMap<String, String>) -> String {
    env.get("HOME")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(homedir)
}

pub fn shared_dir_from(env: &BTreeMap<String, String>) -> String {
    if let Some(raw) = env.get("RIVETOS_SHARED_DIR") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    match std::env::var("RIVETOS_SHARED_DIR") {
        Ok(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                DEFAULT_SHARED_DIR.to_string()
            } else {
                trimmed.to_string()
            }
        }
        Err(_) => DEFAULT_SHARED_DIR.to_string(),
    }
}

pub fn hostname() -> String {
    hostname::get()
        .ok()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "localhost".to_string())
}

pub fn join_path(root: &str, parts: &[&str]) -> String {
    let mut path = PathBuf::from(root);
    for part in parts {
        path.push(part);
    }
    path.to_string_lossy().into_owned()
}

pub fn parse_int_js(raw: &str) -> Option<i64> {
    let trimmed = raw.trim_start_matches([' ', '\t', '\n', '\r', '\u{000c}']);
    if trimmed.is_empty() {
        return None;
    }
    let (sign, rest) = if let Some(rest) = trimmed.strip_prefix('-') {
        (-1, rest)
    } else if let Some(rest) = trimmed.strip_prefix('+') {
        (1, rest)
    } else {
        (1, trimmed)
    };
    let bytes = rest.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_digit() {
        return None;
    }
    let mut number: i64 = 0;
    for byte in bytes {
        if !byte.is_ascii_digit() {
            break;
        }
        number = number
            .saturating_mul(10)
            .saturating_add(i64::from(byte - b'0'));
    }
    Some(number.saturating_mul(sign))
}

pub fn int_env(env: &BTreeMap<String, String>, name: &str, fallback: i64) -> i64 {
    let Some(raw) = env.get(name) else {
        return fallback;
    };
    if raw.is_empty() {
        return fallback;
    }
    parse_int_js(raw).unwrap_or(fallback)
}

pub fn truthy_env(raw: Option<&str>) -> bool {
    let value = raw.unwrap_or("").trim().to_ascii_lowercase();
    value == "1" || value == "on"
}

pub fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|text| !text.is_empty())
}

pub fn unix_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

pub fn http_date(unix_secs: i64) -> String {
    const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let days = unix_secs.div_euclid(86_400);
    let tod = unix_secs.rem_euclid(86_400) as u32;
    let hour = tod / 3600;
    let minute = (tod % 3600) / 60;
    let second = tod % 60;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    if month <= 2 {
        year += 1;
    }
    let weekday = (days + 4).rem_euclid(7) as usize;
    format!(
        "{}, {:02} {} {:04} {:02}:{:02}:{:02} GMT",
        DAYS[weekday],
        day,
        MONTHS[(month as usize).saturating_sub(1)],
        year,
        hour,
        minute,
        second
    )
}

pub fn repo_root() -> String {
    let mut starts = Vec::new();
    starts.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    if let Ok(exe) = std::env::current_exe()
        && let Some(parent) = exe.parent()
    {
        starts.push(parent.to_path_buf());
    }
    if let Ok(current) = std::env::current_dir() {
        starts.push(current);
    }
    for start in starts {
        let mut dir = Some(start);
        while let Some(current) = dir {
            if current.join("packages").join("types").is_dir() {
                let canon = std::fs::canonicalize(&current).unwrap_or(current);
                return canon.to_string_lossy().into_owned();
            }
            dir = current.parent().map(std::path::Path::to_path_buf);
        }
    }
    String::new()
}
