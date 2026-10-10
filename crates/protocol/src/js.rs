use serde_json::{Map, Value};

pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

pub(crate) fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            | '\u{2001}'
            | '\u{2002}'
            | '\u{2003}'
            | '\u{2004}'
            | '\u{2005}'
            | '\u{2006}'
            | '\u{2007}'
            | '\u{2008}'
            | '\u{2009}'
            | '\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    message: &'static str,
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for ParseError {}

#[derive(Clone, Debug)]
pub struct JsString {
    units: Vec<u16>,
    utf8: String,
}

impl PartialEq for JsString {
    fn eq(&self, other: &Self) -> bool {
        self.units == other.units
    }
}

impl Eq for JsString {}

impl JsString {
    pub fn from_text(text: &str) -> Self {
        let units: Vec<u16> = text.encode_utf16().collect();
        Self {
            units,
            utf8: text.to_string(),
        }
    }

    pub fn from_units(units: Vec<u16>) -> Self {
        let utf8 = utf8_from_units(&units);
        Self { units, utf8 }
    }

    pub fn units(&self) -> &[u16] {
        &self.units
    }

    pub fn to_utf8(&self) -> &str {
        &self.utf8
    }
}

fn utf8_from_units(units: &[u16]) -> String {
    char::decode_utf16(units.iter().copied())
        .map(|item| item.unwrap_or('\u{FFFD}'))
        .collect()
}

#[derive(Clone, Debug)]
pub struct JsObject {
    entries: Vec<(JsString, JsValue)>,
}

impl PartialEq for JsObject {
    fn eq(&self, other: &Self) -> bool {
        if self.entries.len() != other.entries.len() {
            return false;
        }
        self.entries.iter().all(|(key, value)| {
            other
                .entries
                .iter()
                .any(|(other_key, other_value)| key == other_key && value == other_value)
        })
    }
}

impl Eq for JsObject {}

impl JsObject {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    pub fn insert(&mut self, key: JsString, value: JsValue) {
        if let Some(slot) = self
            .entries
            .iter_mut()
            .find(|(existing, _)| existing == &key)
        {
            slot.1 = value;
        } else {
            self.entries.push((key, value));
        }
    }

    pub fn remove(&mut self, key: &str) -> Option<JsValue> {
        let needle = JsString::from_text(key);
        let index = self
            .entries
            .iter()
            .position(|(existing, _)| existing == &needle)?;
        Some(self.entries.remove(index).1)
    }

    pub fn get(&self, key: &str) -> Option<&JsValue> {
        let needle = JsString::from_text(key);
        self.entries
            .iter()
            .find(|(existing, _)| existing == &needle)
            .map(|(_, value)| value)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&JsString, &JsValue)> {
        self.entries.iter().map(|(key, value)| (key, value))
    }
}

#[derive(Clone, Debug)]
pub enum JsValue {
    Null,
    Bool(bool),
    Number(f64),
    String(JsString),
    Array(Vec<JsValue>),
    Object(JsObject),
}

impl PartialEq for JsValue {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Null, Self::Null) => true,
            (Self::Bool(left), Self::Bool(right)) => left == right,
            (Self::Number(left), Self::Number(right)) => {
                left == right || (left.is_nan() && right.is_nan())
            }
            (Self::String(left), Self::String(right)) => left == right,
            (Self::Array(left), Self::Array(right)) => left == right,
            (Self::Object(left), Self::Object(right)) => left == right,
            _ => false,
        }
    }
}

impl Eq for JsValue {}

impl JsValue {
    pub fn from_text(text: &str) -> Self {
        Self::String(JsString::from_text(text))
    }

