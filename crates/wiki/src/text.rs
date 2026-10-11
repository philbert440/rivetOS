use serde::de::Deserializer;
use serde::{Deserialize, Serialize, Serializer};

#[derive(Clone, Debug)]
pub struct JsText {
    inner: protocol::js::JsString,
}

impl PartialEq for JsText {
    fn eq(&self, other: &Self) -> bool {
        self.inner.units() == other.inner.units()
    }
}

impl Eq for JsText {}

impl PartialEq<str> for JsText {
    fn eq(&self, other: &str) -> bool {
        self.inner.units() == other.encode_utf16().collect::<Vec<_>>()
    }
}

impl PartialEq<&str> for JsText {
    fn eq(&self, other: &&str) -> bool {
        *self == **other
    }
}

impl PartialEq<String> for JsText {
    fn eq(&self, other: &String) -> bool {
        self == other.as_str()
    }
}

impl From<&str> for JsText {
    fn from(text: &str) -> Self {
        Self {
            inner: protocol::js::JsString::from_text(text),
        }
    }
}

impl From<String> for JsText {
    fn from(text: String) -> Self {
        Self::from(text.as_str())
    }
}

impl From<&protocol::js::JsString> for JsText {
    fn from(text: &protocol::js::JsString) -> Self {
        Self {
            inner: text.clone(),
        }
    }
}

impl std::fmt::Display for JsText {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.utf8())
    }
}

impl std::ops::Deref for JsText {
    type Target = str;

    fn deref(&self) -> &str {
        self.utf8()
    }
}

impl Serialize for JsText {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.inner.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for JsText {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let inner = protocol::js::JsString::deserialize(deserializer)?;
        Ok(Self { inner })
    }
}

impl JsText {
    pub fn from_units(units: Vec<u16>) -> Self {
        Self {
            inner: protocol::js::JsString::from_units(units),
        }
    }

    pub fn as_js_string(&self) -> &protocol::js::JsString {
        &self.inner
    }

    pub fn units(&self) -> &[u16] {
        self.inner.units()
    }

    pub fn len(&self) -> usize {
        self.inner.len()
    }

    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }

    pub fn utf8(&self) -> &str {
        self.inner.to_utf8()
    }

    pub fn trimmed(&self) -> Self {
        Self::from_units(protocol::js::js_trim_units(self.units()).to_vec())
    }

    pub fn trimmed_end(&self) -> Self {
        Self::from_units(protocol::js::js_trim_end_units(self.units()).to_vec())
    }

    pub fn slice(&self, start: usize, end: Option<usize>) -> Self {
        let end = end.map(|value| value as f64);
        Self::from_units(protocol::js::js_slice_units(
            self.units(),
            Some(start as f64),
            end,
        ))
    }

    pub fn last_index_of(&self, needle: &str, from: usize) -> Option<usize> {
        last_index_units(
            self.units(),
            &needle.encode_utf16().collect::<Vec<_>>(),
            from,
        )
    }

    pub fn concat(parts: &[JsText]) -> JsText {
        let mut units = Vec::new();
        for part in parts {
            units.extend_from_slice(part.units());
        }
        Self::from_units(units)
    }

    pub fn join(parts: &[JsText], separator: &str) -> JsText {
        let sep: Vec<u16> = separator.encode_utf16().collect();
        let mut units = Vec::new();
        for (index, part) in parts.iter().enumerate() {
            if index > 0 {
                units.extend_from_slice(&sep);
            }
            units.extend_from_slice(part.units());
        }
        Self::from_units(units)
    }
}

pub(crate) fn demote_h2(text: &JsText) -> JsText {
    let mut in_fence = false;
    let mut lines = Vec::new();
    for line in split_lines(text.units()) {
        let trimmed = protocol::js::js_trim_units(line);
        if units_start(trimmed, "```") {
            in_fence = !in_fence;
        }
        if !in_fence && bare_h2(line) {
            let mut next = Vec::with_capacity(line.len() + 1);
            next.push(u16::from(b'#'));
            next.extend_from_slice(line);
            lines.push(next);
        } else {
            lines.push(line.to_vec());
        }
    }
    JsText::from_units(join_lines(&lines))
}

