use protocol::{HARNESS_IDS, parse_session_id_str};

fn uuid_tail(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    let hex = |index: usize| bytes[index].is_ascii_hexdigit();
    let dash = |index: usize| bytes[index] == b'-';
    hex(0)
        && hex(1)
        && hex(2)
        && hex(3)
        && hex(4)
        && hex(5)
        && hex(6)
        && hex(7)
        && dash(8)
        && hex(9)
        && hex(10)
        && hex(11)
        && hex(12)
        && dash(13)
        && hex(14)
        && hex(15)
        && hex(16)
        && hex(17)
        && dash(18)
        && hex(19)
        && hex(20)
        && hex(21)
        && hex(22)
        && dash(23)
        && hex(24)
        && hex(25)
        && hex(26)
        && hex(27)
        && hex(28)
        && hex(29)
        && hex(30)
        && hex(31)
        && hex(32)
        && hex(33)
        && hex(34)
        && hex(35)
}

fn collapse_native(harness: &str, native: &str) -> String {
    let Some(slash) = native.rfind('/') else {
        return native.to_string();
    };
    let tail = &native[slash + 1..];
    if uuid_tail(tail) {
        let _ = harness;
        return tail.to_string();
    }
    native.to_string()
}

pub fn den_join_key(raw: &str) -> String {
    if raw.is_empty() || raw != raw.trim() || raw.starts_with("task:") {
        return raw.to_string();
    }
    if uuid_tail(raw) {
        return raw.to_string();
    }
    let Some(colon) = raw.find(':') else {
        return raw.to_string();
    };
    if colon == 0 || colon + 1 == raw.len() {
        return raw.to_string();
    }
    let harness = &raw[..colon];
    if !HARNESS_IDS.contains(&harness) {
        return raw.to_string();
    }
    let native = collapse_native(harness, &raw[colon + 1..]);
    let canonical = format!("{harness}:{native}");
    match parse_session_id_str(&canonical) {
        Ok(parsed) => parsed.native_session_id,
        Err(_) => raw.to_string(),
    }
}
