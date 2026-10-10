use std::str::FromStr;

use serde::de::{self, Deserializer};
use serde::ser::SerializeMap;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Map, Value};

use crate::activity::Activity;
use crate::{JsNumber, PROTOCOL_VERSION};

protocol::wire_enum! {
    pub enum EventType {
        SessionStart => "session.start",
        SessionEnd => "session.end",
        TurnEnd => "turn.end",
        TaskPlan => "task.plan",
        TaskCheck => "task.check",
        Activity => "activity",
        ToolStart => "tool.start",
        ToolEnd => "tool.end",
        ThinkingDelta => "thinking.delta",
        ThinkingEnd => "thinking.end",
        SpeechStt => "speech.stt",
        MessageUser => "message.user",
        MessageAgent => "message.agent",
        TermLine => "term.line",
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub prompt_tokens: JsNumber,
    pub completion_tokens: JsNumber,
    pub cached_tokens: JsNumber,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AgentEventBody {
    SessionStart {
        title: String,
    },
    SessionEnd,
    TurnEnd,
    TaskPlan {
        tasks: Vec<String>,
    },
    TaskCheck {
        index: JsNumber,
    },
    Activity {
        activity: Activity,
    },
    ToolStart {
        tool: String,
        activity: Option<Activity>,
        args: Option<Value>,
    },
    ToolEnd {
        tool: Option<String>,
    },
    ThinkingDelta {
        text: String,
    },
    ThinkingEnd,
    SpeechStt {
        active: bool,
    },
    MessageUser {
        text: String,
    },
    MessageAgent {
        text: String,
        usage: Option<TokenUsage>,
        model: Option<String>,
        duration_ms: Option<JsNumber>,
    },
    TermLine {
        text: String,
    },
    Unknown {
        kind: String,
    },
}

impl AgentEventBody {
    fn type_name(&self) -> &str {
        match self {
            Self::SessionStart { .. } => EventType::SessionStart.as_str(),
            Self::SessionEnd => EventType::SessionEnd.as_str(),
            Self::TurnEnd => EventType::TurnEnd.as_str(),
            Self::TaskPlan { .. } => EventType::TaskPlan.as_str(),
            Self::TaskCheck { .. } => EventType::TaskCheck.as_str(),
            Self::Activity { .. } => EventType::Activity.as_str(),
            Self::ToolStart { .. } => EventType::ToolStart.as_str(),
            Self::ToolEnd { .. } => EventType::ToolEnd.as_str(),
            Self::ThinkingDelta { .. } => EventType::ThinkingDelta.as_str(),
            Self::ThinkingEnd => EventType::ThinkingEnd.as_str(),
            Self::SpeechStt { .. } => EventType::SpeechStt.as_str(),
            Self::MessageUser { .. } => EventType::MessageUser.as_str(),
            Self::MessageAgent { .. } => EventType::MessageAgent.as_str(),
            Self::TermLine { .. } => EventType::TermLine.as_str(),
            Self::Unknown { kind } => kind.as_str(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentEvent {
    pub v: JsNumber,
    pub session: String,
    pub name: Option<String>,
    pub harness: Option<String>,
    pub harness_session: Option<String>,
    pub ts: Option<JsNumber>,
    pub body: AgentEventBody,
    pub extra: Map<String, Value>,
}

impl AgentEvent {
    pub fn new(session: impl Into<String>, body: AgentEventBody) -> Self {
        Self {
            v: JsNumber::from(PROTOCOL_VERSION),
            session: session.into(),
            name: None,
            harness: None,
            harness_session: None,
            ts: None,
            body,
            extra: Map::new(),
        }
    }
}

impl Serialize for AgentEvent {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("v", &self.v)?;
        map.serialize_entry("session", &self.session)?;
        map.serialize_entry("type", self.body.type_name())?;
        match &self.body {
            AgentEventBody::SessionStart { title } => {
                map.serialize_entry("title", title)?;
            }
            AgentEventBody::SessionEnd
            | AgentEventBody::TurnEnd
            | AgentEventBody::ThinkingEnd
            | AgentEventBody::Unknown { .. } => {}
            AgentEventBody::TaskPlan { tasks } => {
                map.serialize_entry("tasks", tasks)?;
            }
            AgentEventBody::TaskCheck { index } => {
                map.serialize_entry("index", index)?;
            }
            AgentEventBody::Activity { activity } => {
                map.serialize_entry("activity", activity)?;
            }
            AgentEventBody::ToolStart {
                tool,
                activity,
                args,
            } => {
                map.serialize_entry("tool", tool)?;
                if let Some(activity) = activity {
                    map.serialize_entry("activity", activity)?;
                }
                if let Some(args) = args {
                    map.serialize_entry("args", args)?;
                }
            }
            AgentEventBody::ToolEnd { tool } => {
                if let Some(tool) = tool {
                    map.serialize_entry("tool", tool)?;
                }
            }
            AgentEventBody::ThinkingDelta { text }
            | AgentEventBody::MessageUser { text }
            | AgentEventBody::TermLine { text } => {
                map.serialize_entry("text", text)?;
            }
            AgentEventBody::SpeechStt { active } => {
                map.serialize_entry("active", active)?;
            }
            AgentEventBody::MessageAgent {
                text,
                usage,
                model,
                duration_ms,
            } => {
                map.serialize_entry("text", text)?;
                if let Some(usage) = usage {
                    map.serialize_entry("usage", usage)?;
                }
                if let Some(model) = model {
                    map.serialize_entry("model", model)?;
                }
                if let Some(duration_ms) = duration_ms {
                    map.serialize_entry("durationMs", duration_ms)?;
                }
            }
        }
        if let Some(name) = &self.name {
            map.serialize_entry("name", name)?;
        }
        if let Some(harness) = &self.harness {
            map.serialize_entry("harness", harness)?;
        }
        if let Some(harness_session) = &self.harness_session {
            map.serialize_entry("harnessSession", harness_session)?;
        }
        if let Some(ts) = &self.ts {
            map.serialize_entry("ts", ts)?;
        }
        for (key, value) in &self.extra {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for AgentEvent {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        parse_event(&value).ok_or_else(|| de::Error::custom("not a valid v1 AgentEvent"))
    }
}

const ENVELOPE: &[&str] = &[
    "v",
    "session",
    "type",
    "name",
    "harness",
    "harnessSession",
    "ts",
];

pub fn parse_event(raw: &Value) -> Option<AgentEvent> {
    let obj = raw.as_object()?;
    if !is_version(obj.get("v")?) {
        return None;
    }
    let session = required_session(obj.get("session")?)?.to_string();
    let kind = obj.get("type")?.as_str()?;
    let name = optional_string(obj, "name")?;
    let harness = optional_string(obj, "harness")?;
    let harness_session = optional_string(obj, "harnessSession")?;
    let ts = optional_finite(obj, "ts")?;
    let (body, body_keys) = parse_body(kind, obj)?;
    Some(AgentEvent {
        v: JsNumber::from(PROTOCOL_VERSION),
        session,
        name,
        harness,
        harness_session,
        ts,
        body,
        extra: extra_fields(obj, body_keys),
    })
}

fn parse_body(
    kind: &str,
    obj: &Map<String, Value>,
) -> Option<(AgentEventBody, &'static [&'static str])> {
    let kind = EventType::from_str(kind).ok()?;
    Some(match kind {
        EventType::SessionStart => {
            let title = required_string(obj, "title")?;
            (AgentEventBody::SessionStart { title }, &["title"])
        }
        EventType::SessionEnd => (AgentEventBody::SessionEnd, &[]),
        EventType::TurnEnd => (AgentEventBody::TurnEnd, &[]),
        EventType::TaskPlan => {
            let tasks = parse_tasks(obj.get("tasks")?)?;
            (AgentEventBody::TaskPlan { tasks }, &["tasks"])
        }
        EventType::TaskCheck => {
            let index = required_index(obj.get("index")?)?;
            (AgentEventBody::TaskCheck { index }, &["index"])
        }
        EventType::Activity => {
            let activity = Activity::from_str(obj.get("activity")?.as_str()?).ok()?;
            (AgentEventBody::Activity { activity }, &["activity"])
        }
        EventType::ToolStart => {
            let tool = required_string(obj, "tool")?;
            let activity = optional_activity(obj)?;
            let args = obj.get("args").cloned();
            (
                AgentEventBody::ToolStart {
                    tool,
                    activity,
                    args,
                },
                &["tool", "activity", "args"],
            )
        }
        EventType::ToolEnd => {
            let tool = optional_tool(obj)?;
            (AgentEventBody::ToolEnd { tool }, &["tool"])
        }
        EventType::ThinkingDelta => {
            let text = required_string(obj, "text")?;
            (AgentEventBody::ThinkingDelta { text }, &["text"])
        }
        EventType::ThinkingEnd => (AgentEventBody::ThinkingEnd, &[]),
        EventType::SpeechStt => {
            let active = obj.get("active")?.as_bool()?;
            (AgentEventBody::SpeechStt { active }, &["active"])
        }
        EventType::MessageUser => {
            let text = required_string(obj, "text")?;
            (AgentEventBody::MessageUser { text }, &["text"])
        }
        EventType::MessageAgent => {
            let text = required_string(obj, "text")?;
            let model = optional_string(obj, "model")?;
            let duration_ms = optional_non_neg(obj, "durationMs")?;
            let usage = match obj.get("usage") {
                None => None,
                Some(value) => Some(parse_usage(value)?),
            };
            (
                AgentEventBody::MessageAgent {
                    text,
                    usage,
                    model,
                    duration_ms,
                },
                &["text", "usage", "model", "durationMs"],
            )
        }
        EventType::TermLine => {
            let text = required_string(obj, "text")?;
            (AgentEventBody::TermLine { text }, &["text"])
        }
    })
}

fn is_version(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|number| number == f64::from(PROTOCOL_VERSION))
}

fn required_session(value: &Value) -> Option<&str> {
    let text = value.as_str()?;
    if text.is_empty() { None } else { Some(text) }
}

fn required_string(obj: &Map<String, Value>, key: &str) -> Option<String> {
    obj.get(key).and_then(Value::as_str).map(ToOwned::to_owned)
}

fn optional_string(obj: &Map<String, Value>, key: &str) -> Option<Option<String>> {
    match obj.get(key) {
        None => Some(None),
        Some(Value::String(text)) => Some(Some(text.clone())),
        Some(_) => None,
    }
}

fn optional_finite(obj: &Map<String, Value>, key: &str) -> Option<Option<JsNumber>> {
    match obj.get(key) {
        None => Some(None),
        Some(Value::Number(number)) => {
            let value = number.as_f64()?;
            if !value.is_finite() {
                return None;
            }
            Some(Some(JsNumber::from(value)))
        }
        Some(_) => None,
    }
}

fn optional_non_neg(obj: &Map<String, Value>, key: &str) -> Option<Option<JsNumber>> {
    match obj.get(key) {
        None => Some(None),
        Some(value) => Some(Some(required_non_neg(value)?)),
    }
}

fn required_non_neg(value: &Value) -> Option<JsNumber> {
    let number = value.as_f64()?;
    if !number.is_finite() || number < 0.0 {
        return None;
    }
    Some(JsNumber::from(number))
}

fn required_index(value: &Value) -> Option<JsNumber> {
    let number = value.as_f64()?;
    if !number.is_finite() || number.fract() != 0.0 || number < 0.0 {
        return None;
    }
    Some(JsNumber::from(number))
}

fn optional_activity(obj: &Map<String, Value>) -> Option<Option<Activity>> {
    match obj.get("activity") {
        None => Some(None),
        Some(Value::String(text)) => Activity::from_str(text).ok().map(Some),
        Some(_) => None,
    }
}

fn optional_tool(obj: &Map<String, Value>) -> Option<Option<String>> {
    match obj.get("tool") {
        None => Some(None),
        Some(Value::String(text)) => Some(Some(text.clone())),
        Some(_) => None,
    }
}

fn parse_tasks(value: &Value) -> Option<Vec<String>> {
    value
        .as_array()?
        .iter()
        .map(|item| item.as_str().map(ToOwned::to_owned))
        .collect()
}

fn parse_usage(value: &Value) -> Option<TokenUsage> {
    let obj = value.as_object()?;
    Some(TokenUsage {
        prompt_tokens: required_non_neg(obj.get("promptTokens")?)?,
        completion_tokens: required_non_neg(obj.get("completionTokens")?)?,
        cached_tokens: required_non_neg(obj.get("cachedTokens")?)?,
    })
}

fn extra_fields(obj: &Map<String, Value>, body_keys: &[&str]) -> Map<String, Value> {
    let mut extra = Map::new();
    for (key, value) in obj {
        if ENVELOPE.contains(&key.as_str()) || body_keys.contains(&key.as_str()) {
            continue;
        }
        extra.insert(key.clone(), value.clone());
    }
    extra
}
