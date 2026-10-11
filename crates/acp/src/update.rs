use agent_client_protocol::schema::v1::{
    ContentBlock, PlanEntry, SessionNotification, SessionUpdate, ToolCall, ToolCallStatus,
    ToolCallUpdate,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}

impl ToolStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum SessionEvent {
    AgentMessage {
        text: String,
    },
    AgentThought {
        text: String,
    },
    UserMessage {
        text: String,
    },
    ToolCall {
        id: String,
        title: String,
        name: Option<String>,
        status: ToolStatus,
    },
    ToolCallUpdate {
        id: String,
        title: Option<String>,
        name: Option<String>,
        status: Option<ToolStatus>,
    },
    Plan {
        entries: Vec<String>,
    },
    Usage {
        used: u64,
        size: u64,
        cost_amount: Option<f64>,
        cost_currency: Option<String>,
    },
    Other,
}

pub fn event_of(notification: &SessionNotification) -> SessionEvent {
    match &notification.update {
        SessionUpdate::AgentMessageChunk(chunk) => SessionEvent::AgentMessage {
            text: text_of(&chunk.content),
        },
        SessionUpdate::AgentThoughtChunk(chunk) => SessionEvent::AgentThought {
            text: text_of(&chunk.content),
        },
        SessionUpdate::UserMessageChunk(chunk) => SessionEvent::UserMessage {
            text: text_of(&chunk.content),
        },
        SessionUpdate::ToolCall(call) => tool_call(call),
        SessionUpdate::ToolCallUpdate(update) => tool_update(update),
        SessionUpdate::Plan(plan) => SessionEvent::Plan {
            entries: plan.entries.iter().map(plan_line).collect(),
        },
        SessionUpdate::UsageUpdate(usage) => SessionEvent::Usage {
            used: usage.used,
            size: usage.size,
            cost_amount: usage.cost.as_ref().map(|cost| cost.amount),
            cost_currency: usage.cost.as_ref().map(|cost| cost.currency.clone()),
        },
        _ => SessionEvent::Other,
    }
}

fn tool_call(call: &ToolCall) -> SessionEvent {
    SessionEvent::ToolCall {
        id: call.tool_call_id.to_string(),
        title: call.title.clone(),
        name: call.name.clone(),
        status: status_of(call.status),
    }
}

fn tool_update(update: &ToolCallUpdate) -> SessionEvent {
    SessionEvent::ToolCallUpdate {
        id: update.tool_call_id.to_string(),
        title: update.fields.title.clone(),
        name: update.fields.name.clone(),
        status: update.fields.status.map(status_of),
    }
}

fn status_of(status: ToolCallStatus) -> ToolStatus {
    match status {
        ToolCallStatus::Pending => ToolStatus::Pending,
        ToolCallStatus::InProgress => ToolStatus::InProgress,
        ToolCallStatus::Completed => ToolStatus::Completed,
        ToolCallStatus::Failed => ToolStatus::Failed,
        _ => ToolStatus::Pending,
    }
}

fn plan_line(entry: &PlanEntry) -> String {
    entry.content.clone()
}

fn text_of(block: &ContentBlock) -> String {
    match block {
        ContentBlock::Text(text) => text.text.clone(),
        _ => String::new(),
    }
}
