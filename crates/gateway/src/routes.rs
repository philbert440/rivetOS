use std::path::{Path, PathBuf};
use std::sync::Arc;

use identity::{
    HeaderMap, HeaderVal, RequestIdentity, ResolveUserResult, TRUSTED_USER_HEADER, UserContext,
    resolve_request_user, stamp_user_header,
};
use parking_lot::Mutex;
use serde_json::{Value, json};

use crate::auth::{
    ConnInfo, UNAUTHORIZED_HTML, device_id_from_subject, is_gateway_authorized, is_loopback_host,
    wants_html_unauthorized,
};
use crate::config::GatewayConfig;
use crate::http_codec::{Framing, Incoming, Reply, header, push_new, query_first};
use crate::hub::{Hub, IngestFail, joined_session};
use crate::mesh_view::{MeshCache, home_for_mesh, mesh_paths_for, overview};
use crate::origin::{OriginDecision, check_origin};
use crate::session_key::den_join_key;
use crate::session_owners::audit_tenancy_deny;
use crate::standard_helpers::hostname;

pub struct App {
    pub config: GatewayConfig,
    pub hub: Hub,
    pub peers: Mutex<Vec<String>>,
    pub refused: Mutex<Vec<String>>,
    pub mesh_cache: Mutex<MeshCache>,
}

pub enum Outcome {
    Reply(Reply),
    Upgrade(WsPlan),
    Drop,
}

pub struct WsPlan {
    pub session: Option<String>,
    pub user: Option<UserContext>,
    pub owned_reject: bool,
}

pub struct GatewayRoutes;

impl GatewayRoutes {
    pub fn devices_disabled_body() -> &'static str {
        "{\"error\":\"device enrollment disabled on this node\"}"
    }

    pub fn files_disabled_body() -> &'static str {
        "{\"error\":\"files browser disabled on this node\"}"
    }

    pub fn terminal_disabled_body() -> &'static str {
        "{\"error\":\"terminal disabled\"}"
    }

    pub fn audio_disabled_body() -> &'static str {
        "{\"error\":\"audio mic bridge disabled on this node\",\"hint\":\"set RIVETOS_DEN_AUDIO=1\"}"
    }
}

const ALIASES: &[(&str, &str)] = &[
    ("/api/events", "/events"),
    ("/api/events/event", "/event"),
    ("/api/events/sessions", "/sessions"),
    ("/api/events/state", "/state"),
    ("/api/events/ws", "/ws"),
    ("/api/mesh", "/mesh.json"),
    ("/api/terminal", "/term"),
    ("/api/terminal/config", "/term/config"),
    ("/api/terminal/list", "/term/list"),
    ("/api/terminal/inject", "/term/inject"),
    ("/api/terminal/harness-sessions", "/term/harness-sessions"),
    ("/api/terminal/ws", "/term"),
    ("/api/audio", "/audio"),
    ("/api/audio/status", "/audio/status"),
    ("/api/audio/health", "/audio/health"),
    ("/api/audio/mic", "/audio/mic"),
];

const API_PATHS: &[&str] = &[
    "/event",
    "/events",
    "/sessions",
    "/state",
    "/session",
    "/layout",
    "/mesh.json",
    "/term",
    "/term/config",
    "/term/list",
    "/term/inject",
    "/term/harness-sessions",
    "/audio",
    "/audio/status",
    "/audio/health",
    "/files/list",
    "/files/download",
    "/files/upload",
    "/files/mkdir",
    "/files/rename",
    "/files/delete",
];

pub fn canonicalize(path: &str) -> String {
    if let Some((_, dest)) = ALIASES.iter().find(|(src, _)| *src == path) {
        return (*dest).to_string();
    }
    if let Some(rest) = path.strip_prefix("/api/terminal/") {
        return format!("/term/{rest}");
    }
    if let Some(rest) = path.strip_prefix("/api/files/") {
        return format!("/files/{rest}");
    }
    path.to_string()
}

