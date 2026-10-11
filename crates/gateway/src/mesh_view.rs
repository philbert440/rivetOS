use std::cell::RefCell;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Map, Value};

thread_local! {
    static MESH_CAPTURE: RefCell<Option<Vec<String>>> = const { RefCell::new(None) };
}

fn mesh_log(line: String) {
    let captured = MESH_CAPTURE.with(|slot| {
        if let Some(buf) = slot.borrow_mut().as_mut() {
            buf.push(line.clone());
            true
        } else {
            false
        }
    });
    if !captured {
        eprintln!("{line}");
    }
}

pub fn capturing_mesh_logs<T>(body: impl FnOnce() -> T) -> (T, Vec<String>) {
    MESH_CAPTURE.with(|slot| {
        *slot.borrow_mut() = Some(Vec::new());
    });
    let value = body();
    let logs = MESH_CAPTURE.with(|slot| slot.borrow_mut().take().unwrap_or_default());
    (value, logs)
}

use crate::standard_helpers::{homedir_from, join_path, repo_root, unix_millis};

const BODY_LIMIT: usize = 256 * 1024;

#[derive(Debug, Clone)]
pub struct MeshNode {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: f64,
    pub capabilities: Vec<String>,
    pub metadata: Map<String, Value>,
    pub ssh_user: Option<String>,
}

#[derive(Debug, Clone)]
pub struct MeshFile {
    pub updated_at: f64,
    pub nodes: Vec<(String, MeshNode)>,
}

#[derive(Debug, Clone)]
pub struct MeshFailure {
    pub code: &'static str,
    pub message: String,
    pub path: String,
    pub line: u32,
}

impl MeshFailure {
    pub fn log_block(&self) -> String {
        let repo = repo_root();
        let stamp = unix_millis();
        let path = inspect_string(&self.path);
        let types_mesh = ["packages", "types", "dist", "mesh.js"].join("/");
        format!(
            "mesh.json parse failed: MeshParseError: {}\n    at assertRecordMeshFile ({repo}/{types_mesh}:{}:15)\n    at parseMeshFile ({repo}/{types_mesh}:272:12)\n    at loadMeshFile (file://{repo}/services/den-server/dist/mesh.js:60:20)\n    at async build (file://{repo}/services/den-server/dist/mesh.js:192:22) {{\n  code: '{}',\n  severity: 'fatal',\n  context: {{ path: {path} }},\n  retryable: false,\n  timestamp: {stamp},\n  path: {path}\n}}",
            self.message, self.line, self.code
        )
    }
}

fn inspect_string(value: &str) -> String {
    let mut out = String::from("'");
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            '\n' => out.push_str("\\n"),
            other => out.push(other),
        }
    }
    out.push('\'');
    out
}

pub fn mesh_file_paths(mesh_file: &str, shared_root: &str, home: &str) -> Vec<String> {
    if !mesh_file.is_empty() {
        vec![mesh_file.to_string()]
    } else {
        vec![
            join_path(shared_root, &["mesh.json"]),
            join_path(home, &[".rivetos", "mesh.json"]),
        ]
    }
}

pub fn load_mesh_file(
    paths: &[String],
    shared_root: &str,
) -> Result<Option<MeshFile>, MeshFailure> {
    for path in paths {
        let raw = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(_) => continue,
        };
        match parse_mesh_file(&raw, path, shared_root) {
            Ok(file) => return Ok(Some(file)),
            Err(err) if err.code == "MESH_JSON_INVALID" => continue,
            Err(err) => return Err(err),
        }
    }
    Ok(None)
}

