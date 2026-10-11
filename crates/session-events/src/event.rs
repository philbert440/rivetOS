use std::str::FromStr;

use serde::de::{self, Deserializer};
use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;

use protocol::js::{JsObject, JsString, JsValue};

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
        title: JsString,
    },
    SessionEnd,
    TurnEnd,
    TaskPlan {
        tasks: Vec<JsString>,
    },
    TaskCheck {
        index: JsNumber,
    },
    Activity {
        activity: Activity,
    },
    ToolStart {
        tool: JsString,
        activity: Option<Activity>,
        args: Option<Value>,
    },
    ToolEnd {
        tool: Option<JsString>,
    },
    ThinkingDelta {
        text: JsString,
    },
    ThinkingEnd,
    SpeechStt {
        active: bool,
    },
    MessageUser {
        text: JsString,
    },
    MessageAgent {
        text: JsString,
        usage: Option<TokenUsage>,
        model: Option<String>,
        duration_ms: Option<JsNumber>,
    },
    TermLine {
        text: JsString,
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
    raw: JsValue,
}

const JSON_RAW_VALUE: &str = "$serde_json::private::RawValue";

impl AgentEvent {
    pub fn new(session: impl AsRef<str>, body: AgentEventBody) -> Self {
        let mut object = JsObject::new();
        put(
            &mut object,
            "v",
            JsValue::Number(f64::from(PROTOCOL_VERSION)),
        );
        put(&mut object, "session", JsValue::from_text(session.as_ref()));
        put(&mut object, "type", JsValue::from_text(body.type_name()));
        insert_body(&mut object, body);
        Self {
            raw: JsValue::Object(object),
        }
    }

    pub fn v(&self) -> JsNumber {
        match self.raw.get("v") {
            Some(JsValue::Number(number)) => JsNumber::from(*number),
            _ => JsNumber::from(PROTOCOL_VERSION),
        }
    }

    pub fn session(&self) -> &str {
        self.string_field("session").unwrap_or("")
    }

    pub fn name(&self) -> Option<&str> {
        self.string_field("name")
    }

    pub fn harness(&self) -> Option<&str> {
        self.string_field("harness")
    }

    pub fn harness_session(&self) -> Option<&str> {
        self.string_field("harnessSession")
    }

    pub fn ts(&self) -> Option<JsNumber> {
        match self.raw.get("ts") {
            Some(JsValue::Number(number)) if number.is_finite() => Some(JsNumber::from(*number)),
            _ => None,
        }
    }

    pub fn body(&self) -> AgentEventBody {
        let Some(object) = self.raw.as_object() else {
            return AgentEventBody::Unknown {
                kind: String::new(),
            };
        };
        let kind = object.get("type").and_then(JsValue::as_str).unwrap_or("");
        parse_body(kind, object).unwrap_or(AgentEventBody::Unknown {
            kind: kind.to_string(),
        })
    }

    pub fn with_session(mut self, session: impl AsRef<str>) -> Self {
        if let Some(object) = self.raw.as_object_mut() {
            put(object, "session", JsValue::from_text(session.as_ref()));
        }
        self
    }

    pub fn with_name(mut self, name: Option<&str>) -> Self {
        self.set_string("name", name);
        self
    }

    pub fn with_harness(mut self, harness: Option<&str>) -> Self {
        self.set_string("harness", harness);
        self
    }

    pub fn with_harness_session(mut self, harness_session: Option<&str>) -> Self {
        self.set_string("harnessSession", harness_session);
        self
    }

    pub fn with_ts(mut self, ts: Option<JsNumber>) -> Self {
        if let Some(object) = self.raw.as_object_mut() {
            match ts {
                Some(ts) => put(object, "ts", JsValue::Number(ts.as_f64())),
                None => {
                    object.remove("ts");
                }
            }
        }
        self
    }

    pub fn stamped(
        self,
        ts: impl Into<JsNumber>,
        name: Option<&str>,
        harness: Option<&str>,
    ) -> Self {
        self.with_ts(Some(ts.into()))
            .with_name(name)
            .with_harness(harness)
    }

    fn string_field(&self, key: &str) -> Option<&str> {
        self.raw.get(key).and_then(JsValue::as_str)
    }

    fn set_string(&mut self, key: &str, value: Option<&str>) {
        let Some(object) = self.raw.as_object_mut() else {
            return;
        };
        match value {
            Some(text) => put(object, key, JsValue::from_text(text)),
            None => {
                object.remove(key);
            }
        }
    }
}

impl Serialize for AgentEvent {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let json = protocol::js::stringify(&self.raw);
        let mut state = serializer.serialize_struct(JSON_RAW_VALUE, 1)?;
        state.serialize_field(JSON_RAW_VALUE, &json)?;
        state.end()
    }
}

impl<'de> Deserialize<'de> for AgentEvent {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = Box::<serde_json::value::RawValue>::deserialize(deserializer)?;
        parse_event_str(raw.get()).ok_or_else(|| de::Error::custom("not a valid v1 AgentEvent"))
    }
}

pub fn parse_event(raw: &Value) -> Option<AgentEvent> {
    let text = serde_json::to_string(raw).ok()?;
    parse_event_str(&text)
}

pub fn parse_event_str(text: &str) -> Option<AgentEvent> {
    let raw = protocol::js::parse(text).ok()?;
    validated(raw)
}

pub(crate) fn js_from_deserializer<'de, D>(deserializer: D) -> Result<JsValue, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = Box::<serde_json::value::RawValue>::deserialize(deserializer)?;
    protocol::js::parse(raw.get()).map_err(de::Error::custom)
}

