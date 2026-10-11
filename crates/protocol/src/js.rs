use std::collections::HashMap;

use serde::de::Deserializer;
use serde::{Deserialize, Serialize, Serializer};
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

    fn from_units(units: Vec<u16>) -> Self {
        let utf8 = utf8_from_units(&units);
        Self { units, utf8 }
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

#[derive(Debug, Default)]
pub struct JsObject {
    entries: Vec<(JsString, JsValue)>,
    lookup: HashMap<Vec<u16>, usize>,
}

impl PartialEq for JsObject {
    fn eq(&self, other: &Self) -> bool {
        if self.entries.len() != other.entries.len() {
            return false;
        }
        self.entries.iter().all(|(key, value)| {
            other
                .lookup
                .get(&key.units)
                .and_then(|index| other.entries.get(*index))
                .is_some_and(|(_, other_value)| value == other_value)
        })
    }
}

impl Eq for JsObject {}

impl Clone for JsObject {
    fn clone(&self) -> Self {
        let mut object = JsObject::new();
        for (key, value) in &self.entries {
            object.insert_key(key.clone(), value.clone());
        }
        object
    }
}

impl JsObject {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, key: &str, value: JsValue) {
        self.insert_key(JsString::from_text(key), value);
    }

    fn insert_key(&mut self, key: JsString, value: JsValue) {
        if let Some(index) = self.lookup.get(&key.units).copied() {
            if let Some(slot) = self.entries.get_mut(index) {
                slot.1 = value;
            }
            return;
        }
        let index = self.entries.len();
        self.lookup.insert(key.units.clone(), index);
        self.entries.push((key, value));
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn get(&self, key: &str) -> Option<&JsValue> {
        let needle = JsString::from_text(key);
        let index = *self.lookup.get(&needle.units)?;
        self.entries.get(index).map(|(_, value)| value)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&JsString, &JsValue)> {
        self.entries.iter().map(|(key, value)| (key, value))
    }
}

#[derive(Debug)]
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

    pub(crate) fn into_object(mut self) -> Option<JsObject> {
        match &mut self {
            Self::Object(object) => Some(std::mem::replace(object, JsObject::new())),
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
        object.insert_key(JsString::from_text(key), from_serde(value));
    }
    object
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParseCost {
    pub bytes: u64,
    pub lookups: u64,
}

pub fn parse(text: &str) -> Result<JsValue, ParseError> {
    parse_with_cost(text).map(|(value, _)| value)
}

pub fn parse_cost(text: &str) -> Result<(JsValue, ParseCost), ParseError> {
    parse_with_cost(text)
}

fn parse_with_cost(text: &str) -> Result<(JsValue, ParseCost), ParseError> {
    let mut parser = Parser {
        text,
        index: 0,
        stack: Vec::new(),
        bytes: 0,
        lookups: 0,
    };
    parser.skip_ws();
    if parser.done() {
        return Err(ParseError { message: "empty" });
    }
    let mut state = ParseState::Need;
    loop {
        state = match state {
            ParseState::Need => parser.start_value()?,
            ParseState::Have(value) => {
                if parser.stack.is_empty() {
                    parser.skip_ws();
                    if !parser.done() {
                        return Err(ParseError {
                            message: "trailing",
                        });
                    }
                    let cost = ParseCost {
                        bytes: parser.bytes,
                        lookups: parser.lookups,
                    };
                    return Ok((value, cost));
                }
                parser.adopt(value)?
            }
        };
    }
}

enum ParseState {
    Need,
    Have(JsValue),
}

enum Frame {
    Array(Vec<JsValue>),
    Object(Box<ObjectFrame>),
}

struct ObjectFrame {
    object: JsObject,
    key: Option<JsString>,
}

struct Parser<'a> {
    text: &'a str,
    index: usize,
    stack: Vec<Frame>,
    bytes: u64,
    lookups: u64,
}

impl<'a> Parser<'a> {
    fn done(&self) -> bool {
        self.index >= self.text.len()
    }

    fn peek(&self) -> Option<u8> {
        self.text.as_bytes().get(self.index).copied()
    }

    fn advance(&mut self, count: usize) {
        self.index += count;
        self.bytes = self.bytes.saturating_add(count as u64);
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.advance(1);
        }
    }

    fn start_value(&mut self) -> Result<ParseState, ParseError> {
        self.skip_ws();
        match self.peek() {
            Some(b'n') => Ok(ParseState::Have(self.literal("null", JsValue::Null)?)),
            Some(b't') => Ok(ParseState::Have(self.literal("true", JsValue::Bool(true))?)),
            Some(b'f') => Ok(ParseState::Have(
                self.literal("false", JsValue::Bool(false))?,
            )),
            Some(b'"') => Ok(ParseState::Have(JsValue::String(self.parse_string()?))),
            Some(b'[') => self.open_array(),
            Some(b'{') => self.open_object(),
            Some(b'-') | Some(b'0'..=b'9') => {
                Ok(ParseState::Have(JsValue::Number(self.parse_number()?)))
            }
            _ => Err(ParseError { message: "value" }),
        }
    }

    fn open_array(&mut self) -> Result<ParseState, ParseError> {
        self.advance(1);
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.advance(1);
            return Ok(ParseState::Have(JsValue::Array(Vec::new())));
        }
        self.stack.push(Frame::Array(Vec::new()));
        Ok(ParseState::Need)
    }

    fn open_object(&mut self) -> Result<ParseState, ParseError> {
        self.advance(1);
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.advance(1);
            return Ok(ParseState::Have(JsValue::Object(JsObject::new())));
        }
        let key = self.parse_key()?;
        self.stack.push(Frame::Object(Box::new(ObjectFrame {
            object: JsObject::new(),
            key: Some(key),
        })));
        Ok(ParseState::Need)
    }

    fn parse_key(&mut self) -> Result<JsString, ParseError> {
        self.skip_ws();
        if self.peek() != Some(b'"') {
            return Err(ParseError { message: "key" });
        }
        let key = self.parse_string()?;
        self.skip_ws();
        if self.peek() != Some(b':') {
            return Err(ParseError { message: "colon" });
        }
        self.advance(1);
        Ok(key)
    }

    fn adopt(&mut self, value: JsValue) -> Result<ParseState, ParseError> {
        let inserted = matches!(self.stack.last(), Some(Frame::Object(_)));
        match self.stack.last_mut() {
            Some(Frame::Array(items)) => items.push(value),
            Some(Frame::Object(frame)) => {
                let Some(key) = frame.key.take() else {
                    return Err(ParseError { message: "key" });
                };
                frame.object.insert_key(key, value);
            }
            None => return Err(ParseError { message: "value" }),
        }
        if inserted {
            self.lookups = self.lookups.saturating_add(1);
        }
        self.skip_ws();
        let closing = match self.stack.last() {
            Some(Frame::Array(_)) => b']',
            Some(Frame::Object(_)) => b'}',
            None => return Err(ParseError { message: "value" }),
        };
        match self.peek() {
            Some(b',') => {
                self.advance(1);
                self.skip_ws();
                if self.peek() == Some(closing) {
                    return Err(ParseError { message: "comma" });
                }
                if matches!(self.stack.last(), Some(Frame::Object(_))) {
                    let key = self.parse_key()?;
                    if let Some(Frame::Object(frame)) = self.stack.last_mut() {
                        frame.key = Some(key);
                    }
                }
                Ok(ParseState::Need)
            }
            Some(byte) if byte == closing => {
                self.advance(1);
                match self.stack.pop() {
                    Some(Frame::Array(items)) => Ok(ParseState::Have(JsValue::Array(items))),
                    Some(Frame::Object(frame)) => {
                        Ok(ParseState::Have(JsValue::Object(frame.object)))
                    }
                    None => Err(ParseError { message: "value" }),
                }
            }
            _ => Err(ParseError {
                message: if closing == b']' { "array" } else { "object" },
            }),
        }
    }

    fn literal(&mut self, word: &str, value: JsValue) -> Result<JsValue, ParseError> {
        let Some(rest) = self.text.get(self.index..) else {
            return Err(ParseError { message: "literal" });
        };
        if rest.starts_with(word) {
            self.advance(word.len());
            Ok(value)
        } else {
            Err(ParseError { message: "literal" })
        }
    }

    fn parse_string(&mut self) -> Result<JsString, ParseError> {
        self.advance(1);
        let mut units = Vec::new();
        loop {
            let Some(byte) = self.peek() else {
                return Err(ParseError { message: "string" });
            };
            if byte == b'"' {
                self.advance(1);
                return Ok(JsString::from_units(units));
            }
            if byte == b'\\' {
                self.advance(1);
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
            .text
            .get(self.index..)
            .ok_or(ParseError { message: "utf8" })?;
        let ch = rest.chars().next().ok_or(ParseError { message: "utf8" })?;
        self.advance(ch.len_utf8());
        Ok(ch)
    }

    fn push_escape(&mut self, units: &mut Vec<u16>) -> Result<(), ParseError> {
        let Some(byte) = self.peek() else {
            return Err(ParseError { message: "escape" });
        };
        self.advance(1);
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
        let bytes = self.text.as_bytes();
        if self.index + 4 > bytes.len() {
            return Err(ParseError { message: "hex" });
        }
        let digits = &bytes[self.index..self.index + 4];
        if !digits.iter().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(ParseError { message: "hex" });
        }
        let text = self
            .text
            .get(self.index..self.index + 4)
            .ok_or(ParseError { message: "hex" })?;
        let value = u16::from_str_radix(text, 16).map_err(|_| ParseError { message: "hex" })?;
        self.advance(4);
        Ok(value)
    }

    fn parse_number(&mut self) -> Result<f64, ParseError> {
        let start = self.index;
        if self.peek() == Some(b'-') {
            self.advance(1);
        }
        match self.peek() {
            Some(b'0') => {
                self.advance(1);
                if matches!(self.peek(), Some(b'0'..=b'9')) {
                    return Err(ParseError { message: "number" });
                }
            }
            Some(b'1'..=b'9') => {
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.advance(1);
                }
            }
            _ => return Err(ParseError { message: "number" }),
        }
        if self.peek() == Some(b'.') {
            self.advance(1);
            let frac = self.index;
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.advance(1);
            }
            if self.index == frac {
                return Err(ParseError { message: "number" });
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.advance(1);
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.advance(1);
            }
            let exp = self.index;
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.advance(1);
            }
            if self.index == exp {
                return Err(ParseError { message: "number" });
            }
        }
        let literal = self
            .text
            .get(start..self.index)
            .ok_or(ParseError { message: "number" })?;
        literal
            .parse::<f64>()
            .map_err(|_| ParseError { message: "number" })
    }
}

