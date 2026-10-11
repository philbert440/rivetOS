use std::sync::Arc;

use parking_lot::Mutex;

use agent_client_protocol::schema::v1::{
    AgentCapabilities, AuthMethod, AuthMethodAgent, AuthenticateRequest, AuthenticateResponse,
    CancelNotification, ContentBlock, ContentChunk, Cost, Implementation, InitializeRequest,
    InitializeResponse, LoadSessionRequest, LoadSessionResponse, NewSessionRequest,
    NewSessionResponse, PermissionOption, PermissionOptionKind, Plan, PlanEntry, PlanEntryPriority,
    PlanEntryStatus, PromptRequest, PromptResponse, RequestPermissionRequest, SessionNotification,
    SessionUpdate, StopReason, TextContent, ToolCall, ToolCallStatus, ToolCallUpdate,
    ToolCallUpdateFields, UsageUpdate,
};
use agent_client_protocol::{Agent, Channel, Client, ConnectionTo};
use tokio::task::{AbortHandle, JoinHandle};

use crate::error::AcpError;

#[derive(Clone, Debug)]
pub struct FakeUsage {
    pub used: u64,
    pub size: u64,
    pub amount: Option<f64>,
    pub currency: Option<String>,
}

#[derive(Clone, Debug)]
pub struct FakeScript {
    pub load_session: bool,
    pub session_id: String,
    pub message: String,
    pub thought: Option<String>,
    pub tool_id: Option<String>,
    pub tool_name: Option<String>,
    pub tool_statuses: Vec<String>,
    pub plan: Vec<String>,
    pub usage_used: Option<u64>,
    pub usage_size: Option<u64>,
    pub usage_cost: Option<f64>,
    pub usage_currency: Option<String>,
    pub usage_by_prompt: Vec<FakeUsage>,
    pub load_usage: Option<FakeUsage>,
    pub chunk_count: Option<usize>,
    pub load_chunks: Option<usize>,
    pub request_permission: bool,
    pub permission_allow_second: bool,
    pub permission_allow_always: bool,
    pub permission_reject_only: bool,
    pub wait_for_cancel: bool,
    pub exit_mid_turn: bool,
    pub fail_load: bool,
    pub auth_methods: Vec<String>,
    pub seen_auth: Arc<Mutex<Option<String>>>,
}

impl Default for FakeScript {
    fn default() -> Self {
        Self {
            load_session: true,
            session_id: "sess-1".to_string(),
            message: "hello from the agent".to_string(),
            thought: None,
            tool_id: None,
            tool_name: None,
            tool_statuses: Vec::new(),
            plan: Vec::new(),
            usage_used: None,
            usage_size: None,
            usage_cost: None,
            usage_currency: None,
            usage_by_prompt: Vec::new(),
            load_usage: None,
            chunk_count: None,
            load_chunks: None,
            request_permission: false,
            permission_allow_second: false,
            permission_allow_always: false,
            permission_reject_only: false,
            wait_for_cancel: false,
            exit_mid_turn: false,
            fail_load: false,
            auth_methods: Vec::new(),
            seen_auth: Arc::new(Mutex::new(None)),
        }
    }
}

struct FakeState {
    script: FakeScript,
    pending_prompt: Option<agent_client_protocol::Responder<PromptResponse>>,
    abort: Option<AbortHandle>,
    cancelled: bool,
    prompt_index: usize,
}

