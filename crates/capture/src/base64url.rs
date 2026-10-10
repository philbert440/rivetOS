const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub fn encode(data: &[u8]) -> String {
    let mut out = String::new();
    let mut index = 0;
    while index + 3 <= data.len() {
        let chunk =
            ((data[index] as u32) << 16) | ((data[index + 1] as u32) << 8) | data[index + 2] as u32;
        out.push(ALPHABET[((chunk >> 18) & 63) as usize] as char);
        out.push(ALPHABET[((chunk >> 12) & 63) as usize] as char);
        out.push(ALPHABET[((chunk >> 6) & 63) as usize] as char);
        out.push(ALPHABET[(chunk & 63) as usize] as char);
        index += 3;
    }
    let rest = data.len() - index;
    if rest == 1 {
        let chunk = (data[index] as u32) << 16;
        out.push(ALPHABET[((chunk >> 18) & 63) as usize] as char);
        out.push(ALPHABET[((chunk >> 12) & 63) as usize] as char);
    } else if rest == 2 {
        let chunk = ((data[index] as u32) << 16) | ((data[index + 1] as u32) << 8);
        out.push(ALPHABET[((chunk >> 18) & 63) as usize] as char);
        out.push(ALPHABET[((chunk >> 12) & 63) as usize] as char);
        out.push(ALPHABET[((chunk >> 6) & 63) as usize] as char);
    }
    out
}

pub fn decode(text: &str) -> Option<Vec<u8>> {
    if text.bytes().any(|byte| decode_byte(byte).is_none()) {
        return None;
    }
    let mut padded = text.to_string();
    while !padded.len().is_multiple_of(4) {
        padded.push('=');
    }
    let bytes = padded.as_bytes();
    let mut out = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let a = decode_padded(bytes[index])?;
        let b = decode_padded(bytes[index + 1])?;
        let c = decode_padded(bytes[index + 2])?;
        let d = decode_padded(bytes[index + 3])?;
        let chunk = (a << 18) | (b << 12) | (c << 6) | d;
        out.push((chunk >> 16) as u8);
        if bytes[index + 2] != b'=' {
            out.push((chunk >> 8) as u8);
        }
        if bytes[index + 3] != b'=' {
            out.push(chunk as u8);
        }
        index += 4;
    }
    Some(out)
}

fn decode_padded(byte: u8) -> Option<u32> {
    if byte == b'=' {
        Some(0)
    } else {
        decode_byte(byte).map(|value| value as u32)
    }
}

fn decode_byte(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'-' => Some(62),
        b'_' => Some(63),
        _ => None,
    }
}