pub fn stringify(value: &JsValue) -> String {
    let mut out = String::new();
    let mut jobs = vec![WriteJob::Value(value)];
    write_jobs(&mut out, &mut jobs);
    out
}

pub fn stringify_object(object: &JsObject) -> String {
    let mut out = String::from("{");
    if object.is_empty() {
        out.push('}');
        return out;
    }
    let mut jobs = vec![WriteJob::Object {
        pairs: ordered_pairs(object),
        next: 0,
    }];
    write_jobs(&mut out, &mut jobs);
    out
}

fn write_jobs<'a>(out: &mut String, jobs: &mut Vec<WriteJob<'a>>) {
    while let Some(job) = jobs.pop() {
        match job {
            WriteJob::Value(current) => write_opened(current, out, jobs),
            WriteJob::Array { items, next } => {
                if next >= items.len() {
                    out.push(']');
                    continue;
                }
                if next > 0 {
                    out.push(',');
                }
                let child = &items[next];
                jobs.push(WriteJob::Array {
                    items,
                    next: next + 1,
                });
                jobs.push(WriteJob::Value(child));
            }
            WriteJob::Object { pairs, next } => {
                if next >= pairs.len() {
                    out.push('}');
                    continue;
                }
                if next > 0 {
                    out.push(',');
                }
                let (key, child) = pairs[next];
                write_units(&key.units, out);
                out.push(':');
                jobs.push(WriteJob::Object {
                    pairs,
                    next: next + 1,
                });
                jobs.push(WriteJob::Value(child));
            }
        }
    }
}