fn validated(raw: JsValue) -> Option<AgentEvent> {
    let object = raw.as_object()?;
    if !is_version(object.get("v")?) {
        return None;
    }
    let session = object.get("session")?.as_js_string()?;
    if session.units().is_empty() {
        return None;
    }
    let kind = object.get("type")?.as_str()?;
    optional_string(object, "name")?;
    optional_string(object, "harness")?;
    optional_string(object, "harnessSession")?;
    optional_finite(object, "ts")?;
    parse_body(kind, object)?;
    Some(AgentEvent { raw })
}

fn parse_body(kind: &str, object: &JsObject) -> Option<AgentEventBody> {
    let kind = EventType::from_str(kind).ok()?;
    Some(match kind {
        EventType::SessionStart => AgentEventBody::SessionStart {
            title: required_js(object, "title")?,
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
            tool: required_js(object, "tool")?,
            activity: optional_activity(object)?,
            args: object
                .get("args")
                .map(|value| json_value(value).unwrap_or(Value::Null)),
        },
        EventType::ToolEnd => AgentEventBody::ToolEnd {
            tool: optional_tool(object)?,
        },
        EventType::ThinkingDelta => AgentEventBody::ThinkingDelta {
            text: required_js(object, "text")?,
        },
        EventType::ThinkingEnd => AgentEventBody::ThinkingEnd,
        EventType::SpeechStt => AgentEventBody::SpeechStt {
            active: object.get("active")?.as_bool()?,
        },
        EventType::MessageUser => AgentEventBody::MessageUser {
            text: required_js(object, "text")?,
        },
        EventType::MessageAgent => AgentEventBody::MessageAgent {
            text: required_js(object, "text")?,
            usage: match object.get("usage") {
                None => None,
                Some(value) => Some(parse_usage(value)?),
            },
            model: optional_text(object, "model")?,
            duration_ms: optional_non_neg(object, "durationMs")?,
        },
        EventType::TermLine => AgentEventBody::TermLine {
            text: required_js(object, "text")?,
        },
    })
}

fn is_version(value: &JsValue) -> bool {
    match value {
        JsValue::Number(number) => *number == f64::from(PROTOCOL_VERSION),
        _ => false,
    }
}

fn required_js(object: &JsObject, key: &str) -> Option<JsString> {
    object.get(key).and_then(JsValue::as_js_string).cloned()
}

fn optional_string(object: &JsObject, key: &str) -> Option<()> {
    match object.get(key) {
        None => Some(()),
        Some(value) => value.as_js_string().map(|_| ()),
    }
}

fn optional_text(object: &JsObject, key: &str) -> Option<Option<String>> {
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

fn optional_tool(object: &JsObject) -> Option<Option<JsString>> {
    match object.get("tool") {
        None => Some(None),
        Some(value) => Some(Some(value.as_js_string()?.clone())),
    }
}

fn parse_tasks(value: &JsValue) -> Option<Vec<JsString>> {
    value
        .as_array()?
        .iter()
        .map(|item| item.as_js_string().cloned())
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

fn put(object: &mut JsObject, key: &str, value: JsValue) {
    object.insert(JsString::from_text(key), value);
}

fn insert_body(object: &mut JsObject, body: AgentEventBody) {
    match body {
        AgentEventBody::SessionStart { title } => {
            put(object, "title", JsValue::String(title));
        }
        AgentEventBody::SessionEnd
        | AgentEventBody::TurnEnd
        | AgentEventBody::ThinkingEnd
        | AgentEventBody::Unknown { .. } => {}
        AgentEventBody::TaskPlan { tasks } => {
            put(
                object,
                "tasks",
                JsValue::Array(tasks.into_iter().map(JsValue::String).collect()),
            );
        }
        AgentEventBody::TaskCheck { index } => {
            put(object, "index", JsValue::Number(index.as_f64()));
        }
        AgentEventBody::Activity { activity } => {
            put(object, "activity", JsValue::from_text(activity.as_str()));
        }
        AgentEventBody::ToolStart {
            tool,
            activity,
            args,
        } => {
            put(object, "tool", JsValue::String(tool));
            if let Some(activity) = activity {
                put(object, "activity", JsValue::from_text(activity.as_str()));
            }
            if let Some(args) = args {
                put(object, "args", protocol::js::from_serde(&args));
            }
        }
        AgentEventBody::ToolEnd { tool } => {
            if let Some(tool) = tool {
                put(object, "tool", JsValue::String(tool));
            }
        }
        AgentEventBody::ThinkingDelta { text }
        | AgentEventBody::MessageUser { text }
        | AgentEventBody::TermLine { text } => {
            put(object, "text", JsValue::String(text));
        }
        AgentEventBody::SpeechStt { active } => {
            put(object, "active", JsValue::Bool(active));
        }
        AgentEventBody::MessageAgent {
            text,
            usage,
            model,
            duration_ms,
        } => {
            put(object, "text", JsValue::String(text));
            if let Some(usage) = usage {
                put(object, "usage", usage_value(&usage));
            }
            if let Some(model) = model {
                put(object, "model", JsValue::from_text(&model));
            }
            if let Some(duration_ms) = duration_ms {
                put(object, "durationMs", JsValue::Number(duration_ms.as_f64()));
            }
        }
    }
}

fn usage_value(usage: &TokenUsage) -> JsValue {
    let mut object = JsObject::new();
    put(
        &mut object,
        "promptTokens",
        JsValue::Number(usage.prompt_tokens.as_f64()),
    );
    put(
        &mut object,
        "completionTokens",
        JsValue::Number(usage.completion_tokens.as_f64()),
    );
    put(
        &mut object,
        "cachedTokens",
        JsValue::Number(usage.cached_tokens.as_f64()),
    );
    JsValue::Object(object)
}
