use std::str::FromStr;

use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;

use protocol::js::{JsObject, JsValue};

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
    raw: JsValue,
}

impl AgentEvent {
    pub fn new(session: impl Into<String>, body: AgentEventBody) -> Self {
        let session = session.into();
        let json = encode_event(&session, &body);
        let raw = protocol::js::parse(&json).unwrap_or(JsValue::Null);
        if let Some(event) = event_from_raw(raw.clone()) {
            return event;
        }
        Self {
            v: JsNumber::from(PROTOCOL_VERSION),
            session,
            name: None,
            harness: None,
            harness_session: None,
            ts: None,
            body,
            raw,
        }
    }

    pub(crate) fn text_units(&self) -> Vec<u16> {
        self.raw
            .get("text")
            .and_then(crate::utf16::units_of)
            .unwrap_or_default()
    }
}

impl Serialize for AgentEvent {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        crate::utf16::serialize_json_text(serializer, &protocol::js::stringify(&self.raw))
    }
}

impl<'de> Deserialize<'de> for AgentEvent {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = <Box<serde_json::value::RawValue>>::deserialize(deserializer)?;
        parse_event_str(raw.get()).ok_or_else(|| de::Error::custom("not a valid v1 AgentEvent"))
    }
}

pub fn parse_event(raw: &Value) -> Option<AgentEvent> {
    let text = serde_json::to_string(raw).ok()?;
    parse_event_str(&text)
}

pub fn parse_event_str(text: &str) -> Option<AgentEvent> {
    let raw = protocol::js::parse(text).ok()?;
    event_from_raw(raw)
}

fn event_from_raw(raw: JsValue) -> Option<AgentEvent> {
    let (session, name, harness, harness_session, ts, body) = {
        let object = raw.as_object()?;
        if !is_version(object.get("v")?) {
            return None;
        }
        let session = required_session(object.get("session")?)?;
        let kind = object.get("type")?.as_str()?;
        let name = optional_string(object, "name")?;
        let harness = optional_string(object, "harness")?;
        let harness_session = optional_string(object, "harnessSession")?;
        let ts = optional_finite(object, "ts")?;
        let body = parse_body(kind, object)?;
        (session, name, harness, harness_session, ts, body)
    };
    Some(AgentEvent {
        v: JsNumber::from(PROTOCOL_VERSION),
        session,
        name,
        harness,
        harness_session,
        ts,
        body,
        raw,
    })
}

fn parse_body(kind: &str, object: &JsObject) -> Option<AgentEventBody> {
    let kind = EventType::from_str(kind).ok()?;
    Some(match kind {
        EventType::SessionStart => AgentEventBody::SessionStart {
            title: required_string(object, "title")?,
        },
        EventType::SessionEnd => AgentEventBody::SessionEnd,
        EventType::TurnEnd => AgentEventBody::TurnEnd,
        EventType::TaskPlan => AgentEventBody::TaskPlan {
            tasks: parse_tasks(object.get("tasks")?)?,
        },
        EventType::TaskCheck => AgentEventBody::TaskCheck {
            index: required_index(object.get("index")?)?,
        },
        EventType::Activity => AgentEventBody::Activity {
            activity: Activity::from_str(object.get("activity")?.as_str()?).ok()?,
        },
        EventType::ToolStart => AgentEventBody::ToolStart {
            tool: required_string(object, "tool")?,
            activity: optional_activity(object)?,
            args: object
                .get("args")
                .map(|value| json_value(value).unwrap_or(Value::Null)),
        },
        EventType::ToolEnd => AgentEventBody::ToolEnd {
            tool: optional_tool(object)?,
        },
        EventType::ThinkingDelta => AgentEventBody::ThinkingDelta {
            text: required_string(object, "text")?,
        },
        EventType::ThinkingEnd => AgentEventBody::ThinkingEnd,
        EventType::SpeechStt => AgentEventBody::SpeechStt {
            active: object.get("active")?.as_bool()?,
        },
        EventType::MessageUser => AgentEventBody::MessageUser {
            text: required_string(object, "text")?,
        },
        EventType::MessageAgent => AgentEventBody::MessageAgent {
            text: required_string(object, "text")?,
            usage: match object.get("usage") {
                None => None,
                Some(value) => Some(parse_usage(value)?),
            },
            model: optional_string(object, "model")?,
            duration_ms: optional_non_neg(object, "durationMs")?,
        },
        EventType::TermLine => AgentEventBody::TermLine {
            text: required_string(object, "text")?,
        },
    })
}

fn is_version(value: &JsValue) -> bool {
    match value {
        JsValue::Number(number) => *number == f64::from(PROTOCOL_VERSION),
        _ => false,
    }
}

