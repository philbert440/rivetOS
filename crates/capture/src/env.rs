pub use protocol::host::{Env, MapEnv, ProcessEnv};

pub fn trimmed(env: &dyn Env, key: &str) -> String {
    protocol::host::env_trimmed(env, key).unwrap_or_default()
}

pub fn present_non_empty(env: &dyn Env, key: &str) -> bool {
    match env.var(key) {
        None => false,
        Some(value) => !value.is_empty(),
    }
}
