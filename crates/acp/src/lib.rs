mod client;
mod error;
mod fake;
mod policy;
mod transport;
mod update;

pub use client::{AcpClient, InitializeInfo, LoadOutput, PromptOutput};
pub use error::AcpError;
pub use fake::{FakeScript, FakeUsage, spawn_fake};
pub use policy::{AllowOncePolicy, PermissionChoice, PermissionDecision, PermissionPolicy};
pub use transport::child_lines;
pub use update::{SessionEvent, ToolStatus};
