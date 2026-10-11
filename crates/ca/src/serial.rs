use std::path::Path;

use x509_cert::serial_number::SerialNumber;

use crate::error::{Error, wrap};
use crate::fsutil;

pub fn random_serial() -> Result<SerialNumber, Error> {
    let mut bytes = [0u8; 20];
    getrandom::getrandom(&mut bytes).map_err(wrap)?;
    bytes[0] &= 0x7f;
    if bytes[0] == 0 {
        bytes[0] = 1;
    }
    SerialNumber::new(&bytes).map_err(wrap)
}

pub fn serial_from_u128(value: u128) -> Result<SerialNumber, Error> {
    SerialNumber::new(&minimal_be(value)).map_err(wrap)
}

pub fn hex_u128(value: u128) -> String {
    hex_from_raw(&minimal_be(value))
}

pub fn parse_hex_u128(text: &str) -> Result<u128, Error> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(Error::msg("empty serial"));
    }
    u128::from_str_radix(trimmed, 16).map_err(wrap)
}

pub fn same_serial(left: &str, right: &str) -> bool {
    match (parse_hex_u128(left), parse_hex_u128(right)) {
        (Ok(left_value), Ok(right_value)) => left_value == right_value,
        _ => left.eq_ignore_ascii_case(right),
    }
}

pub fn read_counter(path: &Path) -> Result<u128, Error> {
    let text = fsutil::read_text(path)
        .map_err(|err| Error::msg(format!("read {}: {err}", path.display())))?;
    parse_hex_u128(&text).map_err(|err| Error::msg(format!("{}: {err}", path.display())))
}

pub fn write_counter(path: &Path, value: u128, keep_old: bool) -> Result<(), Error> {
    fsutil::replace_bytes(
        path,
        format!("{}\n", hex_u128(value)).as_bytes(),
        0o644,
        keep_old,
    )
    .map_err(|err| Error::msg(format!("write {}: {err}", path.display())))
}

fn minimal_be(value: u128) -> Vec<u8> {
    if value == 0 {
        return vec![0];
    }
    let raw = value.to_be_bytes();
    let start = raw.iter().position(|byte| *byte != 0).unwrap_or(0);
    let mut bytes = raw[start..].to_vec();
    if bytes[0] & 0x80 != 0 {
        bytes.insert(0, 0);
    }
    bytes
}

pub fn hex_from_raw(raw: &[u8]) -> String {
    let bytes = match raw {
        [0x00, rest @ ..] if !rest.is_empty() => rest,
        other => other,
    };
    if bytes.is_empty() {
        return "00".to_string();
    }
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push_str(&format!("{byte:02X}"));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::{hex_from_raw, hex_u128, random_serial};

    #[test]
    fn random_serial_is_positive() {
        let serial = random_serial().unwrap();
        let raw = serial.as_bytes();
        assert!(!raw.is_empty());
        assert_ne!(raw[0], 0);
        assert_eq!(raw[0] & 0x80, 0);
    }

    #[test]
    fn openssl_even_width() {
        assert_eq!(hex_u128(0x1000), "1000");
        assert_eq!(hex_u128(0xffff), "FFFF");
        assert_eq!(hex_u128(0x10000), "010000");
        assert_eq!(hex_u128(0x80), "80");
        assert_eq!(hex_u128(1), "01");
        assert_eq!(hex_u128(0), "00");
        assert_eq!(hex_from_raw(&[0x00, 0x01, 0x00, 0x00]), "010000");
        assert_eq!(hex_from_raw(&[0x00, 0xff, 0xff]), "FFFF");
        assert_eq!(hex_from_raw(&[0x10, 0x00]), "1000");
    }
}
