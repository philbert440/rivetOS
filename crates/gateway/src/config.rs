use std::collections::BTreeMap;

use identity::{LoadOptions, UsersRegistry, load_users_registry};

use crate::origin::parse_list;
use crate::standard_helpers::{
    homedir_from, hostname, int_env, join_path, non_empty, shared_dir_from, truthy_env,
};

pub const DEFAULT_UPLOAD_MAX_BYTES: i64 = 25 * 1024 * 1024;
pub const DEFAULT_UPLOAD_TTL_MS: i64 = 6 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TermMux {
    Tmux,
    Herdr,
    None,
}

impl TermMux {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Tmux => "tmux",
            Self::Herdr => "herdr",
            Self::None => "none",
        }
    }
}

#[derive(Debug, Clone)]
pub struct TlsConfig {
    pub cert_path: String,
    pub key_path: String,
    pub ca_path: String,
    pub require_client_cert: bool,
}

#[derive(Debug, Clone)]
pub struct TermConfig {
    pub enabled: bool,
    pub open: bool,
    pub config_file: String,
    pub max_ptys: i64,
    pub scrollback_bytes: i64,
    pub detached_ttl_ms: i64,
    pub idle_ttl_ms: i64,
    pub exit_linger_ms: i64,
    pub inject_ready_ms: i64,
    pub inject_ready_max_ms: i64,
    pub inject_confirm_ms: i64,
    pub harness_ended_grace_ms: i64,
    pub inject_submit_delay_ms: i64,
    pub mux: Option<TermMux>,
    pub session_gc_ms: i64,
    pub tmux_user_conf: bool,
}

#[derive(Debug, Clone)]
pub struct AudioConfig {
    pub enabled: bool,
    pub open: bool,
    pub dir: String,
    pub device_name: String,
    pub sample_rate: i64,
}

#[derive(Debug, Clone)]
pub struct DevicesConfig {
    pub enabled: bool,
    pub relay_ssh: String,
    pub relay_sudo: bool,
    pub wg_interface: String,
    pub pool: String,
    pub wg_endpoint: String,
    pub wg_public_key: String,
    pub allowed_ips: String,
    pub home_subnet: String,
    pub shared_host: String,
    pub shared_export: String,
    pub roster_path: String,
    pub pg_url: String,
    pub embed_url: String,
    pub relay_forward_src: String,
    pub relay_forward_dest: String,
    pub gateway_url: String,
    pub pg_admin_url: String,
    pub pg_device_group: String,
}

#[derive(Debug, Clone)]
pub struct UploadsConfig {
    pub dir: String,
    pub max_bytes: i64,
    pub ttl_ms: i64,
}

#[derive(Debug, Clone)]
pub struct VoiceConfig {
    pub stt_url: String,
    pub tts_url: String,
    pub tts_instructions: String,
}

#[derive(Debug, Clone)]
pub struct GatewayConfig {
    pub port: u16,
    pub host: String,
    pub token: String,
    pub tls: TlsConfig,
    pub codex_app_server_url: Option<String>,
    pub state_dir: String,
    pub pairing_dir: String,
    pub pair_cli_path: Option<String>,
    pub pair_ca_root_dir: String,
    pub node_name: String,
    pub agents_dir: String,
    pub static_dir: String,
    pub root_redirect: String,
    pub evict_ttl_ms: i64,
    pub mesh_file: String,
    pub shared_root: String,
    pub mesh_cache_ms: i64,
    pub allowed_origins: Vec<String>,
    pub allowed_hosts: Vec<String>,
    pub allowed_harnesses: Option<Vec<String>>,
    pub term: TermConfig,
    pub audio: AudioConfig,
    pub files_root: String,
    pub files_open: bool,
    pub devices: DevicesConfig,
    pub uploads: UploadsConfig,
    pub voice: VoiceConfig,
    pub pg_url: String,
    pub users_registry: Option<UsersRegistry>,
    pub env: BTreeMap<String, String>,
}