fn parse_mesh_file(raw: &str, path: &str, shared_root: &str) -> Result<MeshFile, MeshFailure> {
    let parsed: Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(_) => {
            return Err(MeshFailure {
                code: "MESH_JSON_INVALID",
                message: format!("mesh.json at {path} is not valid JSON"),
                path: path.to_string(),
                line: 216,
            });
        }
    };
    let Some(object) = parsed.as_object() else {
        return Err(MeshFailure {
            code: "MESH_INVALID_SHAPE",
            message: format!("mesh.json at {path} is not a JSON object"),
            path: path.to_string(),
            line: 216,
        });
    };
    if object.get("nodes").is_some_and(Value::is_array) {
        let live = join_path(shared_root, &["mesh.json"]);
        return Err(MeshFailure {
            code: "MESH_FLAT_ARRAY",
            message: format!(
                "mesh.json at {path} uses the pre-capabilities flat-array format, which is no longer supported. Rewrite the file as Record-format {{ version, nodes: {{ [id]: node }}, updatedAt }} (see live {live}; override with RIVETOS_SHARED_DIR)."
            ),
            path: path.to_string(),
            line: 221,
        });
    }
    if let Some(nodes) = object.get("nodes")
        && !nodes.is_null()
        && !nodes.is_object()
    {
        return Err(MeshFailure {
            code: "MESH_INVALID_SHAPE",
            message: format!("mesh.json at {path}: nodes must be an object keyed by node id"),
            path: path.to_string(),
            line: 224,
        });
    }
    let mut nodes = Vec::new();
    if let Some(map) = object.get("nodes").and_then(Value::as_object) {
        for (key, value) in map {
            if value.is_null() {
                continue;
            }
            match parse_node(key, value, path) {
                Ok(node) => nodes.push((key.clone(), node)),
                Err(_) => {
                    mesh_log(format!(
                        "mesh.json at {path}: skipping invalid node \"{key}\""
                    ));
                }
            }
        }
    }
    let updated_at = object
        .get("updatedAt")
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
        .unwrap_or(0.0);
    Ok(MeshFile { updated_at, nodes })
}

