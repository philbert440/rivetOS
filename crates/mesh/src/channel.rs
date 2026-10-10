use std::collections::HashMap;
use std::convert::Infallible;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{Map, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio_rustls::TlsAcceptor;

use protocol::JsNumber;
use protocol::events::InboundMessage;

use crate::error::MeshError;
use crate::model::{MeshNode, fill_random, mesh_node_from_value, now_ms, now_ms_u64};
use crate::tls::{TlsMaterial, client_config, server_config};

const BODY_LIMIT: usize = 8 * 1024 * 1024;

pub type MessageFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
pub type MessageHandler = Arc<dyn Fn(InboundMessage) -> MessageFuture + Send + Sync>;
pub type MeshNodesFuture = Pin<Box<dyn Future<Output = Result<Vec<MeshNode>, String>> + Send>>;
pub type MeshNodesFn = Arc<dyn Fn() -> MeshNodesFuture + Send + Sync>;
pub type MeshJoinFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
pub type MeshJoinFn = Arc<dyn Fn(MeshNode) -> MeshJoinFuture + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerConfig {
    pub url: String,
    pub secret: Option<String>,
}

#[derive(Clone)]
pub struct AgentChannelConfig {
    pub agent_id: String,
    pub port: u16,
    pub host: String,
    pub secret: Option<String>,
    pub peers: Vec<(String, PeerConfig)>,
    pub tls: Option<TlsMaterial>,
    pub get_mesh_nodes: Option<MeshNodesFn>,
    pub on_mesh_join: Option<MeshJoinFn>,
}

impl AgentChannelConfig {
    pub fn new(agent_id: impl Into<String>) -> Self {
        Self {
            agent_id: agent_id.into(),
            port: 3100,
            host: "0.0.0.0".to_string(),
            secret: None,
            peers: Vec::new(),
            tls: None,
            get_mesh_nodes: None,
            on_mesh_join: None,
        }
    }
}

struct ServerHandle {
    shutdown: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}

struct Inner {
    config: AgentChannelConfig,
    handler: Mutex<Option<MessageHandler>>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<String>>>>,
    bound_port: AtomicU16,
    server: Mutex<Option<ServerHandle>>,
}

#[derive(Clone)]
pub struct AgentChannel {
    inner: Arc<Inner>,
}

impl AgentChannel {
    pub fn new(config: AgentChannelConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                config,
                handler: Mutex::new(None),
                pending: Arc::new(Mutex::new(HashMap::new())),
                bound_port: AtomicU16::new(0),
                server: Mutex::new(None),
            }),
        }
    }

    pub fn id(&self) -> String {
        format!("agent-{}", self.inner.config.agent_id)
    }

    pub fn platform(&self) -> &'static str {
        "agent"
    }

    pub fn bound_port(&self) -> u16 {
        self.inner.bound_port.load(Ordering::SeqCst)
    }

    pub fn on_message<F, Fut>(&self, handler: F)
    where
        F: Fn(InboundMessage) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), String>> + Send + 'static,
    {
        let handler: MessageHandler = Arc::new(move |message| Box::pin(handler(message)));
        *lock(&self.inner.handler) = Some(handler);
    }

    pub fn send(&self, channel_id: &str, text: &str) -> Option<String> {
        if text.is_empty() {
            return None;
        }
        let mut pending = lock(&self.inner.pending);
        let sender = pending.remove(channel_id)?;
        let _ = sender.send(text.to_string());
        Some(channel_id.to_string())
    }

    pub async fn start(&self) -> Result<(), MeshError> {
        self.stop().await;
        let addr = format!("{}:{}", self.inner.config.host, self.inner.config.port);
        let listener = match TcpListener::bind(&addr).await {
            Ok(listener) => listener,
            Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => {
                return Err(MeshError::message(format!(
                    "Agent channel port {} is already in use",
                    self.inner.config.port
                )));
            }
            Err(err) => return Err(err.into()),
        };
        let bound = listener.local_addr()?.port();
        self.inner.bound_port.store(bound, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        let inner = Arc::clone(&self.inner);
        let task = tokio::spawn(async move {
            if inner.config.tls.is_some() {
                run_tls(inner, listener, rx).await;
            } else {
                run_axum(inner, listener, rx).await;
            }
        });
        *lock(&self.inner.server) = Some(ServerHandle {
            shutdown: Some(tx),
            task,
        });
        Ok(())
    }

    pub async fn stop(&self) {
        self.resolve_pending("[channel shutting down]");
        let server = lock(&self.inner.server).take();
        if let Some(mut server) = server {
            if let Some(tx) = server.shutdown.take() {
                let _ = tx.send(());
            }
            tokio::select! {
                _ = &mut server.task => {}
                _ = tokio::time::sleep(Duration::from_secs(2)) => {
                    server.task.abort();
                    let _ = server.task.await;
                }
            }
        }
    }

    pub fn create_message_tool(&self) -> AgentMessageTool {
        AgentMessageTool {
            channel: self.clone(),
        }
    }

    pub async fn send_to_peer(&self, peer: &PeerConfig, body: &Value) -> Result<Value, String> {
        let url = format!("{}/api/message", peer.url.trim_end_matches('/'));
        let timeout_ms = body.get("timeoutMs").and_then(finite_timeout);
        let mut builder = reqwest::Client::builder();
        if let Some(material) = &self.inner.config.tls {
            let config = client_config(material).map_err(|err| err.to_string())?;
            builder = builder.use_preconfigured_tls(config);
        }
        if let Some(ms) = timeout_ms {
            builder = builder.timeout(Duration::from_millis(ms.saturating_add(5000)));
        }
        let client = builder.build().map_err(|err| err.to_string())?;
        let mut request = client.post(&url).json(body);
        if self.inner.config.tls.is_none() {
            let secret = peer
                .secret
                .clone()
                .or_else(|| self.inner.config.secret.clone());
            let header = match secret {
                Some(secret) => format!("Bearer {secret}"),
                None => "Bearer undefined".to_string(),
            };
            request = request.header("authorization", header);
        }
        let response = request.send().await.map_err(|err| err.to_string())?;
        let status = response.status();
        if !status.is_success() {
            let text = response
                .text()
                .await
                .unwrap_or_else(|_| "unknown error".to_string());
            return Err(format!("HTTP {}: {text}", status.as_u16()));
        }
        response.json().await.map_err(|err| err.to_string())
    }

    fn resolve_pending(&self, text: &str) {
        let pending = std::mem::take(&mut *lock(&self.inner.pending));
        for (_, sender) in pending {
            let _ = sender.send(text.to_string());
        }
    }
}

