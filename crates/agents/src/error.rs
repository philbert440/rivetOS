use std::fmt;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum PresetError {
    #[error("{message}")]
    Conflict { message: String },
    #[error("{message}")]
    MigrationRequired { message: String },
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl PresetError {
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::Conflict {
            message: message.into(),
        }
    }

    pub fn migration_required(message: impl Into<String>) -> Self {
        Self::MigrationRequired {
            message: message.into(),
        }
    }

    pub fn message(message: impl Into<String>) -> Self {
        Self::Message(message.into())
    }

    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::Conflict { .. } => Some("preset_conflict"),
            Self::MigrationRequired { .. } => Some("preset_migration_required"),
            Self::Message(_) | Self::Io(_) => None,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::Conflict { .. } => "PresetConflictError",
            Self::MigrationRequired { .. } => "PresetMigrationRequiredError",
            Self::Message(_) | Self::Io(_) => "Error",
        }
    }

    pub fn is_conflict(&self) -> bool {
        matches!(self, Self::Conflict { .. })
    }

    pub fn is_migration_required(&self) -> bool {
        matches!(self, Self::MigrationRequired { .. })
    }

    pub fn is_id_conflict(&self) -> bool {
        let Self::Conflict { message } = self else {
            return false;
        };
        if message.starts_with("agent id already exists") {
            return true;
        }
        if message.starts_with("agent name already exists") {
            return false;
        }
        if message.contains("idx_ros_agent_presets_name") {
            return false;
        }
        word_pkey(message) || message.contains("primary key")
    }
}

fn word_pkey(message: &str) -> bool {
    message.match_indices("_pkey").any(|(index, needle)| {
        let after = index + needle.len();
        message[after..]
            .chars()
            .next()
            .is_none_or(|ch| !ch.is_ascii_alphanumeric() && ch != '_')
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRequestError {
    pub status: u16,
    pub error: String,
    pub code: Option<String>,
    pub harness_id: Option<String>,
}

impl AgentRequestError {
    pub fn bad(error: impl Into<String>) -> Self {
        Self {
            status: 400,
            error: error.into(),
            code: None,
            harness_id: None,
        }
    }

    pub fn conflict(error: impl Into<String>) -> Self {
        Self {
            status: 409,
            error: error.into(),
            code: None,
            harness_id: None,
        }
    }

    pub fn forbidden(harness_id: &str) -> Self {
        Self {
            status: 403,
            error: harness_not_allowed_message(harness_id),
            code: Some("harness_not_allowed".to_string()),
            harness_id: Some(harness_id.to_string()),
        }
    }

    pub fn not_found() -> Self {
        Self {
            status: 404,
            error: AGENT_NOT_FOUND.to_string(),
            code: None,
            harness_id: None,
        }
    }

    pub fn unavailable(error: impl Into<String>) -> Self {
        Self {
            status: 503,
            error: error.into(),
            code: None,
            harness_id: None,
        }
    }

    pub fn directory(message: &str) -> Self {
        Self::unavailable_internal(500, format!("could not create agent directory: {message}"))
    }

    fn unavailable_internal(status: u16, error: String) -> Self {
        Self {
            status,
            error,
            code: None,
            harness_id: None,
        }
    }
}

impl fmt::Display for AgentRequestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.error)
    }
}

impl std::error::Error for AgentRequestError {}

pub const AGENT_NOT_FOUND: &str = "agent not found";
pub const REGISTRY_UNAVAILABLE: &str = "agent registry unavailable";
pub const METHOD_NOT_ALLOWED: &str = "method not allowed";
pub const INVALID_JSON: &str = "invalid JSON";
pub const BODY_TOO_LARGE: &str = "body too large";
pub const NODE_IMMUTABLE: &str = "node is immutable; recreate the agent";
pub const DIRECTORY_ABS: &str = "directory must be an absolute path";
pub const COLOR_HEX: &str = "color must be a hex value";
pub const EFFORT_TOKEN: &str = "effort must be a 0-64 token";
pub const HARNESS_KNOWN: &str = "harnessId must be a known harness";
pub const UNNAMED_AGENT: &str = "Unnamed Agent";
pub const AGENT_NAME_REQUIRED: &str = "agent name is required";
pub const DIRECTORY_EMPTY: &str = "agent directory is empty";
pub const MIGRATION_0018: &str = "agent preset ordering needs DataHub migration 0018_agent_preset_sort_order (run `rivetos db migrate`)";
pub const LINK_NAME: &str = "rivet-shared";
pub const NAME_MAX: usize = 128;
pub const MODEL_MAX: usize = 128;
pub const NODE_BASE_URL_MAX: usize = 512;
pub const SYSTEM_PROMPT_MAX_CHARS: usize = 16_384;
pub const AGENT_SORT_ORDER_MAX: i64 = 1_000_000;
pub const DIRECTORY_MAX_UNITS: usize = 512;

pub fn harness_not_allowed_message(harness_id: &str) -> String {
    format!("harness \"{harness_id}\" is not allowed on this node (den.allowed_harnesses)")
}

pub fn name_taken_message(name: &str) -> String {
    format!("an agent named \"{name}\" already exists")
}

pub fn hosted_elsewhere_message(name: &str, node: &str) -> String {
    format!("agent \"{name}\" is hosted on {node}")
}

pub fn hosting_node_message(node_name: &str) -> String {
    format!("agent must be created on its hosting node ({node_name})")
}

pub fn sort_order_message() -> String {
    format!("sortOrder must be an integer 0-{AGENT_SORT_ORDER_MAX} or null")
}

pub fn model_list_message(model: &str, harness_id: &str, source: &str) -> String {
    format!("model \"{model}\" is not on the {harness_id} model list ({source})")
}

pub fn model_list_warning(preset_name: &str, detail: &str) -> String {
    format!("agent \"{preset_name}\": {detail} — the harness will run its own default")
}