fn bare_h2(line: &[u16]) -> bool {
    if !units_start(line, "## ") {
        return false;
    }
    line.get(3).is_none_or(|unit| *unit != u16::from(b'#'))
}

fn units_start(units: &[u16], prefix: &str) -> bool {
    let prefix: Vec<u16> = prefix.encode_utf16().collect();
    units.starts_with(&prefix)
}

fn split_lines(units: &[u16]) -> Vec<&[u16]> {
    let mut lines = Vec::new();
    let mut start = 0usize;
    for (index, unit) in units.iter().enumerate() {
        if *unit == u16::from(b'\n') {
            lines.push(&units[start..index]);
            start = index + 1;
        }
    }
    lines.push(&units[start..]);
    lines
}

fn join_lines(lines: &[Vec<u16>]) -> Vec<u16> {
    let mut out = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if index > 0 {
            out.push(u16::from(b'\n'));
        }
        out.extend_from_slice(line);
    }
    out
}

fn last_index_units(hay: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() {
        return Some(from.min(hay.len()));
    }
    if needle.len() > hay.len() {
        return None;
    }
    let last = from.min(hay.len().saturating_sub(needle.len()));
    let mut index = last;
    loop {
        if hay[index..index + needle.len()] == needle[..] {
            return Some(index);
        }
        if index == 0 {
            return None;
        }
        index -= 1;
    }
}

pub(crate) fn fmt_count(n: usize) -> String {
    protocol::js::number_to_locale_string_en_us(n as f64)
}