pub struct AgentMessageTool {
    channel: AgentChannel,
}

impl AgentMessageTool {
    pub fn name(&self) -> &'static str {
        "agent_message"
    }

    pub fn schema(&self) -> Value {
        serde_json::json!({
            "name": "agent_message",
            "description": "Send a message to another agent on a different instance. The message goes through the remote agent's full pipeline (memory, hooks, tools). Use for cross-instance collaboration — the remote agent sees it as a real message.",
            "parameters": {
                "type": "object",
                "properties": {
                    "to_agent": {
                        "type": "string",
                        "description": "Agent ID to message (must be configured as a peer)"
                    },
                    "message": {
                        "type": "string",
                        "description": "Message to send"
                    },
                    "wait_for_response": {
                        "type": "boolean",
                        "description": "Wait for the remote agent to respond (default: true)"
                    },
                    "timeout_ms": {
                        "type": "number",
                        "description": "Timeout in ms when waiting for response (default: none — waits until done)"
                    }
                },
                "required": ["to_agent", "message"]
            }
        })
    }

    pub async fn execute(&self, args: &Value) -> String {
        let to_agent = args.get("to_agent").and_then(Value::as_str).unwrap_or("");
        let message = args.get("message").and_then(Value::as_str).unwrap_or("");
        let wait = wait_flag(args.get("wait_for_response"));
        let timeout_ms = finite_timeout(args.get("timeout_ms").unwrap_or(&Value::Null));
        let Some((_, peer)) = self
            .channel
            .inner
            .config
            .peers
            .iter()
            .find(|(name, _)| name == to_agent)
        else {
            let available = peer_names(&self.channel.inner.config.peers);
            return format!(
                "Error: Unknown peer agent \"{to_agent}\". Available peers: {available}"
            );
        };
        let mut body = Map::new();
        body.insert(
            "fromAgent".to_string(),
            Value::String(self.channel.inner.config.agent_id.clone()),
        );
        body.insert("message".to_string(), Value::String(message.to_string()));
        body.insert("waitForResponse".to_string(), Value::Bool(wait));
        if let Some(ms) = timeout_ms {
            body.insert(
                "timeoutMs".to_string(),
                Value::Number(serde_json::Number::from(ms)),
            );
        }
        match self.channel.send_to_peer(peer, &Value::Object(body)).await {
            Ok(response) => {
                if wait {
                    match response.get("response") {
                        Some(Value::String(text)) => text.clone(),
                        Some(Value::Null) | None => "[no response]".to_string(),
                        Some(other) => other.to_string(),
                    }
                } else {
                    let request_id = match response.get("requestId") {
                        None => "undefined".to_string(),
                        Some(Value::Null) => "null".to_string(),
                        Some(Value::String(text)) => text.clone(),
                        Some(other) => other.to_string(),
                    };
                    format!(
                        "Message sent to {to_agent} (async — no response expected). Request ID: {request_id}"
                    )
                }
            }
            Err(err) => format!("Error sending message to {to_agent}: {err}"),
        }
    }
}