    pub fn as_object(&self) -> Option<&JsObject> {
        match self {
            Self::Object(object) => Some(object),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[JsValue]> {
        match self {
            Self::Array(items) => Some(items),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(text) => Some(text.to_utf8()),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        let Self::Number(value) = self else {
            return None;
        };
        if !value.is_finite() || value.fract() != 0.0 {
            return None;
        }
        if *value < i64::MIN as f64 || *value >= 9223372036854775808.0 {
            return None;
        }
        Some(*value as i64)
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Self::Null)
    }

    pub fn is_string(&self) -> bool {
        matches!(self, Self::String(_))
    }

    pub fn is_boolean(&self) -> bool {
        matches!(self, Self::Bool(_))
    }

    pub fn get(&self, key: &str) -> Option<&JsValue> {
        self.as_object().and_then(|object| object.get(key))
    }

    pub fn as_object_mut(&mut self) -> Option<&mut JsObject> {
        match self {
            Self::Object(object) => Some(object),
            _ => None,
        }
    }

    pub fn as_js_string(&self) -> Option<&JsString> {
        match self {
            Self::String(text) => Some(text),
            _ => None,
        }
    }
}

pub fn from_serde(value: &Value) -> JsValue {
    match value {
        Value::Null => JsValue::Null,
        Value::Bool(value) => JsValue::Bool(*value),
        Value::Number(number) => JsValue::Number(number.as_f64().unwrap_or(0.0)),
        Value::String(text) => JsValue::String(JsString::from_text(text)),
        Value::Array(items) => JsValue::Array(items.iter().map(from_serde).collect()),
        Value::Object(map) => JsValue::Object(object_from_map(map)),
    }
}

fn object_from_map(map: &Map<String, Value>) -> JsObject {
    let mut object = JsObject::new();
    for (key, value) in map {
        object.insert(JsString::from_text(key), from_serde(value));
    }
    object
}

pub fn parse(text: &str) -> Result<JsValue, ParseError> {
    let mut parser = Parser {
        bytes: text.as_bytes(),
        index: 0,
        depth: 0,
    };
    parser.skip_ws();
    if parser.done() {
        return Err(ParseError { message: "empty" });
    }
    let value = parser.parse_value()?;
    parser.skip_ws();
    if !parser.done() {
        return Err(ParseError {
            message: "trailing",
        });
    }
    Ok(value)
}

struct Parser<'a> {
    bytes: &'a [u8],
    index: usize,
    depth: u32,
}

impl<'a> Parser<'a> {
    fn done(&self) -> bool {
        self.index >= self.bytes.len()
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.index).copied()
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.index += 1;
        }
    }

    fn parse_value(&mut self) -> Result<JsValue, ParseError> {
        self.depth += 1;
        if self.depth > 10_000 {
            return Err(ParseError { message: "depth" });
        }
        let value = self.parse_value_inner()?;
        self.depth -= 1;
        Ok(value)
    }

    fn parse_value_inner(&mut self) -> Result<JsValue, ParseError> {
        self.skip_ws();
        match self.peek() {
            Some(b'n') => self.literal(b"null", JsValue::Null),
            Some(b't') => self.literal(b"true", JsValue::Bool(true)),
            Some(b'f') => self.literal(b"false", JsValue::Bool(false)),
            Some(b'"') => Ok(JsValue::String(self.parse_string()?)),
            Some(b'[') => self.parse_array(),
            Some(b'{') => self.parse_object(),
            Some(b'-') | Some(b'0'..=b'9') => Ok(JsValue::Number(self.parse_number()?)),
            _ => Err(ParseError { message: "value" }),
        }
    }

    fn literal(&mut self, word: &[u8], value: JsValue) -> Result<JsValue, ParseError> {
        if self.bytes[self.index..].starts_with(word) {
            self.index += word.len();
            Ok(value)
        } else {
            Err(ParseError { message: "literal" })
        }
    }

    fn parse_array(&mut self) -> Result<JsValue, ParseError> {
        self.index += 1;
        self.skip_ws();
        let mut items = Vec::new();
        if self.peek() == Some(b']') {
            self.index += 1;
            return Ok(JsValue::Array(items));
        }
        loop {
            items.push(self.parse_value()?);
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.index += 1;
                    self.skip_ws();
                    if self.peek() == Some(b']') {
                        return Err(ParseError { message: "comma" });
                    }
                }
                Some(b']') => {
                    self.index += 1;
                    break;
                }
                _ => return Err(ParseError { message: "array" }),
            }
        }
        Ok(JsValue::Array(items))
    }

    fn parse_object(&mut self) -> Result<JsValue, ParseError> {
        self.index += 1;
        self.skip_ws();
        let mut object = JsObject::new();
        if self.peek() == Some(b'}') {
            self.index += 1;
            return Ok(JsValue::Object(object));
        }
        loop {
            self.skip_ws();
            if self.peek() != Some(b'"') {
                return Err(ParseError { message: "key" });
            }
            let key = self.parse_string()?;
            self.skip_ws();
            if self.peek() != Some(b':') {
                return Err(ParseError { message: "colon" });
            }
            self.index += 1;
            let value = self.parse_value()?;
            object.insert(key, value);
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.index += 1;
                    self.skip_ws();
                    if self.peek() == Some(b'}') {
                        return Err(ParseError { message: "comma" });
                    }
                }
                Some(b'}') => {
                    self.index += 1;
                    break;
                }
                _ => return Err(ParseError { message: "object" }),
            }
        }
        Ok(JsValue::Object(object))
    }

    fn parse_string(&mut self) -> Result<JsString, ParseError> {
        self.index += 1;
        let mut units = Vec::new();
        loop {
            let Some(byte) = self.peek() else {
                return Err(ParseError { message: "string" });
            };
            if byte == b'"' {
                self.index += 1;
                return Ok(JsString::from_units(units));
            }
            if byte == b'\\' {
                self.index += 1;
                self.push_escape(&mut units)?;
                continue;
            }
            if byte < 0x20 {
                return Err(ParseError { message: "control" });
            }
            let ch = self.bump_char()?;
            let mut encoded = [0u16; 2];
            let written = ch.encode_utf16(&mut encoded);
            units.extend_from_slice(written);
        }
    }

    fn bump_char(&mut self) -> Result<char, ParseError> {
        let rest = self
            .bytes
            .get(self.index..)
            .ok_or(ParseError { message: "utf8" })?;
        let text = std::str::from_utf8(rest).map_err(|_| ParseError { message: "utf8" })?;
        let ch = text.chars().next().ok_or(ParseError { message: "utf8" })?;
        self.index += ch.len_utf8();
        Ok(ch)
    }

    fn push_escape(&mut self, units: &mut Vec<u16>) -> Result<(), ParseError> {
        let Some(byte) = self.peek() else {
            return Err(ParseError { message: "escape" });
        };
        self.index += 1;
        let unit = match byte {
            b'"' => u16::from(b'"'),
            b'\\' => u16::from(b'\\'),
            b'/' => u16::from(b'/'),
            b'b' => 0x08,
            b'f' => 0x0C,
            b'n' => 0x0A,
            b'r' => 0x0D,
            b't' => 0x09,
            b'u' => self.hex4()?,
            _ => return Err(ParseError { message: "escape" }),
        };
        units.push(unit);
        Ok(())
    }

    fn hex4(&mut self) -> Result<u16, ParseError> {
        if self.index + 4 > self.bytes.len() {
            return Err(ParseError { message: "hex" });
        }
        let text = std::str::from_utf8(&self.bytes[self.index..self.index + 4])
            .map_err(|_| ParseError { message: "hex" })?;
        let value = u16::from_str_radix(text, 16).map_err(|_| ParseError { message: "hex" })?;
        self.index += 4;
        Ok(value)
    }

    fn parse_number(&mut self) -> Result<f64, ParseError> {
        let start = self.index;
        if self.peek() == Some(b'-') {
            self.index += 1;
        }
        match self.peek() {
            Some(b'0') => {
                self.index += 1;
                if matches!(self.peek(), Some(b'0'..=b'9')) {
                    return Err(ParseError { message: "number" });
                }
            }
            Some(b'1'..=b'9') => {
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.index += 1;
                }
            }
            _ => return Err(ParseError { message: "number" }),
        }
        if self.peek() == Some(b'.') {
            self.index += 1;
            let frac = self.index;
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.index += 1;
            }
            if self.index == frac {
                return Err(ParseError { message: "number" });
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.index += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.index += 1;
            }
            let exp = self.index;
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.index += 1;
            }
            if self.index == exp {
                return Err(ParseError { message: "number" });
            }
        }
        let literal = std::str::from_utf8(&self.bytes[start..self.index])
            .map_err(|_| ParseError { message: "number" })?;
        literal
            .parse::<f64>()
            .map_err(|_| ParseError { message: "number" })
    }
}

