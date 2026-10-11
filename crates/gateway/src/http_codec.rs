use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::standard_helpers::http_date;

const HEADER_LIMIT: usize = 64 * 1024;
pub const BODY_LIMIT: usize = 256 * 1024;

#[derive(Debug, Clone)]
pub struct Incoming {
    pub method: String,
    pub target: String,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub http10: bool,
    pub head: bool,
    pub upgrade: bool,
}

#[derive(Debug)]
pub enum ReadError {
    Eof,
    BadLine,
    MissingHost,
    TooLarge,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Framing {
    Chunked,
    None,
    UntilClose,
    ContentLength,
}

#[derive(Debug, Clone)]
pub struct Reply {
    pub status: u16,
    pub reason: &'static str,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub auto: bool,
    pub close: bool,
    pub framing: Framing,
}

impl Reply {
    pub fn json(status: u16, body: &str, preset: &[(String, String)]) -> Self {
        let mut headers = preset.to_vec();
        push_new(&mut headers, "Content-Type", "application/json");
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
        Self {
            status,
            reason: reason_phrase(status),
            headers,
            body: body.as_bytes().to_vec(),
            auto: true,
            close: false,
            framing: Framing::Chunked,
        }
    }

    pub fn empty(status: u16, preset: &[(String, String)]) -> Self {
        Self {
            status,
            reason: reason_phrase(status),
            headers: preset.to_vec(),
            body: Vec::new(),
            auto: true,
            close: false,
            framing: Framing::None,
        }
    }
}

pub fn reason_phrase(status: u16) -> &'static str {
    match status {
        100 => "Continue",
        101 => "Switching Protocols",
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        302 => "Found",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        410 => "Gone",
        413 => "Payload Too Large",
        422 => "Unprocessable Entity",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        503 => "Service Unavailable",
        _ => "Error",
    }
}

pub fn cors_headers() -> Vec<(String, String)> {
    vec![
        (
            "Access-Control-Allow-Methods".to_string(),
            "GET, POST, PATCH, DELETE, OPTIONS".to_string(),
        ),
        (
            "Access-Control-Allow-Headers".to_string(),
            "content-type, authorization, x-rivet-conversation, x-rivet-title".to_string(),
        ),
    ]
}

pub fn push_new(headers: &mut Vec<(String, String)>, name: &str, value: &str) {
    if headers
        .iter()
        .any(|(existing, _)| existing.eq_ignore_ascii_case(name))
    {
        return;
    }
    headers.push((name.to_string(), value.to_string()));
}

pub fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

pub fn encode(reply: &Reply, http10: bool, head: bool) -> Vec<u8> {
    let mut headers = reply.headers.clone();
    let close = reply.close || http10;
    let mut framing = reply.framing;
    if http10 && framing == Framing::Chunked {
        framing = Framing::UntilClose;
    }
    if head {
        framing = Framing::None;
    }
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
    let status = axum::http::StatusCode::from_u16(reply.status)
        .unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR);
    let mut out = format!("HTTP/1.1 {} {}\r\n", status.as_u16(), reply.reason).into_bytes();
    for (name, value) in &headers {
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(b": ");
        out.extend_from_slice(value.as_bytes());
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(b"\r\n");
    match framing {
        Framing::None => {}
        Framing::ContentLength | Framing::UntilClose => out.extend_from_slice(&reply.body),
        Framing::Chunked => {
            if !reply.body.is_empty() {
                out.extend_from_slice(format!("{:x}\r\n", reply.body.len()).as_bytes());
                out.extend_from_slice(&reply.body);
                out.extend_from_slice(b"\r\n");
            }
            out.extend_from_slice(b"0\r\n\r\n");
        }
    }
    out
}

