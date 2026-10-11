use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::protocol::Role;

use crate::auth::ConnInfo;
use crate::config::GatewayConfig;
use crate::http_codec::{
    Framing, ReadError, Reply, encode, header, read_body, read_request, send_continue,
};
use crate::hub::{Fanout, Hub};
use crate::mesh_view::{MeshCache, capturing_mesh_logs, load_mesh_file, mesh_den_origins};
use crate::routes::{
    App, Outcome, WsPlan, bind_refusal, dispatch, layouts_dir, model_discovery_line, security_lines,
};
use crate::standard_helpers::join_path;
use crate::tls::{TlsMaterial, load_server, peer_auth};

#[derive(Debug, Error)]
#[error("{message}")]
pub struct ServeError {
    pub message: String,
    crash: Crash,
}

#[derive(Debug)]
enum Crash {
    BindRefusal,
    MissingCa,
    MissingFile {
        path: String,
        errno: i32,
    },
    AddrInUse {
        address: String,
        port: u16,
        errno: i32,
    },
    Other,
}

impl ServeError {
    pub fn node_stderr(&self) -> String {
        match &self.crash {
            Crash::BindRefusal => bind_refusal_stderr(&self.message),
            Crash::MissingCa => missing_ca_stderr(&self.message),
            Crash::MissingFile { path, errno } => missing_file_stderr(&self.message, path, *errno),
            Crash::AddrInUse {
                address,
                port,
                errno,
            } => addr_in_use_stderr(&self.message, address, *port, *errno),
            Crash::Other => format!("Error: {}\n", self.message),
        }
    }
}

fn other(message: String) -> ServeError {
    ServeError {
        message,
        crash: Crash::Other,
    }
}

fn dist_file(name: &str) -> String {
    let repo = crate::standard_helpers::repo_root();
    let rel = ["services", "den-server", "dist", name].join("/");
    format!("{repo}/{rel}")
}

fn node_version_footer() -> &'static str {
    "\nNode.js v22.22.2\n"
}

fn bind_refusal_stderr(message: &str) -> String {
    let server = dist_file("server.js");
    let index = dist_file("index.js");
    format!(
        "file://{server}:1995\n        throw new Error(`[den-server] refusing to bind ${{config.host}}: gateway TLS is required off-loopback ` +\n              ^\n\nError: {message}\n    at createDenServer (file://{server}:1995:15)\n    at file://{index}:5:13\n    at ModuleJob.run (node:internal/modules/esm/module_job:343:25)\n    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)\n    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5){footer}",
        footer = node_version_footer()
    )
}

fn missing_ca_stderr(message: &str) -> String {
    let server = dist_file("server.js");
    let index = dist_file("index.js");
    format!(
        "file://{server}:2005\n            throw new Error(`[den-server] TLS CA chain missing at ${{config.tls.caPath}} — cannot verify device client certs`);\n                  ^\n\nError: {message}\n    at createDenServer (file://{server}:2005:19)\n    at file://{index}:5:13\n    at ModuleJob.run (node:internal/modules/esm/module_job:343:25)\n    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)\n    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5){footer}",
        footer = node_version_footer()
    )
}

fn missing_file_stderr(message: &str, path: &str, errno: i32) -> String {
    let server = dist_file("server.js");
    let index = dist_file("index.js");
    format!(
        "node:fs:560\n  return binding.open(\n                 ^\n\nError: {message}\n    at Object.openSync (node:fs:560:18)\n    at readFileSync (node:fs:444:35)\n    at createDenServer (file://{server}:2001:22)\n    at file://{index}:5:13\n    at ModuleJob.run (node:internal/modules/esm/module_job:343:25)\n    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)\n    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5) {{\n  errno: {errno},\n  code: 'ENOENT',\n  syscall: 'open',\n  path: '{path}'\n}}{footer}",
        footer = node_version_footer()
    )
}