impl Serialize for JsObject {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let text = stringify_object(self);
        match serde_json::value::RawValue::from_string(text) {
            Ok(raw) => raw.serialize(serializer),
            Err(err) => Err(serde::ser::Error::custom(err)),
        }
    }
}

impl<'de> Deserialize<'de> for JsObject {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = Box::<serde_json::value::RawValue>::deserialize(deserializer)?;
        match object_from_json(raw.get()) {
            Ok(object) => Ok(object),
            Err(err) => Err(serde::de::Error::custom(err)),
        }
    }
}

fn object_from_json(text: &str) -> Result<JsObject, ParseError> {
    let value = parse(text)?;
    match value.into_object() {
        Some(object) => Ok(object),
        None => Err(ParseError { message: "object" }),
    }
}

enum WriteJob<'a> {
    Value(&'a JsValue),
    Array {
        items: &'a [JsValue],
        next: usize,
    },
    Object {
        pairs: Vec<(&'a JsString, &'a JsValue)>,
        next: usize,
    },
}

fn write_opened<'a>(value: &'a JsValue, out: &mut String, jobs: &mut Vec<WriteJob<'a>>) {
    match value {
        JsValue::Null => out.push_str("null"),
        JsValue::Bool(true) => out.push_str("true"),
        JsValue::Bool(false) => out.push_str("false"),
        JsValue::Number(number) => write_number(*number, out),
        JsValue::String(text) => write_units(&text.units, out),
        JsValue::Array(items) => {
            out.push('[');
            if items.is_empty() {
                out.push(']');
            } else {
                jobs.push(WriteJob::Array { items, next: 0 });
            }
        }
        JsValue::Object(object) => {
            out.push('{');
            if object.entries.is_empty() {
                out.push('}');
            } else {
                jobs.push(WriteJob::Object {
                    pairs: ordered_pairs(object),
                    next: 0,
                });
            }
        }
    }
}

