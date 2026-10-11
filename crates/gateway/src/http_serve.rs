use std::convert::Infallible;
use std::io::{self, ErrorKind};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http::header::{HeaderName, HeaderValue};
use http::{Request, Response, StatusCode, Version};
use hyper::body::{Body, Frame, Incoming as HyperIncoming, SizeHint};
use hyper::service::Service;
use parking_lot::Mutex;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::protocol::Role;

use crate::auth::ConnInfo;
use crate::http_codec::{
    Framing, Incoming, Reply, RequestBody, header, push_new, reason_phrase, split_target,
};
use crate::hub::Fanout;
use crate::routes::{App, Outcome, WsPlan, dispatch};
use crate::standard_helpers::http_date;

const HEADER_DEADLINE: Duration = Duration::from_secs(60);
const REQUEST_DEADLINE: Duration = Duration::from_secs(300);
const IDLE_DEADLINE: Duration = Duration::from_secs(5);
const WS_WRITE_DEADLINE: Duration = Duration::from_secs(30);
const HEADER_BACKSTOP: Duration = Duration::from_secs(24 * 60 * 60);
const VIEW_QUEUE: usize = 1024 * 1024;
const AUTO_400: &[u8] = b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n";
const NODE_400: &[u8] = b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Headers,
    Request,
    Idle,
    Open,
}

struct GateInner {
    mode: Mode,
    deadline: tokio::time::Instant,
    generation: u64,
    rewrite: bool,
    idle_after: bool,
}

impl GateInner {
    fn headers() -> Self {
        Self {
            mode: Mode::Headers,
            deadline: tokio::time::Instant::now() + HEADER_DEADLINE,
            generation: 1,
            rewrite: false,
            idle_after: false,
        }
    }
}

struct PendingWrite {
    bytes: Vec<u8>,
    orig: usize,
}

struct GateIo<S> {
    inner: S,
    gate: Arc<Mutex<GateInner>>,
    sleep: Pin<Box<tokio::time::Sleep>>,
    seen: u64,
    pending: Option<PendingWrite>,
    shutdown: watch::Receiver<bool>,
}

impl<S> GateIo<S> {
    fn new(inner: S, gate: Arc<Mutex<GateInner>>, shutdown: watch::Receiver<bool>) -> Self {
        let (deadline, seen) = {
            let guard = gate.lock();
            (guard.deadline, guard.generation)
        };
        Self {
            inner,
            gate,
            sleep: Box::pin(tokio::time::sleep_until(deadline)),
            seen,
            pending: None,
            shutdown,
        }
    }

    fn sync(&mut self) {
        let guard = self.gate.lock();
        if guard.generation != self.seen {
            self.seen = guard.generation;
            self.sleep.as_mut().reset(guard.deadline);
        }
    }

    fn shut(&self) -> bool {
        *self.shutdown.borrow()
    }
}

impl<S> AsyncRead for GateIo<S>
where
    S: AsyncRead + Unpin,
{
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if this.shut() {
            return Poll::Ready(Err(io::Error::new(
                ErrorKind::ConnectionAborted,
                "shutdown",
            )));
        }
        {
            let mut guard = this.gate.lock();
            if guard.idle_after && guard.mode != Mode::Open {
                guard.idle_after = false;
                guard.mode = Mode::Idle;
                guard.deadline = tokio::time::Instant::now() + IDLE_DEADLINE;
                guard.generation = guard.generation.wrapping_add(1);
            }
        }
        this.sync();
        let mode = this.gate.lock().mode;
        if mode == Mode::Open {
            return Pin::new(&mut this.inner).poll_read(cx, buf);
        }
        let filled = buf.filled().len();
        match Pin::new(&mut this.inner).poll_read(cx, buf) {
            Poll::Ready(Ok(())) => {
                if buf.filled().len() > filled && mode == Mode::Idle {
                    let mut guard = this.gate.lock();
                    guard.mode = Mode::Headers;
                    guard.deadline = tokio::time::Instant::now() + HEADER_DEADLINE;
                    guard.generation = guard.generation.wrapping_add(1);
                    drop(guard);
                    this.sync();
                }
                Poll::Ready(Ok(()))
            }
            Poll::Ready(Err(err)) => Poll::Ready(Err(err)),
            Poll::Pending => {
                if this.sleep.as_mut().poll(cx).is_ready() {
                    return Poll::Ready(Err(io::Error::new(ErrorKind::TimedOut, "read deadline")));
                }
                Poll::Pending
            }
        }
    }
}