pub fn agent_channel_from_plugin_config(cfg: &Value) -> AgentChannel {
    let object = cfg.as_object();
    let agent_id = object
        .and_then(|map| map.get("agentId"))
        .and_then(Value::as_str)
        .or_else(|| {
            object
                .and_then(|map| map.get("agent_id"))
                .and_then(Value::as_str)
        })
        .unwrap_or("")
        .to_string();
    let mut config = AgentChannelConfig::new(agent_id);
    if let Some(port) = object
        .and_then(|map| map.get("port"))
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
    {
        config.port = port;
    }
    if let Some(host) = object
        .and_then(|map| map.get("host"))
        .and_then(Value::as_str)
    {
        config.host = host.to_string();
    }
    if let Some(secret) = object
        .and_then(|map| map.get("secret"))
        .and_then(Value::as_str)
    {
        config.secret = Some(secret.to_string());
    }
    if let Some(peers) = object
        .and_then(|map| map.get("peers"))
        .and_then(Value::as_object)
    {
        for (name, peer) in peers {
            let Some(peer) = peer.as_object() else {
                continue;
            };
            let url = peer
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let secret = peer
                .get("secret")
                .and_then(Value::as_str)
                .map(str::to_string);
            config
                .peers
                .push((name.clone(), PeerConfig { url, secret }));
        }
    }
    if let Some(tls) = object
        .and_then(|map| map.get("tls"))
        .and_then(Value::as_object)
        && let (Some(ca), Some(cert), Some(key)) = (
            pem_bytes(tls.get("ca")),
            pem_bytes(tls.get("cert")),
            pem_bytes(tls.get("key")),
        )
    {
        config.tls = Some(TlsMaterial {
            ca_pem: ca,
            cert_pem: cert,
            key_pem: key,
        });
    }
    AgentChannel::new(config)
}

struct Reply {
    status: StatusCode,
    body: Vec<u8>,
}

impl Inner {
    async fn handle_hyper(&self, req: Request<Incoming>) -> Response<Full<Bytes>> {
        let (parts, body) = req.into_parts();
        if parts.headers.contains_key("origin") {
            return to_hyper(json_reply(
                StatusCode::FORBIDDEN,
                &error_body("browser requests are not accepted"),
            ));
        }
        let path = request_path(&parts.uri);
        if needs_body(&parts.method, &path) {
            match read_incoming(body).await {
                Ok(bytes) => to_hyper(
                    self.route(&parts.method, &path, &parts.headers, Some(&bytes))
                        .await,
                ),
                Err(()) => to_hyper(invalid_json()),
            }
        } else {
            to_hyper(self.route(&parts.method, &path, &parts.headers, None).await)
        }
    }

