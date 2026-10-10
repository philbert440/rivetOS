use std::fmt;

use serde_json::{Map, Value};

use protocol::JsNumber;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeshParseErrorCode {
    JsonInvalid,
    FlatArray,
    InvalidShape,
    NodeInvalid,
}

impl MeshParseErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::JsonInvalid => "MESH_JSON_INVALID",
            Self::FlatArray => "MESH_FLAT_ARRAY",
            Self::InvalidShape => "MESH_INVALID_SHAPE",
            Self::NodeInvalid => "MESH_NODE_INVALID",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
struct MeshParseErrorInner {
    code: MeshParseErrorCode,
    message: String,
    path: String,
    context: Map<String, Value>,
    cause: Option<String>,
    timestamp: JsNumber,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MeshParseError {
    inner: Box<MeshParseErrorInner>,
}

impl MeshParseError {
    pub fn new(
        code: MeshParseErrorCode,
        message: impl Into<String>,
        path: impl Into<String>,
        context: Map<String, Value>,
        cause: Option<String>,
    ) -> Self {
        let path = path.into();
        let mut context = context;
        context
            .entry("path")
            .or_insert_with(|| Value::String(path.clone()));
        Self {
            inner: Box::new(MeshParseErrorInner {
                code,
                message: message.into(),
                path,
                context,
                cause,
                timestamp: crate::model::now_ms(),
            }),
        }
    }

    pub fn code(&self) -> MeshParseErrorCode {
        self.inner.code
    }

    pub fn message(&self) -> &str {
        &self.inner.message
    }

    pub fn path(&self) -> &str {
        &self.inner.path
    }

    pub fn context(&self) -> &Map<String, Value> {
        &self.inner.context
    }

    pub fn cause(&self) -> Option<&str> {
        self.inner.cause.as_deref()
    }

    pub fn timestamp(&self) -> JsNumber {
        self.inner.timestamp
    }

    pub fn is_flat_array(&self) -> bool {
        self.inner.code == MeshParseErrorCode::FlatArray
            || self.inner.message.contains("pre-capabilities flat-array")
    }

    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert(
            "name".to_string(),
            Value::String("MeshParseError".to_string()),
        );
        map.insert(
            "code".to_string(),
            Value::String(self.inner.code.as_str().to_string()),
        );
        map.insert(
            "message".to_string(),
            Value::String(self.inner.message.clone()),
        );
        map.insert("severity".to_string(), Value::String("fatal".to_string()));
        map.insert("retryable".to_string(), Value::Bool(false));
        map.insert(
            "timestamp".to_string(),
            serde_json::to_value(self.inner.timestamp).unwrap_or(Value::Null),
        );
        map.insert(
            "context".to_string(),
            Value::Object(self.inner.context.clone()),
        );
        if let Some(cause) = &self.inner.cause {
            map.insert("cause".to_string(), Value::String(cause.clone()));
        }
        Value::Object(map)
    }
}

impl fmt::Display for MeshParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.inner.message)
    }
}

impl std::error::Error for MeshParseError {}

#[derive(Debug, thiserror::Error)]
pub enum MeshError {
    #[error(transparent)]
    Parse(#[from] MeshParseError),
    #[error("{0}")]
    Message(String),
}

impl MeshError {
    pub fn message(text: impl Into<String>) -> Self {
        Self::Message(text.into())
    }

    pub fn is_flat_array(&self) -> bool {
        match self {
            Self::Parse(err) => err.is_flat_array(),
            Self::Message(text) => text.contains("pre-capabilities flat-array"),
        }
    }
}

impl From<std::io::Error> for MeshError {
    fn from(err: std::io::Error) -> Self {
        Self::Message(err.to_string())
    }
}

impl From<reqwest::Error> for MeshError {
    fn from(err: reqwest::Error) -> Self {
        Self::Message(err.to_string())
    }
}

pub fn is_mesh_flat_array_error(err: &MeshError) -> bool {
    err.is_flat_array()
}
