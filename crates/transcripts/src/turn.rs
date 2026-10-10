use serde::Serialize;
use serde_json::Value;

use crate::value::Obj;

pub const THINKING_TAIL_CHARS: usize = 8_000;
pub const DEFAULT_TRANSCRIPT_MAX_BYTES: u64 = 8 * 1024 * 1024;
pub const PROMPT_INPUT_MAX: usize = 8192;
pub const PROMPT_RESULT_MAX: usize = 2048;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    Running,
    Done,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LastBlock {
    Thinking,
    Text,
    ToolUse,
    ToolResult,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cached_tokens: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub name: String,
    pub status: ToolStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Obj>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_text: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub role: Role,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Tool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_block: Option<LastBlock>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub complete: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compact: Option<bool>,
    #[serde(skip)]
    pub raw_thinking: Option<String>,
}

impl PartialEq for Turn {
    fn eq(&self, other: &Self) -> bool {
        self.role == other.role
            && self.text == other.text
            && self.thinking == other.thinking
            && self.tools == other.tools
            && self.usage == other.usage
            && self.model == other.model
            && self.stop_reason == other.stop_reason
            && self.last_block == other.last_block
            && self.complete == other.complete
            && self.compact == other.compact
    }
}

impl Turn {
    pub fn user(text: impl Into<String>) -> Self {
        Self {
            role: Role::User,
            text: text.into(),
            thinking: None,
            tools: None,
            usage: None,
            model: None,
            stop_reason: None,
            last_block: None,
            complete: None,
            compact: None,
            raw_thinking: None,
        }
    }

    pub fn assistant() -> Self {
        Self {
            role: Role::Assistant,
            text: String::new(),
            thinking: None,
            tools: Some(Vec::new()),
            usage: None,
            model: None,
            stop_reason: None,
            last_block: None,
            complete: None,
            compact: None,
            raw_thinking: None,
        }
    }

    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

pub fn turns_json(turns: &[Turn]) -> Value {
    Value::Array(turns.iter().map(Turn::to_json).collect())
}

pub fn cap_thinking(raw: &str) -> String {
    if raw.encode_utf16().count() > THINKING_TAIL_CHARS {
        format!("…{}", crate::value::js_slice(raw, -(THINKING_TAIL_CHARS as isize), None))
    } else {
        raw.to_string()
    }
}

pub fn apply_thinking(turn: &mut Turn, raw: &str) {
    if raw.is_empty() {
        return;
    }
    turn.raw_thinking = Some(raw.to_string());
    turn.thinking = Some(cap_thinking(raw));
}

pub fn drop_empty_tools(turn: &mut Turn) {
    if turn.tools.as_ref().is_some_and(Vec::is_empty) {
        turn.tools = None;
    }
}

pub fn thinking_for_delta(turn: Option<&Turn>) -> String {
    turn.map(|item| {
        item.raw_thinking
            .clone()
            .or_else(|| item.thinking.clone())
            .unwrap_or_default()
    })
    .unwrap_or_default()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub live_turn: bool,
    pub prompts: bool,
    pub approvals: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Adapter {
    pub id: &'static str,
    pub command: &'static str,
    pub prompt_tool_names: &'static [&'static str],
    pub capabilities: Capabilities,
}

pub fn adapter_for_command(command: &str) -> Option<Adapter> {
    Some(match command {
        "claude" => Adapter {
            id: "claude-code",
            command: "claude",
            prompt_tool_names: &["AskUserQuestion"],
            capabilities: Capabilities { live_turn: true, prompts: true, approvals: true },
        },
        "grok" => Adapter {
            id: "grok-build",
            command: "grok",
            prompt_tool_names: &[],
            capabilities: Capabilities { live_turn: true, prompts: false, approvals: true },
        },
        "hermes" => Adapter {
            id: "hermes",
            command: "hermes",
            prompt_tool_names: &[],
            capabilities: Capabilities { live_turn: true, prompts: false, approvals: false },
        },
        "kimi" => Adapter {
            id: "kimi-code",
            command: "kimi",
            prompt_tool_names: &[],
            capabilities: Capabilities { live_turn: true, prompts: false, approvals: true },
        },
        "codex" => Adapter {
            id: "codex",
            command: "codex",
            prompt_tool_names: &[],
            capabilities: Capabilities { live_turn: true, prompts: false, approvals: false },
        },
        "opencode" => Adapter {
            id: "opencode",
            command: "opencode",
            prompt_tool_names: &[],
            capabilities: Capabilities { live_turn: true, prompts: false, approvals: false },
        },
        "pi" => Adapter {
            id: "pi",
            command: "pi",
            prompt_tool_names: &[],
            capabilities: Capabilities { live_turn: true, prompts: false, approvals: false },
        },
        "qwen" => Adapter {
            id: "qwen-code",
            command: "qwen",
            prompt_tool_names: &[],
            capabilities: Capabilities { live_turn: true, prompts: false, approvals: false },
        },
        "cursor" => Adapter {
            id: "cursor",
            command: "cursor",
            prompt_tool_names: &[],
            capabilities: Capabilities { live_turn: false, prompts: false, approvals: false },
        },
        "cowork" => Adapter {
            id: "cowork",
            command: "cowork",
            prompt_tool_names: &[],
            capabilities: Capabilities { live_turn: false, prompts: false, approvals: false },
        },
        _ => return None,
    })
}

pub fn roster_to_harness(command: &str) -> Option<&'static str> {
    adapter_for_command(command).map(|adapter| adapter.id)
}

const PROMPT_TOOLS: &[&str] = &["askuserquestion", "ask_user_question", "ask_user"];

pub fn is_prompt_tool_name(name: &str) -> bool {
    let trimmed = protocol::js::js_trim(name).to_ascii_lowercase();
    PROMPT_TOOLS.contains(&trimmed.as_str())
}

pub fn prompt_input(raw: &Value) -> Value {
    let text = protocol::js::stringify(raw);
    if crate::value::js_len(&text) > PROMPT_INPUT_MAX {
        serde_json::json!({ "truncated": true })
    } else {
        raw.clone()
    }
}

pub fn cap_result(text: &str) -> String {
    if crate::value::js_len(text) > PROMPT_RESULT_MAX {
        crate::value::js_slice(text, 0, Some(PROMPT_RESULT_MAX as isize))
    } else {
        text.to_string()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub command: String,
    pub title: String,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub id: String,
    pub command: String,
    pub turns: Vec<Turn>,
    #[serde(skip_serializing_if = "skip_false")]
    pub truncated: bool,
}

fn skip_false(value: &bool) -> bool {
    !*value
}

impl Transcript {
    pub fn empty(id: impl Into<String>) -> Self {
        Self { id: id.into(), command: String::new(), turns: Vec::new(), truncated: false }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreRef {
    pub command: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub watch_paths: Option<Vec<String>>,
}

pub fn running_tools(turn: &Turn) -> bool {
    turn.tools.as_ref().is_some_and(|tools| tools.iter().any(|tool| tool.status == ToolStatus::Running))
}