impl<S> AsyncWrite for GateIo<S>
where
    S: AsyncWrite + Unpin,
{
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        if this.shut() {
            return Poll::Ready(Err(io::Error::new(
                ErrorKind::ConnectionAborted,
                "shutdown",
            )));
        }
        this.sync();
        let mode = this.gate.lock().mode;
        if mode != Mode::Open && this.sleep.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(io::Error::new(ErrorKind::TimedOut, "write deadline")));
        }
        if this.pending.is_none()
            && let Some(bytes) = this.replacement(buf)
        {
            this.pending = Some(PendingWrite {
                bytes,
                orig: buf.len(),
            });
        }
        if this.pending.is_some() {
            return this.drive_pending(cx);
        }
        Pin::new(&mut this.inner).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        Pin::new(&mut this.inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        Pin::new(&mut this.inner).poll_shutdown(cx)
    }
}

impl<S> GateIo<S>
where
    S: AsyncWrite + Unpin,
{
    fn replacement(&mut self, buf: &[u8]) -> Option<Vec<u8>> {
        if buf == AUTO_400 {
            return Some(NODE_400.to_vec());
        }
        let rewrite = self.gate.lock().rewrite;
        if rewrite && buf.starts_with(b"HTTP/1.0 ") {
            self.gate.lock().rewrite = false;
            let mut owned = buf.to_vec();
            owned[..9].copy_from_slice(b"HTTP/1.1 ");
            return Some(owned);
        }
        None
    }

    fn drive_pending(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        loop {
            let Some(pending) = self.pending.as_mut() else {
                return Poll::Ready(Ok(0));
            };
            match Pin::new(&mut self.inner).poll_write(cx, &pending.bytes) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Err(err)) => return Poll::Ready(Err(err)),
                Poll::Ready(Ok(0)) => {
                    return Poll::Ready(Err(io::Error::new(ErrorKind::WriteZero, "write")));
                }
                Poll::Ready(Ok(n)) => {
                    pending.bytes.drain(..n);
                    if pending.bytes.is_empty() {
                        let orig = pending.orig;
                        self.pending = None;
                        return Poll::Ready(Ok(orig));
                    }
                }
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LenKind {
    Known,
    Unknown,
}

struct ReplyBody {
    data: Bytes,
    done: bool,
    kind: LenKind,
}

impl ReplyBody {
    fn new(data: Bytes, kind: LenKind) -> Self {
        Self {
            data,
            done: false,
            kind,
        }
    }
}

impl Body for ReplyBody {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        let this = self.get_mut();
        if this.done {
            return Poll::Ready(None);
        }
        if this.data.is_empty() {
            this.done = true;
            return Poll::Ready(None);
        }
        this.done = true;
        let data = std::mem::take(&mut this.data);
        Poll::Ready(Some(Ok(Frame::data(data))))
    }

    fn is_end_stream(&self) -> bool {
        match self.kind {
            LenKind::Known => self.done || self.data.is_empty(),
            LenKind::Unknown => self.done,
        }
    }

    fn size_hint(&self) -> SizeHint {
        match self.kind {
            LenKind::Known => {
                let len = if self.done {
                    0
                } else {
                    u64::try_from(self.data.len()).unwrap_or(u64::MAX)
                };
                SizeHint::with_exact(len)
            }
            LenKind::Unknown => SizeHint::new(),
        }
    }
}

struct GatewaySvc {
    app: Arc<App>,
    info: ConnInfo,
    gate: Arc<Mutex<GateInner>>,
    shutdown: watch::Receiver<bool>,
}

#[derive(Debug)]
struct Abort;

impl std::fmt::Display for Abort {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("close")
    }
}

impl std::error::Error for Abort {}

impl Service<Request<HyperIncoming>> for GatewaySvc {
    type Response = Response<ReplyBody>;
    type Error = Abort;
    type Future = Pin<Box<dyn std::future::Future<Output = Result<Self::Response, Abort>> + Send>>;