pub fn spawn_fake(script: FakeScript) -> (Channel, JoinHandle<Result<(), AcpError>>) {
    let (client_side, agent_side) = Channel::duplex();
    let state = Arc::new(Mutex::new(FakeState {
        script,
        pending_prompt: None,
        abort: None,
        cancelled: false,
        prompt_index: 0,
    }));
    let state_for_task = Arc::clone(&state);
    let handle = tokio::spawn(async move {
        let state_init = Arc::clone(&state_for_task);
        let state_new = Arc::clone(&state_for_task);
        let state_load = Arc::clone(&state_for_task);
        let state_prompt = Arc::clone(&state_for_task);
        let state_cancel = Arc::clone(&state_for_task);
        Agent
            .builder()
            .on_receive_request(
                move |request: InitializeRequest,
                      responder: agent_client_protocol::Responder<InitializeResponse>,
                      _cx| {
                    let state_init = Arc::clone(&state_init);
                    async move {
                        let state = locked(&state_init);
                        let load_session = state.script.load_session;
                        let methods = state
                            .script
                            .auth_methods
                            .iter()
                            .map(|id| {
                                AuthMethod::Agent(AuthMethodAgent::new(id.clone(), id.clone()))
                            })
                            .collect();
                        drop(state);
                        responder.respond(
                            InitializeResponse::new(request.protocol_version)
                                .agent_capabilities(
                                    AgentCapabilities::new().load_session(load_session),
                                )
                                .auth_methods(methods)
                                .agent_info(Implementation::new("fake-acp", "0.0.0")),
                        )
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                move |_request: NewSessionRequest,
                      responder: agent_client_protocol::Responder<NewSessionResponse>,
                      _cx| {
                    let state_new = Arc::clone(&state_new);
                    async move {
                        let session_id = locked(&state_new).script.session_id.clone();
                        responder.respond(NewSessionResponse::new(session_id))
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                move |request: LoadSessionRequest,
                      responder: agent_client_protocol::Responder<LoadSessionResponse>,
                      cx: ConnectionTo<Client>| {
                    let state_load = Arc::clone(&state_load);
                    async move {
                        let (fail, load_usage, load_chunks) = {
                            let state = locked(&state_load);
                            let fail = state.script.fail_load
                                || request.session_id.to_string() != state.script.session_id;
                            (
                                fail,
                                state.script.load_usage.clone(),
                                state.script.load_chunks,
                            )
                        };
                        if fail {
                            return responder.respond_with_internal_error("session load failed");
                        }
                        let session_id = request.session_id.to_string();
                        if let Some(usage) = load_usage {
                            let _ = send_usage(&cx, &session_id, &usage);
                        }
                        if let Some(count) = load_chunks {
                            for _ in 0..count {
                                let _ = send_message(&cx, &session_id, "y");
                            }
                        }
                        responder.respond(LoadSessionResponse::new())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                move |request: PromptRequest,
                      responder: agent_client_protocol::Responder<PromptResponse>,
                      cx: ConnectionTo<Client>| {
                    let state_prompt = Arc::clone(&state_prompt);
                    async move {
                        let (script, prompt_index) = {
                            let mut state = locked(&state_prompt);
                            let index = state.prompt_index;
                            state.prompt_index += 1;
                            (state.script.clone(), index)
                        };
                        let session_id = request.session_id.to_string();
                        if script.exit_mid_turn {
                            let _ = send_message(&cx, &session_id, "partial");
                            if let Some(abort) = locked(&state_prompt).abort.clone() {
                                abort.abort();
                            }
                            drop(responder);
                            return Ok(());
                        }
                        if script.wait_for_cancel {
                            let mut state = locked(&state_prompt);
                            if state.cancelled {
                                drop(state);
                                let _ =
                                    responder.respond(PromptResponse::new(StopReason::Cancelled));
                                return Ok(());
                            }
                            state.pending_prompt = Some(responder);
                            return Ok(());
                        }
                        if script.request_permission {
                            let cx = cx.clone();
                            tokio::spawn(async move {
                                let options = permission_options(&script);
                                let _ = cx
                                    .send_request(RequestPermissionRequest::new(
                                        session_id.clone(),
                                        ToolCallUpdate::new(
                                            "perm-1",
                                            ToolCallUpdateFields::new().title("run a command"),
                                        ),
                                        options,
                                    ))
                                    .block_task()
                                    .await;
                                finish_prompt(&cx, responder, &session_id, &script, prompt_index);
                            });
                            return Ok(());
                        }
                        finish_prompt(&cx, responder, &session_id, &script, prompt_index);
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                move |request: AuthenticateRequest,
                      responder: agent_client_protocol::Responder<AuthenticateResponse>,
                      _cx| {
                    let state_auth = Arc::clone(&state_for_task);
                    async move {
                        let state = locked(&state_auth);
                        *state.script.seen_auth.lock() = Some(request.method_id.to_string());
                        drop(state);
                        responder.respond(AuthenticateResponse::new())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_notification(
                move |notification: CancelNotification, _cx: ConnectionTo<Client>| {
                    let state_cancel = Arc::clone(&state_cancel);
                    async move {
                        let pending = {
                            let mut state = locked(&state_cancel);
                            state.cancelled = true;
                            state.pending_prompt.take()
                        };
                        if let Some(responder) = pending {
                            let _ = responder.respond(PromptResponse::new(StopReason::Cancelled));
                        }
                        let _ = notification;
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .connect_to(agent_side)
            .await
            .map_err(AcpError::from)
    });
    locked(&state).abort = Some(handle.abort_handle());
    (client_side, handle)
}

fn permission_options(script: &FakeScript) -> Vec<PermissionOption> {
    if script.permission_reject_only {
        return vec![PermissionOption::new(
            "no",
            "Reject",
            PermissionOptionKind::RejectOnce,
        )];
    }
    if script.permission_allow_always {
        return vec![
            PermissionOption::new("no", "Reject", PermissionOptionKind::RejectOnce),
            PermissionOption::new("keep", "Allow always", PermissionOptionKind::AllowAlways),
        ];
    }
    if script.permission_allow_second {
        return vec![
            PermissionOption::new("no", "Reject", PermissionOptionKind::RejectOnce),
            PermissionOption::new("yes", "Allow", PermissionOptionKind::AllowOnce),
        ];
    }
    vec![PermissionOption::new(
        "yes",
        "Allow",
        PermissionOptionKind::AllowOnce,
    )]
}

fn finish_prompt(
    cx: &ConnectionTo<Client>,
    responder: agent_client_protocol::Responder<PromptResponse>,
    session_id: &str,
    script: &FakeScript,
    prompt_index: usize,
) {
    if let Some(thought) = &script.thought {
        let _ = cx.send_notification(SessionNotification::new(
            session_id.to_string(),
            SessionUpdate::AgentThoughtChunk(ContentChunk::new(ContentBlock::Text(
                TextContent::new(thought.clone()),
            ))),
        ));
    }
    if let Some(count) = script.chunk_count {
        for _ in 0..count {
            let _ = send_message(cx, session_id, "x");
        }
    } else {
        let _ = send_message(cx, session_id, &script.message);
    }
    if let (Some(id), Some(name)) = (&script.tool_id, &script.tool_name) {
        let _ = cx.send_notification(SessionNotification::new(
            session_id.to_string(),
            SessionUpdate::ToolCall(ToolCall::new(id.clone(), name.clone()).name(name.clone())),
        ));
        for status in &script.tool_statuses {
            let Some(status) = tool_status(status) else {
                continue;
            };
            let _ = cx.send_notification(SessionNotification::new(
                session_id.to_string(),
                SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
                    id.clone(),
                    ToolCallUpdateFields::new().status(status),
                )),
            ));
        }
    }
    if !script.plan.is_empty() {
        let entries = script
            .plan
            .iter()
            .map(|line| {
                PlanEntry::new(
                    line.clone(),
                    PlanEntryPriority::Medium,
                    PlanEntryStatus::Pending,
                )
            })
            .collect();
        let _ = cx.send_notification(SessionNotification::new(
            session_id.to_string(),
            SessionUpdate::Plan(Plan::new(entries)),
        ));
    }
    if let Some(usage) = script.usage_by_prompt.get(prompt_index) {
        let _ = send_usage(cx, session_id, usage);
    } else if let (Some(used), Some(size)) = (script.usage_used, script.usage_size) {
        let usage = FakeUsage {
            used,
            size,
            amount: script.usage_cost,
            currency: script.usage_currency.clone(),
        };
        let _ = send_usage(cx, session_id, &usage);
    }
    let _ = responder.respond(PromptResponse::new(StopReason::EndTurn));
}

fn tool_status(name: &str) -> Option<ToolCallStatus> {
    match name {
        "pending" => Some(ToolCallStatus::Pending),
        "in_progress" => Some(ToolCallStatus::InProgress),
        "completed" => Some(ToolCallStatus::Completed),
        "failed" => Some(ToolCallStatus::Failed),
        _ => None,
    }
}

fn send_usage(
    cx: &ConnectionTo<Client>,
    session_id: &str,
    usage: &FakeUsage,
) -> Result<(), agent_client_protocol::Error> {
    let mut update = UsageUpdate::new(usage.used, usage.size);
    if let Some(amount) = usage.amount {
        let currency = usage.currency.clone().unwrap_or_else(|| "USD".to_string());
        update = update.cost(Cost::new(amount, currency));
    }
    cx.send_notification(SessionNotification::new(
        session_id.to_string(),
        SessionUpdate::UsageUpdate(update),
    ))
}

fn locked(state: &Mutex<FakeState>) -> parking_lot::MutexGuard<'_, FakeState> {
    state.lock()
}

fn send_message(
    cx: &ConnectionTo<Client>,
    session_id: &str,
    text: &str,
) -> Result<(), agent_client_protocol::Error> {
    cx.send_notification(SessionNotification::new(
        session_id.to_string(),
        SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(TextContent::new(
            text.to_string(),
        )))),
    ))
}
