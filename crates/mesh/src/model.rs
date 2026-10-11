use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

use protocol::JsNumber;
use protocol::js::{JsObject, JsValue};

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

#[derive(Debug, Clone, PartialEq, Default)]
pub struct JsEntries {
    entries: Vec<(String, JsValue)>,
}

impl JsEntries {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    pub fn get(&self, key: &str) -> Option<&JsValue> {
        self.entries
            .iter()
            .find(|(existing, _)| existing == key)
            .map(|(_, value)| value)
    }

    pub fn insert(&mut self, key: impl Into<String>, value: JsValue) {
        let key = key.into();
        if let Some(slot) = self
            .entries
            .iter_mut()
            .find(|(existing, _)| *existing == key)
        {
            slot.1 = value;
        } else {
            self.entries.push((key, value));
        }
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &JsValue)> {
        self.entries
            .iter()
            .map(|(key, value)| (key.as_str(), value))
    }
}

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
    pub metadata: Option<JsValue>,
    pub ssh_user: Option<String>,
    pub install_root: Option<String>,
    pub platform: Option<String>,
    pub extra: JsEntries,
    pub origin: Option<JsValue>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MeshFile {
    pub version: JsNumber,
    pub nodes: Vec<(String, MeshNode)>,
    pub updated_at: JsNumber,
    pub extra: JsEntries,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JoinNodeError {
    MissingFields,
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
            extra: JsEntries::new(),
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
        serde_json::from_str(&node_compact(self)).unwrap_or(Value::Null)
    }
}

pub fn mesh_file_to_value(file: &MeshFile) -> Value {
    serde_json::from_str(&file_compact(file)).unwrap_or(Value::Null)
}

pub fn mesh_file_to_pretty(file: &MeshFile) -> String {
    pretty_json(&file_compact(file))
}

