mod args;
mod command;
mod context;
mod file_edit;
mod file_read;
mod file_write;
mod fsutil;
mod pathutil;
mod schema;
mod search_glob;
mod search_grep;
mod shell;
mod textutil;
mod todo;
mod web;

pub use ask_user::AskUserTool;
pub use context::{ToolContext, ToolSurface};
pub use file_edit::FileEditTool;
pub use file_read::{FileReadConfig, FileReadTool};
pub use file_write::FileWriteTool;
pub use schema::{schema_of, set_property_description, set_property_enum};
pub use search_glob::{SearchGlobConfig, SearchGlobTool};
pub use search_grep::{SearchGrepConfig, SearchGrepTool};
pub use shell::{
    Approval, ApprovalLevel, CommandCategory, ShellConfig, ShellTool, categorize_command,
    check_git_warnings,
};
pub use todo::TodoTool;
pub use tokio_util::sync::CancellationToken;
pub use web::{
    DDG_HTML_URL, GOOGLE_CSE_URL, HttpClient, HttpRequest, HttpResponse, RecordedCall,
    RecordingClient, ReqwestClient, WebFetchConfig, WebFetchTool, WebSearchConfig, WebSearchTool,
    XAI_RESPONSES_URL, default_http, extract_markdown, header_value, request_header,
};

mod ask_user;

use async_trait::async_trait;
use protocol::ToolResult;
use serde_json::Value;

#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &'static str;
    fn description(&self) -> &str;
    fn parameters(&self) -> Value;
    async fn execute(
        &self,
        args: Value,
        cancellation: &CancellationToken,
        context: &ToolContext,
    ) -> ToolResult;
}

pub fn result_text(result: &ToolResult) -> &str {
    match result {
        ToolResult::Text(text) => text,
        ToolResult::Parts(_) => "",
    }
}

pub(crate) fn text(value: impl Into<String>) -> ToolResult {
    ToolResult::Text(value.into())
}
