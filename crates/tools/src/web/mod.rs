mod fetch;
mod html;
mod http;
mod search;

pub use fetch::{WebFetchConfig, WebFetchTool};
pub use html::extract_markdown;
pub use http::{
    HttpClient, HttpRequest, HttpResponse, RecordedCall, RecordingClient, ReqwestClient,
    default_http, header_value, request_header,
};
pub use search::{DDG_HTML_URL, GOOGLE_CSE_URL, WebSearchConfig, WebSearchTool, XAI_RESPONSES_URL};