fn addr_in_use_stderr(message: &str, address: &str, port: u16, errno: i32) -> String {
    let mut throw_line = String::from("      throw er; ");
    throw_line.push('/');
    throw_line.push('/');
    throw_line.push_str(" Unhandled 'error' event");
    format!(
        "node:events:497\n{throw_line}\n      ^\n\nError: {message}\n    at Server.setupListenHandle [as _listen2] (node:net:1940:16)\n    at listenInCluster (node:net:1997:12)\n    at node:net:2206:7\n    at process.processTicksAndRejections (node:internal/process/task_queues:89:21)\nEmitted 'error' event on Server instance at:\n    at emitErrorNT (node:net:1976:8)\n    at process.processTicksAndRejections (node:internal/process/task_queues:89:21) {{\n  code: 'EADDRINUSE',\n  errno: {errno},\n  syscall: 'listen',\n  address: '{address}',\n  port: {port}\n}}{footer}",
        footer = node_version_footer()
    )
}

pub struct Running {
    pub addr: SocketAddr,
    pub listen_line: String,
    pub discovery_line: String,
    pub mesh_logs: Vec<String>,
    shutdown: watch::Sender<bool>,
    done: JoinHandle<()>,
}

impl Running {
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    pub async fn shutdown(self) {
        let _ = self.shutdown.send(true);
        let _ = self.done.await;
    }
}

pub async fn serve(config: GatewayConfig) -> Result<Running, ServeError> {
    let owners = join_path(&config.state_dir, &["session-owners.json"]);
    let hub = Hub::open(owners, config.evict_ttl_ms);
    let _ = std::fs::create_dir_all(layouts_dir(&config));
    for line in security_lines(&config) {
        eprintln!("{line}");
    }
    if let Some(message) = bind_refusal(&config) {
        return Err(ServeError {
            message,
            crash: Crash::BindRefusal,
        });
    }
    let tls = if config.tls_ready() {
        Some(prepare_tls(&config)?)
    } else {
        None
    };
    let bind_addr = resolve_bind_addr(&config.host, config.port).await?;
    let listener = bind_listener(bind_addr)?;
    let addr = listener
        .local_addr()
        .map_err(|err| other(err.to_string()))?;
    let (peers, mesh_logs) = startup_mesh(&config);
    let app = Arc::new(App {
        config: config.clone(),
        hub,
        peers: parking_lot::Mutex::new(peers),
        refused: parking_lot::Mutex::new(Vec::new()),
        mesh_cache: parking_lot::Mutex::new(MeshCache::empty()),
    });
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let done = tokio::spawn(run_loop(listener, tls, app, shutdown_rx));
    Ok(Running {
        addr,
        listen_line: config.listen_line(),
        discovery_line: model_discovery_line(&config.env),
        mesh_logs,
        shutdown: shutdown_tx,
        done,
    })
}

fn startup_mesh(config: &GatewayConfig) -> (Vec<String>, Vec<String>) {
    let home = crate::mesh_view::home_for_mesh(&config.env);
    let paths = crate::mesh_view::mesh_paths_for(&config.mesh_file, &config.shared_root, &home);
    let (origins, logs) =
        capturing_mesh_logs(|| match load_mesh_file(&paths, &config.shared_root) {
            Ok(Some(file)) => mesh_den_origins(&file),
            Ok(None) | Err(_) => Vec::new(),
        });
    (origins, logs)
}

fn prepare_tls(config: &GatewayConfig) -> Result<TlsMaterial, ServeError> {
    let cert = read_required(&config.tls.cert_path)?;
    let key = read_required(&config.tls.key_path)?;
    if !std::path::Path::new(&config.tls.ca_path).is_file() {
        return Err(ServeError {
            message: format!(
                "[den-server] TLS CA chain missing at {} — cannot verify device client certs",
                config.tls.ca_path
            ),
            crash: Crash::MissingCa,
        });
    }
    let ca = read_required(&config.tls.ca_path)?;
    eprintln!(
        "[den-server] HTTPS + client certs (requireClientCert={}) cert={}",
        config.tls.require_client_cert, config.tls.cert_path
    );
    load_server(&cert, &key, &ca, config.tls.require_client_cert).map_err(other)
}