pub async fn dispatch(app: &Arc<App>, incoming: &Incoming, info: &ConnInfo) -> Outcome {
    let path = canonicalize(&incoming.path);
    let origin_header = header(&incoming.headers, "origin");
    let host_header = header(&incoming.headers, "host").unwrap_or("");
    let tls = info.encrypted;
    let peers = app.peers.lock().clone();
    let decision = check_origin(
        info,
        tls,
        host_header,
        origin_header,
        &app.config.allowed_origins,
        &app.config.allowed_hosts,
        &peers,
    );
    let origin_preset = match decision {
        OriginDecision::Deny { reason } => {
            if incoming.upgrade {
                note_refuse(app, &reason);
                return Outcome::Reply(raw_forbidden());
            }
            note_refuse(app, &reason);
            return Outcome::Reply(json_reply(
                403,
                "{\"error\":\"forbidden origin\"}",
                &[],
                false,
            ));
        }
        OriginDecision::Allow { allow_origin } => allow_headers(allow_origin.as_deref()),
    };
    if incoming.upgrade {
        return upgrade(app, incoming, info, &path, &origin_preset);
    }
    if incoming.method == "OPTIONS" {
        return Outcome::Reply(options_reply(&origin_preset));
    }
    if path == "/healthz" {
        return Outcome::Reply(json_reply(200, &health_body(app), &origin_preset, false));
    }
    let carve = path == "/api/devices/pair"
        || (app.config.devices.enabled && path == "/api/devices/enroll");
    if !carve
        && !is_gateway_authorized(
            info,
            app.config.tls_ready(),
            app.config.tls.require_client_cert,
        )
    {
        return Outcome::Reply(unauthorized(incoming, &path, &origin_preset));
    }
    if incoming.method == "GET" && path == "/" && !app.config.root_redirect.is_empty() {
        return Outcome::Reply(redirect(&app.config.root_redirect, &origin_preset));
    }
    if let Some(reply) = static_reply(app, incoming, &path, &origin_preset) {
        return Outcome::Reply(reply);
    }
    if path == "/api/devices/pair" {
        return Outcome::Reply(pair_reply(incoming, &origin_preset));
    }
    if path == "/api/devices" || path.starts_with("/api/devices/") {
        return Outcome::Reply(json_reply(
            503,
            GatewayRoutes::devices_disabled_body(),
            &origin_preset,
            false,
        ));
    }
    if !is_gateway_authorized(
        info,
        app.config.tls_ready(),
        app.config.tls.require_client_cert,
    ) {
        return Outcome::Reply(unauthorized(incoming, &path, &origin_preset));
    }
    let user = match resolve_ctx(app, incoming, info) {
        Resolve::Off => None,
        Resolve::User(ctx) => Some(ctx),
        Resolve::Unroutable(detail) => {
            eprintln!("[den] unroutable identity: {detail}");
            let body = json!({"error": "unroutable identity", "detail": detail}).to_string();
            return Outcome::Reply(json_reply(403, &body, &origin_preset, true));
        }
    };
    if let Some(reply) = route(app, incoming, &path, &origin_preset, user.as_ref()).await {
        return Outcome::Reply(reply);
    }
    Outcome::Reply(json_reply(
        404,
        "{\"error\":\"not found\"}",
        &origin_preset,
        false,
    ))
}

fn upgrade(
    app: &App,
    incoming: &Incoming,
    info: &ConnInfo,
    path: &str,
    _origin_preset: &[(String, String)],
) -> Outcome {
    if !is_gateway_authorized(
        info,
        app.config.tls_ready(),
        app.config.tls.require_client_cert,
    ) {
        return Outcome::Drop;
    }
    let user = match resolve_ctx(app, incoming, info) {
        Resolve::Off => None,
        Resolve::User(ctx) => Some(ctx),
        Resolve::Unroutable(detail) => {
            eprintln!("[den] unroutable identity on upgrade: {detail}");
            return Outcome::Drop;
        }
    };
    if path != "/ws" {
        return Outcome::Drop;
    }
    if header(&incoming.headers, "sec-websocket-key").is_none() {
        return Outcome::Reply(missing_ws_key());
    }
    let session = joined_session(query_first(&incoming.query, "session"));
    let owned_reject = session
        .as_deref()
        .is_some_and(|id| app.hub.forbidden(id, user.as_ref()));
    if owned_reject
        && let Some(ctx) = user.as_ref()
        && let Some(id) = session.as_deref()
    {
        audit_tenancy_deny("WS /ws attach", id, ctx);
    }
    Outcome::Upgrade(WsPlan {
        session,
        user,
        owned_reject,
    })
}