impl GatewayConfig {
    pub fn from_env(env: &BTreeMap<String, String>) -> Self {
        let home = homedir_from(env);
        let shared_root = shared_dir_from(env);
        let default_ca = non_empty(env.get("RIVETOS_DEN_TLS_CA").map(String::as_str))
            .or_else(|| non_empty(env.get("RIVET_CA_CHAIN").map(String::as_str)))
            .map(str::to_string)
            .unwrap_or_else(|| join_path(&shared_root, &["rivet-ca", "intermediate", "chain.pem"]));
        let require_raw = env
            .get("RIVETOS_DEN_TLS_REQUIRE_CLIENT")
            .map(String::as_str)
            .unwrap_or("1")
            .trim()
            .to_ascii_lowercase();
        let require_client_cert = !matches!(require_raw.as_str(), "0" | "off" | "false" | "no");
        let users_registry = load_users_registry(
            env,
            LoadOptions {
                path: None,
                read_file: None,
                homedir: Some(&|| homedir_from(env)),
            },
        );
        let port = int_env(env, "RIVETOS_DEN_PORT", 5174);
        let port = u16::try_from(port).unwrap_or(5174);
        Self {
            port,
            host: env
                .get("RIVETOS_DEN_HOST")
                .cloned()
                .unwrap_or_else(|| "127.0.0.1".to_string()),
            token: String::new(),
            tls: TlsConfig {
                cert_path: non_empty(env.get("RIVETOS_DEN_TLS_CERT").map(String::as_str))
                    .unwrap_or("")
                    .to_string(),
                key_path: non_empty(env.get("RIVETOS_DEN_TLS_KEY").map(String::as_str))
                    .unwrap_or("")
                    .to_string(),
                ca_path: default_ca,
                require_client_cert,
            },
            codex_app_server_url: env.get("RIVETOS_CODEX_APP_SERVER_URL").cloned(),
            state_dir: env
                .get("RIVETOS_DEN_STATE_DIR")
                .cloned()
                .unwrap_or_else(|| join_path(&home, &[".rivetos", "den"])),
            pairing_dir: non_empty(env.get("RIVETOS_DEN_PAIRING_DIR").map(String::as_str))
                .map(str::to_string)
                .unwrap_or_else(|| join_path(&home, &[".rivetos", "devices", "pairing"])),
            pair_cli_path: non_empty(env.get("RIVETOS_DEN_PAIR_CLI").map(String::as_str))
                .map(str::to_string)
                .or_else(|| {
                    non_empty(env.get("RIVETOS_ROOT").map(String::as_str))
                        .map(|root| join_path(root, &["packages", "cli", "dist", "index.js"]))
                }),
            pair_ca_root_dir: join_path(&home, &[".rivetos", "ca", "root"]),
            node_name: node_name(env),
            agents_dir: non_empty(env.get("RIVETOS_DEN_AGENTS_DIR").map(String::as_str))
                .map(str::to_string)
                .unwrap_or_else(|| join_path(&home, &[".rivetos", "agents"])),
            static_dir: env
                .get("RIVETOS_DEN_STATIC_DIR")
                .cloned()
                .unwrap_or_default(),
            root_redirect: env
                .get("RIVETOS_DEN_ROOT_REDIRECT")
                .cloned()
                .unwrap_or_default(),
            evict_ttl_ms: int_env(env, "RIVETOS_DEN_EVICT_TTL_MS", 24 * 60 * 60 * 1000),
            mesh_file: env
                .get("RIVETOS_DEN_MESH_FILE")
                .cloned()
                .unwrap_or_default(),
            shared_root: shared_root.clone(),
            mesh_cache_ms: int_env(env, "RIVETOS_DEN_MESH_CACHE_MS", 10_000),
            allowed_origins: parse_list(env.get("RIVETOS_DEN_ALLOWED_ORIGINS").map(String::as_str)),
            allowed_hosts: parse_list(env.get("RIVETOS_DEN_ALLOWED_HOSTS").map(String::as_str)),
            allowed_harnesses: env
                .get("RIVETOS_DEN_ALLOWED_HARNESSES")
                .map(|raw| parse_list(Some(raw))),
            term: term_config(env, &home),
            audio: AudioConfig {
                enabled: truthy_env(env.get("RIVETOS_DEN_AUDIO").map(String::as_str)),
                open: truthy_env(env.get("RIVETOS_DEN_AUDIO_OPEN").map(String::as_str)),
                dir: env
                    .get("RIVETOS_DEN_AUDIO_DIR")
                    .cloned()
                    .unwrap_or_default(),
                device_name: env
                    .get("RIVETOS_DEN_AUDIO_DEVICE")
                    .cloned()
                    .unwrap_or_else(|| "RivetHub Mic".to_string()),
                sample_rate: int_env(env, "RIVETOS_DEN_AUDIO_RATE", 16_000),
            },
            files_root: env
                .get("RIVETOS_DEN_FILES_ROOT")
                .cloned()
                .unwrap_or_else(|| shared_root.clone()),
            files_open: truthy_env(env.get("RIVETOS_DEN_FILES_OPEN").map(String::as_str)),
            devices: devices_config(env, &shared_root),
            uploads: UploadsConfig {
                dir: env
                    .get("RIVETOS_DEN_UPLOAD_DIR")
                    .cloned()
                    .unwrap_or_default(),
                max_bytes: int_env(
                    env,
                    "RIVETOS_DEN_UPLOAD_MAX_BYTES",
                    DEFAULT_UPLOAD_MAX_BYTES,
                ),
                ttl_ms: int_env(env, "RIVETOS_DEN_UPLOAD_TTL_MS", DEFAULT_UPLOAD_TTL_MS),
            },
            voice: VoiceConfig {
                stt_url: env
                    .get("RIVETOS_DEN_VOICE_STT_URL")
                    .map(|value| value.trim().to_string())
                    .unwrap_or_default(),
                tts_url: env
                    .get("RIVETOS_DEN_VOICE_TTS_URL")
                    .map(|value| value.trim().to_string())
                    .unwrap_or_default(),
                tts_instructions: env
                    .get("RIVETOS_DEN_VOICE_TTS_INSTRUCTIONS")
                    .map(|value| value.trim().to_string())
                    .unwrap_or_default(),
            },
            pg_url: env.get("RIVETOS_PG_URL").cloned().unwrap_or_default(),
            users_registry,
            env: env.clone(),
        }
    }

