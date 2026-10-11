use serde::de::{self, DeserializeOwned, Deserializer};
use serde::ser::Serializer;
use serde::{Deserialize, Serialize};

use protocol::js::{JsString, JsValue};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrderedMap<T> {
    entries: Vec<(JsString, T)>,
}

impl<T> OrderedMap<T> {
    pub(crate) fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    pub(crate) fn insert(&mut self, key: JsString, value: T) {
        if let Some((_, slot)) = self
            .entries
            .iter_mut()
            .find(|(existing, _)| existing == &key)
        {
            *slot = value;
            return;
        }
        let Some(index) = canonical_index(&key) else {
            self.entries.push((key, value));
            return;
        };
        let position = self
            .entries
            .iter()
            .position(|(existing, _)| match canonical_index(existing) {
                Some(existing_index) => existing_index > index,
                None => true,
            })
            .unwrap_or(self.entries.len());
        self.entries.insert(position, (key, value));
    }

    pub fn get(&self, key: &str) -> Option<&T> {
        let needle = JsString::from_text(key);
        self.get_key(&needle)
    }

    pub fn get_key(&self, key: &JsString) -> Option<&T> {
        self.entries
            .iter()
            .find(|(existing, _)| existing == key)
            .map(|(_, value)| value)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&JsString, &T)> {
        self.entries.iter().map(|(key, value)| (key, value))
    }

    pub fn keys(&self) -> impl Iterator<Item = &JsString> {
        self.entries.iter().map(|(key, _)| key)
    }

    pub fn values(&self) -> impl Iterator<Item = &T> {
        self.entries.iter().map(|(_, value)| value)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

impl<T: Serialize> Serialize for OrderedMap<T> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut body = String::from('{');
        for (index, (key, value)) in self.entries.iter().enumerate() {
            if index > 0 {
                body.push(',');
            }
            body.push_str(&protocol::js::stringify(&JsValue::String(key.clone())));
            body.push(':');
            body.push_str(&serde_json::to_string(value).map_err(serde::ser::Error::custom)?);
        }
        body.push('}');
        let raw =
            serde_json::value::RawValue::from_string(body).map_err(serde::ser::Error::custom)?;
        raw.serialize(serializer)
    }
}

impl<'de, T> Deserialize<'de> for OrderedMap<T>
where
    T: DeserializeOwned,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = Box::<serde_json::value::RawValue>::deserialize(deserializer)?;
        let value = protocol::js::parse(raw.get()).map_err(de::Error::custom)?;
        let object = value.as_object().ok_or_else(|| de::Error::custom("map"))?;
        let mut ordered = Self::new();
        for (key, item) in object.iter() {
            let json = protocol::js::stringify(item);
            let parsed = serde_json::from_str(&json).map_err(de::Error::custom)?;
            ordered.insert(key.clone(), parsed);
        }
        Ok(ordered)
    }
}

fn canonical_index(key: &JsString) -> Option<u32> {
    let units = key.units();
    if units.is_empty() || units.len() > 10 {
        return None;
    }
    if units.len() > 1 && units[0] == u16::from(b'0') {
        return None;
    }
    if !units
        .iter()
        .all(|unit| (u16::from(b'0')..=u16::from(b'9')).contains(unit))
    {
        return None;
    }
    let value: u64 = key.to_utf8().parse().ok()?;
    if value > 4_294_967_294 {
        return None;
    }
    u32::try_from(value).ok()
}
