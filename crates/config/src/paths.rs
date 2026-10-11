use protocol::host::{Env, env_trimmed, home_dir};
use protocol::js::posix_join;

pub fn shared_dir(env: &dyn Env) -> String {
    match env_trimmed(env, "RIVETOS_SHARED_DIR") {
        Some(value) if !value.is_empty() => value,
        _ => "/rivet-shared".to_string(),
    }
}

pub fn shared_path(env: &dyn Env, segments: &[&str]) -> String {
    join_root(&shared_dir(env), segments)
}

pub fn install_root(env: &dyn Env) -> String {
    match env_trimmed(env, "RIVETOS_INSTALL_ROOT") {
        Some(value) if !value.is_empty() => value,
        _ => "/opt/rivetos".to_string(),
    }
}

pub fn install_path(env: &dyn Env, segments: &[&str]) -> String {
    join_root(&install_root(env), segments)
}

pub fn rivetos_root(env: &dyn Env) -> String {
    match env.var("RIVETOS_ROOT") {
        Some(value) if !value.is_empty() => value,
        _ => "/opt/rivetos".to_string(),
    }
}

pub fn instance_dir(env: &dyn Env) -> Option<String> {
    instance_path(env, &[])
}

pub fn instance_path(env: &dyn Env, segments: &[&str]) -> Option<String> {
    let home = home_dir(env)?;
    let mut parts = Vec::with_capacity(segments.len() + 2);
    parts.push(home);
    parts.push(".rivetos".to_string());
    for segment in segments {
        parts.push((*segment).to_string());
    }
    let refs: Vec<&str> = parts.iter().map(String::as_str).collect();
    Some(posix_join(&refs))
}

pub fn local_shared_dir(env: &dyn Env) -> Option<String> {
    instance_path(env, &["shared"])
}

pub fn den_state_dir(env: &dyn Env) -> Option<String> {
    if let Some(value) = env.var("RIVETOS_DEN_STATE_DIR") {
        return Some(value);
    }
    instance_path(env, &["den"])
}

pub fn den_pairing_dir(env: &dyn Env) -> Option<String> {
    nonempty_or_instance(env, "RIVETOS_DEN_PAIRING_DIR", &["devices", "pairing"])
}

pub fn den_agents_dir(env: &dyn Env) -> Option<String> {
    nonempty_or_instance(env, "RIVETOS_DEN_AGENTS_DIR", &["agents"])
}

pub fn env_file(env: &dyn Env) -> Option<String> {
    if let Some(value) = env.var("RIVETOS_ENV_FILE") {
        return Some(value);
    }
    instance_path(env, &[".env"])
}

pub fn env_file_or(env: &dyn Env) -> Option<String> {
    match env.var("RIVETOS_ENV_FILE") {
        Some(value) if !value.is_empty() => Some(value),
        _ => instance_path(env, &[".env"]),
    }
}

pub fn den_term_config(env: &dyn Env) -> Option<String> {
    if let Some(value) = env.var("RIVETOS_DEN_TERM_CONFIG") {
        return Some(value);
    }
    instance_path(env, &["den-term.json"])
}

pub fn users_json_candidates(env: &dyn Env) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(file) = env_trimmed(env, "RIVETOS_USERS_FILE")
        && !file.is_empty()
    {
        out.push(file);
    }
    out.push(shared_path(env, &["rivetos", "users.json"]));
    if let Some(home) = instance_path(env, &["users.json"]) {
        out.push(home);
    }
    out
}

pub fn mesh_json_candidates(env: &dyn Env) -> Vec<String> {
    match env.var("RIVETOS_DEN_MESH_FILE") {
        Some(value) if !value.is_empty() => vec![value],
        _ => {
            let mut out = vec![shared_path(env, &["mesh.json"])];
            if let Some(home) = instance_path(env, &["mesh.json"]) {
                out.push(home);
            }
            out
        }
    }
}

