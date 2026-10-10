use crate::turn::{Adapter, Role, ToolStatus, Turn, is_prompt_tool_name};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrackerStatus {
    pub status: &'static str,
    pub phase: Option<&'static str>,
    pub tool_name: Option<String>,
    pub tool_call_id: Option<String>,
    pub prompt_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrackerEdges {
    pub status: Option<TrackerStatus>,
    pub turn_completed: Option<bool>,
}

pub struct TurnTracker {
    live: bool,
    prompt_names: Vec<String>,
    in_flight: Option<bool>,
    last_sig: Option<String>,
    was_complete: bool,
    applied: bool,
}

pub fn create_turn_tracker(adapter: &Adapter) -> TurnTracker {
    TurnTracker {
        live: adapter.capabilities.live_turn,
        prompt_names: adapter.prompt_tool_names.iter().map(|name| (*name).to_string()).collect(),
        in_flight: None,
        last_sig: None,
        was_complete: false,
        applied: false,
    }
}

impl TurnTracker {
    pub fn in_flight(&self) -> Option<bool> {
        self.in_flight
    }

    pub fn apply(&mut self, turns: &[Turn]) -> TrackerEdges {
        if !self.live {
            return TrackerEdges { status: None, turn_completed: None };
        }
        let derived = derive_turn_status(turns);
        let in_flight = match derived.in_flight {
            Some(value) => value,
            None => turns.last().is_some_and(|turn| turn.role == Role::User || turn.complete != Some(true)),
        };
        self.in_flight = Some(in_flight);
        let next = TrackerStatus {
            status: if in_flight { "working" } else { "idle" },
            phase: derived.phase,
            tool_name: derived.tool_name.clone(),
            tool_call_id: derived.tool_call_id.clone(),
            prompt_id: derived.prompt_id.clone(),
        };
        let sig = status_sig(&next);
        let mut edges = TrackerEdges { status: None, turn_completed: None };
        if self.last_sig.as_deref() != Some(sig.as_str()) {
            edges.status = Some(next);
        }
        self.last_sig = Some(sig);
        let now_complete = turns.last().is_some_and(|turn| turn.role == Role::Assistant && turn.complete == Some(true));
        if self.applied && now_complete && !self.was_complete {
            edges.turn_completed = Some(true);
        }
        self.was_complete = now_complete;
        self.applied = true;
        let _ = &self.prompt_names;
        edges
    }
}

struct Derived {
    in_flight: Option<bool>,
    phase: Option<&'static str>,
    tool_name: Option<String>,
    tool_call_id: Option<String>,
    prompt_id: Option<String>,
}

fn derive_turn_status(turns: &[Turn]) -> Derived {
    let Some(last) = turns.last() else {
        return Derived { in_flight: None, phase: None, tool_name: None, tool_call_id: None, prompt_id: None };
    };
    if last.role == Role::User {
        return Derived {
            in_flight: Some(true),
            phase: Some("thinking"),
            tool_name: None,
            tool_call_id: None,
            prompt_id: None,
        };
    }
    if let Some(tools) = &last.tools {
        for tool in tools.iter().rev() {
            if tool.status != ToolStatus::Running {
                continue;
            }
            let prompt = is_prompt_tool_name(&tool.name);
            return Derived {
                in_flight: Some(true),
                phase: Some(if prompt { "prompt" } else { "tool" }),
                tool_name: Some(tool.name.clone()),
                tool_call_id: tool.id.clone(),
                prompt_id: if prompt { tool.id.clone() } else { None },
            };
        }
    }
    if last.complete == Some(true) {
        return Derived { in_flight: Some(false), phase: None, tool_name: None, tool_call_id: None, prompt_id: None };
    }
    if last.last_block == Some(crate::turn::LastBlock::Thinking) {
        return Derived {
            in_flight: Some(true),
            phase: Some("thinking"),
            tool_name: None,
            tool_call_id: None,
            prompt_id: None,
        };
    }
    if last.last_block == Some(crate::turn::LastBlock::Text) {
        return Derived {
            in_flight: Some(true),
            phase: Some("writing"),
            tool_name: None,
            tool_call_id: None,
            prompt_id: None,
        };
    }
    Derived { in_flight: None, phase: None, tool_name: None, tool_call_id: None, prompt_id: None }
}

fn status_sig(status: &TrackerStatus) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        status.status,
        status.phase.unwrap_or(""),
        status.tool_name.as_deref().unwrap_or(""),
        status.tool_call_id.as_deref().unwrap_or(""),
        status.prompt_id.as_deref().unwrap_or("")
    )
}
