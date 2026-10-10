use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

crate::wire_enum! {
    pub enum ErrorSeverity {
        Fatal => "fatal",
        Error => "error",
        Warning => "warning",
        Transient => "transient",
    }
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

crate::wire_enum! {
    pub enum ChannelErrorCode {
        ChannelDisconnected => "CHANNEL_DISCONNECTED",
        ChannelSendFailed => "CHANNEL_SEND_FAILED",
        ChannelAuthFailed => "CHANNEL_AUTH_FAILED",
        ChannelRateLimited => "CHANNEL_RATE_LIMITED",
        ChannelStartFailed => "CHANNEL_START_FAILED",
    }
}

impl ChannelErrorCode {
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

crate::wire_enum! {
    pub enum MemoryErrorCode {
        MemoryConnectionFailed => "MEMORY_CONNECTION_FAILED",
        MemoryQueryFailed => "MEMORY_QUERY_FAILED",
        MemoryMigrationFailed => "MEMORY_MIGRATION_FAILED",
        MemoryEmbedFailed => "MEMORY_EMBED_FAILED",
    }
}

impl MemoryErrorCode {
    pub const fn defaults(self) -> (ErrorSeverity, bool) {
        match self {
            MemoryErrorCode::MemoryConnectionFailed => (ErrorSeverity::Fatal, true),
            MemoryErrorCode::MemoryQueryFailed => (ErrorSeverity::Error, true),
            MemoryErrorCode::MemoryMigrationFailed => (ErrorSeverity::Fatal, false),
            MemoryErrorCode::MemoryEmbedFailed => (ErrorSeverity::Warning, true),
        }
    }
}

crate::wire_enum! {
    pub enum ConfigErrorCode {
        ConfigInvalid => "CONFIG_INVALID",
        ConfigMissing => "CONFIG_MISSING",
        ConfigParseFailed => "CONFIG_PARSE_FAILED",
    }
}

impl ConfigErrorCode {
    pub const fn defaults(self) -> (ErrorSeverity, bool) {
        match self {
            ConfigErrorCode::ConfigInvalid
            | ConfigErrorCode::ConfigMissing
            | ConfigErrorCode::ConfigParseFailed => (ErrorSeverity::Fatal, false),
        }
    }
}

crate::wire_enum! {
    pub enum ToolErrorCode {
        ToolExecutionFailed => "TOOL_EXECUTION_FAILED",
        ToolNotFound => "TOOL_NOT_FOUND",
        ToolTimeout => "TOOL_TIMEOUT",
        ToolBlocked => "TOOL_BLOCKED",
    }
}

impl ToolErrorCode {
    pub const fn defaults(self) -> (ErrorSeverity, bool) {
        match self {
            ToolErrorCode::ToolExecutionFailed => (ErrorSeverity::Error, false),
            ToolErrorCode::ToolNotFound => (ErrorSeverity::Error, false),
            ToolErrorCode::ToolTimeout => (ErrorSeverity::Warning, true),
            ToolErrorCode::ToolBlocked => (ErrorSeverity::Warning, false),
        }
    }
}

crate::wire_enum! {
    pub enum DelegationErrorCode {
        DelegationTimeout => "DELEGATION_TIMEOUT",
        DelegationAgentNotFound => "DELEGATION_AGENT_NOT_FOUND",
        DelegationFailed => "DELEGATION_FAILED",
    }
}

impl DelegationErrorCode {
    pub const fn defaults(self) -> (ErrorSeverity, bool) {
        match self {
            DelegationErrorCode::DelegationTimeout => (ErrorSeverity::Error, true),
            DelegationErrorCode::DelegationAgentNotFound => (ErrorSeverity::Error, false),
            DelegationErrorCode::DelegationFailed => (ErrorSeverity::Error, false),
        }
    }
}

crate::wire_enum! {
    pub enum RuntimeErrorCode {
        RuntimeStartFailed => "RUNTIME_START_FAILED",
        RuntimeShutdownError => "RUNTIME_SHUTDOWN_ERROR",
    }
}

impl RuntimeErrorCode {
    pub const fn defaults(self) -> (ErrorSeverity, bool) {
        match self {
            RuntimeErrorCode::RuntimeStartFailed => (ErrorSeverity::Fatal, false),
            RuntimeErrorCode::RuntimeShutdownError => (ErrorSeverity::Error, false),
        }
    }
}

crate::wire_enum! {
    pub enum HarnessErrorCode {
        InvalidSessionId => "invalid_session_id",
        SessionIdCollision => "session_id_collision",
        CapabilityUnsupported => "capability_unsupported",
        UnknownApproval => "unknown_approval",
        UnknownPrompt => "unknown_prompt",
        BadRequest => "bad_request",
        TurnInFlight => "turn_in_flight",
    }
}

impl HarnessErrorCode {
    pub const fn defaults(self) -> (ErrorSeverity, bool) {
        match self {
            HarnessErrorCode::TurnInFlight => (ErrorSeverity::Transient, true),
            HarnessErrorCode::InvalidSessionId
            | HarnessErrorCode::SessionIdCollision
            | HarnessErrorCode::CapabilityUnsupported
            | HarnessErrorCode::UnknownApproval
            | HarnessErrorCode::UnknownPrompt
            | HarnessErrorCode::BadRequest => (ErrorSeverity::Error, false),
        }
    }
}

pub struct ErrorDetails {
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
    build: ErrorDetails,
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
    build: ErrorDetails,
    channel_id: Option<&str>,
    platform: Option<&str>,
) -> ErrorJson {
    let (severity, retryable) = code.defaults();
    let mut built = base("ChannelError", code.as_str(), severity, retryable, build);
    put_nonempty(&mut built.context, "channelId", channel_id);
    put_nonempty(&mut built.context, "platform", platform);
    built
}

pub fn memory_error_json(code: MemoryErrorCode, build: ErrorDetails) -> ErrorJson {
    let (severity, retryable) = code.defaults();
    base("MemoryError", code.as_str(), severity, retryable, build)
}

pub fn config_error_json(
    code: ConfigErrorCode,
    build: ErrorDetails,
    path: Option<&str>,
) -> ErrorJson {
    let (severity, retryable) = code.defaults();
    let mut built = base("ConfigError", code.as_str(), severity, retryable, build);
    put_nonempty(&mut built.context, "path", path);
    built
}

pub fn tool_error_json(
    code: ToolErrorCode,
    build: ErrorDetails,
    tool_name: Option<&str>,
) -> ErrorJson {
    let (severity, retryable) = code.defaults();
    let mut built = base("ToolError", code.as_str(), severity, retryable, build);
    put_nonempty(&mut built.context, "toolName", tool_name);
    built
}

pub fn delegation_error_json(
    code: DelegationErrorCode,
    build: ErrorDetails,
    from_agent: Option<&str>,
    to_agent: Option<&str>,
) -> ErrorJson {
    let (severity, retryable) = code.defaults();
    let mut built = base("DelegationError", code.as_str(), severity, retryable, build);
    put_nonempty(&mut built.context, "fromAgent", from_agent);
    put_nonempty(&mut built.context, "toAgent", to_agent);
    built
}

pub fn runtime_error_json(code: RuntimeErrorCode, build: ErrorDetails) -> ErrorJson {
    let (severity, retryable) = code.defaults();
    base("RuntimeError", code.as_str(), severity, retryable, build)
}

pub fn harness_error_json(
    code: HarnessErrorCode,
    build: ErrorDetails,
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
