use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    AuthCapabilities, AuthenticateRequest, CancelNotification, ClientCapabilities, ContentBlock,
    FileSystemCapabilities, InitializeRequest, LoadSessionRequest, NewSessionRequest,
    PromptRequest, SessionNotification, StopReason, TextContent,
};
use agent_client_protocol::{Agent, Client, ConnectTo, ConnectionTo};
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::error::AcpError;
use crate::policy::{PermissionPolicy, choices_of, response_for};
use crate::update::{SessionEvent, event_of};

const UPDATE_CAP: usize = 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InitializeInfo {
    pub load_session: bool,
    pub auth_methods: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PromptOutput {
    pub stop_reason: String,
    pub text: String,
    pub events: Vec<SessionEvent>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LoadOutput {
    pub events: Vec<SessionEvent>,
}

enum Command {
    Initialize(oneshot::Sender<Result<InitializeInfo, AcpError>>),
    NewSession {
        cwd: PathBuf,
        reply: oneshot::Sender<Result<String, AcpError>>,
    },
    LoadSession {
        session_id: String,
        cwd: PathBuf,
        reply: oneshot::Sender<Result<LoadOutput, AcpError>>,
    },
    Prompt {
        session_id: String,
        text: String,
        reply: oneshot::Sender<Result<PromptOutput, AcpError>>,
    },
    Authenticate {
        method_id: String,
        reply: oneshot::Sender<Result<(), AcpError>>,
    },
    Shutdown,
}

pub struct AcpClient {
    commands: mpsc::UnboundedSender<Command>,
    connection: Arc<Mutex<Option<ConnectionTo<Agent>>>>,
    cancelled: Arc<AtomicBool>,
    driver: Option<JoinHandle<Result<(), AcpError>>>,
}

impl AcpClient {
    pub async fn connect<C>(
        transport: C,
        policy: Arc<dyn PermissionPolicy>,
    ) -> Result<Self, AcpError>
    where
        C: ConnectTo<Client> + Send + 'static,
    {
        let (commands_tx, mut commands_rx) = mpsc::unbounded_channel();
        let (updates_tx, mut updates_rx) = mpsc::channel(UPDATE_CAP);
        let connection: Arc<Mutex<Option<ConnectionTo<Agent>>>> = Arc::new(Mutex::new(None));
        let cancelled = Arc::new(AtomicBool::new(false));
        let connection_for_driver = Arc::clone(&connection);
        let cancelled_for_handler = Arc::clone(&cancelled);
        let (ready_tx, ready_rx) = oneshot::channel();
        let driver = tokio::spawn(async move {
            let policy = policy;
            let updates_tx = updates_tx;
            let cancelled_for_handler = cancelled_for_handler;
            Client
                .builder()
                .on_receive_notification(
                    {
                        let updates_tx = updates_tx.clone();
                        move |notification: SessionNotification, _cx| {
                            let updates_tx = updates_tx.clone();
                            async move {
                                if updates_tx.send(event_of(&notification)).await.is_err() {
                                    tracing::warn!("acp session update dropped: channel closed");
                                }
                                Ok(())
                            }
                        }
                    },
                    agent_client_protocol::on_receive_notification!(),
                )
                .on_receive_request(
                    {
                        let policy = Arc::clone(&policy);
                        let cancelled_for_handler = Arc::clone(&cancelled_for_handler);
                        move |request: agent_client_protocol::schema::v1::RequestPermissionRequest,
                              responder: agent_client_protocol::Responder<
                            agent_client_protocol::schema::v1::RequestPermissionResponse,
                        >,
                              _cx| {
                            let policy = Arc::clone(&policy);
                            let cancelled_for_handler = Arc::clone(&cancelled_for_handler);
                            async move {
                                let decision = if cancelled_for_handler.load(Ordering::SeqCst) {
                                    crate::policy::PermissionDecision::Cancelled
                                } else {
                                    policy.decide(&choices_of(&request))
                                };
                                responder.respond(response_for(decision))
                            }
                        }
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .connect_with(transport, |cx: ConnectionTo<Agent>| async move {
                    {
                        let mut slot = connection_for_driver.lock().await;
                        *slot = Some(cx.clone());
                    }
                    let _ = ready_tx.send(());
                    while let Some(command) = commands_rx.recv().await {
                        match command {
                            Command::Shutdown => break,
                            Command::Initialize(reply) => {
                                discard_queued(&mut updates_rx);
                                let pending = cx
                                    .send_request(
                                        InitializeRequest::new(ProtocolVersion::V1)
                                            .client_capabilities(
                                                ClientCapabilities::new()
                                                    .fs(FileSystemCapabilities::new())
                                                    .terminal(false)
                                                    .auth(AuthCapabilities::new().terminal(false)),
                                            ),
                                    )
                                    .block_task();
                                let result = finish_request(&mut updates_rx, pending).await.map(
                                    |(response, _)| InitializeInfo {
                                        load_session: response.agent_capabilities.load_session,
                                        auth_methods: response
                                            .auth_methods
                                            .iter()
                                            .map(|method| method.id().to_string())
                                            .collect(),
                                    },
                                );
                                let _ = reply.send(result);
                            }
                            Command::Authenticate { method_id, reply } => {
                                discard_queued(&mut updates_rx);
                                let pending = cx
                                    .send_request(AuthenticateRequest::new(method_id))
                                    .block_task();
                                let result =
                                    finish_request(&mut updates_rx, pending).await.map(|_| ());
                                let _ = reply.send(result);
                            }
                            Command::NewSession { cwd, reply } => {
                                discard_queued(&mut updates_rx);
                                let pending =
                                    cx.send_request(NewSessionRequest::new(cwd)).block_task();
                                let result = finish_request(&mut updates_rx, pending)
                                    .await
                                    .map(|(response, _)| response.session_id.to_string());
                                let _ = reply.send(result);
                            }
                            Command::LoadSession {
                                session_id,
                                cwd,
                                reply,
                            } => {
                                discard_queued(&mut updates_rx);
                                let pending = cx
                                    .send_request(LoadSessionRequest::new(session_id, cwd))
                                    .block_task();
                                let result = finish_request(&mut updates_rx, pending)
                                    .await
                                    .map(|(_, events)| LoadOutput { events });
                                let _ = reply.send(result);
                            }
                            Command::Prompt {
                                session_id,
                                text,
                                reply,
                            } => {
                                cancelled_for_handler.store(false, Ordering::SeqCst);
                                discard_queued(&mut updates_rx);
                                let pending = cx
                                    .send_request(PromptRequest::new(
                                        session_id,
                                        vec![ContentBlock::Text(TextContent::new(text))],
                                    ))
                                    .block_task();
                                let result = finish_request(&mut updates_rx, pending).await.map(
                                    |(response, events)| PromptOutput {
                                        stop_reason: stop_name(response.stop_reason),
                                        text: message_text(&events),
                                        events,
                                    },
                                );
                                let _ = reply.send(result);
                            }
                        }
                    }
                    Ok(())
                })
                .await
                .map_err(AcpError::from)
        });
        match ready_rx.await {
            Ok(()) => Ok(Self {
                commands: commands_tx,
                connection,
                cancelled,
                driver: Some(driver),
            }),
            Err(_) => match driver.await {
                Ok(Ok(())) => Err(AcpError::Closed),
                Ok(Err(error)) => Err(error),
                Err(error) => Err(AcpError::message(error.to_string())),
            },
        }
    }

    pub async fn initialize(&self) -> Result<InitializeInfo, AcpError> {
        self.roundtrip(Command::Initialize).await
    }

    pub async fn new_session(&self, cwd: PathBuf) -> Result<String, AcpError> {
        self.roundtrip(|reply| Command::NewSession { cwd, reply })
            .await
    }

    pub async fn load_session(
        &self,
        session_id: String,
        cwd: PathBuf,
    ) -> Result<LoadOutput, AcpError> {
        self.roundtrip(|reply| Command::LoadSession {
            session_id,
            cwd,
            reply,
        })
        .await
    }

    pub async fn prompt(&self, session_id: String, text: String) -> Result<PromptOutput, AcpError> {
        self.roundtrip(|reply| Command::Prompt {
            session_id,
            text,
            reply,
        })
        .await
    }

    pub async fn authenticate(&self, method_id: String) -> Result<(), AcpError> {
        self.roundtrip(|reply| Command::Authenticate { method_id, reply })
            .await
    }

    pub async fn cancel_session(&self, session_id: &str) -> Result<(), AcpError> {
        self.cancelled.store(true, Ordering::SeqCst);
        let guard = self.connection.lock().await;
        let Some(connection) = guard.as_ref() else {
            return Ok(());
        };
        connection
            .send_notification(CancelNotification::new(session_id.to_string()))
            .map_err(AcpError::from)
    }

    pub async fn shutdown(mut self) -> Result<(), AcpError> {
        let _ = self.commands.send(Command::Shutdown);
        let Some(driver) = self.driver.take() else {
            return Ok(());
        };
        match driver.await {
            Ok(result) => result,
            Err(error) => Err(AcpError::message(error.to_string())),
        }
    }

    async fn roundtrip<T>(
        &self,
        build: impl FnOnce(oneshot::Sender<Result<T, AcpError>>) -> Command,
    ) -> Result<T, AcpError> {
        let (tx, rx) = oneshot::channel();
        self.commands
            .send(build(tx))
            .map_err(|_| AcpError::Closed)?;
        rx.await.map_err(|_| AcpError::Closed)?
    }
}

impl Drop for AcpClient {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Shutdown);
        if let Some(driver) = self.driver.take() {
            driver.abort();
        }
    }
}

fn discard_queued(updates: &mut mpsc::Receiver<SessionEvent>) {
    while updates.try_recv().is_ok() {}
}

async fn finish_request<T, F>(
    updates: &mut mpsc::Receiver<SessionEvent>,
    request: F,
) -> Result<(T, Vec<SessionEvent>), AcpError>
where
    F: std::future::Future<Output = Result<T, agent_client_protocol::Error>>,
{
    let mut events = Vec::new();
    tokio::pin!(request);
    let mut open = true;
    let value = loop {
        if !open {
            break (&mut request).await.map_err(AcpError::from)?;
        }
        tokio::select! {
            biased;
            event = updates.recv() => {
                match event {
                    Some(event) => events.push(event),
                    None => open = false,
                }
            }
            result = &mut request => {
                break result.map_err(AcpError::from)?;
            }
        }
    };
    while let Ok(event) = updates.try_recv() {
        events.push(event);
    }
    Ok((value, events))
}

fn message_text(events: &[SessionEvent]) -> String {
    let mut text = String::new();
    for event in events {
        if let SessionEvent::AgentMessage { text: chunk } = event {
            text.push_str(chunk);
        }
    }
    text
}

fn stop_name(reason: StopReason) -> String {
    match reason {
        StopReason::EndTurn => "end_turn".to_string(),
        StopReason::MaxTokens => "max_tokens".to_string(),
        StopReason::MaxTurnRequests => "max_turn_requests".to_string(),
        StopReason::Refusal => "refusal".to_string(),
        StopReason::Cancelled => "cancelled".to_string(),
        _ => "other".to_string(),
    }
}