fn ordered_pairs(object: &JsObject) -> Vec<(&JsString, &JsValue)> {
    let mut indexed = Vec::new();
    let mut rest = Vec::new();
    for (key, value) in &object.entries {
        if let Some(index) = array_index(key) {
            indexed.push((index, key, value));
        } else {
            rest.push((key, value));
        }
    }
    indexed.sort_by_key(|(index, _, _)| *index);
    let mut pairs = Vec::with_capacity(indexed.len() + rest.len());
    for (_, key, value) in indexed {
        pairs.push((key, value));
    }
    pairs.extend(rest);
    pairs
}

fn write_number(number: f64, out: &mut String) {
    if !number.is_finite() {
        out.push_str("null");
        return;
    }
    out.push_str(&crate::js_number::json_number(number));
}

impl Clone for JsValue {
    fn clone(&self) -> Self {
        clone_value(self)
    }
}

impl Drop for JsValue {
    fn drop(&mut self) {
        let mut stack = Vec::new();
        take_children(self, &mut stack);
        while let Some(mut child) = stack.pop() {
            take_children(&mut child, &mut stack);
        }
    }
}

fn take_children(value: &mut JsValue, stack: &mut Vec<JsValue>) {
    match value {
        JsValue::Array(items) => stack.append(items),
        JsValue::Object(object) => {
            object.lookup.clear();
            for (_, child) in object.entries.drain(..) {
                stack.push(child);
            }
        }
        JsValue::Null | JsValue::Bool(_) | JsValue::Number(_) | JsValue::String(_) => {}
    }
}

enum Walk<'a> {
    Enter(&'a JsValue),
    Leave(&'a JsValue),
}

enum Flat {
    Leaf(JsValue),
    Array(usize),
    Object(Vec<JsString>),
}

fn clone_value(root: &JsValue) -> JsValue {
    let mut flat = Vec::new();
    let mut walk = vec![Walk::Enter(root)];
    while let Some(step) = walk.pop() {
        match step {
            Walk::Enter(value) => match value {
                JsValue::Array(items) => {
                    walk.push(Walk::Leave(value));
                    for item in items.iter().rev() {
                        walk.push(Walk::Enter(item));
                    }
                }
                JsValue::Object(object) => {
                    walk.push(Walk::Leave(value));
                    for (_, child) in object.entries.iter().rev() {
                        walk.push(Walk::Enter(child));
                    }
                }
                JsValue::Null => flat.push(Flat::Leaf(JsValue::Null)),
                JsValue::Bool(flag) => flat.push(Flat::Leaf(JsValue::Bool(*flag))),
                JsValue::Number(number) => flat.push(Flat::Leaf(JsValue::Number(*number))),
                JsValue::String(text) => flat.push(Flat::Leaf(JsValue::String(text.clone()))),
            },
            Walk::Leave(JsValue::Array(items)) => flat.push(Flat::Array(items.len())),
            Walk::Leave(JsValue::Object(object)) => {
                let keys = object.entries.iter().map(|(key, _)| key.clone()).collect();
                flat.push(Flat::Object(keys));
            }
            Walk::Leave(_) => {}
        }
    }
    let mut built = Vec::new();
    for item in flat {
        match item {
            Flat::Leaf(value) => built.push(value),
            Flat::Array(count) => {
                let start = built.len().saturating_sub(count);
                let items = built.split_off(start);
                built.push(JsValue::Array(items));
            }
            Flat::Object(keys) => {
                let start = built.len().saturating_sub(keys.len());
                let values = built.split_off(start);
                let mut object = JsObject::new();
                for (key, value) in keys.into_iter().zip(values) {
                    object.insert_key(key, value);
                }
                built.push(JsValue::Object(object));
            }
        }
    }
    match built.pop() {
        Some(value) => value,
        None => JsValue::Null,
    }
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
    use super::{JsString, parse, stringify};

    #[test]
    fn lone_surrogates_escape() {
        let value = parse(r#""\ud800""#).unwrap();
        assert_eq!(stringify(&value), r#""\ud800""#);
        assert_eq!(value.as_str(), Some("\u{FFFD}"));
        let high = parse(r#""\udfff""#).unwrap();
        assert_eq!(stringify(&high), r#""\udfff""#);
        let built = JsString::from_units(vec![0xD800]);
        assert_eq!(built.to_utf8(), "\u{FFFD}");
    }
}
