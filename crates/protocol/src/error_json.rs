use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ErrorSeverity {
    Fatal,
    Error,
    Warning,
    Transient,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorJson {
    pub name: String,
    pub code: String,
    pub message: String,
    pub severity: ErrorSeverity,
    pub retryable: bool,
    pub timestamp: i64,
    pub context: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelErrorCode {
    ChannelDisconnected,
    ChannelSendFailed,
    ChannelAuthFailed,
    ChannelRateLimited,
    ChannelStartFailed,
}

impl ChannelErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            ChannelErrorCode::ChannelDisconnected => "CHANNEL_DISCONNECTED",
            ChannelErrorCode::ChannelSendFailed => "CHANNEL_SEND_FAILED",
            ChannelErrorCode::ChannelAuthFailed => "CHANNEL_AUTH_FAILED",
            ChannelErrorCode::ChannelRateLimited => "CHANNEL_RATE_LIMITED",
            ChannelErrorCode::ChannelStartFailed => "CHANNEL_START_FAILED",
        }
    }

    pub const fn defaults(self) -> (ErrorSeverity, bool) {
        match self {
            ChannelErrorCode::ChannelDisconnected => (ErrorSeverity::Transient, true),
            ChannelErrorCode::ChannelSendFailed => (ErrorSeverity::Error, true),
            ChannelErrorCode::ChannelAuthFailed => (ErrorSeverity::Fatal, false),
            ChannelErrorCode::ChannelRateLimited => (ErrorSeverity::Transient, true),
            ChannelErrorCode::ChannelStartFailed => (ErrorSeverity::Fatal, false),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryErrorCode {
    MemoryConnectionFailed,
    MemoryQueryFailed,
    MemoryMigrationFailed,
    MemoryEmbedFailed,
}

impl MemoryErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            MemoryErrorCode::MemoryConnectionFailed => "MEMORY_CONNECTION_FAILED",
            MemoryErrorCode::MemoryQueryFailed => "MEMORY_QUERY_FAILED",
            MemoryErrorCode::MemoryMigrationFailed => "MEMORY_MIGRATION_FAILED",
            MemoryErrorCode::MemoryEmbedFailed => "MEMORY_EMBED_FAILED",
        }
    }

    pub const fn defaults(self) -> (ErrorSeverity, bool) {
        match self {
            MemoryErrorCode::MemoryConnectionFailed => (ErrorSeverity::Fatal, true),
            MemoryErrorCode::MemoryQueryFailed => (ErrorSeverity::Error, true),
            MemoryErrorCode::MemoryMigrationFailed => (ErrorSeverity::Fatal, false),
            MemoryErrorCode::MemoryEmbedFailed => (ErrorSeverity::Warning, true),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigErrorCode {
    ConfigInvalid,
    ConfigMissing,
    ConfigParseFailed,
}

impl ConfigErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            ConfigErrorCode::ConfigInvalid => "CONFIG_INVALID",
            ConfigErrorCode::ConfigMissing => "CONFIG_MISSING",
            ConfigErrorCode::ConfigParseFailed => "CONFIG_PARSE_FAILED",
        }
    }

    pub const fn defaults(self) -> (ErrorSeverity, bool) {
        let _ = self;
        (ErrorSeverity::Fatal, false)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolErrorCode {
    ToolExecutionFailed,
    ToolNotFound,
    ToolTimeout,
    ToolBlocked,
}

impl ToolErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            ToolErrorCode::ToolExecutionFailed => "TOOL_EXECUTION_FAILED",
            ToolErrorCode::ToolNotFound => "TOOL_NOT_FOUND",
            ToolErrorCode::ToolTimeout => "TOOL_TIMEOUT",
            ToolErrorCode::ToolBlocked => "TOOL_BLOCKED",
        }
    }

    pub const fn defaults(self) -> (ErrorSeverity, bool) {
        match self {
            ToolErrorCode::ToolExecutionFailed => (ErrorSeverity::Error, false),
            ToolErrorCode::ToolNotFound => (ErrorSeverity::Error, false),
            ToolErrorCode::ToolTimeout => (ErrorSeverity::Warning, true),
            ToolErrorCode::ToolBlocked => (ErrorSeverity::Warning, false),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DelegationErrorCode {
    DelegationTimeout,
    DelegationAgentNotFound,
    DelegationFailed,
}

impl DelegationErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            DelegationErrorCode::DelegationTimeout => "DELEGATION_TIMEOUT",
            DelegationErrorCode::DelegationAgentNotFound => "DELEGATION_AGENT_NOT_FOUND",
            DelegationErrorCode::DelegationFailed => "DELEGATION_FAILED",
        }
    }

    pub const fn defaults(self) -> (ErrorSeverity, bool) {
        match self {
            DelegationErrorCode::DelegationTimeout => (ErrorSeverity::Error, true),
            DelegationErrorCode::DelegationAgentNotFound => (ErrorSeverity::Error, false),
            DelegationErrorCode::DelegationFailed => (ErrorSeverity::Error, false),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeErrorCode {
    RuntimeStartFailed,
    RuntimeShutdownError,
}

impl RuntimeErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            RuntimeErrorCode::RuntimeStartFailed => "RUNTIME_START_FAILED",
            RuntimeErrorCode::RuntimeShutdownError => "RUNTIME_SHUTDOWN_ERROR",
        }
    }

    pub const fn defaults(self) -> (ErrorSeverity, bool) {
        match self {
            RuntimeErrorCode::RuntimeStartFailed => (ErrorSeverity::Fatal, false),
            RuntimeErrorCode::RuntimeShutdownError => (ErrorSeverity::Error, false),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HarnessErrorCode {
    InvalidSessionId,
    SessionIdCollision,
    CapabilityUnsupported,
    UnknownApproval,
    UnknownPrompt,
    BadRequest,
    TurnInFlight,
}

impl HarnessErrorCode {
    pub const ALL: [HarnessErrorCode; 7] = [
        HarnessErrorCode::InvalidSessionId,
        HarnessErrorCode::SessionIdCollision,
        HarnessErrorCode::CapabilityUnsupported,
        HarnessErrorCode::UnknownApproval,
        HarnessErrorCode::UnknownPrompt,
        HarnessErrorCode::BadRequest,
        HarnessErrorCode::TurnInFlight,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            HarnessErrorCode::InvalidSessionId => "invalid_session_id",
            HarnessErrorCode::SessionIdCollision => "session_id_collision",
            HarnessErrorCode::CapabilityUnsupported => "capability_unsupported",
            HarnessErrorCode::UnknownApproval => "unknown_approval",
            HarnessErrorCode::UnknownPrompt => "unknown_prompt",
            HarnessErrorCode::BadRequest => "bad_request",
            HarnessErrorCode::TurnInFlight => "turn_in_flight",
        }
    }

    pub const fn defaults(self) -> (ErrorSeverity, bool) {
        match self {
            HarnessErrorCode::TurnInFlight => (ErrorSeverity::Transient, true),
            _ => (ErrorSeverity::Error, false),
        }
    }
}

pub struct ErrorBuild {
    pub message: String,
    pub timestamp: i64,
    pub cause: Option<String>,
    pub stack: Option<String>,
    pub context: Map<String, Value>,
}

fn base(
    name: &str,
    code: &str,
    severity: ErrorSeverity,
    retryable: bool,
    build: ErrorBuild,
) -> ErrorJson {
    ErrorJson {
        name: name.to_string(),
        code: code.to_string(),
        message: build.message,
        severity,
        retryable,
        timestamp: build.timestamp,
        context: build.context,
        cause: build.cause,
        stack: build.stack,
        status_code: None,
        provider_id: None,
    }
}

fn put_nonempty(context: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(text) = value
        && !text.is_empty()
    {
        context.insert(key.to_string(), Value::String(text.to_string()));
    }
}

pub fn channel_error_json(
    code: ChannelErrorCode,
    build: ErrorBuild,
    channel_id: Option<&str>,
    platform: Option<&str>,
) -> ErrorJson {
    let (severity, retryable) = code.defaults();
    let mut built = base("ChannelError", code.as_str(), severity, retryable, build);
    put_nonempty(&mut built.context, "channelId", channel_id);
    put_nonempty(&mut built.context, "platform", platform);
    built
}

pub fn memory_error_json(code: MemoryErrorCode, build: ErrorBuild) -> ErrorJson {
    let (severity, retryable) = code.defaults();
    base("MemoryError", code.as_str(), severity, retryable, build)
}

pub fn config_error_json(
    code: ConfigErrorCode,
    build: ErrorBuild,
    path: Option<&str>,
) -> ErrorJson {
    let (severity, retryable) = code.defaults();
    let mut built = base("ConfigError", code.as_str(), severity, retryable, build);
    put_nonempty(&mut built.context, "path", path);
    built
}

pub fn tool_error_json(
    code: ToolErrorCode,
    build: ErrorBuild,
    tool_name: Option<&str>,
) -> ErrorJson {
    let (severity, retryable) = code.defaults();
    let mut built = base("ToolError", code.as_str(), severity, retryable, build);
    put_nonempty(&mut built.context, "toolName", tool_name);
    built
}

pub fn delegation_error_json(
    code: DelegationErrorCode,
    build: ErrorBuild,
    from_agent: Option<&str>,
    to_agent: Option<&str>,
) -> ErrorJson {
    let (severity, retryable) = code.defaults();
    let mut built = base("DelegationError", code.as_str(), severity, retryable, build);
    put_nonempty(&mut built.context, "fromAgent", from_agent);
    put_nonempty(&mut built.context, "toAgent", to_agent);
    built
}

pub fn runtime_error_json(code: RuntimeErrorCode, build: ErrorBuild) -> ErrorJson {
    let (severity, retryable) = code.defaults();
    base("RuntimeError", code.as_str(), severity, retryable, build)
}

pub fn harness_error_json(
    code: HarnessErrorCode,
    build: ErrorBuild,
    harness_id: Option<&str>,
    session_id: Option<&str>,
) -> ErrorJson {
    let (severity, retryable) = code.defaults();
    let mut built = base("HarnessError", code.as_str(), severity, retryable, build);
    put_nonempty(&mut built.context, "harnessId", harness_id);
    put_nonempty(&mut built.context, "sessionId", session_id);
    built
}

pub fn provider_severity(status_code: i64) -> ErrorSeverity {
    if status_code == 401 || status_code == 403 {
        ErrorSeverity::Fatal
    } else if status_code == 429 || status_code >= 500 {
        ErrorSeverity::Transient
    } else {
        ErrorSeverity::Error
    }
}

pub fn provider_retryable(status_code: i64) -> bool {
    matches!(status_code, 429 | 503 | 529)
}

pub fn provider_error_json(
    message: impl Into<String>,
    status_code: i64,
    provider_id: &str,
    timestamp: i64,
    cause: Option<String>,
    stack: Option<String>,
    context: Map<String, Value>,
) -> ErrorJson {
    ErrorJson {
        name: "ProviderError".to_string(),
        code: format!("PROVIDER_HTTP_{status_code}"),
        message: message.into(),
        severity: provider_severity(status_code),
        retryable: provider_retryable(status_code),
        timestamp,
        context,
        cause,
        stack,
        status_code: Some(status_code),
        provider_id: Some(provider_id.to_string()),
    }
}