    fn call(&self, mut req: Request<HyperIncoming>) -> Self::Future {
        let app = Arc::clone(&self.app);
        let info = self.info.clone();
        let gate = Arc::clone(&self.gate);
        let shutdown = self.shutdown.clone();
        Box::pin(async move {
            note_request(&gate);
            let upgrade = wants_upgrade(&req).then(|| hyper::upgrade::on(&mut req));
            let (parts, stream) = req.into_parts();
            let incoming = incoming_from(&parts);
            let mut body = RequestBody::new(stream, declared_length(&parts.headers));
            if !incoming.http10 && header(&incoming.headers, "host").is_none() {
                let response = to_response(&missing_host_reply(), false, false, true, &gate);
                return Ok(response);
            }
            let req_close = connection_close(&incoming.headers);
            match dispatch(&app, &incoming, &mut body, &info).await {
                Outcome::Drop => Err(Abort),
                Outcome::Upgrade(plan) => {
                    let Some(on_upgrade) = upgrade else {
                        return Err(Abort);
                    };
                    let key = header(&incoming.headers, "sec-websocket-key").unwrap_or("");
                    let reply = switching_protocols(key);
                    note_open(&gate);
                    let app = Arc::clone(&app);
                    tokio::spawn(async move {
                        let Ok(upgraded) = on_upgrade.await else {
                            return;
                        };
                        let io = hyper_util::rt::TokioIo::new(upgraded);
                        ws_session(io, app, plan, shutdown).await;
                    });
                    Ok(to_response(&reply, false, false, false, &gate))
                }
                Outcome::Reply(reply) => Ok(to_response(
                    &reply,
                    incoming.http10,
                    incoming.head,
                    req_close,
                    &gate,
                )),
            }
        })
    }
}

fn note_request(gate: &Mutex<GateInner>) {
    let mut guard = gate.lock();
    guard.mode = Mode::Request;
    guard.deadline = tokio::time::Instant::now() + REQUEST_DEADLINE;
    guard.generation = guard.generation.wrapping_add(1);
}

fn note_open(gate: &Mutex<GateInner>) {
    let mut guard = gate.lock();
    guard.mode = Mode::Open;
    guard.rewrite = false;
    guard.idle_after = false;
    guard.generation = guard.generation.wrapping_add(1);
}

fn note_http(gate: &Mutex<GateInner>, http10: bool, close: bool) {
    let mut guard = gate.lock();
    guard.rewrite = http10;
    guard.idle_after = !close && !http10;
    guard.generation = guard.generation.wrapping_add(1);
}

fn wants_upgrade(req: &Request<HyperIncoming>) -> bool {
    req.headers()
        .get(http::header::UPGRADE)
        .is_some_and(|value| value.as_bytes().eq_ignore_ascii_case(b"websocket"))
}

fn declared_length(headers: &http::HeaderMap) -> Option<u64> {
    headers
        .get(http::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|text| text.parse().ok())
}

fn connection_close(headers: &[(String, String)]) -> bool {
    header(headers, "connection").is_some_and(|value| {
        value
            .split(',')
            .any(|part| part.trim().eq_ignore_ascii_case("close"))
    })
}

