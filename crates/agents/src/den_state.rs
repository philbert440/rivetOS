use crate::validate::posix_join;

pub fn den_state_dir() -> String {
    match std::env::var("RIVETOS_DEN_STATE_DIR") {
        Ok(value) => value,
        Err(_) => den_state_dir_from(None),
    }
}

pub fn den_state_dir_from(value: Option<&str>) -> String {
    match value {
        Some(value) => value.to_string(),
        None => {
            let home = std::env::var("HOME").unwrap_or_default();
            posix_join(&[&home, ".rivetos", "den"])
        }
    }
}

pub fn agents_json_file() -> String {
    posix_join(&[&den_state_dir(), "agents.json"])
}

pub fn agents_json_file_in(state_dir: &str) -> String {
    posix_join(&[state_dir, "agents.json"])
}