    async fn handle_axum(&self, req: axum::extract::Request) -> axum::response::Response {
        let (parts, body) = req.into_parts();
        if parts.headers.contains_key("origin") {
            return to_axum(json_reply(
                StatusCode::FORBIDDEN,
                &error_body("browser requests are not accepted"),
            ));
        }
        let path = request_path(&parts.uri);
        if needs_body(&parts.method, &path) {
            match read_axum_body(body).await {
                Ok(bytes) => to_axum(
                    self.route(&parts.method, &path, &parts.headers, Some(&bytes))
                        .await,
                ),
                Err(()) => to_axum(invalid_json()),
            }
        } else {
            to_axum(self.route(&parts.method, &path, &parts.headers, None).await)
        }
    }

    async fn route(
        &self,
        method: &hyper::Method,
        path: &str,
        headers: &hyper::HeaderMap,
        body: Option<&[u8]>,
    ) -> Reply {
        if method == hyper::Method::GET && path == "/health" {
            return json_reply(StatusCode::OK, &health_body(&self.config.agent_id));
        }
        if method == hyper::Method::POST && path == "/api/message" {
            return self.handle_message(body.unwrap_or_default()).await;
        }
        if method == hyper::Method::GET && path == "/api/mesh" {
            return self.handle_mesh_get(headers).await;
        }
        if method == hyper::Method::POST && path == "/api/mesh/join" {
            return self
                .handle_mesh_join(headers, body.unwrap_or_default())
                .await;
        }
        if method == hyper::Method::GET && path == "/api/mesh/ping" {
            return json_reply(StatusCode::OK, &ping_body(&self.config.agent_id));
        }
        json_reply(StatusCode::NOT_FOUND, &error_body("Not found"))
    }

