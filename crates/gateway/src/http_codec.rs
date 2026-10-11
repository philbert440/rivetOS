pub const BODY_LIMIT: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyFail {
    TooLarge,
    Closed,
}

pub struct RequestBody {
    stream: Option<hyper::body::Incoming>,
    declared: Option<u64>,
    cached: Option<Result<Vec<u8>, BodyFail>>,
}

impl RequestBody {
    pub fn new(stream: hyper::body::Incoming, declared: Option<u64>) -> Self {
        Self {
            stream: Some(stream),
            declared,
            cached: None,
        }
    }

    pub async fn bytes(&mut self) -> Result<Vec<u8>, BodyFail> {
        if let Some(cached) = &self.cached {
            return cached.clone();
        }
        if self.declared.is_some_and(|len| len > BODY_LIMIT as u64) {
            let err = Err(BodyFail::TooLarge);
            self.cached = Some(err.clone());
            return err;
        }
        let Some(mut stream) = self.stream.take() else {
            let err = Err(BodyFail::Closed);
            self.cached = Some(err.clone());
            return err;
        };
        let result = collect_limited(&mut stream).await;
        self.cached = Some(result.clone());
        result
    }

    pub async fn finish_unread(&mut self) {
        if self.cached.is_some() || self.stream.is_none() {
            return;
        }
        if self.declared.is_some_and(|len| len > BODY_LIMIT as u64) {
            return;
        }
        let _ = self.bytes().await;
    }
}

async fn collect_limited(stream: &mut hyper::body::Incoming) -> Result<Vec<u8>, BodyFail> {
    use http_body_util::BodyExt;
    let mut out = Vec::new();
    while let Some(next) = stream.frame().await {
        let frame = next.map_err(|_| BodyFail::Closed)?;
        let Ok(data) = frame.into_data() else {
            continue;
        };
        if out.len().saturating_add(data.len()) > BODY_LIMIT {
            return Err(BodyFail::TooLarge);
        }
        out.extend_from_slice(&data);
    }
    Ok(out)
}

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
