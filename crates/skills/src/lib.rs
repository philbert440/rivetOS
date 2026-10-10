mod catalog;
mod dirs;
mod frontmatter;
mod helpers;
mod hooks;
mod list_tool;
mod manage;
mod manager;
mod security;

pub use catalog::catalog_text;
pub use dirs::{default_runtime_skill_dirs, resolve_skill_dirs};
pub use frontmatter::{ParsedFrontmatter, extract_triggers_from_description, parse_frontmatter};
pub use helpers::{SkillMeta, cosine_similarity};
pub use hooks::{SkillAfterContext, SkillBeforeContext, SkillHookPipeline};
pub use list_tool::SkillListTool;
pub use manage::SkillManageTool;
pub use manager::{Skill, SkillError, SkillManager, SkillMatch};
pub use security::{ScanResult, scan_skill_content};

use protocol::ToolResult;

pub(crate) fn text(value: impl Into<String>) -> ToolResult {
    ToolResult::Text(value.into())
}