async fn route(
    app: &Arc<App>,
    incoming: &Incoming,
    path: &str,
    preset: &[(String, String)],
    user: Option<&UserContext>,
) -> Option<Reply> {
    if path == "/api/capabilities" {
        if incoming.method != "GET" {
            return None;
        }
        return Some(json_reply(200, &capabilities_body(app), preset, true));
    }
    if path == "/api/phone-pairing" || path.starts_with("/api/phone-pairing/") {
        return Some(phone_reply(app, incoming, path, preset));
    }
    if path == "/api/voice/transcribe" || path == "/api/voice/speak" {
        let error = if path.ends_with("speak") {
            "voice synthesis is not configured on this node"
        } else {
            "voice transcription is not configured on this node"
        };
        let body = json!({"error": error}).to_string();
        return Some(json_reply(501, &body, preset, true));
    }
    if path.starts_with("/api/voice/") {
        return None;
    }
    if incoming.method == "POST" && (path == "/event" || path == "/events") {
        return Some(ingest_reply(app, incoming, path == "/events", preset));
    }
    if incoming.method == "GET" && path == "/sessions" {
        let body = json!({"sessions": app.hub.sessions(user)}).to_string();
        return Some(json_reply(200, &body, preset, false));
    }
    if incoming.method == "GET" && path == "/mesh.json" {
        return Some(mesh_reply(app, preset).await);
    }
    if incoming.method == "DELETE" && path == "/session" {
        return Some(delete_session(app, incoming, preset, user));
    }
    if path == "/term" || path.starts_with("/term/") {
        return Some(term_reply(app, incoming, path, preset));
    }
    if path == "/audio" || path.starts_with("/audio/") {
        return Some(audio_reply(app, path, preset));
    }
    if path.starts_with("/files/") {
        return Some(files_reply(app, preset));
    }
    if incoming.method == "GET" && path == "/state" {
        return Some(state_reply(app, incoming, preset, user));
    }
    if path == "/layout" {
        return layout_reply(app, incoming, preset);
    }
    None
}

fn ingest_reply(app: &App, incoming: &Incoming, batch: bool, preset: &[(String, String)]) -> Reply {
    let text = String::from_utf8_lossy(&incoming.body);
    match app.hub.ingest_text(batch, &text) {
        Ok(count) if batch => {
            let body = json!({"ok": true, "ingested": count}).to_string();
            json_reply(200, &body, preset, false)
        }
        Ok(_) => json_reply(200, "{\"ok\":true}", preset, false),
        Err(IngestFail::Json) => json_reply(400, "{\"error\":\"invalid JSON\"}", preset, false),
        Err(IngestFail::Batch) => json_reply(
            400,
            "{\"error\":\"expected an array of 1-100 events\"}",
            preset,
            false,
        ),
        Err(IngestFail::Event { index: Some(index) }) => {
            let body = json!({"error": format!("event[{index}] is not a valid v1 AgentEvent")})
                .to_string();
            json_reply(422, &body, preset, false)
        }
        Err(IngestFail::Event { index: None }) => json_reply(
            422,
            "{\"error\":\"not a valid v1 AgentEvent\"}",
            preset,
            false,
        ),
    }
}

fn delete_session(
    app: &App,
    incoming: &Incoming,
    preset: &[(String, String)],
    user: Option<&UserContext>,
) -> Reply {
    let Some(raw) = query_first(&incoming.query, "session") else {
        return json_reply(404, "{\"error\":\"unknown session\"}", preset, false);
    };
    if raw.is_empty() {
        return json_reply(404, "{\"error\":\"unknown session\"}", preset, false);
    }
    let id = den_join_key(raw);
    if app.hub.forbidden(&id, user) {
        if let Some(ctx) = user {
            audit_tenancy_deny("DELETE /session", &id, ctx);
        }
        return json_reply(
            403,
            "{\"error\":\"session is owned by another user\"}",
            preset,
            false,
        );
    }
    if !app.hub.remove_session(raw) {
        return json_reply(404, "{\"error\":\"unknown session\"}", preset, false);
    }
    json_reply(200, "{\"ok\":true}", preset, false)
}

fn state_reply(
    app: &App,
    incoming: &Incoming,
    preset: &[(String, String)],
    user: Option<&UserContext>,
) -> Reply {
    let Some(raw) = query_first(&incoming.query, "session") else {
        return json_reply(404, "{\"error\":\"unknown session\"}", preset, false);
    };
    if raw.is_empty() {
        return json_reply(404, "{\"error\":\"unknown session\"}", preset, false);
    }
    let id = den_join_key(raw);
    if app.hub.forbidden(&id, user) {
        if let Some(ctx) = user {
            audit_tenancy_deny("GET /state", &id, ctx);
        }
        return json_reply(
            403,
            "{\"error\":\"session is owned by another user\"}",
            preset,
            false,
        );
    }
    let Some((_id, room)) = app.hub.room(raw) else {
        return json_reply(404, "{\"error\":\"unknown session\"}", preset, false);
    };
    let body = json!({"session": raw, "state": room}).to_string();
    json_reply(200, &body, preset, false)
}

