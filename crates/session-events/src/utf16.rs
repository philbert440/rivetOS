use serde::de::{self, Deserializer, Visitor};
use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize, Serializer};

use protocol::js::{JsValue, parse, stringify};

const JSON_RAW_VALUE: &str = "$serde_json::private::RawValue";

#[derive(Clone, Debug, Eq)]
pub struct Utf16String {
    value: JsValue,
    utf8: String,
}

impl PartialEq for Utf16String {
    fn eq(&self, other: &Self) -> bool {
        self.value == other.value
    }
}

impl PartialEq<str> for Utf16String {
    fn eq(&self, other: &str) -> bool {
        self.utf8 == other
    }
}

impl PartialEq<&str> for Utf16String {
    fn eq(&self, other: &&str) -> bool {
        self.utf8 == *other
    }
}

impl PartialEq<String> for Utf16String {
    fn eq(&self, other: &String) -> bool {
        self.utf8 == *other
    }
}

impl From<&str> for Utf16String {
    fn from(text: &str) -> Self {
        Self {
            value: JsValue::from_text(text),
            utf8: text.to_string(),
        }
    }
}

impl From<String> for Utf16String {
    fn from(text: String) -> Self {
        Self::from(text.as_str())
    }
}

impl std::ops::Deref for Utf16String {
    type Target = str;

    fn deref(&self) -> &str {
        &self.utf8
    }
}

impl Utf16String {
    pub(crate) fn clear(&mut self) {
        *self = Self::from("");
    }

    pub(crate) fn units(&self) -> Vec<u16> {
        units_of(&self.value).unwrap_or_else(|| self.utf8.encode_utf16().collect())
    }

    pub(crate) fn from_units(units: &[u16]) -> Self {
        let value = js_string_value(units);
        let utf8 = value.as_str().unwrap_or("").to_string();
        Self { value, utf8 }
    }
}

impl Serialize for Utf16String {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serialize_json_text(serializer, &stringify(&self.value))
    }
}

impl<'de> Deserialize<'de> for Utf16String {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let text = String::deserialize(deserializer)?;
        Ok(Self::from(text))
    }
}

pub(crate) fn units_of(value: &JsValue) -> Option<Vec<u16>> {
    if !value.is_string() {
        return None;
    }
    decode_json_string(&stringify(value))
}

pub(crate) fn serialize_json_text<S>(serializer: S, json: &str) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    let mut state = serializer.serialize_struct(JSON_RAW_VALUE, 1)?;
    state.serialize_field(JSON_RAW_VALUE, json)?;
    state.end()
}

fn js_string_value(units: &[u16]) -> JsValue {
    let mut literal = String::with_capacity(units.len().saturating_mul(6).saturating_add(2));
    literal.push('"');
    for unit in units {
        literal.push_str("\\u");
        push_hex4(*unit, &mut literal);
    }
    literal.push('"');
    parse(&literal).unwrap_or_else(|_| JsValue::from_text(""))
}

fn push_hex4(unit: u16, out: &mut String) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let value = usize::from(unit);
    out.push(char::from(HEX[(value >> 12) & 0xF]));
    out.push(char::from(HEX[(value >> 8) & 0xF]));
    out.push(char::from(HEX[(value >> 4) & 0xF]));
    out.push(char::from(HEX[value & 0xF]));
}

fn decode_json_string(encoded: &str) -> Option<Vec<u16>> {
    let bytes = encoded.as_bytes();
    if bytes.first() != Some(&b'"') || bytes.last() != Some(&b'"') || bytes.len() < 2 {
        return None;
    }
    let mut units = Vec::new();
    let mut index = 1;
    let end = bytes.len() - 1;
    while index < end {
        if bytes[index] == b'\\' {
            index += 1;
            if index >= end {
                return None;
            }
            let unit = match bytes[index] {
                b'"' => u16::from(b'"'),
                b'\\' => u16::from(b'\\'),
                b'/' => u16::from(b'/'),
                b'b' => 0x08,
                b'f' => 0x0C,
                b'n' => 0x0A,
                b'r' => 0x0D,
                b't' => 0x09,
                b'u' => {
                    if index + 5 > end {
                        return None;
                    }
                    let hex = std::str::from_utf8(bytes.get(index + 1..index + 5)?).ok()?;
                    let value = u16::from_str_radix(hex, 16).ok()?;
                    index += 4;
                    value
                }
                _ => return None,
            };
            units.push(unit);
            index += 1;
            continue;
        }
        let rest = std::str::from_utf8(bytes.get(index..end)?).ok()?;
        let ch = rest.chars().next()?;
        let mut encoded_units = [0u16; 2];
        units.extend_from_slice(ch.encode_utf16(&mut encoded_units));
        index += ch.len_utf8();
    }
    Some(units)
}

impl<'de> Visitor<'de> for () {
    type Value = ();

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("")
    }
}

const _: fn() = || {
    let _ = de::IgnoredAny;
};