pub fn to_serde(value: &JsValue) -> Value {
    match value {
        JsValue::Null => Value::Null,
        JsValue::Bool(item) => Value::Bool(*item),
        JsValue::Number(number) => {
            if !number.is_finite() {
                return Value::Null;
            }
            let text = crate::js_number::json_number(*number);
            serde_json::from_str(&text).unwrap_or(Value::Null)
        }
        JsValue::String(text) => Value::String(text.to_utf8().to_string()),
        JsValue::Array(items) => Value::Array(items.iter().map(to_serde).collect()),
        JsValue::Object(object) => {
            let mut map = Map::new();
            for (key, child) in object.iter() {
                map.insert(key.to_utf8().to_string(), to_serde(child));
            }
            Value::Object(map)
        }
    }
}

pub fn stringify(value: &JsValue) -> String {
    let mut out = String::new();
    write_value(value, &mut out);
    out
}

fn write_value(value: &JsValue, out: &mut String) {
    match value {
        JsValue::Null => out.push_str("null"),
        JsValue::Bool(true) => out.push_str("true"),
        JsValue::Bool(false) => out.push_str("false"),
        JsValue::Number(number) => write_number(*number, out),
        JsValue::String(text) => write_units(&text.units, out),
        JsValue::Array(items) => write_array(items, out),
        JsValue::Object(object) => write_object(object, out),
    }
}