fn term_reply(app: &App, incoming: &Incoming, path: &str, preset: &[(String, String)]) -> Reply {
    if let Some(error) = term_gate(&app.config) {
        let body = json!({"error": error}).to_string();
        return json_reply(503, &body, preset, false);
    }
    if incoming.method == "GET" && path == "/term/config" {
        return json_reply(200, &term_config_body(app), preset, false);
    }
    if !app.config.term.enabled {
        return json_reply(503, GatewayRoutes::terminal_disabled_body(), preset, false);
    }
    json_reply(503, "{\"error\":\"node-pty unavailable\"}", preset, false)
}

fn term_gate(config: &GatewayConfig) -> Option<&'static str> {
    if config.term.enabled && !config.tls_ready() && !is_loopback_host(&config.host) {
        Some(
            "terminal disabled: gateway TLS (RIVETOS_DEN_TLS_CERT/KEY) required when host is not loopback",
        )
    } else {
        None
    }
}

fn term_config_body(app: &App) -> String {
    let commands = roster(&app.config);
    let default_id = if commands.iter().any(|cmd| cmd.0 == "claude") {
        "claude"
    } else {
        commands.first().map(|cmd| cmd.0).unwrap_or("claude")
    };
    let rows: Vec<Value> = commands
        .into_iter()
        .map(|(id, label, room)| json!({"id": id, "label": label, "room": room}))
        .collect();
    json!({
        "enabled": app.config.term.enabled && term_gate(&app.config).is_none(),
        "default": default_id,
        "maxPtys": app.config.term.max_ptys,
        "active": 0,
        "commands": rows,
    })
    .to_string()
}

fn roster(config: &GatewayConfig) -> Vec<(&'static str, &'static str, bool)> {
    let all = [
        ("claude", "Claude Code", true, Some("claude-code")),
        ("grok", "Grok Build", true, Some("grok-build")),
        ("hermes", "Hermes", true, Some("hermes")),
        ("kimi", "Kimi Code", true, Some("kimi-code")),
        ("codex", "Codex", true, Some("codex")),
        ("opencode", "OpenCode", true, Some("opencode")),
        ("pi", "Pi", true, Some("pi")),
        ("qwen", "Qwen Code", true, Some("qwen-code")),
        ("cursor", "Cursor", true, Some("cursor")),
        ("shell", "Shell", false, None),
    ];
    all.into_iter()
        .filter(
            |(_, _, _, harness)| match (&config.allowed_harnesses, harness) {
                (_, None) => true,
                (None, _) => true,
                (Some(allowed), Some(id)) => allowed.iter().any(|item| item == id),
            },
        )
        .map(|(id, label, room, _)| (id, label, room))
        .collect()
}

fn audio_reply(app: &App, path: &str, preset: &[(String, String)]) -> Reply {
    let _ = path;
    let enabled = app.config.audio.enabled && audio_gate(&app.config).is_none();
    if !enabled {
        let error = audio_gate(&app.config).unwrap_or("audio mic bridge disabled on this node");
        let body = json!({"error": error, "hint": "set RIVETOS_DEN_AUDIO=1"}).to_string();
        return json_reply(503, &body, preset, false);
    }
    json_reply(
        503,
        "{\"error\":\"audio bridge unavailable\"}",
        preset,
        false,
    )
}

fn audio_gate(config: &GatewayConfig) -> Option<&'static str> {
    if config.audio.enabled && !config.tls_ready() && !is_loopback_host(&config.host) {
        Some("audio disabled: gateway TLS required when host is not loopback")
    } else {
        None
    }
}

fn files_reply(app: &App, preset: &[(String, String)]) -> Reply {
    if app.config.files_root.is_empty() {
        return json_reply(503, GatewayRoutes::files_disabled_body(), preset, false);
    }
    if files_gate(&app.config).is_some() {
        return json_reply(503, GatewayRoutes::files_disabled_body(), preset, false);
    }
    let root = &app.config.files_root;
    if !Path::new(root).is_dir() {
        let body = json!({"error": format!("files root not available: {root}")}).to_string();
        return json_reply(503, &body, preset, true);
    }
    json_reply(404, "{\"error\":\"not found\"}", preset, true)
}

fn files_gate(config: &GatewayConfig) -> Option<&'static str> {
    if !config.files_root.is_empty() && !config.tls_ready() && !is_loopback_host(&config.host) {
        Some("files disabled: gateway TLS required when host is not loopback")
    } else {
        None
    }
}