fn incoming_from(parts: &http::request::Parts) -> Incoming {
    let method = parts.method.as_str().to_ascii_uppercase();
    let target = parts
        .uri
        .path_and_query()
        .map(|item| item.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let (path, query) = split_target(&target);
    let mut headers = Vec::new();
    for (name, value) in &parts.headers {
        let text = value
            .to_str()
            .map(str::to_string)
            .unwrap_or_else(|_| String::from_utf8_lossy(value.as_bytes()).into_owned());
        headers.push((name.as_str().to_string(), text));
    }
    let upgrade =
        header(&headers, "upgrade").is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
    let head = method == "HEAD";
    Incoming {
        method,
        target,
        path,
        query,
        headers,
        body: Vec::new(),
        http10: parts.version == Version::HTTP_10,
        head,
        upgrade,
    }
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
            ("Date".to_string(), http_date(now)),
            ("Transfer-Encoding".to_string(), "chunked".to_string()),
        ],
        body: Vec::new(),
        auto: false,
        close: true,
        framing: Framing::Chunked,
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

fn to_response(
    reply: &Reply,
    http10: bool,
    head: bool,
    req_close: bool,
    gate: &Mutex<GateInner>,
) -> Response<ReplyBody> {
    let close = reply.close || http10 || req_close;
    let mut framing = reply.framing;
    if http10 && framing == Framing::Chunked {
        framing = Framing::UntilClose;
    }
    if head || reply.status == 101 || reply.status == 204 {
        framing = Framing::None;
    }
    let mut headers = reply.headers.clone();
    if reply.auto {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs() as i64)
            .unwrap_or(0);
        push_new(&mut headers, "Date", &http_date(now));
        push_new(
            &mut headers,
            "Connection",
            if close { "close" } else { "keep-alive" },
        );
        if !close {
            push_new(&mut headers, "Keep-Alive", "timeout=5");
        }
        if framing == Framing::Chunked {
            push_new(&mut headers, "Transfer-Encoding", "chunked");
        }
    }
    let (kind, data) = match framing {
        Framing::None => (LenKind::Known, Bytes::new()),
        Framing::ContentLength => (LenKind::Known, Bytes::from(reply.body.clone())),
        Framing::Chunked | Framing::UntilClose => {
            (LenKind::Unknown, Bytes::from(reply.body.clone()))
        }
    };
    if gate.lock().mode != Mode::Open {
        note_http(gate, http10, close);
    }
    let status = StatusCode::from_u16(reply.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut response = Response::new(ReplyBody::new(data, kind));
    *response.status_mut() = status;
    *response.version_mut() = if http10 {
        Version::HTTP_10
    } else {
        Version::HTTP_11
    };
    let map = response.headers_mut();
    for (name, value) in headers {
        let Ok(name) = HeaderName::try_from(name) else {
            continue;
        };
        let Ok(value) = HeaderValue::try_from(value) else {
            continue;
        };
        map.append(name, value);
    }
    let _ = reason_phrase(reply.status);
    response
}

pub(crate) async fn serve_conn<S>(
    socket: S,
    info: ConnInfo,
    app: Arc<App>,
    shutdown: watch::Receiver<bool>,
) where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let gate = Arc::new(Mutex::new(GateInner::headers()));
    let io = GateIo::new(socket, Arc::clone(&gate), shutdown.clone());
    let service = GatewaySvc {
        app,
        info,
        gate,
        shutdown,
    };
    let io = hyper_util::rt::TokioIo::new(io);
    let connection = hyper::server::conn::http1::Builder::new()
        .timer(hyper_util::rt::TokioTimer::new())
        .title_case_headers(true)
        .preserve_header_case(true)
        .auto_date_header(false)
        .writev(false)
        .max_header_size(64 * 1024)
        .max_buf_size(64 * 1024)
        .header_read_timeout(HEADER_BACKSTOP)
        .serve_connection(io, service)
        .with_upgrades();
    let _ = connection.await;
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
        let _ =
            tokio::time::timeout(WS_WRITE_DEADLINE, socket.send(Message::Close(Some(frame)))).await;
        return;
    }
    let snapshot = app
        .hub
        .snapshot_json(plan.session.as_deref(), plan.user.as_ref());
    let buffered = Arc::new(AtomicU64::new(0));
    let (tx, mut rx) = mpsc::channel(VIEW_QUEUE);
    let id = app
        .hub
        .subscribe(plan.session, plan.user, tx, buffered.clone());
    if send_deadline(&mut socket, Message::Text(snapshot.into()))
        .await
        .is_err()
    {
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
                    let _ = send_deadline(&mut socket, Message::Close(None)).await;
                    break;
                }
            }
            _ = ticker.tick() => {
                if !alive {
                    break;
                }
                alive = false;
                if send_deadline(&mut socket, Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            }
            incoming = socket.next() => {
                match incoming {
                    Some(Ok(Message::Pong(_))) => alive = true,
                    Some(Ok(Message::Ping(payload))) => {
                        if send_deadline(&mut socket, Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => {}
                }
            }
            outbound = rx.recv() => {
                match outbound {
                    Some(Fanout::Text(text)) => {
                        let len = u64::try_from(text.len()).unwrap_or(0);
                        if send_deadline(&mut socket, Message::Text(text.into())).await.is_err() {
                            break;
                        }
                        buffered.fetch_sub(len, Ordering::Relaxed);
                    }
                    Some(Fanout::Shutdown) | None => {
                        let _ = send_deadline(&mut socket, Message::Close(None)).await;
                        break;
                    }
                }
            }
        }
    }
    app.hub.unsubscribe(id);
}

async fn send_deadline<S>(socket: &mut WebSocketStream<S>, message: Message) -> Result<(), ()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    match tokio::time::timeout(WS_WRITE_DEADLINE, socket.send(message)).await {
        Ok(Ok(())) => Ok(()),
        _ => Err(()),
    }
}
