use std::fmt;

use serde::de::{self, Deserializer, Visitor};
use serde::{Deserialize, Serialize, Serializer};

#[derive(Debug, Clone, Copy)]
pub struct JsNumber(f64);

impl JsNumber {
    pub fn as_f64(self) -> f64 {
        self.0
    }

    pub fn as_i64(self) -> Option<i64> {
        if !self.0.is_finite() || self.0.fract() != 0.0 {
            return None;
        }
        if self.0 < i64::MIN as f64 || self.0 >= 9223372036854775808.0 {
            return None;
        }
        Some(self.0 as i64)
    }

    pub fn as_u64(self) -> Option<u64> {
        if !self.0.is_finite() || self.0 < 0.0 || self.0.fract() != 0.0 {
            return None;
        }
        if self.0 >= 18446744073709551616.0 {
            return None;
        }
        Some(self.0 as u64)
    }
}

impl PartialEq for JsNumber {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0 || (self.0.is_nan() && other.0.is_nan())
    }
}

impl Eq for JsNumber {}

impl From<f64> for JsNumber {
    fn from(value: f64) -> Self {
        Self(value)
    }
}

impl From<i64> for JsNumber {
    fn from(value: i64) -> Self {
        Self(value as f64)
    }
}

impl From<i32> for JsNumber {
    fn from(value: i32) -> Self {
        Self(f64::from(value))
    }
}

impl From<u64> for JsNumber {
    fn from(value: u64) -> Self {
        Self(value as f64)
    }
}

impl From<u32> for JsNumber {
    fn from(value: u32) -> Self {
        Self(f64::from(value))
    }
}

impl PartialEq<i64> for JsNumber {
    fn eq(&self, other: &i64) -> bool {
        self.as_i64() == Some(*other)
    }
}

impl PartialEq<i32> for JsNumber {
    fn eq(&self, other: &i32) -> bool {
        self.as_i64() == Some(i64::from(*other))
    }
}

impl PartialEq<u64> for JsNumber {
    fn eq(&self, other: &u64) -> bool {
        self.as_u64() == Some(*other)
    }
}

impl PartialEq<u32> for JsNumber {
    fn eq(&self, other: &u32) -> bool {
        self.as_u64() == Some(u64::from(*other))
    }
}

impl PartialEq<f64> for JsNumber {
    fn eq(&self, other: &f64) -> bool {
        self.0 == *other || (self.0.is_nan() && other.is_nan())
    }
}

impl fmt::Display for JsNumber {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.0.is_nan() {
            return formatter.write_str("NaN");
        }
        if self.0.is_infinite() {
            return formatter.write_str(if self.0.is_sign_positive() {
                "Infinity"
            } else {
                "-Infinity"
            });
        }
        formatter.write_str(&json_number(self.0))
    }
}

impl Serialize for JsNumber {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        if !self.0.is_finite() {
            return serializer.serialize_unit();
        }
        let text = json_number(self.0);
        let raw =
            serde_json::value::RawValue::from_string(text).map_err(serde::ser::Error::custom)?;
        raw.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for JsNumber {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(JsNumberVisitor)
    }
}

struct JsNumberVisitor;

impl Visitor<'_> for JsNumberVisitor {
    type Value = JsNumber;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON number")
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
        Ok(JsNumber::from(value))
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
        Ok(JsNumber::from(value))
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Self::Value, E> {
        Ok(JsNumber::from(value))
    }
}

fn json_number(value: f64) -> String {
    if value == 0.0 {
        return "0".to_string();
    }
    let negative = value.is_sign_negative();
    let mut buffer = ryu::Buffer::new();
    let printed = buffer.format_finite(value.abs());
    let (digits, exp10) = significant(printed);
    let body = layout(&digits, exp10);
    if negative {
        let mut out = String::with_capacity(body.len() + 1);
        out.push('-');
        out.push_str(&body);
        out
    } else {
        body
    }
}

fn significant(printed: &str) -> (String, i32) {
    let printed = printed.strip_prefix('+').unwrap_or(printed);
    let printed = printed.strip_prefix('-').unwrap_or(printed);
    let bytes = printed.as_bytes();
    let mut index = 0;
    let mut digits = String::new();
    let mut fraction: i32 = -1;
    while index < bytes.len() && bytes[index] != b'e' && bytes[index] != b'E' {
        match bytes[index] {
            b'.' => fraction = 0,
            b'0'..=b'9' => {
                digits.push(bytes[index] as char);
                if fraction >= 0 {
                    fraction += 1;
                }
            }
            _ => {}
        }
        index += 1;
    }
    let mut exponent = 0i32;
    if index < bytes.len() && (bytes[index] == b'e' || bytes[index] == b'E') {
        index += 1;
        let mut sign = 1i32;
        if index < bytes.len() && bytes[index] == b'+' {
            index += 1;
        } else if index < bytes.len() && bytes[index] == b'-' {
            sign = -1;
            index += 1;
        }
        let mut parsed = 0i32;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            parsed = parsed * 10 + i32::from(bytes[index] - b'0');
            index += 1;
        }
        exponent = sign * parsed;
    }
    let decimal_places = if fraction < 0 { 0 } else { fraction };
    let mut exp10 = exponent - decimal_places;
    if digits.chars().all(|ch| ch == '0') {
        return ("0".to_string(), 0);
    }
    let digits = digits.trim_start_matches('0').to_string();
    let trailing = digits.len() - digits.trim_end_matches('0').len();
    let digits = digits.trim_end_matches('0').to_string();
    exp10 += trailing as i32;
    (digits, exp10)
}

fn layout(digits: &str, exp10: i32) -> String {
    let k = digits.len() as i32;
    let n = exp10 + k;
    if k <= n && n <= 21 {
        let mut out = digits.to_string();
        for _ in 0..(n - k) {
            out.push('0');
        }
        return out;
    }
    if n > 0 && n <= 21 {
        let split = n as usize;
        let mut out = String::new();
        out.push_str(&digits[..split]);
        out.push('.');
        out.push_str(&digits[split..]);
        return out;
    }
    if n > -6 && n <= 0 {
        let mut out = String::from("0.");
        for _ in 0..(-n) {
            out.push('0');
        }
        out.push_str(digits);
        return out;
    }
    let exp = n - 1;
    let exp_sign = if exp >= 0 { '+' } else { '-' };
    let exp_abs = exp.unsigned_abs();
    if k == 1 {
        return format!("{digits}e{exp_sign}{exp_abs}");
    }
    format!("{}.{}e{exp_sign}{exp_abs}", &digits[..1], &digits[1..])
}
