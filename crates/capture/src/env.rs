use std::collections::HashMap;

pub use protocol::host::{Env, ProcessEnv};

#[derive(Clone, Debug, Default)]
pub struct MapEnv {
    inner: protocol::host::MapEnv,
}

impl MapEnv {
    pub fn new(values: HashMap<String, String>) -> Self {
        let mut inner = protocol::host::MapEnv::new();
        for (key, value) in values {
            inner.set(key, value);
        }
        Self { inner }
    }

    pub fn from_pairs(pairs: &[(&str, &str)]) -> Self {
        let mut inner = protocol::host::MapEnv::new();
        for (key, value) in pairs {
            inner.set(*key, *value);
        }
        Self { inner }
    }
}

impl Env for MapEnv {
    fn var(&self, name: &str) -> Option<String> {
        self.inner.var(name)
    }
}

pub fn trimmed(env: &dyn Env, key: &str) -> String {
    protocol::host::env_trimmed(env, key).unwrap_or_default()
}

pub fn present_non_empty(env: &dyn Env, key: &str) -> bool {
    match env.var(key) {
        None => false,
        Some(value) => !value.is_empty(),
    }
}
