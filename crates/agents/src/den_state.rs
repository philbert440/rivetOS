use protocol::host::{Env, ProcessEnv, home_dir};
use protocol::js::{posix_is_absolute, posix_join};

pub fn den_state_dir() -> String {
    den_state_dir_in(&ProcessEnv)
}

pub fn den_state_dir_in(env: &dyn Env) -> String {
    match env.var("RIVETOS_DEN_STATE_DIR") {
        Some(value) => value,
        None => den_under_home(env),
    }
}

pub fn den_state_dir_from(value: Option<&str>) -> String {
    match value {
        Some(value) => value.to_string(),
        None => den_under_home(&ProcessEnv),
    }
}

fn den_under_home(env: &dyn Env) -> String {
    let Some(home) = home_dir(env).filter(|home| !home.is_empty()) else {
        return String::new();
    };
    let joined = posix_join(&[&home, ".rivetos", "den"]);
    if posix_is_absolute(&joined) {
        joined
    } else {
        String::new()
    }
}

pub fn agents_json_file() -> String {
    posix_join(&[&den_state_dir(), "agents.json"])
}

pub fn agents_json_file_in(state_dir: &str) -> String {
    posix_join(&[state_dir, "agents.json"])
}

#[cfg(test)]
mod tests {
    use protocol::host::MapEnv;

    use super::{den_state_dir_in, den_under_home};

    #[test]
    fn blank_override_is_kept_and_missing_home_is_not_relative() {
        let mut env = MapEnv::new();
        env.set("RIVETOS_DEN_STATE_DIR", "");
        assert_eq!(den_state_dir_in(&env), "");
        env.set("RIVETOS_DEN_STATE_DIR", "/tmp/den-state");
        assert_eq!(den_state_dir_in(&env), "/tmp/den-state");
        let mut home = MapEnv::new();
        home.set("HOME", "/home/example");
        assert_eq!(den_under_home(&home), "/home/example/.rivetos/den");
        let mut empty = MapEnv::new();
        empty.set("HOME", "");
        assert_eq!(den_under_home(&empty), "");
        assert_ne!(den_under_home(&MapEnv::new()), ".rivetos/den");
        let joined = den_under_home(&MapEnv::new());
        assert!(joined.is_empty() || joined.starts_with('/'));
    }
}