fn phone_reply(app: &App, incoming: &Incoming, path: &str, preset: &[(String, String)]) -> Reply {
    if path == "/api/phone-pairing" && incoming.method == "GET" {
        let reason = phone_unavailable(app);
        let body = json!({"available": false, "reason": reason}).to_string();
        return json_reply(200, &body, preset, true);
    }
    if path == "/api/phone-pairing" && incoming.method == "POST" {
        let reason = phone_unavailable(app);
        let body = json!({"error": reason}).to_string();
        return json_reply(503, &body, preset, true);
    }
    let Some(rest) = path.strip_prefix("/api/phone-pairing/") else {
        return json_reply(404, "{\"error\":\"not found\"}", preset, true);
    };
    let Ok(name) = crate::http_codec::percent_decode_strict(rest) else {
        return json_reply(400, "{\"error\":\"malformed device name\"}", preset, true);
    };
    if !full_match("^[A-Za-z0-9._-]{1,64}$", &name) || incoming.method != "GET" {
        return json_reply(404, "{\"error\":\"not found\"}", preset, true);
    }
    json_reply(200, "{\"state\":\"expired\"}", preset, true)
}

fn phone_unavailable(app: &App) -> &'static str {
    let cli_ok = app
        .config
        .pair_cli_path
        .as_deref()
        .is_some_and(|path| Path::new(path).is_file());
    if !cli_ok {
        return "the rivetos CLI is not found on this node";
    }
    if !Path::new(&app.config.pair_ca_root_dir).is_dir() {
        return "this node does not hold the device CA; pair from the node that does";
    }
    "could not run rivetos pair"
}

fn pair_reply(incoming: &Incoming, preset: &[(String, String)]) -> Reply {
    if incoming.method != "POST" {
        return json_reply(405, "{\"error\":\"POST only\"}", preset, true);
    }
    let _token = pairing_token(&incoming.body);
    json_reply(
        403,
        "{\"error\":\"invalid or expired pairing code\"}",
        preset,
        true,
    )
}

fn pairing_token(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    let Ok(value) = protocol::js::parse(&text) else {
        return String::new();
    };
    value
        .as_object()
        .and_then(|object| object.get("token"))
        .and_then(|token| token.as_str())
        .unwrap_or("")
        .to_string()
}

async fn mesh_reply(app: &Arc<App>, preset: &[(String, String)]) -> Reply {
    let home = home_for_mesh(&app.config.env);
    let paths = mesh_paths_for(&app.config.mesh_file, &app.config.shared_root, &home);
    let latest = app.hub.local_latest();
    let ca = std::fs::read_to_string(&app.config.tls.ca_path).ok();
    match overview(
        &paths,
        &app.config.shared_root,
        app.config.mesh_cache_ms,
        &app.config.node_name,
        latest,
        ca,
        &app.mesh_cache,
    )
    .await
    {
        Ok(Some(value)) => json_reply(200, &value.to_string(), preset, false),
        Ok(None) => json_reply(404, "{\"error\":\"no mesh file\"}", preset, false),
        Err(err) => {
            eprintln!("{}", err.log_block());
            let body = json!({"error": "mesh.json parse failed", "code": err.code}).to_string();
            json_reply(500, &body, preset, false)
        }
    }
}

fn layout_reply(app: &App, incoming: &Incoming, preset: &[(String, String)]) -> Option<Reply> {
    let key = match query_first(&incoming.query, "viewer") {
        None => "default".to_string(),
        Some(value) if full_match("^[A-Za-z0-9_.-]{1,64}$", value) => value.to_string(),
        Some(_) => {
            return Some(json_reply(
                400,
                "{\"error\":\"bad viewer key\"}",
                preset,
                false,
            ));
        }
    };
    let file = Path::new(&app.config.state_dir)
        .join("layouts")
        .join(format!("{key}.json"));
    if incoming.method == "GET" {
        let fallback = Path::new(&app.config.state_dir)
            .join("layouts")
            .join("default.json");
        let src = if file.is_file() { file } else { fallback };
        let Ok(bytes) = std::fs::read(&src) else {
            return Some(json_reply(404, "{\"error\":\"no layout\"}", preset, false));
        };
        let text = String::from_utf8_lossy(&bytes).into_owned();
        return Some(json_reply(200, &text, preset, false));
    }
    if incoming.method == "POST" {
        let text = String::from_utf8_lossy(&incoming.body);
        if protocol::js::parse(&text).is_err() {
            return Some(json_reply(
                400,
                "{\"error\":\"invalid JSON\"}",
                preset,
                false,
            ));
        }
        if let Some(parent) = file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let tmp = file.with_extension("json.tmp");
        if std::fs::write(&tmp, incoming.body.as_slice()).is_err() {
            return Some(json_reply(
                500,
                "{\"error\":\"internal error\"}",
                preset,
                false,
            ));
        }
        if std::fs::rename(&tmp, &file).is_err() {
            return Some(json_reply(
                500,
                "{\"error\":\"internal error\"}",
                preset,
                false,
            ));
        }
        return Some(json_reply(200, "{\"ok\":true}", preset, false));
    }
    None
}

