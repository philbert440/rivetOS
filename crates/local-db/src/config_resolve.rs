use std::path::{Path, PathBuf};

use protocol::host::Env;
use serde_json::{Map, Number, Value};

use crate::error::{LocalDbError, Result};
use crate::paths::{
    cluster_dir_for, default_pglite_dir, expand_tilde, lexical_absolute, postgres_bin_dir,
};

pub const DEFAULT_PORT: i64 = 5433;
pub const DEFAULT_MAX_CONNECTIONS: i64 = 96;
pub const DEFAULT_DATA_DIR: &str = "~/.rivetos/pglite";
pub const ATTACH_TIMEOUT_MS: u64 = 20_000;

pub const PORT_ERROR_PREFIX: &str =
    "memory.postgres.embedded.port must be an integer between 1 and 65535 (got ";

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedEmbeddedPg {
    pub data_dir: PathBuf,
    pub port: i64,
    pub auto_migrate: bool,
    pub max_connections: i64,
    pub pg_url: String,
    pub lite_mode: bool,
    pub engine_data_dir: PathBuf,
    pub installation_dir: PathBuf,
    pub home: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbeddedPgEnv {
    pub pg_url_key: &'static str,
    pub pg_url: String,
    pub embedded_key: &'static str,
    pub embedded: &'static str,
}

pub fn embedded_pg_url(port: i64) -> String {
    format!("postgres://postgres:postgres@127.0.0.1:{port}/postgres")
}

pub fn embedded_pg_env(pg_url: &str) -> EmbeddedPgEnv {
    EmbeddedPgEnv {
        pg_url_key: "RIVETOS_PG_URL",
        pg_url: pg_url.to_string(),
        embedded_key: "RIVETOS_PG_EMBEDDED",
        embedded: "1",
    }
}

impl EmbeddedPgEnv {
    pub fn apply_to_std(&self, command: &mut std::process::Command) {
        command.env(self.pg_url_key, &self.pg_url);
        command.env(self.embedded_key, self.embedded);
    }

    pub fn apply_to_tokio(&self, command: &mut tokio::process::Command) {
        command.env(self.pg_url_key, &self.pg_url);
        command.env(self.embedded_key, self.embedded);
    }
}

pub fn resolve_embedded_pg(
    config: &Value,
    home: &Path,
    embed_url: Option<&str>,
) -> Option<ResolvedEmbeddedPg> {
    let pg = config.get("memory")?.get("postgres")?;
    let embedded = pg.get("embedded")?;
    if embedded.is_null() || !embedded.is_object() {
        return None;
    }
    let embedded = embedded.as_object()?;
    let data_dir = match embedded.get("data_dir").and_then(Value::as_str) {
        Some(raw) => lexical_absolute(&expand_tilde(raw, home)),
        None => lexical_absolute(&default_pglite_dir(home)),
    };
    let (port, pg_url) = configured_port(embedded);
    let auto_migrate = embedded
        .get("auto_migrate")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let max_connections = configured_max(embedded);
    let endpoint = pg
        .get("embed_endpoint")
        .and_then(Value::as_str)
        .map(protocol::js::js_trim)
        .unwrap_or("");
    let embed_env = embed_url.map(protocol::js::js_trim).unwrap_or("");
    let engine_data_dir = cluster_dir_for(&data_dir);
    Some(ResolvedEmbeddedPg {
        data_dir,
        port,
        auto_migrate,
        max_connections,
        pg_url,
        lite_mode: endpoint.is_empty() && embed_env.is_empty(),
        engine_data_dir,
        installation_dir: postgres_bin_dir(home),
        home: home.to_path_buf(),
    })
}

pub fn resolve_embedded_pg_from_env(
    config: &Value,
    home: &Path,
    env: &dyn Env,
) -> Option<ResolvedEmbeddedPg> {
    let embed = env.var("RIVETOS_EMBED_URL");
    resolve_embedded_pg(config, home, embed.as_deref())
}

pub fn assert_embedded_port(config: &Value) -> Result<()> {
    config::assert_embedded_port(config).map_err(|error| LocalDbError::message(error.to_string()))
}

pub fn apply_embedded_pg_url(config: &mut Value, pg_url: &str) -> Result<EmbeddedPgEnv> {
    let root = object_mut(config, "config")?;
    let memory = child_object(root, "memory")?;
    let postgres = child_object(memory, "postgres")?;
    postgres.insert(
        "connection_string".to_string(),
        Value::String(pg_url.to_string()),
    );
    Ok(embedded_pg_env(pg_url))
}

pub fn read_embedded_config(
    path: &Path,
    home: &Path,
) -> Result<Option<(Value, ResolvedEmbeddedPg)>> {
    read_embedded_config_with(path, home, &protocol::host::ProcessEnv)
}

pub fn read_embedded_config_with(
    path: &Path,
    home: &Path,
    env: &dyn Env,
) -> Result<Option<(Value, ResolvedEmbeddedPg)>> {
    let text = match protocol::host::read_text(path) {
        Ok(text) => text,
        Err(_) => return Ok(None),
    };
    let parsed = match config::parse_yaml(&text) {
        Ok(parsed) => parsed,
        Err(_) => return Ok(None),
    };
    if !parsed.is_object() {
        return Ok(None);
    }
    let resolved_doc = config::resolve_env_vars_with(&parsed, |name| env.var(name));
    assert_embedded_port(&resolved_doc)?;
    let embed = env.var("RIVETOS_EMBED_URL");
    let Some(resolved) = resolve_embedded_pg(&resolved_doc, home, embed.as_deref()) else {
        return Ok(None);
    };
    Ok(Some((resolved_doc, resolved)))
}

pub fn require_listen_port(resolved: &ResolvedEmbeddedPg) -> Result<u16> {
    if (1..=65535).contains(&resolved.port) {
        u16::try_from(resolved.port).map_err(|_| port_error(resolved.port))
    } else {
        Err(port_error(resolved.port))
    }
}

pub fn require_max_connections(resolved: &ResolvedEmbeddedPg) -> Result<u32> {
    if resolved.max_connections >= 1 {
        u32::try_from(resolved.max_connections)
            .map_err(|_| LocalDbError::message("\"max_connections\" must be a positive integer"))
    } else {
        Err(LocalDbError::message(
            "\"max_connections\" must be a positive integer",
        ))
    }
}

fn port_error(port: i64) -> LocalDbError {
    let rendered = serde_json::to_string(&port).unwrap_or_else(|_| "null".to_string());
    LocalDbError::message(format!("{PORT_ERROR_PREFIX}{rendered})"))
}

fn configured_port(embedded: &Map<String, Value>) -> (i64, String) {
    match embedded.get("port") {
        Some(Value::Number(number)) => {
            if let Some(port) = js_i64(number) {
                (port, embedded_pg_url(port))
            } else {
                (
                    0,
                    format!("postgres://postgres:postgres@127.0.0.1:{number}/postgres"),
                )
            }
        }
        _ => (DEFAULT_PORT, embedded_pg_url(DEFAULT_PORT)),
    }
}

fn configured_max(embedded: &Map<String, Value>) -> i64 {
    match embedded.get("max_connections") {
        Some(Value::Number(number)) => js_i64(number).unwrap_or(0),
        _ => DEFAULT_MAX_CONNECTIONS,
    }
}

fn js_i64(number: &Number) -> Option<i64> {
    if let Some(integer) = number.as_i64() {
        return Some(integer);
    }
    let float = number.as_f64()?;
    if float.is_finite()
        && float.fract() == 0.0
        && (i64::MIN as f64..=i64::MAX as f64).contains(&float)
    {
        let integer = float as i64;
        if integer as f64 == float {
            return Some(integer);
        }
    }
    None
}

fn object_mut<'a>(value: &'a mut Value, what: &str) -> Result<&'a mut Map<String, Value>> {
    if value.is_null() {
        *value = Value::Object(Map::new());
    }
    value.as_object_mut().ok_or_else(|| {
        LocalDbError::message(format!(
            "embedded postgres: {what} must be an object to receive the loopback URL"
        ))
    })
}

