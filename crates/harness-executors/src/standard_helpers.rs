use std::collections::BTreeMap;

use protocol::host::Env as HostEnv;

pub trait Env: Send + Sync {
    fn var(&self, name: &str) -> Option<String>;
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
    fn var(&self, name: &str) -> Option<String> {
        self.pairs.get(name).cloned()
    }

    fn pairs(&self) -> Vec<(String, String)> {
        self.pairs
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect()
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ProcessEnv;

impl Env for ProcessEnv {
    fn var(&self, name: &str) -> Option<String> {
        protocol::host::ProcessEnv.var(name)
    }

    fn pairs(&self) -> Vec<(String, String)> {
        std::env::vars().collect()
    }
}

struct EnvLookup<'a>(&'a dyn Env);

impl protocol::host::Env for EnvLookup<'_> {
    fn var(&self, name: &str) -> Option<String> {
        self.0.var(name)
    }
}

pub fn clock_ms() -> i64 {
    protocol::js::date_now() as i64
}

pub fn home_path(env: &dyn Env) -> std::path::PathBuf {
    match protocol::host::home_dir(&EnvLookup(env)) {
        Some(home) => std::path::PathBuf::from(home),
        None => std::path::PathBuf::from("."),
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
