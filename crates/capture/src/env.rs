use std::collections::HashMap;
use std::sync::Arc;

pub trait EnvLookup: Send + Sync {
    fn get(&self, key: &str) -> Option<String>;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct ProcessEnv;

impl EnvLookup for ProcessEnv {
    fn get(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }
}

#[derive(Debug, Clone, Default)]
pub struct MapEnv {
    values: HashMap<String, String>,
}

impl MapEnv {
    pub fn new(values: HashMap<String, String>) -> Self {
        Self { values }
    }

    pub fn from_pairs(pairs: &[(&str, &str)]) -> Self {
        let values = pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect();
        Self { values }
    }
}

impl EnvLookup for MapEnv {
    fn get(&self, key: &str) -> Option<String> {
        self.values.get(key).cloned()
    }
}

impl EnvLookup for Arc<dyn EnvLookup> {
    fn get(&self, key: &str) -> Option<String> {
        (**self).get(key)
    }
}

pub fn trimmed(env: &dyn EnvLookup, key: &str) -> String {
    env.get(key)
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

pub fn present_non_empty(env: &dyn EnvLookup, key: &str) -> bool {
    match env.get(key) {
        None => false,
        Some(value) => !value.is_empty(),
    }
}