fn parse_node(key: &str, raw: &Value, path: &str) -> Result<MeshNode, MeshFailure> {
    let Some(object) = raw.as_object() else {
        return Err(node_err(path, key));
    };
    if object.get("id").is_some_and(|value| !value.is_string())
        || object.get("name").is_some_and(|value| !value.is_string())
        || object.get("host").is_some_and(|value| !value.is_string())
        || object
            .get("port")
            .is_some_and(|value| !value.as_f64().is_some_and(f64::is_finite))
        || object.get("status").is_some_and(|value| !value.is_string())
        || object
            .get("sshUser")
            .is_some_and(|value| !value.is_string())
        || object
            .get("capabilities")
            .is_some_and(|value| !string_array(value))
        || object
            .get("metadata")
            .is_some_and(|value| !value.is_object())
        || object
            .get("agents")
            .is_some_and(|value| !string_array(value))
        || object
            .get("providers")
            .is_some_and(|value| !string_array(value))
        || object
            .get("models")
            .is_some_and(|value| !string_array(value))
    {
        return Err(node_err(path, key));
    }
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .unwrap_or(key)
        .to_string();
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .unwrap_or(id.as_str())
        .to_string();
    Ok(MeshNode {
        id,
        name,
        host: object
            .get("host")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        port: object.get("port").and_then(Value::as_f64).unwrap_or(0.0),
        capabilities: object
            .get("capabilities")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        metadata: object
            .get("metadata")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default(),
        ssh_user: object
            .get("sshUser")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn string_array(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.iter().all(Value::is_string))
}

fn node_err(path: &str, key: &str) -> MeshFailure {
    MeshFailure {
        code: "MESH_NODE_INVALID",
        message: format!("mesh.json at {path}: node \"{key}\" is not an object"),
        path: path.to_string(),
        line: 224,
    }
}

pub fn den_url_for(id: &str, node: &MeshNode) -> Option<String> {
    if let Some(raw) = node.metadata.get("denUrl").and_then(Value::as_str) {
        if raw.is_empty() {
            return None;
        }
        let scheme = url::Url::parse(raw)
            .ok()
            .map(|parsed| parsed.scheme().to_string())
            .unwrap_or_default();
        if scheme != "http" && scheme != "https" {
            mesh_log(format!(
                "[den-server] mesh: ignoring node {id} — denUrl \"{raw}\" is not http(s)"
            ));
            return None;
        }
        return Some(raw.trim_end_matches('/').to_string());
    }
    if node.host.is_empty() {
        return None;
    }
    if let Some(port) = node.metadata.get("denPort") {
        let port = match port {
            Value::Number(number) => number.as_f64(),
            Value::String(text) => text.parse::<f64>().ok(),
            _ => None,
        };
        if let Some(port) = port
            && port.is_finite()
            && port.fract() == 0.0
            && port > 0.0
            && port < 65536.0
        {
            return Some(format!("http://{}:{}", node.host, port as u16));
        }
    }
    if node.capabilities.iter().any(|item| item == "den") {
        return Some(format!("http://{}:5174", node.host));
    }
    None
}

pub struct LocalIdentity {
    pub host: String,
    pub ssh_user: String,
}

pub fn local_mesh_identity(
    file: Option<&MeshFile>,
    node_id: &str,
    fallback_host: &str,
) -> LocalIdentity {
    let Some(file) = file else {
        return LocalIdentity {
            host: fallback_host.to_string(),
            ssh_user: "rivet".to_string(),
        };
    };
    let node = file
        .nodes
        .iter()
        .find(|(key, _)| key == node_id)
        .map(|(_, node)| node)
        .or_else(|| {
            file.nodes
                .iter()
                .find(|(_, node)| node.id == node_id)
                .map(|(_, node)| node)
        });
    let Some(node) = node else {
        return LocalIdentity {
            host: fallback_host.to_string(),
            ssh_user: "rivet".to_string(),
        };
    };
    let host = node.host.trim();
    let host = if host.is_empty() {
        fallback_host.to_string()
    } else {
        host.to_string()
    };
    let ssh_user = node
        .ssh_user
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("rivet")
        .to_string();
    LocalIdentity { host, ssh_user }
}

pub fn mesh_den_origins(file: &MeshFile) -> Vec<String> {
    let mut out = Vec::new();
    for (_, node) in &file.nodes {
        let Some(den_url) = den_url_for(&node.id, node) else {
            continue;
        };
        let Ok(mut parsed) = url::Url::parse(&den_url) else {
            continue;
        };
        let origin = parsed.origin().ascii_serialization();
        if !out.contains(&origin) {
            out.push(origin);
        }
        if !node.metadata.get("denUrl").is_some_and(Value::is_string) {
            if parsed.scheme() == "http" {
                let _ = parsed.set_scheme("https");
            } else {
                let _ = parsed.set_scheme("http");
            }
            let flipped = parsed.origin().ascii_serialization();
            if !out.contains(&flipped) {
                out.push(flipped);
            }
        }
    }
    out
}

pub struct MeshCache {
    pub at: i64,
    pub value: Option<Value>,
}

impl MeshCache {
    pub fn empty() -> Self {
        Self { at: 0, value: None }
    }
}

pub async fn overview(
    paths: &[String],
    shared_root: &str,
    cache_ms: i64,
    local_node_id: &str,
    latest: Option<Value>,
    ca_pem: Option<String>,
    cache: &Mutex<MeshCache>,
) -> Result<Option<Value>, MeshFailure> {
    let now = crate::standard_helpers::unix_millis();
    {
        let cached = cache.lock();
        if cached.value.is_some() && now.saturating_sub(cached.at) < cache_ms {
            return Ok(cached.value.clone());
        }
    }
    let loaded = load_mesh_file(paths, shared_root)?;
    let Some(file) = loaded else {
        let mut cached = cache.lock();
        cached.value = None;
        cached.at = 0;
        return Ok(None);
    };
    let mut enabled = Vec::new();
    for (key, node) in &file.nodes {
        let id = if node.id.is_empty() {
            key.clone()
        } else {
            node.id.clone()
        };
        if let Some(den_url) = den_url_for(&id, node) {
            enabled.push((id, node.name.clone(), den_url));
        }
    }
    let mut nodes = Vec::new();
    for (id, name, den_url) in enabled {
        let probed = probe_healthz(&den_url, ca_pem.as_deref()).await;
        let mut row = Map::new();
        row.insert("id".to_string(), Value::String(id.clone()));
        row.insert("name".to_string(), Value::String(name));
        row.insert("denUrl".to_string(), Value::String(den_url));
        row.insert("online".to_string(), Value::Bool(probed.0));
        row.insert(
            "sessions".to_string(),
            match probed.1 {
                Some(count) => Value::from(count),
                None => Value::Null,
            },
        );
        if id == local_node_id {
            row.insert("latest".to_string(), latest.clone().unwrap_or(Value::Null));
        }
        nodes.push(Value::Object(row));
    }
    let mut body = Map::new();
    let updated = if file.updated_at.fract() == 0.0 && file.updated_at.abs() < (i64::MAX as f64) {
        Value::from(file.updated_at as i64)
    } else {
        serde_json::Number::from_f64(file.updated_at)
            .map(Value::Number)
            .unwrap_or(Value::from(0))
    };
    body.insert("updatedAt".to_string(), updated);
    body.insert("nodes".to_string(), Value::Array(nodes));
    let value = Value::Object(body);
    if cache_ms > 0 {
        let mut cached = cache.lock();
        cached.at = now;
        cached.value = Some(value.clone());
    }
    Ok(Some(value))
}

async fn probe_healthz(den_url: &str, ca_pem: Option<&str>) -> (bool, Option<i64>) {
    let url = format!("{den_url}/healthz");
    let body =
        match tokio::time::timeout(Duration::from_millis(1500), fetch_text(&url, ca_pem)).await {
            Ok(Ok(body)) => body,
            _ => return (false, None),
        };
    let Ok(value) = serde_json::from_str::<Value>(&body) else {
        return (false, None);
    };
    if value.get("ok") != Some(&Value::Bool(true)) {
        return (false, None);
    }
    let sessions = value.get("sessions").and_then(Value::as_i64);
    (true, sessions)
}

async fn fetch_text(url: &str, ca_pem: Option<&str>) -> Result<String, String> {
    let parsed = url::Url::parse(url).map_err(|err| err.to_string())?;
    if parsed.scheme() == "https" {
        return fetch_https(&parsed, ca_pem).await;
    }
    fetch_http(url).await
}

async fn fetch_http(url: &str) -> Result<String, String> {
    let connector = hyper_util::client::legacy::connect::HttpConnector::new();
    let client: hyper_util::client::legacy::Client<_, http_body_util::Empty<bytes::Bytes>> =
        hyper_util::client::legacy::Client::builder(hyper_util::rt::TokioExecutor::new())
            .build(connector);
    let request = hyper::Request::builder()
        .method(hyper::Method::GET)
        .uri(url)
        .body(http_body_util::Empty::<bytes::Bytes>::new())
        .map_err(|err| err.to_string())?;
    let response = client
        .request(request)
        .await
        .map_err(|err| err.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("status {}", status.as_u16()));
    }
    let bytes = http_body_util::BodyExt::collect(response.into_body())
        .await
        .map_err(|err| err.to_string())?
        .to_bytes();
    if bytes.len() > BODY_LIMIT {
        return Err("body".to_string());
    }
    String::from_utf8(bytes.to_vec()).map_err(|err| err.to_string())
}

async fn fetch_https(url: &url::Url, ca_pem: Option<&str>) -> Result<String, String> {
    let host = url.host_str().ok_or_else(|| "host".to_string())?;
    let port = url.port_or_known_default().unwrap_or(443);
    let stream = tokio::net::TcpStream::connect((host, port))
        .await
        .map_err(|err| err.to_string())?;
    let Some(ca_pem) = ca_pem else {
        return Err("ca".to_string());
    };
    let mut roots = rustls::RootCertStore::empty();
    let mut cursor = std::io::Cursor::new(ca_pem.as_bytes());
    let certs = rustls_pemfile::certs(&mut cursor).collect::<Result<Vec<_>, _>>();
    let certs = certs.map_err(|err| err.to_string())?;
    for cert in certs {
        roots.add(cert).map_err(|err| err.to_string())?;
    }
    let provider = std::sync::Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|err| err.to_string())?
        .with_root_certificates(roots)
        .with_no_client_auth();
    let connector = tokio_rustls::TlsConnector::from(std::sync::Arc::new(config));
    let name =
        rustls::pki_types::ServerName::try_from(host.to_string()).map_err(|err| err.to_string())?;
    let mut tls = connector
        .connect(name, stream)
        .await
        .map_err(|err| err.to_string())?;
    let path = if url.query().is_some() {
        format!("{}?{}", url.path(), url.query().unwrap_or(""))
    } else {
        let path = url.path();
        if path.is_empty() {
            "/".to_string()
        } else {
            path.to_string()
        }
    };
    let request = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    tls.write_all(request.as_bytes())
        .await
        .map_err(|err| err.to_string())?;
    let mut buf = Vec::new();
    tls.read_to_end(&mut buf)
        .await
        .map_err(|err| err.to_string())?;
    let text = String::from_utf8_lossy(&buf);
    let Some((head, body)) = text.split_once("\r\n\r\n") else {
        return Err("http".to_string());
    };
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);
    if !(200..300).contains(&status) {
        return Err(format!("status {status}"));
    }
    Ok(body.to_string())
}

pub fn mesh_paths_for(config_mesh: &str, shared_root: &str, env_home: &str) -> Vec<String> {
    mesh_file_paths(config_mesh, shared_root, env_home)
}

pub fn home_for_mesh(env: &std::collections::BTreeMap<String, String>) -> String {
    homedir_from(env)
}
