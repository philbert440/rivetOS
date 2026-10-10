pub fn resolve_skill_dirs(explicit: Option<&[String]>) -> Vec<String> {
    if let Some(dirs) = explicit
        && !dirs.is_empty()
    {
        return dirs.to_vec();
    }
    if let Ok(env_value) = std::env::var("RIVETOS_SKILL_DIRS") {
        let parts: Vec<String> = env_value
            .split(':')
            .map(|part| protocol::js::js_trim(part).to_string())
            .filter(|part| !part.is_empty())
            .collect();
        if !parts.is_empty() {
            return parts;
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "~".to_string());
    vec![format!("{home}/.rivetos/skills")]
}

pub fn default_runtime_skill_dirs() -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "~".to_string());
    vec![format!("{home}/.rivetos/workspace/skills")]
}
