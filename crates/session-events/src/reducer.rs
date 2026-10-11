use std::cmp::Ordering;
use std::str::FromStr;

use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};

use protocol::js::{JsString, JsValue, js_replace, js_slice_units};

use crate::JsNumber;
use crate::activity::{Activity, tool_activity};
use crate::event::{AgentEvent, AgentEventBody, js_from_deserializer};
use crate::ordered::OrderedMap;

protocol::wire_enum! {
    pub enum LogWho {
        User => "user",
        Agent => "agent",
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Task {
    pub label: JsString,
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LogEntry {
    pub who: LogWho,
    pub text: JsString,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomState {
    pub title: JsString,
    pub activity: Activity,
    pub tool: Option<JsString>,
    pub tasks: Vec<Task>,
    pub thought: JsString,
    pub last_message: JsString,
    pub log: Vec<LogEntry>,
    pub term: Vec<JsString>,
    pub ended: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: JsString,
    pub name: JsString,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub harness: Option<JsString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_event_ts: Option<JsNumber>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DenState {
    pub rooms: OrderedMap<RoomState>,
    pub sessions: OrderedMap<SessionInfo>,
}

const THOUGHT_MAX: usize = 220;
const LOG_MAX: usize = 60;
const TERM_MAX: usize = 6;

impl<'de> Deserialize<'de> for Task {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = js_from_deserializer(deserializer)?;
        task_from_js(&value).ok_or_else(|| de::Error::custom("task"))
    }
}

impl<'de> Deserialize<'de> for LogEntry {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = js_from_deserializer(deserializer)?;
        log_from_js(&value).ok_or_else(|| de::Error::custom("log"))
    }
}

impl<'de> Deserialize<'de> for SessionInfo {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = js_from_deserializer(deserializer)?;
        session_info_from_js(&value).ok_or_else(|| de::Error::custom("session"))
    }
}

impl<'de> Deserialize<'de> for RoomState {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = js_from_deserializer(deserializer)?;
        room_from_js(&value).ok_or_else(|| de::Error::custom("room"))
    }
}

pub(crate) fn session_info_from_js(value: &JsValue) -> Option<SessionInfo> {
    let object = value.as_object()?;
    let harness = match object.get("harness") {
        None | Some(JsValue::Null) => None,
        Some(text) => Some(cloned_string(text)?),
    };
    let last_event_ts = match object.get("lastEventTs") {
        None | Some(JsValue::Null) => None,
        Some(JsValue::Number(number)) if number.is_finite() => Some(JsNumber::from(*number)),
        Some(_) => return None,
    };
    Some(SessionInfo {
        id: cloned_string(object.get("id")?)?,
        name: cloned_string(object.get("name")?)?,
        harness,
        last_event_ts,
    })
}

pub(crate) fn room_from_js(value: &JsValue) -> Option<RoomState> {
    let object = value.as_object()?;
    Some(RoomState {
        title: cloned_string(object.get("title")?)?,
        activity: Activity::from_str(object.get("activity")?.as_str()?).ok()?,
        tool: match object.get("tool")? {
            JsValue::Null => None,
            other => Some(cloned_string(other)?),
        },
        tasks: object
            .get("tasks")?
            .as_array()?
            .iter()
            .map(task_from_js)
            .collect::<Option<Vec<_>>>()?,
        thought: cloned_string(object.get("thought")?)?,
        last_message: cloned_string(object.get("lastMessage")?)?,
        log: object
            .get("log")?
            .as_array()?
            .iter()
            .map(log_from_js)
            .collect::<Option<Vec<_>>>()?,
        term: object
            .get("term")?
            .as_array()?
            .iter()
            .map(cloned_string)
            .collect::<Option<Vec<_>>>()?,
        ended: object.get("ended")?.as_bool()?,
    })
}

fn task_from_js(value: &JsValue) -> Option<Task> {
    let object = value.as_object()?;
    Some(Task {
        label: cloned_string(object.get("label")?)?,
        done: object.get("done")?.as_bool()?,
    })
}

fn log_from_js(value: &JsValue) -> Option<LogEntry> {
    let object = value.as_object()?;
    Some(LogEntry {
        who: LogWho::from_str(object.get("who")?.as_str()?).ok()?,
        text: cloned_string(object.get("text")?)?,
    })
}

fn cloned_string(value: &JsValue) -> Option<JsString> {
    value.as_js_string().cloned()
}

pub fn initial_room_state() -> RoomState {
    RoomState {
        title: JsString::from_text(""),
        activity: Activity::Idle,
        tool: None,
        tasks: Vec::new(),
        thought: JsString::from_text(""),
        last_message: JsString::from_text(""),
        log: Vec::new(),
        term: Vec::new(),
        ended: false,
    }
}

pub fn initial_den_state() -> DenState {
    DenState {
        rooms: OrderedMap::new(),
        sessions: OrderedMap::new(),
    }
}

pub fn reduce_room(mut state: RoomState, event: &AgentEvent) -> RoomState {
    let body = event.body();
    if state.ended && !matches!(body, AgentEventBody::SessionStart { .. }) {
        return state;
    }
    match body {
        AgentEventBody::SessionStart { title } => {
            let log = std::mem::take(&mut state.log);
            let mut next = initial_room_state();
            next.title = title;
            next.log = log;
            next
        }
        AgentEventBody::SessionEnd => {
            state.activity = Activity::Sleeping;
            state.tool = None;
            state.thought = JsString::from_text("");
            state.ended = true;
            state
        }
        AgentEventBody::TurnEnd => {
            state.activity = Activity::Idle;
            state.tool = None;
            state.thought = JsString::from_text("");
            state
        }
        AgentEventBody::TaskPlan { tasks } => {
            state.tasks = tasks
                .into_iter()
                .map(|label| Task { label, done: false })
                .collect();
            state.activity = Activity::WritingPlan;
            state
        }
        AgentEventBody::TaskCheck { index } => {
            if let Some(index) = index.as_u64().and_then(|index| usize::try_from(index).ok())
                && let Some(task) = state.tasks.get_mut(index)
            {
                task.done = true;
            }
            state
        }
        AgentEventBody::Activity { activity } => {
            if activity != Activity::Thinking {
                state.thought = JsString::from_text("");
            }
            state.activity = activity;
            state.tool = None;
            state
        }
        AgentEventBody::ToolStart { tool, activity, .. } => {
            state.activity = activity.unwrap_or_else(|| tool_activity(tool.to_utf8()));
            state.tool = Some(tool);
            state.thought = JsString::from_text("");
            state
        }
        AgentEventBody::ToolEnd { .. } => {
            state.tool = None;
            state.activity = Activity::Thinking;
            state
        }
        AgentEventBody::ThinkingDelta { text } => {
            state.thought = if is_spinner_line(text.units()) {
                text
            } else {
                window_thought(&state.thought, &text)
            };
            state.activity = Activity::Thinking;
            state.tool = None;
            state
        }
        AgentEventBody::ThinkingEnd => {
            state.thought = JsString::from_text("");
            state
        }
        AgentEventBody::SpeechStt { active: true } => {
            state.activity = Activity::Listening;
            state.tool = None;
            state.thought = JsString::from_text("");
            state
        }
        AgentEventBody::SpeechStt { active: false } => {
            state.activity = Activity::Thinking;
            state
        }
        AgentEventBody::MessageUser { text } => {
            push_capped(
                &mut state.log,
                LogEntry {
                    who: LogWho::User,
                    text,
                },
                LOG_MAX,
            );
            state
        }
        AgentEventBody::MessageAgent { text, .. } => {
            push_capped(
                &mut state.log,
                LogEntry {
                    who: LogWho::Agent,
                    text: text.clone(),
                },
                LOG_MAX,
            );
            state.last_message = text;
            state.activity = Activity::Speaking;
            state.tool = None;
            state.thought = JsString::from_text("");
            state
        }
        AgentEventBody::TermLine { text } => {
            push_capped(&mut state.term, text, TERM_MAX);
            state
        }
        AgentEventBody::Unknown { .. } => state,
    }
}

pub fn reduce_den(mut state: DenState, event: &AgentEvent) -> DenState {
    let session = event.session().clone();
    let room = state
        .rooms
        .get_key(&session)
        .cloned()
        .unwrap_or_else(initial_room_state);
    let previous = state.sessions.get_key(&session).cloned();
    let info = SessionInfo {
        id: session.clone(),
        name: display_name(event, previous.as_ref()),
        harness: display_harness(event, previous.as_ref()),
        last_event_ts: display_ts(event, previous.as_ref()),
    };
    let reduced = reduce_room(room, event);
    state.rooms.insert(session.clone(), reduced);
    state.sessions.insert(session, info);
    state
}

pub fn list_sessions(state: &DenState) -> Vec<SessionInfo> {
    let mut sessions: Vec<SessionInfo> = state.sessions.values().cloned().collect();
    sessions.sort_by(cmp_recency);
    sessions
}

fn display_name(event: &AgentEvent, previous: Option<&SessionInfo>) -> JsString {
    if let Some(name) = event.name()
        && !name.is_empty()
    {
        return name.clone();
    }
    if let Some(previous) = previous
        && !previous.name.is_empty()
    {
        return previous.name.clone();
    }
    event.session().clone()
}

fn display_harness(event: &AgentEvent, previous: Option<&SessionInfo>) -> Option<JsString> {
    if let Some(harness) = event.harness() {
        Some(harness.clone())
    } else {
        previous.and_then(|info| info.harness.clone())
    }
}

fn display_ts(event: &AgentEvent, previous: Option<&SessionInfo>) -> Option<JsNumber> {
    match event.ts() {
        None => previous.and_then(|info| info.last_event_ts),
        Some(ts) => {
            let previous_ts = previous
                .and_then(|info| info.last_event_ts)
                .map(|value| value.as_f64())
                .unwrap_or(0.0);
            Some(JsNumber::from(js_math_max(ts.as_f64(), previous_ts)))
        }
    }
}

fn js_math_max(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        return f64::NAN;
    }
    if left == 0.0 && right == 0.0 {
        return 0.0;
    }
    if left > right { left } else { right }
}