fn capabilities_body(app: &App) -> String {
    let home = home_for_mesh(&app.config.env);
    let mesh = mesh_paths_for(&app.config.mesh_file, &app.config.shared_root, &home)
        .iter()
        .any(|path| Path::new(path).exists());
    let devices = app.config.devices.enabled;
    format!(
        "{{\"subsystems\":{{\"den\":true,\"devices\":{devices},\"mesh\":{mesh}}},\"harnesses\":[{harnesses}]}}",
        harnesses = HARNESS_CAPS
    )
}

const HARNESS_CAPS: &str = "{\"harnessId\":\"claude-code\",\"list\":true,\"read\":true,\"drive\":true,\"resume\":false},{\"harnessId\":\"grok-build\",\"list\":true,\"read\":true,\"drive\":true,\"resume\":false},{\"harnessId\":\"hermes\",\"list\":true,\"read\":true,\"drive\":true,\"resume\":false},{\"harnessId\":\"kimi-code\",\"list\":true,\"read\":true,\"drive\":true,\"resume\":false},{\"harnessId\":\"pi\",\"list\":true,\"read\":true,\"drive\":true,\"resume\":false},{\"harnessId\":\"qwen-code\",\"list\":true,\"read\":true,\"drive\":true,\"resume\":false},{\"harnessId\":\"cursor\",\"list\":true,\"read\":true,\"drive\":true,\"resume\":false},{\"harnessId\":\"cowork\",\"list\":true,\"read\":true,\"drive\":false,\"resume\":false},{\"harnessId\":\"opencode\",\"list\":true,\"read\":true,\"drive\":true,\"resume\":false},{\"harnessId\":\"codex\",\"list\":true,\"read\":true,\"drive\":true,\"resume\":false}";

fn health_body(app: &App) -> String {
    json!({
        "ok": true,
        "sessions": app.hub.room_count(),
        "name": hostname(),
        "node": app.config.node_name,
    })
    .to_string()
}

fn static_reply(
    app: &App,
    incoming: &Incoming,
    path: &str,
    preset: &[(String, String)],
) -> Option<Reply> {
    if incoming.method != "GET" && incoming.method != "HEAD" {
        return None;
    }
    if static_blocked(path) {
        return None;
    }
    if app.config.static_dir.is_empty() {
        return None;
    }
    let root = Path::new(&app.config.static_dir);
    let rel = path.trim_start_matches('/');
    if rel.starts_with("..") {
        return Some(json_reply(404, "{\"error\":\"not found\"}", preset, false));
    }
    let candidate = root.join(rel);
    if !inside(root, &candidate) {
        return Some(json_reply(404, "{\"error\":\"not found\"}", preset, false));
    }
    let file = if candidate.is_dir() {
        candidate.join("index.html")
    } else {
        candidate
    };
    if file.is_file() {
        return Some(file_reply(&file, preset));
    }
    if extname(path).is_empty() {
        let index = root.join("index.html");
        if index.is_file() {
            return Some(file_reply(&index, preset));
        }
    }
    None
}

fn file_reply(path: &Path, preset: &[(String, String)]) -> Reply {
    let bytes = std::fs::read(path).unwrap_or_default();
    let mime = mime_of(&path.to_string_lossy());
    let cache = if hashed_asset(&path.to_string_lossy()) {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let mut headers = preset.to_vec();
    push_new(&mut headers, "Content-Type", mime);
    push_new(&mut headers, "Cache-Control", cache);
    push_new(
        &mut headers,
        "Access-Control-Allow-Methods",
        "GET, POST, PATCH, DELETE, OPTIONS",
    );
    push_new(
        &mut headers,
        "Access-Control-Allow-Headers",
        "content-type, authorization, x-rivet-conversation, x-rivet-title",
    );
    Reply {
        status: 200,
        reason: crate::http_codec::reason_phrase(200),
        headers,
        body: bytes,
        auto: true,
        close: false,
        framing: Framing::Chunked,
    }
}

fn static_blocked(path: &str) -> bool {
    API_PATHS.contains(&path)
        || path.starts_with("/api/")
        || path.starts_with("/term")
        || path.starts_with("/files")
        || path.starts_with("/audio")
}

fn inside(root: &Path, candidate: &Path) -> bool {
    let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    if candidate.exists() {
        let canon = std::fs::canonicalize(candidate).unwrap_or_else(|_| candidate.to_path_buf());
        return canon.starts_with(&root);
    }
    let Some(parent) = candidate.parent() else {
        return false;
    };
    let parent = if parent.exists() {
        std::fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf())
    } else {
        parent.to_path_buf()
    };
    parent.starts_with(&root)
}