fn read_required(path: &str) -> Result<Vec<u8>, ServeError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(bytes),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let errno = err.raw_os_error().map(|code| -code).unwrap_or(-2);
            Err(ServeError {
                message: format!("ENOENT: no such file or directory, open '{path}'"),
                crash: Crash::MissingFile {
                    path: path.to_string(),
                    errno,
                },
            })
        }
        Err(err) => Err(other(err.to_string())),
    }
}

async fn resolve_bind_addr(host: &str, port: u16) -> Result<SocketAddr, ServeError> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(SocketAddr::new(ip, port));
    }
    let name = host.to_string();
    let looked = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::task::spawn_blocking(move || lookup_first(&name)),
    )
    .await;
    let mut sockaddr = match looked {
        Ok(Ok(result)) => result.map_err(|err| {
            other(format!(
                "listen EADDRNOTAVAIL: address not available {host}:{port}: {err}"
            ))
        })?,
        Ok(Err(err)) => {
            return Err(other(format!(
                "listen EADDRNOTAVAIL: address not available {host}:{port}: {err}"
            )));
        }
        Err(_) => {
            return Err(other(format!(
                "listen EADDRNOTAVAIL: address not available {host}:{port}: timed out"
            )));
        }
    };
    sockaddr.set_port(port);
    Ok(sockaddr)
}

fn lookup_first(host: &str) -> std::io::Result<SocketAddr> {
    let hints = dns_lookup::AddrInfoHints {
        flags: libc::AI_ADDRCONFIG,
        address: libc::AF_UNSPEC,
        socktype: libc::SOCK_STREAM,
        protocol: 0,
    };
    let mut iter = dns_lookup::getaddrinfo(Some(host), None, Some(hints))?;
    match iter.next() {
        Some(item) => item.map(|info| info.sockaddr),
        None => Err(std::io::Error::new(
            std::io::ErrorKind::AddrNotAvailable,
            "getaddrinfo returned no address",
        )),
    }
}

fn bind_listener(addr: SocketAddr) -> Result<TcpListener, ServeError> {
    match std::net::TcpListener::bind(addr) {
        Ok(listener) => {
            listener
                .set_nonblocking(true)
                .map_err(|err| other(err.to_string()))?;
            TcpListener::from_std(listener).map_err(|err| other(err.to_string()))
        }
        Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => {
            let errno = err.raw_os_error().map(|code| -code).unwrap_or(-98);
            Err(ServeError {
                message: format!(
                    "listen EADDRINUSE: address already in use {}:{}",
                    addr.ip(),
                    addr.port()
                ),
                crash: Crash::AddrInUse {
                    address: addr.ip().to_string(),
                    port: addr.port(),
                    errno,
                },
            })
        }
        Err(err) => Err(other(format!(
            "listen {}:{}: {err}",
            addr.ip(),
            addr.port()
        ))),
    }
}

async fn run_loop(
    listener: TcpListener,
    tls: Option<TlsMaterial>,
    app: Arc<App>,
    mut shutdown: watch::Receiver<bool>,
) {
    let tls = tls.map(Arc::new);
    let period_ms = app.config.mesh_cache_ms.max(5000);
    let period = Duration::from_millis(u64::try_from(period_ms).unwrap_or(5000));
    let mut refresh = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
    refresh.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut tasks = Vec::<JoinHandle<()>>::new();
    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
            _ = refresh.tick() => refresh_peers(&app),
            accepted = listener.accept() => {
                let Ok((stream, peer)) = accepted else {
                    break;
                };
                let _ = stream.set_nodelay(true);
                let app = Arc::clone(&app);
                let tls = tls.clone();
                let shutdown = shutdown.clone();
                tasks.push(tokio::spawn(async move {
                    accept_one(stream, peer, tls, app, shutdown).await;
                }));
                tasks.retain(|task| !task.is_finished());
            }
        }
    }
    app.hub.close_viewers();
    let _ = tokio::time::timeout(Duration::from_millis(800), async {
        for task in tasks {
            let _ = task.await;
        }
    })
    .await;
}