fn required_session(value: &JsValue) -> Option<String> {
    let text = value.as_str()?;
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

fn required_string(object: &JsObject, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(JsValue::as_str)
        .map(ToOwned::to_owned)
}

fn optional_string(object: &JsObject, key: &str) -> Option<Option<String>> {
    match object.get(key) {
        None => Some(None),
        Some(value) => Some(Some(value.as_str()?.to_string())),
    }
}

fn optional_finite(object: &JsObject, key: &str) -> Option<Option<JsNumber>> {
    match object.get(key) {
        None => Some(None),
        Some(JsValue::Number(number)) if number.is_finite() => Some(Some(JsNumber::from(*number))),
        Some(_) => None,
    }
}

fn optional_non_neg(object: &JsObject, key: &str) -> Option<Option<JsNumber>> {
    match object.get(key) {
        None => Some(None),
        Some(value) => Some(Some(required_non_neg(value)?)),
    }
}

fn required_non_neg(value: &JsValue) -> Option<JsNumber> {
    let JsValue::Number(number) = value else {
        return None;
    };
    if !number.is_finite() || *number < 0.0 {
        return None;
    }
    Some(JsNumber::from(*number))
}

fn required_index(value: &JsValue) -> Option<JsNumber> {
    let JsValue::Number(number) = value else {
        return None;
    };
    if !number.is_finite() || number.fract() != 0.0 || *number < 0.0 {
        return None;
    }
    Some(JsNumber::from(*number))
}

fn optional_activity(object: &JsObject) -> Option<Option<Activity>> {
    match object.get("activity") {
        None => Some(None),
        Some(value) => {
            let text = value.as_str()?;
            Some(Some(Activity::from_str(text).ok()?))
        }
    }
}

fn optional_tool(object: &JsObject) -> Option<Option<String>> {
    match object.get("tool") {
        None => Some(None),
        Some(value) => Some(Some(value.as_str()?.to_string())),
    }
}

fn parse_tasks(value: &JsValue) -> Option<Vec<String>> {
    value
        .as_array()?
        .iter()
        .map(|item| item.as_str().map(ToOwned::to_owned))
        .collect()
}

fn parse_usage(value: &JsValue) -> Option<TokenUsage> {
    let object = value.as_object()?;
    Some(TokenUsage {
        prompt_tokens: required_non_neg(object.get("promptTokens")?)?,
        completion_tokens: required_non_neg(object.get("completionTokens")?)?,
        cached_tokens: required_non_neg(object.get("cachedTokens")?)?,
    })
}

fn json_value(value: &JsValue) -> Option<Value> {
    serde_json::from_str(&protocol::js::stringify(value)).ok()
}

fn encode_event(session: &str, body: &AgentEventBody) -> String {
    let mut out = String::from("{\"v\":");
    push_number(&mut out, JsNumber::from(PROTOCOL_VERSION));
    out.push_str(",\"session\":");
    push_string(&mut out, session);
    out.push_str(",\"type\":");
    push_string(&mut out, body.type_name());
    match body {
        AgentEventBody::SessionStart { title } => {
            out.push_str(",\"title\":");
            push_string(&mut out, title);
        }
        AgentEventBody::SessionEnd
        | AgentEventBody::TurnEnd
        | AgentEventBody::ThinkingEnd
        | AgentEventBody::Unknown { .. } => {}
        AgentEventBody::TaskPlan { tasks } => {
            out.push_str(",\"tasks\":[");
            for (index, task) in tasks.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                push_string(&mut out, task);
            }
            out.push(']');
        }
        AgentEventBody::TaskCheck { index } => {
            out.push_str(",\"index\":");
            push_number(&mut out, *index);
        }
        AgentEventBody::Activity { activity } => {
            out.push_str(",\"activity\":");
            push_string(&mut out, activity.as_str());
        }
        AgentEventBody::ToolStart {
            tool,
            activity,
            args,
        } => {
            out.push_str(",\"tool\":");
            push_string(&mut out, tool);
            if let Some(activity) = activity {
                out.push_str(",\"activity\":");
                push_string(&mut out, activity.as_str());
            }
            if let Some(args) = args
                && let Ok(text) = serde_json::to_string(args)
            {
                out.push_str(",\"args\":");
                out.push_str(&text);
            }
        }
        AgentEventBody::ToolEnd { tool } => {
            if let Some(tool) = tool {
                out.push_str(",\"tool\":");
                push_string(&mut out, tool);
            }
        }
        AgentEventBody::ThinkingDelta { text }
        | AgentEventBody::MessageUser { text }
        | AgentEventBody::TermLine { text } => {
            out.push_str(",\"text\":");
            push_string(&mut out, text);
        }
        AgentEventBody::SpeechStt { active } => {
            out.push_str(",\"active\":");
            out.push_str(if *active { "true" } else { "false" });
        }
        AgentEventBody::MessageAgent {
            text,
            usage,
            model,
            duration_ms,
        } => {
            out.push_str(",\"text\":");
            push_string(&mut out, text);
            if let Some(usage) = usage
                && let Ok(text) = serde_json::to_string(usage)
            {
                out.push_str(",\"usage\":");
                out.push_str(&text);
            }
            if let Some(model) = model {
                out.push_str(",\"model\":");
                push_string(&mut out, model);
            }
            if let Some(duration_ms) = duration_ms {
                out.push_str(",\"durationMs\":");
                push_number(&mut out, *duration_ms);
            }
        }
    }
    out.push('}');
    out
}

fn push_string(out: &mut String, text: &str) {
    out.push_str(&protocol::js::stringify(&JsValue::from_text(text)));
}

fn push_number(out: &mut String, number: JsNumber) {
    out.push_str(&protocol::js::stringify(&JsValue::Number(number.as_f64())));
}
