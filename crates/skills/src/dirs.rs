pub fn resolve_skill_dirs(explicit: Option<&[String]>) -> Vec<String> {
    resolve_skill_dirs_from(explicit, &protocol::host::ProcessEnv)
}

pub fn resolve_skill_dirs_from(
    explicit: Option<&[String]>,
    env: &dyn protocol::host::Env,
) -> Vec<String> {
    if let Some(dirs) = explicit
        && !dirs.is_empty()
    {
        return dirs.to_vec();
    }
    if let Some(env_value) = env.var("RIVETOS_SKILL_DIRS") {
        let parts: Vec<String> = env_value
            .split(':')
            .map(|part| protocol::js::js_trim(part).to_string())
            .filter(|part| !part.is_empty())
            .collect();
        if !parts.is_empty() {
            return parts;
        }
    }
    let home = env.var("HOME").unwrap_or_else(|| "~".to_string());
    vec![format!("{home}/.rivetos/skills")]
}

pub fn default_runtime_skill_dirs() -> Vec<String> {
    default_runtime_skill_dirs_from(&protocol::host::ProcessEnv)
}

pub fn default_runtime_skill_dirs_from(env: &dyn protocol::host::Env) -> Vec<String> {
    let home = env.var("HOME").unwrap_or_else(|| "~".to_string());
    vec![format!("{home}/.rivetos/workspace/skills")]
}
