use serde::de::{DeserializeOwned, Deserializer};
use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrderedMap<T> {
    entries: Vec<(String, T)>,
}

impl<T> OrderedMap<T> {
    pub(crate) fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    pub(crate) fn insert(&mut self, key: String, value: T) {
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
        self.entries
            .iter()
            .find(|(existing, _)| existing == key)
            .map(|(_, value)| value)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &T)> {
        self.entries
            .iter()
            .map(|(key, value)| (key.as_str(), value))
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|(key, _)| key.as_str())
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
        let mut map = serializer.serialize_map(Some(self.entries.len()))?;
        for (key, value) in &self.entries {
            map.serialize_entry(key, value)?;
        }
        map.end()
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
        let map = Map::<String, Value>::deserialize(deserializer)?;
        let mut ordered = Self::new();
        for (key, value) in map {
            let parsed = serde_json::from_value(value).map_err(serde::de::Error::custom)?;
            ordered.insert(key, parsed);
        }
        Ok(ordered)
    }
}

fn canonical_index(key: &str) -> Option<u32> {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 10 {
        return None;
    }
    if bytes.len() > 1 && bytes[0] == b'0' {
        return None;
    }
    if !bytes.iter().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let value: u64 = key.parse().ok()?;
    if value > 4_294_967_294 {
        return None;
    }
    u32::try_from(value).ok()
}
