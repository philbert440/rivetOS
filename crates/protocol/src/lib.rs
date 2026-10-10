mod wire_enum;

pub mod error_json;
pub mod events;
pub mod hooks;
pub mod message;
pub mod session_id;
pub mod task;
pub mod tool_result;

pub use error_json::{
    ChannelErrorCode, ConfigErrorCode, DelegationErrorCode, ErrorDetails, ErrorJson, ErrorSeverity,
    HarnessErrorCode, MemoryErrorCode, RuntimeErrorCode, ToolErrorCode, channel_error_json,
    config_error_json, delegation_error_json, harness_error_json, memory_error_json,
    provider_error_json, runtime_error_json, tool_error_json,
};
pub use events::{
    Attachment, CompactionPending, DelegationRequest, DelegationResult, DelegationStatus,
    InboundMessage, LlmChunk, LlmChunkType, LlmResponse, LlmResponseType, LlmUsage,
    PartialToolCall, QueuedMessage, SessionState, SilentResponse, StreamEvent, StreamEventType,
    ThinkingLevel, TokenUsage,
};
pub use hooks::HookEventName;
pub use message::{
    ContentPart, ImagePart, Message, MessageContent, MessageRole, TextPart, ToolCall, VideoPart,
};
pub use session_id::{
    HARNESS_IDS, ParsedSessionId, SessionIdError, parse_session_id, parse_session_id_str,
};
pub use task::{
    ArtifactKind, CriterionSelfReport, ParsedTaskResult, TASK_RESULT_FENCE, TaskArtifact,
    TaskBudget, TaskExecutorKind, TaskResult, TaskStatus, TaskUsage, TaskVerdict,
    parse_task_result, parse_task_result_json,
};
pub use tool_result::{BLOCKED_PREFIX, TOOL_ERROR_PREFIX, ToolResult, is_blocked, is_thrown_error};
pub use wire_enum::UnknownWireValue;