    pub fn tls_ready(&self) -> bool {
        !self.tls.cert_path.trim().is_empty() && !self.tls.key_path.trim().is_empty()
    }

    pub fn listen_line(&self) -> String {
        let auth = if self.token.is_empty() {
            " [auth off]"
        } else {
            " [auth on]"
        };
        format!(
            "[den-server] listening on {}:{} (POST /event, WS /ws){auth}",
            self.host, self.port
        )
    }
}

fn node_name(env: &BTreeMap<String, String>) -> String {
    non_empty(env.get("RIVETOS_DEN_NODE_NAME").map(String::as_str))
        .or_else(|| non_empty(env.get("RIVETOS_DEN_NODE_ID").map(String::as_str)))
        .map(str::to_string)
        .or_else(|| {
            let name = hostname();
            if name.is_empty() { None } else { Some(name) }
        })
        .unwrap_or_else(|| "local".to_string())
}

fn term_config(env: &BTreeMap<String, String>, home: &str) -> TermConfig {
    let enabled = truthy_env(env.get("RIVETOS_DEN_TERM").map(String::as_str));
    let mux = mux_from_env(env, enabled, home);
    TermConfig {
        enabled,
        open: truthy_env(env.get("RIVETOS_DEN_TERM_OPEN").map(String::as_str)),
        config_file: env
            .get("RIVETOS_DEN_TERM_CONFIG")
            .cloned()
            .unwrap_or_else(|| join_path(home, &[".rivetos", "den-term.json"])),
        max_ptys: int_env(env, "RIVETOS_DEN_TERM_MAX", 4),
        scrollback_bytes: int_env(env, "RIVETOS_DEN_TERM_SCROLLBACK", 262_144),
        detached_ttl_ms: int_env(env, "RIVETOS_DEN_TERM_DETACHED_TTL_MS", 1_800_000),
        idle_ttl_ms: int_env(env, "RIVETOS_DEN_TERM_IDLE_TTL_MS", 1_800_000),
        exit_linger_ms: int_env(env, "RIVETOS_DEN_TERM_EXIT_LINGER_MS", 60_000),
        inject_ready_ms: int_env(env, "RIVETOS_DEN_TERM_INJECT_READY_MS", 500),
        inject_ready_max_ms: int_env(env, "RIVETOS_DEN_TERM_INJECT_READY_MAX_MS", 15_000),
        inject_confirm_ms: int_env(env, "RIVETOS_DEN_TERM_INJECT_CONFIRM_MS", 5_000),
        harness_ended_grace_ms: int_env(env, "RIVETOS_DEN_TERM_HARNESS_ENDED_GRACE_MS", 3_000),
        inject_submit_delay_ms: int_env(env, "RIVETOS_DEN_TERM_INJECT_SUBMIT_DELAY_MS", 80),
        mux,
        session_gc_ms: int_env(env, "RIVETOS_DEN_TERM_SESSION_GC_MS", 0),
        tmux_user_conf: truthy_env(
            env.get("RIVETOS_DEN_TERM_TMUX_USER_CONF")
                .map(String::as_str),
        ),
    }
}

fn mux_from_env(env: &BTreeMap<String, String>, term_enabled: bool, home: &str) -> Option<TermMux> {
    let Some(raw_value) = env.get("RIVETOS_DEN_TERM_MUX") else {
        if !term_enabled {
            return None;
        }
        return if herdr_present(env, home) {
            Some(TermMux::Herdr)
        } else {
            None
        };
    };
    let raw = raw_value.trim().to_ascii_lowercase();
    match raw.as_str() {
        "tmux" => Some(TermMux::Tmux),
        "herdr" => Some(TermMux::Herdr),
        "none" => Some(TermMux::None),
        "" => {
            if !term_enabled {
                None
            } else if herdr_present(env, home) {
                Some(TermMux::Herdr)
            } else {
                None
            }
        }
        _ => {
            let shown = serde_json::to_string(raw_value).unwrap_or_else(|_| "\"\"".to_string());
            eprintln!(
                "[den-server] config: RIVETOS_DEN_TERM_MUX={shown} is not 'tmux', 'herdr', or 'none' — using 'none'"
            );
            Some(TermMux::None)
        }
    }
}