pub async fn read_request<R>(reader: &mut R, buf: &mut Vec<u8>) -> Result<Incoming, ReadError>
where
    R: AsyncRead + Unpin,
{
    let header_end = read_headers(reader, buf).await?;
    let head = buf[..header_end].to_vec();
    buf.drain(..header_end);
    let text = String::from_utf8_lossy(&head);
    let mut lines = text.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    if request_line.is_empty() {
        return Err(ReadError::BadLine);
    }
    let mut parts = request_line.split(' ');
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    let version = parts.next().unwrap_or("");
    if parts.next().is_some()
        || method.is_empty()
        || target.is_empty()
        || !version.starts_with("HTTP/")
        || !method.bytes().all(|byte| byte.is_ascii_alphabetic())
    {
        return Err(ReadError::BadLine);
    }
    let http10 = version == "HTTP/1.0";
    if version != "HTTP/1.0" && version != "HTTP/1.1" {
        return Err(ReadError::BadLine);
    }
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(ReadError::BadLine);
        };
        headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
    }
    if !http10 && header(&headers, "host").is_none() {
        return Err(ReadError::MissingHost);
    }
    let upgrade =
        header(&headers, "upgrade").is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
    let (path, query) = split_target(target);
    Ok(Incoming {
        head: method.eq_ignore_ascii_case("HEAD"),
        method: method.to_ascii_uppercase(),
        target: target.to_string(),
        path,
        query,
        headers,
        body: Vec::new(),
        http10,
        upgrade,
    })
}

pub async fn read_headers<R>(reader: &mut R, buf: &mut Vec<u8>) -> Result<usize, ReadError>
where
    R: AsyncRead + Unpin,
{
    loop {
        if let Some(end) = find_header_end(buf) {
            return Ok(end);
        }
        if buf.len() > HEADER_LIMIT {
            return Err(ReadError::BadLine);
        }
        let mut chunk = [0_u8; 4096];
        let read = reader
            .read(&mut chunk)
            .await
            .map_err(|_| ReadError::Closed)?;
        if read == 0 {
            if buf.is_empty() {
                return Err(ReadError::Eof);
            }
            return Err(ReadError::BadLine);
        }
        buf.extend_from_slice(&chunk[..read]);
    }
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
}

pub async fn send_continue<W>(writer: &mut W) -> Result<(), ReadError>
where
    W: AsyncWrite + Unpin,
{
    writer
        .write_all(b"HTTP/1.1 100 Continue\r\n\r\n")
        .await
        .map_err(|_| ReadError::Closed)?;
    writer.flush().await.map_err(|_| ReadError::Closed)
}

pub async fn read_body<R>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    headers: &[(String, String)],
) -> Result<Vec<u8>, ReadError>
where
    R: AsyncRead + Unpin,
{
    if header(headers, "transfer-encoding")
        .is_some_and(|value| value.to_ascii_lowercase().contains("chunked"))
    {
        return read_chunked(reader, buf).await;
    }
    if let Some(length) = header(headers, "content-length") {
        let length = length.parse::<usize>().map_err(|_| ReadError::BadLine)?;
        if length > BODY_LIMIT {
            return Err(ReadError::TooLarge);
        }
        return read_exact(reader, buf, length).await;
    }
    Ok(Vec::new())
}

async fn read_exact<R>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    length: usize,
) -> Result<Vec<u8>, ReadError>
where
    R: AsyncRead + Unpin,
{
    while buf.len() < length {
        let mut chunk = [0_u8; 8192];
        let read = reader
            .read(&mut chunk)
            .await
            .map_err(|_| ReadError::Closed)?;
        if read == 0 {
            return Err(ReadError::Closed);
        }
        buf.extend_from_slice(&chunk[..read]);
    }
    let body = buf[..length].to_vec();
    buf.drain(..length);
    Ok(body)
}

async fn read_chunked<R>(reader: &mut R, buf: &mut Vec<u8>) -> Result<Vec<u8>, ReadError>
where
    R: AsyncRead + Unpin,
{
    let mut body = Vec::new();
    loop {
        let line = read_line(reader, buf).await?;
        let size_text = line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_text, 16).map_err(|_| ReadError::BadLine)?;
        if size == 0 {
            let _ = read_line(reader, buf).await?;
            break;
        }
        if body.len().saturating_add(size) > BODY_LIMIT {
            return Err(ReadError::TooLarge);
        }
        let chunk = read_exact(reader, buf, size).await?;
        body.extend_from_slice(&chunk);
        let _ = read_line(reader, buf).await?;
    }
    Ok(body)
}