fn write_number(number: f64, out: &mut String) {
    if !number.is_finite() {
        out.push_str("null");
        return;
    }
    out.push_str(&crate::js_number::json_number(number));
}

fn write_array(items: &[JsValue], out: &mut String) {
    out.push('[');
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        write_value(item, out);
    }
    out.push(']');
}

fn write_object(object: &JsObject, out: &mut String) {
    out.push('{');
    let mut indexed = Vec::new();
    let mut rest = Vec::new();
    for (key, value) in object.iter() {
        if let Some(index) = array_index(key) {
            indexed.push((index, key, value));
        } else {
            rest.push((key, value));
        }
    }
    indexed.sort_by_key(|(index, _, _)| *index);
    let mut first = true;
    for (_, key, value) in indexed {
        write_entry(key, value, &mut first, out);
    }
    for (key, value) in rest {
        write_entry(key, value, &mut first, out);
    }
    out.push('}');
}

fn write_entry(key: &JsString, value: &JsValue, first: &mut bool, out: &mut String) {
    if !*first {
        out.push(',');
    }
    *first = false;
    write_units(&key.units, out);
    out.push(':');
    write_value(value, out);
}

fn array_index(key: &JsString) -> Option<u32> {
    if key.units.is_empty() || key.units.len() > 10 {
        return None;
    }
    if key.units.len() > 1 && key.units[0] == u16::from(b'0') {
        return None;
    }
    if !key
        .units
        .iter()
        .all(|unit| (u16::from(b'0')..=u16::from(b'9')).contains(unit))
    {
        return None;
    }
    let text = key.to_utf8();
    let value: u64 = text.parse().ok()?;
    if value > 4_294_967_294 {
        return None;
    }
    u32::try_from(value).ok()
}

fn write_units(units: &[u16], out: &mut String) {
    out.push('"');
    let mut index = 0;
    while index < units.len() {
        let unit = units[index];
        if (0xD800..=0xDBFF).contains(&unit)
            && units
                .get(index + 1)
                .is_some_and(|next| (0xDC00..=0xDFFF).contains(next))
        {
            let pair = [unit, units[index + 1]];
            if let Some(Ok(ch)) = char::decode_utf16(pair).next() {
                out.push(ch);
                index += 2;
                continue;
            }
        }
        append_code_unit(u32::from(unit), out);
        index += 1;
    }
    out.push('"');
}

fn append_code_unit(unit: u32, out: &mut String) {
    match unit {
        0x22 => out.push_str("\\\""),
        0x5C => out.push_str("\\\\"),
        0x08 => out.push_str("\\b"),
        0x0C => out.push_str("\\f"),
        0x0A => out.push_str("\\n"),
        0x0D => out.push_str("\\r"),
        0x09 => out.push_str("\\t"),
        0x00..=0x1F => {
            out.push_str("\\u00");
            push_hex(unit, out);
        }
        0xD800..=0xDFFF => {
            out.push_str("\\u");
            push_hex(unit >> 8, out);
            push_hex(unit, out);
        }
        _ => {
            if let Some(ch) = char::from_u32(unit) {
                out.push(ch);
            }
        }
    }
}

fn push_hex(unit: u32, out: &mut String) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push(char::from(HEX[((unit >> 4) & 0xF) as usize]));
    out.push(char::from(HEX[(unit & 0xF) as usize]));
}

#[cfg(test)]
mod code_units {
    use super::{JsString, JsValue, parse, stringify};

    #[test]
    fn lone_surrogates_escape() {
        let value = parse(r#""\ud800""#).unwrap();
        assert_eq!(stringify(&value), r#""\ud800""#);
        assert_eq!(value.as_str(), Some("\u{FFFD}"));
        let high = parse(r#""\udfff""#).unwrap();
        assert_eq!(stringify(&high), r#""\udfff""#);
        let JsValue::String(text) = value else {
            panic!("string");
        };
        assert_eq!(text.to_utf8(), "\u{FFFD}");
        let built = JsString::from_units(vec![0xD800]);
        assert_eq!(built.to_utf8(), "\u{FFFD}");
    }
}