    async fn handle_message(&self, bytes: &[u8]) -> Reply {
        let body = match serde_json::from_slice::<Value>(bytes) {
            Ok(body) => body,
            Err(_) => return invalid_json(),
        };
        let Some(from_agent) = truthy_string(&body, "fromAgent") else {
            return json_reply(
                StatusCode::BAD_REQUEST,
                &error_body("Missing required fields: fromAgent, message"),
            );
        };
        let Some(message) = truthy_string(&body, "message") else {
            return json_reply(
                StatusCode::BAD_REQUEST,
                &error_body("Missing required fields: fromAgent, message"),
            );
        };
        let from_agent = from_agent.to_string();
        let message = message.to_string();
        let conversation_id = body
            .get("conversationId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let request_id = new_request_id();
        let inbound = inbound_message(
            &self.config.agent_id,
            &from_agent,
            &message,
            conversation_id.as_deref(),
            &request_id,
        );
        if waits_for_response(&body) {
            let handler = lock(&self.handler).clone();
            let Some(handler) = handler else {
                return json_reply(
                    StatusCode::SERVICE_UNAVAILABLE,
                    &error_body("No message handler registered"),
                );
            };
            let (tx, rx) = oneshot::channel();
            lock(&self.pending).insert(request_id.clone(), tx);
            let request_for_handler = request_id.clone();
            let handler_pending = Arc::clone(&self.pending);
            tokio::spawn(async move {
                if let Err(msg) = handler(inbound).await
                    && let Some(sender) = lock(&handler_pending).remove(&request_for_handler)
                {
                    let _ = sender.send(format!("[error processing message: {msg}]"));
                }
            });
            let timeout_ms = body.get("timeoutMs").and_then(finite_timeout);
            let text = wait_for_text(self.pending.as_ref(), &request_id, rx, timeout_ms).await;
            let mut response = Map::new();
            response.insert("response".to_string(), Value::String(text));
            response.insert(
                "agent".to_string(),
                Value::String(self.config.agent_id.clone()),
            );
            response.insert("fromAgent".to_string(), Value::String(from_agent));
            response.insert("timestamp".to_string(), number_value(now_ms()));
            json_reply(StatusCode::OK, &Value::Object(response))
        } else {
            if let Some(handler) = lock(&self.handler).clone() {
                tokio::spawn(async move {
                    let _ = handler(inbound).await;
                });
            }
            let mut response = Map::new();
            response.insert("status".to_string(), Value::String("accepted".to_string()));
            response.insert("requestId".to_string(), Value::String(request_id));
            response.insert(
                "agent".to_string(),
                Value::String(self.config.agent_id.clone()),
            );
            response.insert("timestamp".to_string(), number_value(now_ms()));
            json_reply(StatusCode::ACCEPTED, &Value::Object(response))
        }
    }

    async fn handle_mesh_get(&self, headers: &hyper::HeaderMap) -> Reply {
        if let Some(reply) = self.check_auth(headers) {
            return reply;
        }
        let Some(getter) = &self.config.get_mesh_nodes else {
            return json_reply(
                StatusCode::NOT_IMPLEMENTED,
                &error_body("Mesh not enabled on this node"),
            );
        };
        match getter().await {
            Ok(nodes) => {
                let values = nodes.into_iter().map(|node| node.to_value()).collect();
                json_reply(StatusCode::OK, &Value::Array(values))
            }
            Err(msg) => json_reply(
                StatusCode::INTERNAL_SERVER_ERROR,
                &error_body(&format!("Failed to get mesh nodes: {msg}")),
            ),
        }
    }

    async fn handle_mesh_join(&self, headers: &hyper::HeaderMap, bytes: &[u8]) -> Reply {
        if let Some(reply) = self.check_auth(headers) {
            return reply;
        }
        let Some(join) = self.config.on_mesh_join.clone() else {
            return json_reply(
                StatusCode::NOT_IMPLEMENTED,
                &error_body("Mesh not enabled on this node"),
            );
        };
        let body = match serde_json::from_slice::<Value>(bytes) {
            Ok(body) => body,
            Err(_) => return invalid_json(),
        };
        let Some((id, name, host)) = required_join_fields(&body) else {
            return json_reply(
                StatusCode::BAD_REQUEST,
                &error_body("Missing required fields: id, name, host"),
            );
        };
        let node = match mesh_node_from_value(id, &body, "join") {
            Ok(node) => node,
            Err(_) => minimal_node(id, name, host),
        };
        if let Err(msg) = join(node).await {
            return json_reply(
                StatusCode::INTERNAL_SERVER_ERROR,
                &error_body(&format!("Failed to join mesh: {msg}")),
            );
        }
        let nodes = if let Some(getter) = &self.config.get_mesh_nodes {
            match getter().await {
                Ok(nodes) => nodes,
                Err(msg) => {
                    return json_reply(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        &error_body(&format!("Failed to join mesh: {msg}")),
                    );
                }
            }
        } else {
            Vec::new()
        };
        let mut response = Map::new();
        response.insert("status".to_string(), Value::String("joined".to_string()));
        response.insert(
            "nodes".to_string(),
            Value::Array(nodes.into_iter().map(|node| node.to_value()).collect()),
        );
        json_reply(StatusCode::OK, &Value::Object(response))
    }

    fn check_auth(&self, headers: &hyper::HeaderMap) -> Option<Reply> {
        if self.config.tls.is_some() {
            return None;
        }
        let header = headers
            .get(hyper::header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok());
        let Some(header) = header else {
            return Some(json_reply(
                StatusCode::UNAUTHORIZED,
                &error_body("Missing or invalid authorization"),
            ));
        };
        let Some(token) = header.strip_prefix("Bearer ") else {
            return Some(json_reply(
                StatusCode::UNAUTHORIZED,
                &error_body("Missing or invalid authorization"),
            ));
        };
        if self.config.secret.as_deref() != Some(token) {
            return Some(json_reply(
                StatusCode::FORBIDDEN,
                &error_body("Invalid secret"),
            ));
        }
        None
    }
}

async fn wait_for_text(
    pending: &Mutex<HashMap<String, oneshot::Sender<String>>>,
    request_id: &str,
    rx: oneshot::Receiver<String>,
    timeout_ms: Option<u64>,
) -> String {
    match timeout_ms {
        Some(ms) => match tokio::time::timeout(Duration::from_millis(ms), rx).await {
            Ok(Ok(text)) => text,
            Ok(Err(_)) => "[channel shutting down]".to_string(),
            Err(_) => {
                lock(pending).remove(request_id);
                "[timeout — agent did not respond in time]".to_string()
            }
        },
        None => match rx.await {
            Ok(text) => text,
            Err(_) => "[channel shutting down]".to_string(),
        },
    }
}

async fn run_axum(inner: Arc<Inner>, listener: TcpListener, shutdown: oneshot::Receiver<()>) {
    let app = axum::Router::new().fallback(axum_entry).with_state(inner);
    let server = axum::serve(listener, app).with_graceful_shutdown(async move {
        let _ = shutdown.await;
    });
    let _ = server.await;
}

async fn axum_entry(
    axum::extract::State(inner): axum::extract::State<Arc<Inner>>,
    req: axum::extract::Request,
) -> axum::response::Response {
    inner.handle_axum(req).await
}

async fn run_tls(inner: Arc<Inner>, listener: TcpListener, mut shutdown: oneshot::Receiver<()>) {
    let Some(material) = inner.config.tls.clone() else {
        return;
    };
    let acceptor = match server_config(&material) {
        Ok(config) => TlsAcceptor::from(config),
        Err(err) => {
            tracing::error!("agent channel TLS setup failed: {err}");
            return;
        }
    };
    let mut tasks = Vec::new();
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else {
                    break;
                };
                let acceptor = acceptor.clone();
                let inner = Arc::clone(&inner);
                tasks.push(tokio::spawn(async move {
                    if let Err(err) = serve_tls(inner, acceptor, stream).await {
                        tracing::debug!("agent channel connection closed: {err}");
                    }
                }));
            }
        }
    }
    for task in tasks {
        let _ = task.await;
    }
}

