use std::fs;
use std::path::Path;

use rand::RngCore;
use x509_cert::serial_number::SerialNumber;

use crate::error::{Error, wrap};

pub fn random_serial() -> Result<SerialNumber, Error> {
    let mut bytes = [0u8; 20];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
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
    format!("{value:X}")
}

pub fn parse_hex_u128(text: &str) -> Result<u128, Error> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(Error::msg("empty serial"));
    }
    u128::from_str_radix(trimmed, 16).map_err(wrap)
}

pub fn read_counter(path: &Path) -> Result<u128, Error> {
    let text = fs::read_to_string(path)
        .map_err(|err| Error::msg(format!("read {}: {err}", path.display())))?;
    parse_hex_u128(&text).map_err(|err| Error::msg(format!("{}: {err}", path.display())))
}

pub fn write_counter(path: &Path, value: u128) -> Result<(), Error> {
    fs::write(path, format!("{value:X}\n"))
        .map_err(|err| Error::msg(format!("write {}: {err}", path.display())))
}

pub fn use_then_increment(path: &Path) -> Result<u128, Error> {
    let value = read_counter(path)?;
    let next = value
        .checked_add(1)
        .ok_or_else(|| Error::msg("serial overflow"))?;
    backup(path)?;
    write_counter(path, next)?;
    Ok(value)
}

pub fn increment_then_use(path: &Path) -> Result<u128, Error> {
    let value = read_counter(path)?;
    let used = value
        .checked_add(1)
        .ok_or_else(|| Error::msg("serial overflow"))?;
    write_counter(path, used)?;
    Ok(used)
}

pub fn backup(path: &Path) -> Result<(), Error> {
    if path.exists() {
        fs::copy(path, old_path(path))?;
    }
    Ok(())
}

pub fn old_path(path: &Path) -> std::path::PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".old");
    std::path::PathBuf::from(name)
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
    let start = raw.iter().position(|byte| *byte != 0).unwrap_or(raw.len());
    if start == raw.len() {
        return "0".to_string();
    }
    let mut text = format!("{:X}", raw[start]);
    for byte in &raw[start + 1..] {
        text.push_str(&format!("{byte:02X}"));
    }
    text
}