pub(crate) fn fmt_kb(chars: usize) -> String {
    match protocol::js::to_fixed(chars as f64 / 1024.0, 1.0) {
        Ok(text) => text,
        Err(_) => "0.0".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::{JsText, fmt_count, fmt_kb};
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Golden {
        utf16: Utf16Golden,
        trim: Vec<TrimCase>,
        to_fixed: Vec<FixedCase>,
        iso: Vec<IsoCase>,
        number_locale: Vec<LocaleCase>,
        locale_compare: LocaleCompare,
    }

    #[derive(Deserialize)]
    struct Utf16Golden {
        length: Vec<LengthCase>,
        slice: Vec<SliceCase>,
    }

    #[derive(Deserialize)]
    struct LengthCase {
        text: Vec<u16>,
        length: usize,
    }

    #[derive(Deserialize)]
    struct SliceCase {
        text: Vec<u16>,
        start: Option<f64>,
        start_undefined: bool,
        end: Option<f64>,
        end_undefined: bool,
        result: Vec<u16>,
    }

    #[derive(Deserialize)]
    struct TrimCase {
        text: Vec<u16>,
        trim: Vec<u16>,
        trim_end: Vec<u16>,
    }

    #[derive(Deserialize)]
    struct FixedCase {
        value: serde_json::Value,
        #[serde(default)]
        neg_zero: bool,
        digits: f64,
        #[serde(default)]
        result: Option<String>,
        #[serde(default)]
        error: Option<String>,
    }

    #[derive(Deserialize)]
    struct IsoCase {
        ms: serde_json::Value,
        #[serde(default)]
        day: Option<String>,
        #[serde(default)]
        error: Option<String>,
    }

    #[derive(Deserialize)]
    struct LocaleCase {
        value: serde_json::Value,
        neg_zero: bool,
        en_us: String,
    }

    #[derive(Deserialize)]
    struct LocaleCompare {
        pairs: Vec<PairCase>,
    }

    #[derive(Deserialize)]
    struct PairCase {
        a: String,
        b: String,
        sign: i32,
    }

    fn golden() -> Golden {
        serde_json::from_str(include_str!("../tests/golden/js-semantics.json")).expect("golden")
    }

    fn signed_number(value: &serde_json::Value, neg_zero: bool) -> f64 {
        let number = match value.as_f64() {
            Some(number) => number,
            None => match value.as_str() {
                Some("NaN") => f64::NAN,
                Some("Infinity") => f64::INFINITY,
                Some("-Infinity") => f64::NEG_INFINITY,
                Some(text) => text.parse::<f64>().unwrap_or(f64::NAN),
                None => f64::NAN,
            },
        };
        if neg_zero { -number } else { number }
    }

    #[test]
    fn utf16_length_slice_and_trim_match_node() {
        let golden = golden();
        for case in &golden.utf16.length {
            assert_eq!(JsText::from_units(case.text.clone()).len(), case.length);
        }
        for case in &golden.utf16.slice {
            let start = if case.start_undefined {
                None
            } else {
                case.start
            };
            let end = if case.end_undefined { None } else { case.end };
            let sliced = protocol::js::js_slice_units(&case.text, start, end);
            assert_eq!(sliced, case.result);
        }
        for case in &golden.trim {
            let text = JsText::from_units(case.text.clone());
            assert_eq!(text.trimmed().units(), case.trim.as_slice());
            assert_eq!(text.trimmed_end().units(), case.trim_end.as_slice());
            if let Ok(text) = String::from_utf16(&case.text) {
                assert_eq!(
                    protocol::js::js_trim(&text)
                        .encode_utf16()
                        .collect::<Vec<_>>(),
                    case.trim
                );
                assert_eq!(
                    protocol::js::js_trim_end(&text)
                        .encode_utf16()
                        .collect::<Vec<_>>(),
                    case.trim_end
                );
            }
        }
    }

    #[test]
    fn counts_kilobytes_and_utc_days_match_node() {
        let golden = golden();
        for case in &golden.number_locale {
            let value = signed_number(&case.value, case.neg_zero);
            assert_eq!(
                protocol::js::number_to_locale_string_en_us(value),
                case.en_us
            );
            if !case.neg_zero
                && let Some(value) = case.value.as_f64()
                && value >= 0.0
                && value.fract() == 0.0
                && value <= usize::MAX as f64
            {
                assert_eq!(fmt_count(value as usize), case.en_us);
            }
        }
        for case in &golden.to_fixed {
            let value = signed_number(&case.value, case.neg_zero);
            match protocol::js::to_fixed(value, case.digits) {
                Ok(text) => assert_eq!(Some(text), case.result),
                Err(err) => assert_eq!(Some(err.to_string()), case.error),
            }
        }
        assert_eq!(fmt_kb(0), "0.0");
        assert_eq!(fmt_kb(1024), "1.0");
        assert_eq!(fmt_kb(1536), "1.5");
        let one = golden
            .to_fixed
            .iter()
            .find(|case| !case.neg_zero && case.value.as_f64() == Some(1.0) && case.digits == 1.0)
            .expect("1.0");
        assert_eq!(fmt_kb(1024), one.result.as_deref().expect("result"));
        for case in &golden.iso {
            let ms = match case.ms.as_f64() {
                Some(ms) => ms,
                None => match case.ms.as_str() {
                    Some("NaN") => f64::NAN,
                    Some(text) => text.parse::<f64>().unwrap_or(f64::NAN),
                    None => f64::NAN,
                },
            };
            match protocol::js::utc_day(ms) {
                Ok(day) => assert_eq!(Some(day), case.day),
                Err(err) => assert_eq!(Some(err.to_string()), case.error),
            }
        }
    }

    #[test]
    fn locale_compare_pairs_match_node() {
        let golden = golden();
        for case in &golden.locale_compare.pairs {
            let sign = protocol::js::locale_compare(&case.a, &case.b).expect("collator");
            assert_eq!(
                sign.signum(),
                case.sign.signum(),
                "{} vs {}",
                case.a,
                case.b
            );
        }
    }

    #[test]
    fn slice_keeps_an_unpaired_surrogate_until_json() {
        let text = JsText::from(format!("{}😀", "a".repeat(3)));
        let kept = text.slice(0, Some(4));
        let rest = text.slice(4, None);
        assert_eq!(
            kept.units(),
            &[b'a' as u16, b'a' as u16, b'a' as u16, 0xD83D]
        );
        assert_eq!(rest.units(), &[0xDE00]);
        let json = serde_json::to_string(&kept).expect("json");
        assert!(json.contains("\\ud83d"), "{json}");
        assert!(!json.contains("\\ufffd"), "{json}");
    }
}