async fn serve_tls(
    inner: Arc<Inner>,
    acceptor: TlsAcceptor,
    stream: TcpStream,
) -> Result<(), String> {
    let tls = acceptor
        .accept(stream)
        .await
        .map_err(|err| err.to_string())?;
    let io = TokioIo::new(tls);
    let service = service_fn(move |req| {
        let inner = Arc::clone(&inner);
        async move {
            let response = inner.handle_hyper(req).await;
            Ok::<_, Infallible>(response)
        }
    });
    http1::Builder::new()
        .serve_connection(io, service)
        .await
        .map_err(|err| err.to_string())
}

async fn read_incoming(body: Incoming) -> Result<Vec<u8>, ()> {
    collect_limited(Limited::new(body, BODY_LIMIT)).await
}

async fn read_axum_body(body: axum::body::Body) -> Result<Vec<u8>, ()> {
    collect_limited(Limited::new(body, BODY_LIMIT)).await
}

async fn collect_limited<B>(body: Limited<B>) -> Result<Vec<u8>, ()>
where
    Limited<B>: BodyExt,
{
    match body.collect().await {
        Ok(collected) => Ok(collected.to_bytes().to_vec()),
        Err(_) => Err(()),
    }
}

fn needs_body(method: &hyper::Method, path: &str) -> bool {
    method == hyper::Method::POST && (path == "/api/message" || path == "/api/mesh/join")
}

fn request_path(uri: &hyper::Uri) -> String {
    uri.path_and_query()
        .map(|path| path.as_str().to_string())
        .unwrap_or_default()
}

fn to_hyper(reply: Reply) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from(reply.body)));
    *response.status_mut() = reply.status;
    response.headers_mut().insert(
        hyper::header::CONTENT_TYPE,
        hyper::header::HeaderValue::from_static("application/json"),
    );
    response
}

fn to_axum(reply: Reply) -> axum::response::Response {
    let mut response = axum::response::Response::new(axum::body::Body::from(reply.body));
    *response.status_mut() = reply.status;
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static("application/json"),
    );
    response
}