fn recency_key(info: &SessionInfo) -> f64 {
    info.last_event_ts
        .map(|value| value.as_f64())
        .unwrap_or(0.0)
}

fn cmp_recency(left: &SessionInfo, right: &SessionInfo) -> Ordering {
    let left_ts = recency_key(left);
    let right_ts = recency_key(right);
    if left_ts.is_nan() || right_ts.is_nan() || left_ts == right_ts {
        Ordering::Equal
    } else if left_ts < right_ts {
        Ordering::Greater
    } else {
        Ordering::Less
    }
}

fn push_capped<T>(items: &mut Vec<T>, item: T, max: usize) {
    items.push(item);
    if items.len() > max {
        let drop_count = items.len() - max;
        items.drain(0..drop_count);
    }
}

fn is_spinner_line(units: &[u16]) -> bool {
    let Some(first) = units.first().copied() else {
        return false;
    };
    let Some(second) = units.get(1).copied() else {
        return false;
    };
    if second != u16::from(b' ') {
        return false;
    }
    let Some(ch) = char::from_u32(u32::from(first)) else {
        return false;
    };
    matches!(ch, '✳' | '✢' | '✻' | '✽' | '·')
}

fn window_thought(existing: &JsString, delta: &JsString) -> JsString {
    let mut units = Vec::with_capacity(existing.len() + delta.len());
    units.extend_from_slice(existing.units());
    units.extend_from_slice(delta.units());
    let sliced = JsString::from_units(js_slice_units(&units, Some(-(THOUGHT_MAX as f64)), None));
    if sliced.len() != THOUGHT_MAX {
        return sliced;
    }
    js_replace(&sliced, r"^\S*\s+", "", "").unwrap_or(sliced)
}