async fn read_line<R>(reader: &mut R, buf: &mut Vec<u8>) -> Result<String, ReadError>
where
    R: AsyncRead + Unpin,
{
    loop {
        if let Some(index) = buf.windows(2).position(|window| window == b"\r\n") {
            let line = String::from_utf8_lossy(&buf[..index]).into_owned();
            buf.drain(..index + 2);
            return Ok(line);
        }
        let mut chunk = [0_u8; 1024];
        let read = reader
            .read(&mut chunk)
            .await
            .map_err(|_| ReadError::Closed)?;
        if read == 0 {
            return Err(ReadError::Closed);
        }
        buf.extend_from_slice(&chunk[..read]);
    }
}

pub fn split_target(target: &str) -> (String, Vec<(String, String)>) {
    if target == "*" {
        return ("/*".to_string(), Vec::new());
    }
    let (path_and_query, _) = target.split_once('#').unwrap_or((target, ""));
    let absolute = if let Some(rest) = path_and_query.strip_prefix("http://") {
        Some(rest)
    } else {
        path_and_query.strip_prefix("https://")
    };
    let path_and_query = if let Some(rest) = absolute {
        rest.find('/').map(|index| &rest[index..]).unwrap_or("/")
    } else if let Some(rest) = path_and_query.strip_prefix("//") {
        rest.find('/').map(|index| &rest[index..]).unwrap_or("/")
    } else {
        path_and_query
    };
    let (path, query) = path_and_query
        .split_once('?')
        .unwrap_or((path_and_query, ""));
    let path = if path.is_empty() { "/" } else { path };
    let path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    (resolve_dots(&path), parse_query(query))
}

fn resolve_dots(path: &str) -> String {
    let keep_slash = path.len() > 1 && path.ends_with('/');
    let mut parts = Vec::new();
    for part in path.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            parts.pop();
            continue;
        }
        parts.push(part);
    }
    if parts.is_empty() {
        return "/".to_string();
    }
    let mut out = format!("/{}", parts.join("/"));
    if keep_slash {
        out.push('/');
    }
    out
}

fn parse_query(query: &str) -> Vec<(String, String)> {
    if query.is_empty() {
        return Vec::new();
    }
    query
        .split('&')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let (name, value) = part.split_once('=').unwrap_or((part, ""));
            (percent_decode(name), percent_decode(value))
        })
        .collect()
}

pub fn query_first<'a>(query: &'a [(String, String)], name: &str) -> Option<&'a str> {
    query
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

pub fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'+' {
            out.push(b' ');
            index += 1;
            continue;
        }
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let (Some(hi), Some(lo)) = (from_hex(bytes[index + 1]), from_hex(bytes[index + 2]))
        {
            out.push((hi << 4) | lo);
            index += 3;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn percent_decode_strict(text: &str) -> Result<String, ()> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(());
            }
            let Some(hi) = from_hex(bytes[index + 1]) else {
                return Err(());
            };
            let Some(lo) = from_hex(bytes[index + 2]) else {
                return Err(());
            };
            out.push((hi << 4) | lo);
            index += 3;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(out).map_err(|_| ())
}

fn from_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

pub fn accept_key(key: &str) -> String {
    use base64::Engine;
    use sha1::{Digest, Sha1};
    let mut hasher = Sha1::new();
    hasher.update(key.as_bytes());
    hasher.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    base64::engine::general_purpose::STANDARD.encode(hasher.finalize())
}

pub fn ws_accept_matches_tungstenite(key: &str) -> bool {
    tungstenite::handshake::derive_accept_key(key.as_bytes()) == accept_key(key)
}
