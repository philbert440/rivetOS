use std::cmp::Ordering;

use serde::{Deserialize, Serialize};

use crate::JsNumber;
use crate::activity::{Activity, tool_activity};
use crate::event::{AgentEvent, AgentEventBody};
use crate::ordered::OrderedMap;
use crate::utf16::Utf16String;

protocol::wire_enum! {
    pub enum LogWho {
        User => "user",
        Agent => "agent",
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Task {
    pub label: String,
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogEntry {
    pub who: LogWho,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomState {
    pub title: String,
    pub activity: Activity,
    pub tool: Option<String>,
    pub tasks: Vec<Task>,
    pub thought: Utf16String,
    pub last_message: String,
    pub log: Vec<LogEntry>,
    pub term: Vec<String>,
    pub ended: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
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

pub fn initial_room_state() -> RoomState {
    RoomState {
        title: String::new(),
        activity: Activity::Idle,
        tool: None,
        tasks: Vec::new(),
        thought: Utf16String::from(""),
        last_message: String::new(),
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
    if state.ended && !matches!(event.body, AgentEventBody::SessionStart { .. }) {
        return state;
    }
    match &event.body {
        AgentEventBody::SessionStart { title } => {
            let log = std::mem::take(&mut state.log);
            let mut next = initial_room_state();
            next.title.clone_from(title);
            next.log = log;
            next
        }
        AgentEventBody::SessionEnd => {
            state.activity = Activity::Sleeping;
            state.tool = None;
            state.thought.clear();
            state.ended = true;
            state
        }
        AgentEventBody::TurnEnd => {
            state.activity = Activity::Idle;
            state.tool = None;
            state.thought.clear();
            state
        }
        AgentEventBody::TaskPlan { tasks } => {
            state.tasks = tasks
                .iter()
                .map(|label| Task {
                    label: label.clone(),
                    done: false,
                })
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
            if *activity != Activity::Thinking {
                state.thought.clear();
            }
            state.activity = *activity;
            state.tool = None;
            state
        }
        AgentEventBody::ToolStart { tool, activity, .. } => {
            state.activity = (*activity).unwrap_or_else(|| tool_activity(tool));
            state.tool = Some(tool.clone());
            state.thought.clear();
            state
        }
        AgentEventBody::ToolEnd { .. } => {
            state.tool = None;
            state.activity = Activity::Thinking;
            state
        }
        AgentEventBody::ThinkingDelta { text } => {
            let mut units = event.text_units();
            if units.is_empty() && !text.is_empty() {
                units.extend(text.encode_utf16());
            }
            let thought = if is_spinner_line(&units) {
                Utf16String::from_units(&units)
            } else {
                window_thought(&state.thought, &units)
            };
            state.thought = thought;
            state.activity = Activity::Thinking;
            state.tool = None;
            state
        }
        AgentEventBody::ThinkingEnd => {
            state.thought.clear();
            state
        }
        AgentEventBody::SpeechStt { active: true } => {
            state.activity = Activity::Listening;
            state.tool = None;
            state.thought.clear();
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
                    text: text.clone(),
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
            state.last_message.clone_from(text);
            state.activity = Activity::Speaking;
            state.tool = None;
            state.thought.clear();
            state
        }
        AgentEventBody::TermLine { text } => {
            push_capped(&mut state.term, text.clone(), TERM_MAX);
            state
        }
        AgentEventBody::Unknown { .. } => state,
    }
}

pub fn reduce_den(mut state: DenState, event: &AgentEvent) -> DenState {
    let room = state
        .rooms
        .get(&event.session)
        .cloned()
        .unwrap_or_else(initial_room_state);
    let previous = state.sessions.get(&event.session).cloned();
    let info = SessionInfo {
        id: event.session.clone(),
        name: display_name(event, previous.as_ref()),
        harness: display_harness(event, previous.as_ref()),
        last_event_ts: display_ts(event, previous.as_ref()),
    };
    let reduced = reduce_room(room, event);
    state.rooms.insert(event.session.clone(), reduced);
    state.sessions.insert(event.session.clone(), info);
    state
}

pub fn list_sessions(state: &DenState) -> Vec<SessionInfo> {
    let mut sessions: Vec<SessionInfo> = state.sessions.values().cloned().collect();
    sessions.sort_by(cmp_recency);
    sessions
}

fn display_name(event: &AgentEvent, previous: Option<&SessionInfo>) -> String {
    if let Some(name) = event.name.as_deref()
        && !name.is_empty()
    {
        return name.to_string();
    }
    if let Some(previous) = previous
        && !previous.name.is_empty()
    {
        return previous.name.clone();
    }
    event.session.clone()
}

fn display_harness(event: &AgentEvent, previous: Option<&SessionInfo>) -> Option<String> {
    if event.harness.is_some() {
        event.harness.clone()
    } else {
        previous.and_then(|info| info.harness.clone())
    }
}

fn display_ts(event: &AgentEvent, previous: Option<&SessionInfo>) -> Option<JsNumber> {
    match event.ts {
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

fn window_thought(existing: &Utf16String, delta: &[u16]) -> Utf16String {
    let mut units = existing.units();
    units.extend_from_slice(delta);
    if units.len() > THOUGHT_MAX {
        let start = units.len() - THOUGHT_MAX;
        units.drain(0..start);
    }
    if units.len() == THOUGHT_MAX {
        units = trim_to_word_boundary(&units);
    }
    Utf16String::from_units(&units)
}

fn trim_to_word_boundary(units: &[u16]) -> Vec<u16> {
    let mut consumed_ws = false;
    let mut cut = 0;
    for (index, unit) in units.iter().enumerate() {
        if is_whitespace_unit(*unit) {
            consumed_ws = true;
            cut = index + 1;
        } else if consumed_ws {
            return units[cut..].to_vec();
        }
    }
    if consumed_ws {
        Vec::new()
    } else {
        units.to_vec()
    }
}

fn is_whitespace_unit(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(is_js_whitespace)
}

fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            | '\u{2001}'
            | '\u{2002}'
            | '\u{2003}'
            | '\u{2004}'
            | '\u{2005}'
            | '\u{2006}'
            | '\u{2007}'
            | '\u{2008}'
            | '\u{2009}'
            | '\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}