fn join_root(root: &str, segments: &[&str]) -> String {
    let mut parts = Vec::with_capacity(segments.len() + 1);
    parts.push(root);
    parts.extend(segments.iter().copied());
    posix_join(&parts)
}

fn nonempty_or_instance(env: &dyn Env, name: &str, segments: &[&str]) -> Option<String> {
    match env_trimmed(env, name) {
        Some(value) if !value.is_empty() => Some(value),
        _ => instance_path(env, segments),
    }
}

#[cfg(test)]
mod tests {
    use protocol::host::MapEnv;
    use protocol::js::posix_join;

    use super::{
        den_agents_dir, den_pairing_dir, den_state_dir, den_term_config, env_file, env_file_or,
        install_path, install_root, instance_dir, local_shared_dir, mesh_json_candidates,
        rivetos_root, shared_dir, shared_path, users_json_candidates,
    };

    #[test]
    fn directories_follow_each_rule() {
        let env = MapEnv::new();
        assert_eq!(shared_dir(&env), "/rivet-shared");
        assert_eq!(install_root(&env), "/opt/rivetos");
        assert_eq!(rivetos_root(&env), "/opt/rivetos");
        assert_eq!(shared_path(&env, &["mesh.json"]), "/rivet-shared/mesh.json");
        let mut cli = String::from("/opt/rivetos/");
        cli.push_str("packages");
        cli.push('/');
        cli.push_str("cli");
        assert_eq!(install_path(&env, &["packages", "cli"]), cli);

        let mut set = MapEnv::new();
        set.set("RIVETOS_SHARED_DIR", "  /data/shared  ");
        set.set("RIVETOS_INSTALL_ROOT", " ");
        set.set("RIVETOS_ROOT", "");
        set.set("HOME", "/home/example");
        set.set("RIVETOS_DEN_STATE_DIR", "");
        set.set("RIVETOS_DEN_PAIRING_DIR", "  /pair  ");
        set.set("RIVETOS_ENV_FILE", "");
        assert_eq!(shared_dir(&set), "/data/shared");
        assert_eq!(install_root(&set), "/opt/rivetos");
        assert_eq!(rivetos_root(&set), "/opt/rivetos");
        assert_eq!(
            instance_dir(&set).as_deref(),
            Some("/home/example/.rivetos")
        );
        assert_eq!(
            local_shared_dir(&set).as_deref(),
            Some("/home/example/.rivetos/shared")
        );
        assert_eq!(den_state_dir(&set).as_deref(), Some(""));
        assert_eq!(den_pairing_dir(&set).as_deref(), Some("/pair"));
        assert_eq!(
            den_agents_dir(&set).as_deref(),
            Some("/home/example/.rivetos/agents")
        );
        assert_eq!(env_file(&set).as_deref(), Some(""));
        assert_eq!(
            env_file_or(&set).as_deref(),
            Some("/home/example/.rivetos/.env")
        );
        assert_eq!(
            den_term_config(&set).as_deref(),
            Some("/home/example/.rivetos/den-term.json")
        );
        assert_eq!(
            users_json_candidates(&set),
            vec![
                "/data/shared/rivetos/users.json".to_string(),
                "/home/example/.rivetos/users.json".to_string(),
            ]
        );
        set.set("RIVETOS_SHARED_DIR", "/data/shared");
        set.set("RIVETOS_USERS_FILE", " /users.json ");
        set.set("RIVETOS_DEN_MESH_FILE", "/mesh.json");
        assert_eq!(users_json_candidates(&set)[0], "/users.json");
        assert_eq!(mesh_json_candidates(&set), vec!["/mesh.json".to_string()]);
        assert_eq!(posix_join(&["/a", "b", "..", "c"]), "/a/c");
        assert_eq!(posix_join(&["a", "", "b/"]), "a/b/");
        assert_eq!(posix_join(&["/a", "/b"]), "/a/b");
        assert_eq!(posix_join(&["..", "a"]), "../a");
        assert_eq!(posix_join(&["", ""]), ".");
    }
}
