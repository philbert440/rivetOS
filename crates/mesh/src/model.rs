use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

use protocol::JsNumber;

use crate::error::{MeshParseError, MeshParseErrorCode};
use crate::paths::shared_path;

pub const DEFAULT_HEARTBEAT_INTERVAL_MS: u64 = 30_000;
pub const DEFAULT_STALE_THRESHOLD_MS: u64 = 90_000;
pub const DEFAULT_SEED_PORT: u16 = 3000;
pub const MESH_FILE_NAME: &str = "mesh.json";

const KNOWN_NODE_KEYS: &[&str] = &[
    "id",
    "name",
    "host",
    "port",
    "role",
    "status",
    "version",
    "sshUser",
    "installRoot",
    "platform",
    "lastSeen",
    "registeredAt",
    "agents",
    "providers",
    "models",
    "capabilities",
    "metadata",
];

#[derive(Debug, Clone, PartialEq)]
pub struct MeshNode {
    pub id: String,
    pub name: String,
    pub role: Option<String>,
    pub agents: Vec<String>,
    pub host: String,
    pub port: JsNumber,
    pub providers: Vec<String>,
    pub models: Vec<String>,
    pub capabilities: Vec<String>,
    pub status: String,
    pub last_seen: JsNumber,
    pub registered_at: JsNumber,
    pub version: String,
    pub metadata: Option<Map<String, Value>>,
    pub ssh_user: Option<String>,
    pub install_root: Option<String>,
    pub platform: Option<String>,
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MeshFile {
    pub version: JsNumber,
    pub nodes: Vec<(String, MeshNode)>,
    pub updated_at: JsNumber,
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnInvalidNode {
    Throw,
    Skip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MeshParseOptions {
    pub on_invalid_node: OnInvalidNode,
}

impl Default for MeshParseOptions {
    fn default() -> Self {
        Self {
            on_invalid_node: OnInvalidNode::Throw,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParseOutcome {
    pub file: MeshFile,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MeshNodeEvent {
    pub event_type: String,
    pub node: MeshNode,
    pub timestamp: JsNumber,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeshIdentity {
    pub host: String,
    pub ssh_user: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DenUrl {
    pub url: Option<String>,
    pub warning: Option<String>,
}

pub fn now_ms() -> JsNumber {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let millis = u64::try_from(millis).unwrap_or(u64::MAX);
    JsNumber::from(millis)
}

pub fn now_ms_u64() -> u64 {
    now_ms().as_u64().unwrap_or(0)
}

impl MeshFile {
    pub fn empty() -> Self {
        Self {
            version: JsNumber::from(1_u32),
            nodes: Vec::new(),
            updated_at: now_ms(),
            extra: Map::new(),
        }
    }

    pub fn get(&self, id: &str) -> Option<&MeshNode> {
        self.nodes
            .iter()
            .find(|(key, _)| key == id)
            .map(|(_, node)| node)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut MeshNode> {
        self.nodes
            .iter_mut()
            .find(|(key, _)| key == id)
            .map(|(_, node)| node)
    }

    pub fn insert(&mut self, id: String, node: MeshNode) {
        if let Some(slot) = self.nodes.iter_mut().find(|(key, _)| *key == id) {
            slot.1 = node;
        } else {
            self.nodes.push((id, node));
        }
    }

    pub fn values(&self) -> Vec<MeshNode> {
        self.nodes.iter().map(|(_, node)| node.clone()).collect()
    }
}

impl MeshNode {
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("id".to_string(), Value::String(self.id.clone()));
        map.insert("name".to_string(), Value::String(self.name.clone()));
        if let Some(role) = &self.role {
            map.insert("role".to_string(), Value::String(role.clone()));
        }
        map.insert(
            "agents".to_string(),
            Value::Array(self.agents.iter().cloned().map(Value::String).collect()),
        );
        map.insert("host".to_string(), Value::String(self.host.clone()));
        map.insert("port".to_string(), js_value(self.port));
        map.insert(
            "providers".to_string(),
            Value::Array(self.providers.iter().cloned().map(Value::String).collect()),
        );
        map.insert(
            "models".to_string(),
            Value::Array(self.models.iter().cloned().map(Value::String).collect()),
        );
        map.insert(
            "capabilities".to_string(),
            Value::Array(
                self.capabilities
                    .iter()
                    .cloned()
                    .map(Value::String)
                    .collect(),
            ),
        );
        if let Some(metadata) = &self.metadata {
            map.insert("metadata".to_string(), Value::Object(metadata.clone()));
        }
        map.insert("status".to_string(), Value::String(self.status.clone()));
        map.insert("lastSeen".to_string(), js_value(self.last_seen));
        map.insert("registeredAt".to_string(), js_value(self.registered_at));
        map.insert("version".to_string(), Value::String(self.version.clone()));
        if let Some(ssh_user) = &self.ssh_user {
            map.insert("sshUser".to_string(), Value::String(ssh_user.clone()));
        }
        if let Some(install_root) = &self.install_root {
            map.insert(
                "installRoot".to_string(),
                Value::String(install_root.clone()),
            );
        }
        if let Some(platform) = &self.platform {
            map.insert("platform".to_string(), Value::String(platform.clone()));
        }
        for (key, value) in &self.extra {
            map.insert(key.clone(), value.clone());
        }
        Value::Object(map)
    }
}

pub fn mesh_file_to_value(file: &MeshFile) -> Value {
    let mut map = Map::new();
    map.insert("version".to_string(), js_value(file.version));
    let mut nodes = Map::new();
    for (key, node) in &file.nodes {
        nodes.insert(key.clone(), node.to_value());
    }
    map.insert("nodes".to_string(), Value::Object(nodes));
    map.insert("updatedAt".to_string(), js_value(file.updated_at));
    for (key, value) in &file.extra {
        map.insert(key.clone(), value.clone());
    }
    Value::Object(map)
}

pub fn mesh_file_to_pretty(file: &MeshFile) -> Result<String, serde_json::Error> {
    serde_json::to_string_pretty(&mesh_file_to_value(file))
}

fn js_value(number: JsNumber) -> Value {
    serde_json::to_value(number).unwrap_or(Value::Null)
}

pub fn inherit_operator_fields(incoming: MeshNode, existing: Option<&MeshNode>) -> MeshNode {
    let Some(existing) = existing else {
        return incoming;
    };
    let mut merged = incoming;
    if merged.ssh_user.is_none() {
        merged.ssh_user = existing.ssh_user.clone();
    }
    if merged.install_root.is_none() {
        merged.install_root = existing.install_root.clone();
    }
    if merged.platform.is_none() {
        merged.platform = existing.platform.clone();
    }
    merged
}

pub fn operator_host_warning(
    incoming: &MeshNode,
    existing: &MeshNode,
    merged: &MeshNode,
) -> Option<String> {
    if existing.host == incoming.host {
        return None;
    }
    let mut kept = Vec::new();
    if merged.ssh_user.is_some() && incoming.ssh_user.is_none() {
        kept.push("sshUser");
    }
    if merged.install_root.is_some() && incoming.install_root.is_none() {
        kept.push("installRoot");
    }
    if merged.platform.is_some() && incoming.platform.is_none() {
        kept.push("platform");
    }
    if kept.is_empty() {
        return None;
    }
    Some(format!(
        "Node {}: keeping {} recorded for host {} on new host {} — check mesh.json",
        incoming.id,
        kept.join(", "),
        existing.host,
        incoming.host
    ))
}

pub fn parse_mesh_file(
    raw: &str,
    path: &str,
    options: MeshParseOptions,
) -> Result<ParseOutcome, MeshParseError> {
    let parsed = match serde_json::from_str::<Value>(raw) {
        Ok(value) => value,
        Err(err) => {
            return Err(MeshParseError::new(
                MeshParseErrorCode::JsonInvalid,
                format!("mesh.json at {path} is not valid JSON"),
                path,
                Map::new(),
                Some(err.to_string()),
            ));
        }
    };
    assert_record_mesh_file(&parsed, path, options)
}

pub fn assert_record_mesh_file(
    parsed: &Value,
    path: &str,
    options: MeshParseOptions,
) -> Result<ParseOutcome, MeshParseError> {
    let Some(root) = parsed.as_object() else {
        return Err(MeshParseError::new(
            MeshParseErrorCode::InvalidShape,
            format!("mesh.json at {path} is not a JSON object"),
            path,
            Map::new(),
            None,
        ));
    };
    if root.get("nodes").is_some_and(Value::is_array) {
        return Err(MeshParseError::new(
            MeshParseErrorCode::FlatArray,
            flat_array_message(path),
            path,
            Map::new(),
            None,
        ));
    }
    if let Some(nodes) = root.get("nodes")
        && !nodes.is_object()
    {
        return Err(MeshParseError::new(
            MeshParseErrorCode::InvalidShape,
            format!("mesh.json at {path}: nodes must be an object keyed by node id"),
            path,
            Map::new(),
            None,
        ));
    }
    let mut warnings = Vec::new();
    let mut nodes = Vec::new();
    if let Some(nodes_in) = root.get("nodes").and_then(Value::as_object) {
        for (key, value) in nodes_in {
            if value.is_null() {
                continue;
            }
            match parse_mesh_node(key, value, path) {
                Ok(node) => nodes.push((key.clone(), node)),
                Err(err) => {
                    if options.on_invalid_node == OnInvalidNode::Skip
                        && err.code() == MeshParseErrorCode::NodeInvalid
                    {
                        let warning =
                            format!("mesh.json at {path}: skipping invalid node \"{key}\"");
                        warnings.push(warning);
                        continue;
                    }
                    return Err(err);
                }
            }
        }
    }
    let version = root
        .get("version")
        .and_then(finite_number)
        .map(JsNumber::from)
        .unwrap_or_else(|| JsNumber::from(1_u32));
    let updated_at = root
        .get("updatedAt")
        .and_then(finite_number)
        .map(JsNumber::from)
        .unwrap_or_else(|| JsNumber::from(0_u32));
    let mut extra = Map::new();
    for (key, value) in root {
        if key == "version" || key == "nodes" || key == "updatedAt" {
            continue;
        }
        extra.insert(key.clone(), value.clone());
    }
    Ok(ParseOutcome {
        file: MeshFile {
            version,
            nodes,
            updated_at,
            extra,
        },
        warnings,
    })
}

fn flat_array_message(path: &str) -> String {
    format!(
        "mesh.json at {path} uses the pre-capabilities flat-array format, which is no longer supported. Rewrite the file as Record-format {{ version, nodes: {{ [id]: node }}, updatedAt }} (see live {}; override with RIVETOS_SHARED_DIR).",
        shared_path(&["mesh.json"])
    )
}

pub fn mesh_node_from_value(
    key: &str,
    value: &Value,
    path: &str,
) -> Result<MeshNode, MeshParseError> {
    parse_mesh_node(key, value, path)
}

fn parse_mesh_node(key: &str, raw: &Value, path: &str) -> Result<MeshNode, MeshParseError> {
    let Some(object) = raw.as_object() else {
        let mut context = Map::new();
        context.insert("nodeId".to_string(), Value::String(key.to_string()));
        return Err(MeshParseError::new(
            MeshParseErrorCode::NodeInvalid,
            format!("mesh.json at {path}: node \"{key}\" is not an object"),
            path,
            context,
            None,
        ));
    };
    check_string(object, path, key, "id")?;
    check_string(object, path, key, "name")?;
    check_string(object, path, key, "host")?;
    check_finite(object, path, key, "port")?;
    check_string(object, path, key, "role")?;
    check_string(object, path, key, "status")?;
    check_string(object, path, key, "version")?;
    check_string(object, path, key, "sshUser")?;
    check_string(object, path, key, "installRoot")?;
    check_string(object, path, key, "platform")?;
    check_finite(object, path, key, "lastSeen")?;
    check_finite(object, path, key, "registeredAt")?;
    check_string_array(object, path, key, "agents")?;
    check_string_array(object, path, key, "providers")?;
    check_string_array(object, path, key, "models")?;
    check_string_array(object, path, key, "capabilities")?;
    if let Some(metadata) = object.get("metadata")
        && !metadata.is_object()
    {
        return Err(node_field_error(path, key, "metadata", "must be an object"));
    }
    let id = non_empty_string(object.get("id")).unwrap_or_else(|| key.to_string());
    let name = non_empty_string(object.get("name")).unwrap_or_else(|| id.clone());
    let status = object
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("offline")
        .to_string();
    let mut extra = Map::new();
    for (field, value) in object {
        if !KNOWN_NODE_KEYS.contains(&field.as_str()) {
            extra.insert(field.clone(), value.clone());
        }
    }
    Ok(MeshNode {
        id,
        name,
        role: object
            .get("role")
            .and_then(Value::as_str)
            .map(str::to_string),
        agents: string_array(object.get("agents")),
        host: object
            .get("host")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        port: object
            .get("port")
            .and_then(finite_number)
            .map(JsNumber::from)
            .unwrap_or_else(|| JsNumber::from(0_u32)),
        providers: string_array(object.get("providers")),
        models: string_array(object.get("models")),
        capabilities: string_array(object.get("capabilities")),
        status,
        last_seen: object
            .get("lastSeen")
            .and_then(finite_number)
            .map(JsNumber::from)
            .unwrap_or_else(|| JsNumber::from(0_u32)),
        registered_at: object
            .get("registeredAt")
            .and_then(finite_number)
            .map(JsNumber::from)
            .unwrap_or_else(|| JsNumber::from(0_u32)),
        version: object
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        metadata: object.get("metadata").and_then(Value::as_object).cloned(),
        ssh_user: object
            .get("sshUser")
            .and_then(Value::as_str)
            .map(str::to_string),
        install_root: object
            .get("installRoot")
            .and_then(Value::as_str)
            .map(str::to_string),
        platform: object
            .get("platform")
            .and_then(Value::as_str)
            .map(str::to_string),
        extra,
    })
}

fn check_string(
    object: &Map<String, Value>,
    path: &str,
    key: &str,
    field: &str,
) -> Result<(), MeshParseError> {
    if let Some(value) = object.get(field)
        && !value.is_string()
    {
        return Err(node_field_error(path, key, field, "must be a string"));
    }
    Ok(())
}

fn check_finite(
    object: &Map<String, Value>,
    path: &str,
    key: &str,
    field: &str,
) -> Result<(), MeshParseError> {
    if let Some(value) = object.get(field)
        && finite_number(value).is_none()
    {
        return Err(node_field_error(
            path,
            key,
            field,
            "must be a finite number",
        ));
    }
    Ok(())
}

fn check_string_array(
    object: &Map<String, Value>,
    path: &str,
    key: &str,
    field: &str,
) -> Result<(), MeshParseError> {
    if let Some(value) = object.get(field)
        && !is_string_array(value)
    {
        return Err(node_field_error(path, key, field, "must be a string array"));
    }
    Ok(())
}

fn node_field_error(path: &str, key: &str, field: &str, detail: &str) -> MeshParseError {
    let mut context = Map::new();
    context.insert("nodeId".to_string(), Value::String(key.to_string()));
    context.insert("field".to_string(), Value::String(field.to_string()));
    MeshParseError::new(
        MeshParseErrorCode::NodeInvalid,
        format!("mesh.json at {path}: node \"{key}\" has invalid {field} ({detail})"),
        path,
        context,
        None,
    )
}

fn finite_number(value: &Value) -> Option<f64> {
    let number = value.as_f64()?;
    if number.is_finite() {
        Some(number)
    } else {
        None
    }
}

fn is_string_array(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.iter().all(Value::is_string))
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn non_empty_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

pub fn local_mesh_identity(
    nodes: Option<&[(String, MeshNode)]>,
    node_id: &str,
    fallback_host: &str,
) -> MeshIdentity {
    let Some(nodes) = nodes else {
        return MeshIdentity {
            host: fallback_host.to_string(),
            ssh_user: "rivet".to_string(),
        };
    };
    let by_key = nodes
        .iter()
        .find(|(key, _)| key == node_id)
        .map(|(_, node)| node);
    let by_id = nodes
        .iter()
        .find(|(_, node)| node.id == node_id)
        .map(|(_, node)| node);
    let Some(node) = by_key.or(by_id) else {
        return MeshIdentity {
            host: fallback_host.to_string(),
            ssh_user: "rivet".to_string(),
        };
    };
    let host = protocol::js::js_trim(&node.host);
    let ssh_user = node
        .ssh_user
        .as_deref()
        .map(protocol::js::js_trim)
        .filter(|text| !text.is_empty())
        .unwrap_or("rivet");
    MeshIdentity {
        host: if host.is_empty() {
            fallback_host.to_string()
        } else {
            host.to_string()
        },
        ssh_user: ssh_user.to_string(),
    }
}

pub fn den_url_for(id: &str, node: &MeshNode) -> DenUrl {
    let metadata = node.metadata.as_ref();
    if let Some(Value::String(raw_url)) = metadata.and_then(|meta| meta.get("denUrl"))
        && !raw_url.is_empty()
    {
        let scheme = url::Url::parse(raw_url)
            .ok()
            .map(|url| url.scheme().to_string())
            .unwrap_or_default();
        if scheme != "http" && scheme != "https" {
            return DenUrl {
                url: None,
                warning: Some(format!(
                    "[den-server] mesh: ignoring node {id} — denUrl \"{raw_url}\" is not http(s)"
                )),
            };
        }
        return DenUrl {
            url: Some(raw_url.trim_end_matches('/').to_string()),
            warning: None,
        };
    }
    if node.host.is_empty() {
        return DenUrl {
            url: None,
            warning: None,
        };
    }
    if let Some(port) = metadata
        .and_then(|meta| meta.get("denPort"))
        .and_then(js_port)
    {
        return DenUrl {
            url: Some(format!("http://{}:{port}", node.host)),
            warning: None,
        };
    }
    if node.capabilities.iter().any(|item| item == "den") {
        return DenUrl {
            url: Some(format!("http://{}:5174", node.host)),
            warning: None,
        };
    }
    DenUrl {
        url: None,
        warning: None,
    }
}

fn js_port(value: &Value) -> Option<u16> {
    let number = match value {
        Value::Number(number) => number.as_f64()?,
        Value::String(text) => text.parse::<f64>().ok()?,
        _ => return None,
    };
    if !number.is_finite() || number.fract() != 0.0 {
        return None;
    }
    let port = number as i64;
    if (1..65536).contains(&port) {
        u16::try_from(port).ok()
    } else {
        None
    }
}

pub fn mesh_den_origins(file: &MeshFile) -> Vec<String> {
    let mut out = Vec::new();
    for (key, node) in &file.nodes {
        let id = if node.id.is_empty() {
            key.as_str()
        } else {
            node.id.as_str()
        };
        let Some(den_url) = den_url_for(id, node).url else {
            continue;
        };
        let Ok(url) = url::Url::parse(&den_url) else {
            continue;
        };
        push_unique(&mut out, origin_of(&url));
        let explicit = node
            .metadata
            .as_ref()
            .and_then(|meta| meta.get("denUrl"))
            .is_some_and(Value::is_string);
        if !explicit {
            let mut flipped = url;
            let scheme = if flipped.scheme() == "http" {
                "https"
            } else {
                "http"
            };
            if flipped.set_scheme(scheme).is_ok() {
                push_unique(&mut out, origin_of(&flipped));
            }
        }
    }
    out
}

fn origin_of(url: &url::Url) -> String {
    url.origin().ascii_serialization()
}

fn push_unique(out: &mut Vec<String>, value: String) {
    if !value.is_empty() && !out.iter().any(|existing| existing == &value) {
        out.push(value);
    }
}

pub struct BuildLocalNodeArgs {
    pub existing_id: Option<String>,
    pub name: Option<String>,
    pub role: Option<String>,
    pub agents: Vec<String>,
    pub host: String,
    pub port: u32,
    pub providers: Vec<String>,
    pub models: Vec<String>,
    pub capabilities: Option<Vec<String>>,
    pub metadata: Option<Map<String, Value>>,
    pub version: String,
}

pub fn build_local_node(args: BuildLocalNodeArgs) -> MeshNode {
    let now = now_ms();
    MeshNode {
        id: args.existing_id.unwrap_or_else(random_uuid),
        name: args.name.unwrap_or_else(system_hostname),
        role: args.role,
        agents: args.agents,
        host: args.host,
        port: JsNumber::from(args.port),
        providers: args.providers,
        models: args.models,
        capabilities: args.capabilities.unwrap_or_default(),
        status: "online".to_string(),
        last_seen: now,
        registered_at: now,
        version: args.version,
        metadata: args.metadata,
        ssh_user: None,
        install_root: None,
        platform: None,
        extra: Map::new(),
    }
}

fn system_hostname() -> String {
    hostname::get()
        .ok()
        .and_then(|name| name.into_string().ok())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "localhost".to_string())
}

fn random_uuid() -> String {
    let mut bytes = [0_u8; 16];
    fill_random(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

pub fn fill_random(bytes: &mut [u8]) {
    if getrandom::getrandom(bytes).is_err() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let raw = nanos.to_le_bytes();
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = raw[index % raw.len()] ^ ((index as u8).wrapping_mul(17));
        }
    }
}

pub fn cmp_last_seen_desc(left: &MeshNode, right: &MeshNode) -> std::cmp::Ordering {
    right
        .last_seen
        .as_f64()
        .partial_cmp(&left.last_seen.as_f64())
        .unwrap_or(std::cmp::Ordering::Equal)
}