fn json_reply(status: StatusCode, value: &Value) -> Reply {
    Reply {
        status,
        body: serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec()),
    }
}

fn invalid_json() -> Reply {
    json_reply(StatusCode::BAD_REQUEST, &error_body("Invalid JSON body"))
}

fn error_body(message: &str) -> Value {
    let mut map = Map::new();
    map.insert("error".to_string(), Value::String(message.to_string()));
    Value::Object(map)
}

fn health_body(agent_id: &str) -> Value {
    let mut map = Map::new();
    map.insert("status".to_string(), Value::String("ok".to_string()));
    map.insert("agent".to_string(), Value::String(agent_id.to_string()));
    map.insert("timestamp".to_string(), number_value(now_ms()));
    Value::Object(map)
}

fn ping_body(agent_id: &str) -> Value {
    let mut map = Map::new();
    map.insert("ok".to_string(), Value::Bool(true));
    map.insert("tls".to_string(), Value::Bool(true));
    map.insert("node".to_string(), Value::String(agent_id.to_string()));
    Value::Object(map)
}

fn number_value(number: JsNumber) -> Value {
    serde_json::to_value(number).unwrap_or(Value::Null)
}

fn truthy_string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

fn waits_for_response(value: &Value) -> bool {
    !matches!(value.get("waitForResponse"), Some(Value::Bool(false)))
}

fn finite_timeout(value: &Value) -> Option<u64> {
    let number = value.as_f64()?;
    if !number.is_finite() || number <= 0.0 {
        return None;
    }
    Some(number as u64)
}

fn wait_flag(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::Bool(flag)) => *flag,
        Some(_) => true,
    }
}

fn peer_names(peers: &[(String, PeerConfig)]) -> String {
    if peers.is_empty() {
        "none".to_string()
    } else {
        peers
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    }
}

fn pem_bytes(value: Option<&Value>) -> Option<Vec<u8>> {
    value
        .and_then(Value::as_str)
        .map(|text| text.as_bytes().to_vec())
}

fn required_join_fields(value: &Value) -> Option<(&str, &str, &str)> {
    let id = truthy_string(value, "id")?;
    let name = truthy_string(value, "name")?;
    let host = truthy_string(value, "host")?;
    Some((id, name, host))
}

fn minimal_node(id: &str, name: &str, host: &str) -> MeshNode {
    MeshNode {
        id: id.to_string(),
        name: name.to_string(),
        role: None,
        agents: Vec::new(),
        host: host.to_string(),
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
        extra: Map::new(),
    }
}

fn new_request_id() -> String {
    format!("agent-msg-{}-{}", now_ms_u64(), random_base36(6))
}

fn random_base36(len: usize) -> String {
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut bytes = vec![0_u8; len];
    fill_random(&mut bytes);
    bytes
        .iter()
        .map(|byte| char::from(ALPHABET[usize::from(*byte) % ALPHABET.len()]))
        .collect()
}

fn inbound_message(
    agent_id: &str,
    from_agent: &str,
    message: &str,
    conversation_id: Option<&str>,
    request_id: &str,
) -> InboundMessage {
    let mut metadata = Map::new();
    metadata.insert(
        "fromAgent".to_string(),
        Value::String(from_agent.to_string()),
    );
    if let Some(conversation_id) = conversation_id {
        metadata.insert(
            "conversationId".to_string(),
            Value::String(conversation_id.to_string()),
        );
    }
    metadata.insert("isAgentMessage".to_string(), Value::Bool(true));
    InboundMessage {
        id: request_id.to_string(),
        user_id: format!("agent:{from_agent}"),
        username: Some(from_agent.to_string()),
        display_name: Some(format!("Agent: {from_agent}")),
        channel_id: request_id.to_string(),
        chat_type: "agent".to_string(),
        text: message.to_string(),
        platform: "agent".to_string(),
        agent: Some(agent_id.to_string()),
        reply_to_message_id: None,
        attachments: None,
        metadata: Some(metadata),
        timestamp: JsNumber::from(now_ms_u64() / 1000),
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|err| err.into_inner())
}