pub fn mesh_nodes_json(nodes: &[MeshNode]) -> String {
    let mut out = String::from("[");
    for (index, node) in nodes.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(&node_compact(node));
    }
    out.push(']');
    canonical_json(&out)
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
    let parsed = match protocol::js::parse(raw) {
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
    parsed: &JsValue,
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
    if let Some(nodes) = root.get("nodes") {
        if nodes.as_array().is_some() {
            return Err(MeshParseError::new(
                MeshParseErrorCode::FlatArray,
                flat_array_message(path),
                path,
                Map::new(),
                None,
            ));
        }
        if nodes.as_object().is_none() {
            return Err(MeshParseError::new(
                MeshParseErrorCode::InvalidShape,
                format!("mesh.json at {path}: nodes must be an object keyed by node id"),
                path,
                Map::new(),
                None,
            ));
        }
    }
    let mut warnings = Vec::new();
    let mut nodes = Vec::new();
    if let Some(nodes_in) = root.get("nodes").and_then(JsValue::as_object) {
        for (key, value) in nodes_in.iter() {
            let key = key.to_utf8().to_string();
            if value.is_null() {
                continue;
            }
            match parse_mesh_node(&key, value, path, false) {
                Ok(node) => nodes.push((key, node)),
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
    let version = finite_js(root.get("version"))
        .map(JsNumber::from)
        .unwrap_or_else(|| JsNumber::from(1_u32));
    let updated_at = finite_js(root.get("updatedAt"))
        .map(JsNumber::from)
        .unwrap_or_else(|| JsNumber::from(0_u32));
    let mut extra = JsEntries::new();
    for (key, value) in root.iter() {
        let key = key.to_utf8();
        if key == "version" || key == "nodes" || key == "updatedAt" {
            continue;
        }
        extra.insert(key, value.clone());
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
    value: &JsValue,
    path: &str,
) -> Result<MeshNode, MeshParseError> {
    parse_mesh_node(key, value, path, false)
}

pub fn mesh_node_from_network(
    key: &str,
    value: &JsValue,
    path: &str,
) -> Result<MeshNode, MeshParseError> {
    parse_mesh_node(key, value, path, true)
}

#[derive(Clone, Debug, PartialEq)]
pub struct JoinedMeshNode {
    original: JsValue,
}

impl JoinedMeshNode {
    pub fn original(&self) -> &JsValue {
        &self.original
    }

    pub fn id(&self) -> &str {
        self.string_field("id").unwrap_or("")
    }

    pub fn port(&self) -> Option<JsNumber> {
        finite_js(self.original.get("port")).map(JsNumber::from)
    }

    pub fn status(&self) -> Option<&str> {
        self.string_field("status")
    }

    pub fn agents(&self) -> Option<Vec<String>> {
        let value = self.original.get("agents")?;
        if is_string_array(value) {
            Some(string_array(Some(value)))
        } else {
            None
        }
    }

    pub fn ssh_user(&self) -> Option<&str> {
        self.string_field("sshUser")
    }

    pub fn metadata(&self) -> Option<&JsValue> {
        self.original
            .get("metadata")
            .filter(|value| value.as_object().is_some())
    }

    pub fn get(&self, key: &str) -> Option<&JsValue> {
        self.original.get(key)
    }

    pub fn into_mesh_node(self) -> MeshNode {
        let mut node = match self.original.as_object() {
            Some(object) => assemble_node(object, ""),
            None => return blank_mesh_node(),
        };
        node.origin = Some(self.original);
        node
    }

    fn string_field(&self, key: &str) -> Option<&str> {
        self.original.get(key).and_then(JsValue::as_str)
    }
}

pub fn mesh_node_from_join(value: &JsValue) -> Result<JoinedMeshNode, JoinNodeError> {
    let Some(object) = value.as_object() else {
        return Err(JoinNodeError::MissingFields);
    };
    if truthy_string(object.get("id")).is_none()
        || truthy_string(object.get("name")).is_none()
        || truthy_string(object.get("host")).is_none()
    {
        return Err(JoinNodeError::MissingFields);
    }
    Ok(JoinedMeshNode {
        original: value.clone(),
    })
}

fn blank_mesh_node() -> MeshNode {
    MeshNode {
        id: String::new(),
        name: String::new(),
        role: None,
        agents: Vec::new(),
        host: String::new(),
        port: JsNumber::from(0_u32),
        providers: Vec::new(),
        models: Vec::new(),
        capabilities: Vec::new(),
        status: "offline".to_string(),
        last_seen: JsNumber::from(0_u32),
        registered_at: JsNumber::from(0_u32),
        version: String::new(),
        metadata: None,
        ssh_user: None,
        install_root: None,
        platform: None,
        extra: JsEntries::new(),
        origin: None,
    }
}

fn parse_mesh_node(
    key: &str,
    raw: &JsValue,
    path: &str,
    null_operators: bool,
) -> Result<MeshNode, MeshParseError> {
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
    check_string(object, path, key, "id", false)?;
    check_string(object, path, key, "name", false)?;
    check_string(object, path, key, "host", false)?;
    check_finite(object, path, key, "port")?;
    check_string(object, path, key, "role", false)?;
    check_string(object, path, key, "status", false)?;
    check_string(object, path, key, "version", false)?;
    check_string(object, path, key, "sshUser", null_operators)?;
    check_string(object, path, key, "installRoot", null_operators)?;
    check_string(object, path, key, "platform", null_operators)?;
    check_finite(object, path, key, "lastSeen")?;
    check_finite(object, path, key, "registeredAt")?;
    check_string_array(object, path, key, "agents")?;
    check_string_array(object, path, key, "providers")?;
    check_string_array(object, path, key, "models")?;
    check_string_array(object, path, key, "capabilities")?;
    if let Some(metadata) = object.get("metadata")
        && metadata.as_object().is_none()
    {
        return Err(node_field_error(path, key, "metadata", "must be an object"));
    }
    Ok(assemble_node(object, key))
}

fn assemble_node(object: &JsObject, record_key: &str) -> MeshNode {
    let id = truthy_string(object.get("id")).unwrap_or_else(|| record_key.to_string());
    let name = truthy_string(object.get("name")).unwrap_or_else(|| id.clone());
    let mut extra = JsEntries::new();
    for (key, value) in object.iter() {
        let key = key.to_utf8();
        if !KNOWN_NODE_KEYS.contains(&key) {
            extra.insert(key, value.clone());
        }
    }
    MeshNode {
        id,
        name,
        role: optional_string(object, "role"),
        agents: string_array(object.get("agents")),
        host: object
            .get("host")
            .and_then(JsValue::as_str)
            .unwrap_or("")
            .to_string(),
        port: finite_or_zero(object, "port"),
        providers: string_array(object.get("providers")),
        models: string_array(object.get("models")),
        capabilities: string_array(object.get("capabilities")),
        status: object
            .get("status")
            .and_then(JsValue::as_str)
            .unwrap_or("offline")
            .to_string(),
        last_seen: finite_or_zero(object, "lastSeen"),
        registered_at: finite_or_zero(object, "registeredAt"),
        version: object
            .get("version")
            .and_then(JsValue::as_str)
            .unwrap_or("")
            .to_string(),
        metadata: object
            .get("metadata")
            .filter(|value| value.as_object().is_some())
            .cloned(),
        ssh_user: optional_string(object, "sshUser"),
        install_root: optional_string(object, "installRoot"),
        platform: optional_string(object, "platform"),
        extra,
        origin: None,
    }
}

fn check_string(
    object: &JsObject,
    path: &str,
    key: &str,
    field: &str,
    null_operator: bool,
) -> Result<(), MeshParseError> {
    if let Some(value) = object.get(field) {
        if null_operator && value.is_null() {
            return Ok(());
        }
        if !value.is_string() {
            return Err(node_field_error(path, key, field, "must be a string"));
        }
    }
    Ok(())
}

fn check_finite(
    object: &JsObject,
    path: &str,
    key: &str,
    field: &str,
) -> Result<(), MeshParseError> {
    if let Some(value) = object.get(field)
        && finite_js(Some(value)).is_none()
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
    object: &JsObject,
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

fn finite_js(value: Option<&JsValue>) -> Option<f64> {
    match value {
        Some(JsValue::Number(number)) if number.is_finite() => Some(*number),
        _ => None,
    }
}

fn finite_or_zero(object: &JsObject, key: &str) -> JsNumber {
    finite_js(object.get(key))
        .map(JsNumber::from)
        .unwrap_or_else(|| JsNumber::from(0_u32))
}

fn is_string_array(value: &JsValue) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.iter().all(JsValue::is_string))
}

fn string_array(value: Option<&JsValue>) -> Vec<String> {
    value
        .and_then(JsValue::as_array)
        .filter(|items| items.iter().all(JsValue::is_string))
        .map(|items| {
            items
                .iter()
                .filter_map(JsValue::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn optional_string(object: &JsObject, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(JsValue::as_str)
        .map(str::to_string)
}

fn truthy_string(value: Option<&JsValue>) -> Option<String> {
    value
        .and_then(JsValue::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

struct JsonObject {
    parts: Vec<(String, String)>,
}

impl JsonObject {
    fn new() -> Self {
        Self { parts: Vec::new() }
    }

    fn field(&mut self, key: &str, value: impl AsRef<str>) {
        self.parts
            .push((js_string_literal(key), value.as_ref().to_string()));
    }

    fn finish(self) -> String {
        let mut out = String::from("{");
        for (index, (key, value)) in self.parts.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            out.push_str(key);
            out.push(':');
            out.push_str(value);
        }
        out.push('}');
        canonical_json(&out)
    }
}

fn node_compact(node: &MeshNode) -> String {
    if let Some(origin) = &node.origin {
        return joined_compact(origin, node);
    }
    typed_node_compact(node)
}

fn joined_compact(origin: &JsValue, node: &MeshNode) -> String {
    let Some(object) = origin.as_object() else {
        return typed_node_compact(node);
    };
    let mut out = JsonObject::new();
    let mut seen = [false; 3];
    for (key, value) in object.iter() {
        let name = key.to_utf8();
        if let Some(index) = operator_index(name) {
            seen[index] = true;
            push_operator(&mut out, name, value, operator_text(node, name));
            continue;
        }
        out.field(name, protocol::js::stringify(value));
    }
    for (index, key) in ["sshUser", "installRoot", "platform"]
        .into_iter()
        .enumerate()
    {
        if !seen[index]
            && let Some(text) = operator_text(node, key)
        {
            out.field(key, js_string_literal(text));
        }
    }
    out.finish()
}

fn operator_index(key: &str) -> Option<usize> {
    match key {
        "sshUser" => Some(0),
        "installRoot" => Some(1),
        "platform" => Some(2),
        _ => None,
    }
}

fn operator_text<'a>(node: &'a MeshNode, key: &str) -> Option<&'a str> {
    match key {
        "sshUser" => node.ssh_user.as_deref(),
        "installRoot" => node.install_root.as_deref(),
        "platform" => node.platform.as_deref(),
        _ => None,
    }
}

fn push_operator(out: &mut JsonObject, key: &str, value: &JsValue, inherited: Option<&str>) {
    if value.is_null() {
        if let Some(text) = inherited {
            out.field(key, js_string_literal(text));
        }
        return;
    }
    out.field(key, protocol::js::stringify(value));
}

fn typed_node_compact(node: &MeshNode) -> String {
    let mut object = JsonObject::new();
    object.field("id", js_string_literal(&node.id));
    object.field("name", js_string_literal(&node.name));
    object.field("host", js_string_literal(&node.host));
    object.field("port", js_number_literal(node.port));
    object.field("agents", js_string_array(&node.agents));
    object.field("providers", js_string_array(&node.providers));
    object.field("models", js_string_array(&node.models));
    object.field("capabilities", js_string_array(&node.capabilities));
    object.field("status", js_string_literal(&node.status));
    object.field("lastSeen", js_number_literal(node.last_seen));
    object.field("registeredAt", js_number_literal(node.registered_at));
    object.field("version", js_string_literal(&node.version));
    if let Some(role) = &node.role {
        object.field("role", js_string_literal(role));
    }
    if let Some(metadata) = &node.metadata {
        object.field("metadata", protocol::js::stringify(metadata));
    }
    if let Some(ssh_user) = &node.ssh_user {
        object.field("sshUser", js_string_literal(ssh_user));
    }
    if let Some(install_root) = &node.install_root {
        object.field("installRoot", js_string_literal(install_root));
    }
    if let Some(platform) = &node.platform {
        object.field("platform", js_string_literal(platform));
    }
    for (key, value) in node.extra.iter() {
        object.field(key, protocol::js::stringify(value));
    }
    object.finish()
}

fn file_compact(file: &MeshFile) -> String {
    let mut nodes = JsonObject::new();
    for (key, node) in &file.nodes {
        nodes.field(key, node_compact(node));
    }
    let nodes_json = nodes.finish();
    let mut object = JsonObject::new();
    object.field("version", js_number_literal(file.version));
    object.field("nodes", nodes_json);
    object.field("updatedAt", js_number_literal(file.updated_at));
    for (key, value) in file.extra.iter() {
        object.field(key, protocol::js::stringify(value));
    }
    object.finish()
}

fn canonical_json(compact: &str) -> String {
    match protocol::js::parse(compact) {
        Ok(value) => protocol::js::stringify(&value),
        Err(_) => compact.to_string(),
    }
}

fn js_string_literal(text: &str) -> String {
    protocol::js::stringify(&JsValue::from_text(text))
}

fn js_number_literal(number: JsNumber) -> String {
    if number.as_f64().is_finite() {
        number.to_string()
    } else {
        "null".to_string()
    }
}

fn js_string_array(items: &[String]) -> String {
    let mut out = String::from("[");
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(&js_string_literal(item));
    }
    out.push(']');
    out
}

fn pretty_json(compact: &str) -> String {
    let bytes = compact.as_bytes();
    let mut index = 0;
    let mut depth = 0_usize;
    let mut out = String::new();
    while index < bytes.len() {
        match bytes[index] {
            b'"' => {
                let start = index;
                index += 1;
                while index < bytes.len() {
                    match bytes[index] {
                        b'\\' => {
                            index += 1;
                            if index < bytes.len() {
                                index += 1;
                            }
                        }
                        b'"' => {
                            index += 1;
                            break;
                        }
                        _ => index += 1,
                    }
                }
                out.push_str(&compact[start..index]);
            }
            b'{' | b'[' => {
                let close = if bytes[index] == b'{' { b'}' } else { b']' };
                if bytes.get(index + 1) == Some(&close) {
                    out.push(bytes[index] as char);
                    out.push(close as char);
                    index += 2;
                } else {
                    out.push(bytes[index] as char);
                    out.push('\n');
                    depth += 1;
                    push_indent(&mut out, depth);
                    index += 1;
                }
            }
            b'}' | b']' => {
                out.push('\n');
                depth = depth.saturating_sub(1);
                push_indent(&mut out, depth);
                out.push(bytes[index] as char);
                index += 1;
            }
            b',' => {
                out.push(',');
                out.push('\n');
                push_indent(&mut out, depth);
                index += 1;
            }
            b':' => {
                out.push(':');
                out.push(' ');
                index += 1;
            }
            byte => {
                out.push(byte as char);
                index += 1;
            }
        }
    }
    out
}

fn push_indent(out: &mut String, depth: usize) {
    for _ in 0..depth {
        out.push_str("  ");
    }
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
    if let Some(raw_url) = metadata
        .and_then(|meta| meta.get("denUrl"))
        .and_then(JsValue::as_str)
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

fn js_port(value: &JsValue) -> Option<u16> {
    let number = match value {
        JsValue::Number(number) => *number,
        JsValue::String(text) => text.to_utf8().parse::<f64>().ok()?,
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
            .is_some_and(JsValue::is_string);
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
    pub metadata: Option<JsValue>,
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
        extra: JsEntries::new(),
        origin: None,
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