fn child_object<'a>(
    parent: &'a mut Map<String, Value>,
    key: &'static str,
) -> Result<&'a mut Map<String, Value>> {
    let entry = parent
        .entry(key)
        .or_insert_with(|| Value::Object(Map::new()));
    if entry.is_null() {
        *entry = Value::Object(Map::new());
    }
    object_mut(entry, key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::host::MapEnv;
    use serde_json::json;

    #[test]
    fn absent_embedded_block_resolves_to_none() {
        let config = json!({"memory": {"postgres": {}}});
        assert!(resolve_embedded_pg(&config, Path::new("/home/rivet"), None).is_none());
        let missing = json!({});
        assert!(resolve_embedded_pg(&missing, Path::new("/home/rivet"), None).is_none());
        let null_block = json!({"memory": {"postgres": {"embedded": null}}});
        assert!(resolve_embedded_pg(&null_block, Path::new("/home/rivet"), None).is_none());
    }

    #[test]
    fn defaults_match_the_typescript_resolver() {
        let config = json!({"memory": {"postgres": {"embedded": {}}}});
        let resolved =
            resolve_embedded_pg(&config, Path::new("/tmp/fakehome"), None).expect("resolved");
        assert_eq!(
            resolved.data_dir,
            PathBuf::from("/tmp/fakehome/.rivetos/pglite")
        );
        assert_eq!(resolved.port, 5433);
        assert!(resolved.auto_migrate);
        assert_eq!(resolved.max_connections, 96);
        assert_eq!(
            resolved.pg_url,
            "postgres://postgres:postgres@127.0.0.1:5433/postgres"
        );
        assert!(resolved.lite_mode);
        assert_eq!(
            resolved.engine_data_dir,
            PathBuf::from("/tmp/fakehome/.rivetos/postgres")
        );
        assert_eq!(
            resolved.installation_dir,
            PathBuf::from("/tmp/fakehome/.rivetos/pg-bin")
        );
        assert_eq!(
            default_pglite_dir(Path::new("/tmp/fakehome")),
            resolved.data_dir
        );
    }

    #[test]
    fn explicit_keys_and_lite_mode_follow_embed_endpoint_and_env() {
        let config = json!({
            "memory": {
                "postgres": {
                    "embedded": {
                        "data_dir": "~/db",
                        "port": 5434,
                        "auto_migrate": false,
                        "max_connections": 8
                    },
                    "embed_endpoint": "  http://127.0.0.1:9402/v1  "
                }
            }
        });
        let resolved =
            resolve_embedded_pg(&config, Path::new("/tmp/fakehome"), None).expect("resolved");
        assert_eq!(resolved.data_dir, PathBuf::from("/tmp/fakehome/db"));
        assert_eq!(resolved.port, 5434);
        assert!(!resolved.auto_migrate);
        assert_eq!(resolved.max_connections, 8);
        assert!(!resolved.lite_mode);

        let bare = json!({"memory": {"postgres": {"embedded": {}}}});
        let from_env = resolve_embedded_pg(
            &bare,
            Path::new("/tmp/fakehome"),
            Some("  http://127.0.0.1:9402/v1  "),
        )
        .expect("resolved");
        assert!(!from_env.lite_mode);

        let blank = resolve_embedded_pg(
            &json!({"memory": {"postgres": {"embedded": {}, "embed_endpoint": "   "}}}),
            Path::new("/tmp/fakehome"),
            Some("   "),
        )
        .expect("resolved");
        assert!(blank.lite_mode);
        assert_eq!(
            resolved.engine_data_dir,
            PathBuf::from("/tmp/fakehome/db.postgres")
        );
        assert_eq!(resolved.home, PathBuf::from("/tmp/fakehome"));
    }

    #[test]
    fn injected_embed_url_selects_full_mode_without_the_process_environment() {
        let config = json!({"memory": {"postgres": {"embedded": {}}}});
        let mut env = MapEnv::new();
        env.set("RIVETOS_EMBED_URL", "http://127.0.0.1:9/v1");
        let resolved =
            resolve_embedded_pg_from_env(&config, Path::new("/tmp/fakehome"), &env).expect("full");
        assert!(!resolved.lite_mode);
        let empty =
            resolve_embedded_pg_from_env(&config, Path::new("/tmp/fakehome"), &MapEnv::new())
                .expect("lite");
        assert!(empty.lite_mode);
        assert_eq!(
            empty.engine_data_dir,
            PathBuf::from("/tmp/fakehome/.rivetos/postgres")
        );
    }

    #[test]
    fn read_config_expands_placeholders_from_the_injected_map() {
        let home = std::env::temp_dir().join(format!(
            "local-db-cfg-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&home).expect("home");
        let path = home.join("config.yaml");
        std::fs::write(
            &path,
            "memory:\n  postgres:\n    embedded:\n      data_dir: \"${RIVET_DB}\"\n",
        )
        .expect("yaml");
        let mut env = MapEnv::new();
        env.set("RIVET_DB", "/srv/rivet/db");
        let (_doc, resolved) = read_embedded_config_with(&path, &home, &env)
            .expect("read")
            .expect("configured");
        assert_eq!(resolved.data_dir, PathBuf::from("/srv/rivet/db"));
        assert_eq!(
            resolved.engine_data_dir,
            PathBuf::from("/srv/rivet/db.postgres")
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn port_assertion_uses_the_config_crate_text() {
        let config = json!({"memory": {"postgres": {"embedded": {"port": "5433"}}}});
        let error = assert_embedded_port(&config).expect_err("port");
        assert_eq!(
            error.to_string(),
            "memory.postgres.embedded.port must be an integer between 1 and 65535 (got \"5433\")"
        );
        assert!(assert_embedded_port(&json!({})).is_ok());
    }

    #[test]
    fn apply_url_sets_connection_string_and_returns_process_env() {
        let mut config = json!({});
        let env = apply_embedded_pg_url(
            &mut config,
            "postgres://postgres:postgres@127.0.0.1:5433/postgres",
        )
        .expect("apply");
        assert_eq!(env.pg_url_key, "RIVETOS_PG_URL");
        assert_eq!(
            env.pg_url,
            "postgres://postgres:postgres@127.0.0.1:5433/postgres"
        );
        assert_eq!(env.embedded_key, "RIVETOS_PG_EMBEDDED");
        assert_eq!(env.embedded, "1");
        assert_eq!(
            config["memory"]["postgres"]["connection_string"],
            env.pg_url
        );
        let mut command = std::process::Command::new("true");
        env.apply_to_std(&mut command);
        let vars: Vec<(String, Option<String>)> = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().to_string(),
                    value.map(|item| item.to_string_lossy().to_string()),
                )
            })
            .collect();
        assert!(vars.iter().any(|(key, value)| {
            key == "RIVETOS_PG_URL" && value.as_deref() == Some(env.pg_url.as_str())
        }));
        assert!(
            vars.iter()
                .any(|(key, value)| key == "RIVETOS_PG_EMBEDDED" && value.as_deref() == Some("1"))
        );
    }

    #[test]
    fn listen_port_and_max_connections_reject_invalid_values() {
        let mut resolved = resolve_embedded_pg(
            &json!({"memory": {"postgres": {"embedded": {}}}}),
            Path::new("/tmp"),
            None,
        )
        .expect("resolved");
        assert_eq!(require_listen_port(&resolved).expect("port"), 5433);
        assert_eq!(require_max_connections(&resolved).expect("max"), 96);
        resolved.port = 0;
        assert!(
            require_listen_port(&resolved)
                .unwrap_err()
                .to_string()
                .contains(
                    "memory.postgres.embedded.port must be an integer between 1 and 65535 (got 0)"
                )
        );
        resolved.port = 5433;
        resolved.max_connections = 0;
        assert_eq!(
            require_max_connections(&resolved).unwrap_err().to_string(),
            "\"max_connections\" must be a positive integer"
        );
    }
}