fn hashed_asset(path: &str) -> bool {
    let Ok(re) = regress::Regex::new("-[[:alnum:]_]{8}\\.[[:alnum:]_]+$") else {
        return false;
    };
    re.find(path).is_some()
}

fn full_match(pattern: &str, text: &str) -> bool {
    let Ok(re) = regress::Regex::new(pattern) else {
        return false;
    };
    re.find(text)
        .is_some_and(|found| found.start() == 0 && found.end() == text.len())
}

fn extname(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    let Some(dot) = name.rfind('.') else {
        return "";
    };
    if dot == 0 {
        return "";
    }
    &name[dot..]
}

fn mime_of(path: &str) -> &'static str {
    match extname(path) {
        ".html" => "text/html",
        ".js" => "text/javascript",
        ".css" => "text/css",
        ".json" => "application/json",
        ".png" => "image/png",
        ".jpg" => "image/jpeg",
        ".svg" => "image/svg+xml",
        ".zip" => "application/zip",
        ".ttf" => "font/ttf",
        ".otf" => "font/otf",
        ".woff" => "font/woff",
        ".woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

enum Resolve {
    Off,
    User(UserContext),
    Unroutable(String),
}

fn resolve_ctx(app: &App, incoming: &Incoming, info: &ConnInfo) -> Resolve {
    let Some(registry) = app.config.users_registry.as_ref() else {
        return Resolve::Off;
    };
    let mut ident = request_identity(incoming, info);
    match resolve_request_user(registry, &ident) {
        ResolveUserResult::Ok(ctx) => {
            stamp_user_header(&mut ident, Some(&ctx));
            Resolve::User(ctx)
        }
        ResolveUserResult::Err(detail) => Resolve::Unroutable(detail),
    }
}

fn request_identity(incoming: &Incoming, info: &ConnInfo) -> RequestIdentity {
    let mut headers = HeaderMap::new();
    for (name, value) in &incoming.headers {
        if name == TRUSTED_USER_HEADER {
            continue;
        }
        match headers.get(name).cloned() {
            None => {
                headers.insert(name.clone(), HeaderVal::One(value.clone()));
            }
            Some(HeaderVal::One(first)) => {
                headers.insert(name.clone(), HeaderVal::Many(vec![first, value.clone()]));
            }
            Some(HeaderVal::Many(mut many)) => {
                many.push(value.clone());
                headers.insert(name.clone(), HeaderVal::Many(many));
            }
        }
    }
    RequestIdentity {
        remote_address: info.remote.clone(),
        headers,
        device_id: device_id_from_subject(&info.cn, &info.ou),
    }
}

fn unauthorized(incoming: &Incoming, path: &str, preset: &[(String, String)]) -> Reply {
    let accept = header(&incoming.headers, "accept").unwrap_or("");
    if wants_html_unauthorized(&incoming.method, path, accept) {
        let mut headers = preset.to_vec();
        push_new(&mut headers, "Content-Type", "text/html; charset=utf-8");
        push_new(
            &mut headers,
            "Access-Control-Allow-Methods",
            "GET, POST, PATCH, DELETE, OPTIONS",
        );
        push_new(
            &mut headers,
            "Access-Control-Allow-Headers",
            "content-type, authorization, x-rivet-conversation, x-rivet-title",
        );
        return Reply {
            status: 401,
            reason: crate::http_codec::reason_phrase(401),
            headers,
            body: UNAUTHORIZED_HTML.as_bytes().to_vec(),
            auto: true,
            close: false,
            framing: Framing::Chunked,
        };
    }
    json_reply(401, "{\"error\":\"unauthorized\"}", preset, false)
}

fn json_reply(status: u16, body: &str, preset: &[(String, String)], cors_first: bool) -> Reply {
    let headers = if cors_first {
        cors_preset(preset)
    } else {
        preset.to_vec()
    };
    Reply::json(status, body, &headers)
}

fn cors_preset(preset: &[(String, String)]) -> Vec<(String, String)> {
    let mut headers = preset.to_vec();
    push_new(
        &mut headers,
        "Access-Control-Allow-Methods",
        "GET, POST, PATCH, DELETE, OPTIONS",
    );
    push_new(
        &mut headers,
        "Access-Control-Allow-Headers",
        "content-type, authorization, x-rivet-conversation, x-rivet-title",
    );
    headers
}

fn options_reply(preset: &[(String, String)]) -> Reply {
    Reply::empty(204, &cors_preset(preset))
}

fn redirect(location: &str, preset: &[(String, String)]) -> Reply {
    let mut headers = preset.to_vec();
    push_new(&mut headers, "Location", location);
    Reply {
        status: 302,
        reason: crate::http_codec::reason_phrase(302),
        headers,
        body: Vec::new(),
        auto: true,
        close: false,
        framing: Framing::Chunked,
    }
}

fn allow_headers(origin: Option<&str>) -> Vec<(String, String)> {
    let Some(origin) = origin else {
        return Vec::new();
    };
    vec![
        (
            "Access-Control-Allow-Origin".to_string(),
            origin.to_string(),
        ),
        ("Vary".to_string(), "Origin".to_string()),
    ]
}

fn raw_forbidden() -> Reply {
    Reply {
        status: 403,
        reason: crate::http_codec::reason_phrase(403),
        headers: vec![
            ("Connection".to_string(), "close".to_string()),
            ("Content-Length".to_string(), "0".to_string()),
        ],
        body: Vec::new(),
        auto: false,
        close: true,
        framing: Framing::ContentLength,
    }
}

fn missing_ws_key() -> Reply {
    let body = b"Missing or invalid Sec-WebSocket-Key header".to_vec();
    Reply {
        status: 400,
        reason: crate::http_codec::reason_phrase(400),
        headers: vec![
            ("Connection".to_string(), "close".to_string()),
            ("Content-Type".to_string(), "text/html".to_string()),
            ("Content-Length".to_string(), body.len().to_string()),
        ],
        body,
        auto: false,
        close: true,
        framing: Framing::ContentLength,
    }
}

fn note_refuse(app: &App, reason: &str) {
    let mut list = app.refused.lock();
    if list.iter().any(|item| item == reason) || list.len() >= 100 {
        return;
    }
    list.push(reason.to_string());
    eprintln!("[den-server] refused browser request: {reason}");
}

pub fn security_lines(config: &GatewayConfig) -> Vec<String> {
    let mut lines = Vec::new();
    if config.term.enabled && !config.tls_ready() && !is_loopback_host(&config.host) {
        lines.push(format!(
            "[den-server] SECURITY: refusing to enable terminals — RIVETOS_DEN_TERM is set but TLS is not configured and host {} is not loopback. Set RIVETOS_DEN_TLS_CERT + RIVETOS_DEN_TLS_KEY (node cert) and enroll devices with rivet-ca.sh issue-client, or bind den.host to loopback.",
            config.host
        ));
    }
    if config.audio.enabled && !config.tls_ready() && !is_loopback_host(&config.host) {
        lines.push(format!(
            "[den-server] SECURITY: refusing to enable MicBridge — RIVETOS_DEN_AUDIO is set but TLS is not configured and host {} is not loopback.",
            config.host
        ));
    }
    if !config.files_root.is_empty() && !config.tls_ready() && !is_loopback_host(&config.host) {
        lines.push(format!(
            "[den-server] SECURITY: refusing to enable /api/files — files root is set but TLS is not configured and host {} is not loopback.",
            config.host
        ));
    }
    lines
}

pub fn bind_refusal(config: &GatewayConfig) -> Option<String> {
    if !config.tls_ready() && !is_loopback_host(&config.host) {
        Some(format!(
            "[den-server] refusing to bind {}: gateway TLS is required off-loopback (set RIVETOS_DEN_TLS_CERT + RIVETOS_DEN_TLS_KEY to the node cert from rivet-ca issue-node; enroll clients with rivet-ca issue-client). Or bind den.host to 127.0.0.1.",
            config.host
        ))
    } else {
        None
    }
}

pub fn model_discovery_line(env: &std::collections::BTreeMap<String, String>) -> String {
    let home = crate::standard_helpers::homedir_from(env);
    let codex = env
        .get("CODEX_HOME")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{home}/.codex"));
    format!(
        "[den-server] model discovery codex:debug-models:{codex}: spawn codex ENOENT — serving the static sheet"
    )
}

pub fn layouts_dir(config: &GatewayConfig) -> PathBuf {
    Path::new(&config.state_dir).join("layouts")
}