fn herdr_present(env: &BTreeMap<String, String>, home: &str) -> bool {
    let path = env.get("PATH").map(String::as_str).unwrap_or("");
    if let Some(bin) = herdr_on_path(path) {
        return herdr_supported(&bin);
    }
    herdr_supported(std::path::Path::new(&join_path(
        home,
        &[".local", "bin", "herdr"],
    )))
}

fn herdr_on_path(path: &str) -> Option<std::path::PathBuf> {
    for dir in path.split(':') {
        if dir.is_empty() {
            continue;
        }
        let bin = std::path::Path::new(dir).join("herdr");
        if bin.is_file() {
            return Some(bin);
        }
    }
    None
}

fn herdr_supported(bin: &std::path::Path) -> bool {
    if !bin.is_file() {
        return false;
    }
    let Ok(output) = std::process::Command::new(bin)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
    else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    herdr_version(text.trim()) == Some("0.8.2")
}

fn herdr_version(out: &str) -> Option<&str> {
    out.split_whitespace().find(|token| {
        let mut parts = token.split('.');
        match (parts.next(), parts.next(), parts.next(), parts.next()) {
            (Some(major), Some(minor), Some(patch), None) => {
                !major.is_empty()
                    && !minor.is_empty()
                    && !patch.is_empty()
                    && major.bytes().all(|byte| byte.is_ascii_digit())
                    && minor.bytes().all(|byte| byte.is_ascii_digit())
                    && patch.bytes().all(|byte| byte.is_ascii_digit())
            }
            _ => false,
        }
    })
}

fn devices_config(env: &BTreeMap<String, String>, shared_root: &str) -> DevicesConfig {
    DevicesConfig {
        enabled: truthy_env(env.get("RIVETOS_DEN_DEVICES").map(String::as_str)),
        relay_ssh: env
            .get("RIVETOS_DEN_DEVICES_RELAY_SSH")
            .cloned()
            .unwrap_or_default(),
        relay_sudo: truthy_env(
            env.get("RIVETOS_DEN_DEVICES_RELAY_SUDO")
                .map(String::as_str),
        ),
        wg_interface: env
            .get("RIVETOS_DEN_DEVICES_WG_IFACE")
            .cloned()
            .unwrap_or_else(|| "wg0".to_string()),
        pool: env
            .get("RIVETOS_DEN_DEVICES_POOL")
            .cloned()
            .unwrap_or_default(),
        wg_endpoint: env
            .get("RIVETOS_DEN_DEVICES_WG_ENDPOINT")
            .cloned()
            .unwrap_or_default(),
        wg_public_key: env
            .get("RIVETOS_DEN_DEVICES_WG_PUBKEY")
            .cloned()
            .unwrap_or_default(),
        allowed_ips: env
            .get("RIVETOS_DEN_DEVICES_ALLOWED_IPS")
            .cloned()
            .unwrap_or_default(),
        home_subnet: env
            .get("RIVETOS_DEN_DEVICES_HOME_SUBNET")
            .cloned()
            .unwrap_or_default(),
        shared_host: env
            .get("RIVETOS_DEN_DEVICES_SHARED_HOST")
            .cloned()
            .unwrap_or_default(),
        shared_export: env
            .get("RIVETOS_DEN_DEVICES_SHARED_EXPORT")
            .cloned()
            .unwrap_or_else(|| shared_root.to_string()),
        roster_path: env
            .get("RIVETOS_DEN_DEVICES_ROSTER")
            .cloned()
            .unwrap_or_default(),
        pg_url: env.get("RIVETOS_PG_URL").cloned().unwrap_or_default(),
        embed_url: env.get("RIVETOS_EMBED_URL").cloned().unwrap_or_default(),
        relay_forward_src: env
            .get("RIVETOS_DEN_DEVICES_FWD_SRC")
            .cloned()
            .unwrap_or_default(),
        relay_forward_dest: env
            .get("RIVETOS_DEN_DEVICES_FWD_DEST")
            .cloned()
            .unwrap_or_default(),
        gateway_url: env
            .get("RIVETOS_DEN_DEVICES_GATEWAY_URL")
            .cloned()
            .unwrap_or_default(),
        pg_admin_url: env
            .get("RIVETOS_DEN_DEVICES_PG_ADMIN_URL")
            .cloned()
            .unwrap_or_default(),
        pg_device_group: env
            .get("RIVETOS_DEN_DEVICES_PG_DEVICE_GROUP")
            .cloned()
            .unwrap_or_else(|| "rivet_device".to_string()),
    }
}