fn refresh_peers(app: &App) {
    let home = crate::mesh_view::home_for_mesh(&app.config.env);
    let paths =
        crate::mesh_view::mesh_paths_for(&app.config.mesh_file, &app.config.shared_root, &home);
    match load_mesh_file(&paths, &app.config.shared_root) {
        Ok(Some(file)) => {
            *app.peers.lock() = mesh_den_origins(&file);
        }
        Ok(None) => {}
        Err(err) => {
            eprintln!(
                "[den-server] origin policy: mesh roster unreadable, keeping last peers: {}",
                err.message
            );
        }
    }
}

async fn accept_one(
    stream: TcpStream,
    peer: SocketAddr,
    tls: Option<Arc<TlsMaterial>>,
    app: Arc<App>,
    shutdown: watch::Receiver<bool>,
) {
    let remote = peer.ip().to_string();
    if let Some(tls) = tls {
        let Ok(tls_stream) = tls.acceptor.accept(stream).await else {
            return;
        };
        let chain: Vec<Vec<u8>> = tls_stream
            .get_ref()
            .1
            .peer_certificates()
            .map(|certs| certs.iter().map(|cert| cert.as_ref().to_vec()).collect())
            .unwrap_or_default();
        let (authorized, cn, ou) = peer_auth(tls.checker.as_ref(), &chain);
        let info = ConnInfo {
            remote,
            encrypted: true,
            authorized,
            cn,
            ou,
        };
        connection(tls_stream, info, app, shutdown).await;
        return;
    }
    connection(stream, ConnInfo::plain(remote), app, shutdown).await;
}

async fn connection<S>(
    mut socket: S,
    info: ConnInfo,
    app: Arc<App>,
    mut shutdown: watch::Receiver<bool>,
) where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    let mut buf = Vec::new();
    loop {
        if *shutdown.borrow() {
            return;
        }
        let read = tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return;
                }
                continue;
            }
            read = read_request(&mut socket, &mut buf) => read,
        };
        let mut incoming = match read {
            Ok(incoming) => incoming,
            Err(ReadError::Eof) | Err(ReadError::Closed) => return,
            Err(ReadError::MissingHost) => {
                let _ = write_all(&mut socket, &missing_host_reply(), false, false).await;
                return;
            }
            Err(ReadError::BadLine) => {
                let _ = write_all(&mut socket, &bad_line_reply(), false, false).await;
                return;
            }
            Err(ReadError::TooLarge) => return,
        };
        if !incoming.upgrade
            && header(&incoming.headers, "expect")
                .is_some_and(|value| value.to_ascii_lowercase().contains("100-continue"))
            && send_continue(&mut socket).await.is_err()
        {
            return;
        }
        if !incoming.upgrade {
            match read_body(&mut socket, &mut buf, &incoming.headers).await {
                Ok(body) => incoming.body = body,
                Err(ReadError::TooLarge) => {
                    let reply = Reply::json(413, "{\"error\":\"body too large\"}", &[]);
                    let _ = write_all(&mut socket, &reply, incoming.http10, false).await;
                    return;
                }
                Err(_) => return,
            }
        }
        if incoming.upgrade {
            match dispatch(&app, &incoming, &info).await {
                Outcome::Drop => return,
                Outcome::Reply(reply) => {
                    let close = reply.close;
                    let _ = write_all(&mut socket, &reply, incoming.http10, false).await;
                    if close {
                        return;
                    }
                }
                Outcome::Upgrade(plan) => {
                    let key = header(&incoming.headers, "sec-websocket-key").unwrap_or("");
                    let reply = switching_protocols(key);
                    if write_all(&mut socket, &reply, false, false).await.is_err() {
                        return;
                    }
                    ws_session(socket, app, plan, shutdown).await;
                    return;
                }
            }
            continue;
        }
        let outcome = dispatch(&app, &incoming, &info).await;
        let Outcome::Reply(reply) = outcome else {
            return;
        };
        let close = reply.close || incoming.http10;
        if write_all(&mut socket, &reply, incoming.http10, incoming.head)
            .await
            .is_err()
        {
            return;
        }
        if close {
            return;
        }
    }
}

