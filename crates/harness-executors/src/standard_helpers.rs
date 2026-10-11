use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

pub trait Env: Send + Sync {
    fn get(&self, key: &str) -> Option<String>;
    fn pairs(&self) -> Vec<(String, String)>;
}

#[derive(Clone, Debug, Default)]
pub struct MapEnv {
    pairs: BTreeMap<String, String>,
}

impl MapEnv {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, key: impl Into<String>, value: impl Into<String>) {
        self.pairs.insert(key.into(), value.into());
    }

    pub fn from_pairs(
        pairs: impl IntoIterator<Item = (impl Into<String>, impl Into<String>)>,
    ) -> Self {
        let mut env = Self::new();
        for (key, value) in pairs {
            env.insert(key, value);
        }
        env
    }
}

impl Env for MapEnv {
    fn get(&self, key: &str) -> Option<String> {
        self.pairs.get(key).cloned()
    }

    fn pairs(&self) -> Vec<(String, String)> {
        self.pairs
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ProcessEnv;

impl Env for ProcessEnv {
    fn get(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }

    fn pairs(&self) -> Vec<(String, String)> {
        std::env::vars().collect()
    }
}

pub fn now_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => i64::try_from(duration.as_millis()).unwrap_or(i64::MAX),
        Err(_) => 0,
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub fn home_dir() -> std::path::PathBuf {
    match std::env::var("HOME") {
        Ok(home) if !home.is_empty() => std::path::PathBuf::from(home),
        _ => std::path::PathBuf::from("."),
    }
}

pub fn finite_f64(value: &serde_json::Value) -> Option<f64> {
    value.as_f64().filter(|number| number.is_finite())
}

pub fn num_value(value: Option<&serde_json::Value>) -> f64 {
    value.and_then(finite_f64).unwrap_or(0.0)
}

pub fn json_str(value: Option<&serde_json::Value>) -> Option<String> {
    value
        .and_then(serde_json::Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

pub fn object_str<'a>(
    object: &'a serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Option<&'a str> {
    object
        .get(key)
        .and_then(serde_json::Value::as_str)
        .filter(|text| !text.is_empty())
}
