use std::sync::Arc;

use std::sync::Mutex;

use agent_client_protocol::schema::v1::{
    AgentCapabilities, CancelNotification, ContentBlock, ContentChunk, Cost, Implementation,
    InitializeRequest, InitializeResponse, LoadSessionRequest, LoadSessionResponse,
    NewSessionRequest, NewSessionResponse, PermissionOption, PermissionOptionKind, Plan, PlanEntry,
    PlanEntryPriority, PlanEntryStatus, PromptRequest, PromptResponse, RequestPermissionRequest,
    SessionNotification, SessionUpdate, StopReason, TextContent, ToolCall, ToolCallUpdate,
    ToolCallUpdateFields, UsageUpdate,
};
use agent_client_protocol::{Agent, Channel, Client, ConnectionTo};
use tokio::task::{AbortHandle, JoinHandle};

use crate::error::AcpError;

#[derive(Clone, Debug)]
pub struct FakeScript {
    pub load_session: bool,
    pub session_id: String,
    pub message: String,
    pub thought: Option<String>,
    pub tool_id: Option<String>,
    pub tool_name: Option<String>,
    pub plan: Vec<String>,
    pub usage_used: Option<u64>,
    pub usage_size: Option<u64>,
    pub usage_cost: Option<f64>,
    pub request_permission: bool,
    pub permission_allow_second: bool,
    pub wait_for_cancel: bool,
    pub exit_mid_turn: bool,
    pub fail_load: bool,
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
            plan: Vec::new(),
            usage_used: None,
            usage_size: None,
            usage_cost: None,
            request_permission: false,
            permission_allow_second: false,
            wait_for_cancel: false,
            exit_mid_turn: false,
            fail_load: false,
        }
    }
}

struct FakeState {
    script: FakeScript,
    pending_prompt: Option<agent_client_protocol::Responder<PromptResponse>>,
    abort: Option<AbortHandle>,
    cancelled: bool,
}

pub fn spawn_fake(script: FakeScript) -> (Channel, JoinHandle<Result<(), AcpError>>) {
    let (client_side, agent_side) = Channel::duplex();
    let state = Arc::new(Mutex::new(FakeState {
        script,
        pending_prompt: None,
        abort: None,
        cancelled: false,
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
                        let load_session = locked(&state_init).script.load_session;
                        responder.respond(
                            InitializeResponse::new(request.protocol_version)
                                .agent_capabilities(
                                    AgentCapabilities::new().load_session(load_session),
                                )
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
                      _cx| {
                    let state_load = Arc::clone(&state_load);
                    async move {
                        let state = locked(&state_load);
                        if state.script.fail_load
                            || request.session_id.to_string() != state.script.session_id
                        {
                            drop(state);
                            return responder.respond_with_internal_error("session load failed");
                        }
                        drop(state);
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
                        let script = locked(&state_prompt).script.clone();
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
                                let options = permission_options(script.permission_allow_second);
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
                                finish_prompt(&cx, responder, &session_id, &script);
                            });
                            return Ok(());
                        }
                        finish_prompt(&cx, responder, &session_id, &script);
                        Ok(())
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

fn permission_options(allow_second: bool) -> Vec<PermissionOption> {
    if allow_second {
        vec![
            PermissionOption::new("no", "Reject", PermissionOptionKind::RejectOnce),
            PermissionOption::new("yes", "Allow", PermissionOptionKind::AllowOnce),
        ]
    } else {
        vec![PermissionOption::new(
            "yes",
            "Allow",
            PermissionOptionKind::AllowOnce,
        )]
    }
}

fn finish_prompt(
    cx: &ConnectionTo<Client>,
    responder: agent_client_protocol::Responder<PromptResponse>,
    session_id: &str,
    script: &FakeScript,
) {
    if let Some(thought) = &script.thought {
        let _ = cx.send_notification(SessionNotification::new(
            session_id.to_string(),
            SessionUpdate::AgentThoughtChunk(ContentChunk::new(ContentBlock::Text(
                TextContent::new(thought.clone()),
            ))),
        ));
    }
    let _ = send_message(cx, session_id, &script.message);
    if let (Some(id), Some(name)) = (&script.tool_id, &script.tool_name) {
        let _ = cx.send_notification(SessionNotification::new(
            session_id.to_string(),
            SessionUpdate::ToolCall(ToolCall::new(id.clone(), name.clone()).name(name.clone())),
        ));
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
    if let (Some(used), Some(size)) = (script.usage_used, script.usage_size) {
        let mut usage = UsageUpdate::new(used, size);
        if let Some(amount) = script.usage_cost {
            usage = usage.cost(Cost::new(amount, "USD"));
        }
        let _ = cx.send_notification(SessionNotification::new(
            session_id.to_string(),
            SessionUpdate::UsageUpdate(usage),
        ));
    }
    let _ = responder.respond(PromptResponse::new(StopReason::EndTurn));
}

fn locked(state: &Mutex<FakeState>) -> std::sync::MutexGuard<'_, FakeState> {
    state.lock().unwrap_or_else(|poison| poison.into_inner())
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