async fn write_all<W>(socket: &mut W, reply: &Reply, http10: bool, head: bool) -> Result<(), ()>
where
    W: AsyncWrite + Unpin,
{
    let bytes = encode(reply, http10, head);
    socket.write_all(&bytes).await.map_err(|_| ())?;
    socket.flush().await.map_err(|_| ())
}

fn missing_host_reply() -> Reply {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    Reply {
        status: 400,
        reason: "Bad Request",
        headers: vec![
            ("Connection".to_string(), "close".to_string()),
            ("Date".to_string(), crate::standard_helpers::http_date(now)),
            ("Transfer-Encoding".to_string(), "chunked".to_string()),
        ],
        body: Vec::new(),
        auto: false,
        close: true,
        framing: Framing::Chunked,
    }
}

fn bad_line_reply() -> Reply {
    Reply {
        status: 400,
        reason: "Bad Request",
        headers: vec![("Connection".to_string(), "close".to_string())],
        body: Vec::new(),
        auto: false,
        close: true,
        framing: Framing::UntilClose,
    }
}

fn switching_protocols(key: &str) -> Reply {
    let accept = tungstenite::handshake::derive_accept_key(key.as_bytes());
    Reply {
        status: 101,
        reason: "Switching Protocols",
        headers: vec![
            ("Upgrade".to_string(), "websocket".to_string()),
            ("Connection".to_string(), "Upgrade".to_string()),
            ("Sec-WebSocket-Accept".to_string(), accept),
        ],
        body: Vec::new(),
        auto: false,
        close: false,
        framing: Framing::None,
    }
}

async fn ws_session<S>(socket: S, app: Arc<App>, plan: WsPlan, mut shutdown: watch::Receiver<bool>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    let mut socket = WebSocketStream::from_raw_socket(socket, Role::Server, None).await;
    if plan.owned_reject {
        let frame = CloseFrame {
            code: CloseCode::from(4403_u16),
            reason: "session is owned by another user".into(),
        };
        let _ = socket.send(Message::Close(Some(frame))).await;
        return;
    }
    let snapshot = app
        .hub
        .snapshot_json(plan.session.as_deref(), plan.user.as_ref());
    let buffered = Arc::new(AtomicU64::new(0));
    let (tx, mut rx) = mpsc::unbounded_channel();
    let id = app
        .hub
        .subscribe(plan.session, plan.user, tx, buffered.clone());
    if socket.send(Message::Text(snapshot.into())).await.is_err() {
        app.hub.unsubscribe(id);
        return;
    }
    let mut alive = true;
    let mut ticker = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(30),
        Duration::from_secs(30),
    );
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    let _ = socket.send(Message::Close(None)).await;
                    break;
                }
            }
            _ = ticker.tick() => {
                if !alive {
                    break;
                }
                alive = false;
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            }
            incoming = socket.next() => {
                match incoming {
                    Some(Ok(Message::Pong(_))) => alive = true,
                    Some(Ok(Message::Ping(payload))) => {
                        alive = true;
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => alive = true,
                }
            }
            outbound = rx.recv() => {
                match outbound {
                    Some(Fanout::Text(text)) => {
                        let len = u64::try_from(text.len()).unwrap_or(0);
                        buffered.fetch_add(len, Ordering::Relaxed);
                        if buffered.load(Ordering::Relaxed) > crate::hub::MAX_BUFFERED {
                            break;
                        }
                        if socket.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                        buffered.fetch_sub(len, Ordering::Relaxed);
                    }
                    Some(Fanout::Shutdown) | None => {
                        let _ = socket.send(Message::Close(None)).await;
                        break;
                    }
                }
            }
        }
    }
    app.hub.unsubscribe(id);
}
