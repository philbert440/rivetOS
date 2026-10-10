use schemars::JsonSchema;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::args::{self, string};
use crate::context::ToolContext;
use crate::schema::{schema_of, set_property_description, set_property_enum};
use crate::textutil::js_trim;
use crate::{Tool, text};

const DESCRIPTION: &str = "Ask the user a question when you need clarification, confirmation, or a choice. Use instead of guessing. Supports free text, yes/no, and multiple choice questions.";

const VALID_TYPES: &[&str] = &["free_text", "yes_no", "multiple_choice"];

pub struct AskUserTool;

#[derive(JsonSchema)]
struct AskUserParams {
    question: String,
    #[serde(rename = "type")]
    kind: Option<String>,
    choices: Option<Vec<String>>,
    default_value: Option<String>,
    context: Option<String>,
}

impl AskUserTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for AskUserTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl Tool for AskUserTool {
    fn name(&self) -> &'static str {
        "ask_user"
    }

    fn description(&self) -> &str {
        DESCRIPTION
    }

    fn parameters(&self) -> Value {
        crate::anchor_schema!(AskUserParams {
            question,
            kind,
            choices,
            default_value,
            context
        });
        let mut schema = schema_of::<AskUserParams>();
        set_property_description(&mut schema, "question", "The question to ask the user.");
        set_property_description(&mut schema, "type", "Question type. Defaults to free_text.");
        set_property_enum(&mut schema, "type", VALID_TYPES);
        set_property_description(
            &mut schema,
            "choices",
            "Options for multiple_choice questions.",
        );
        set_property_description(
            &mut schema,
            "default_value",
            "Default answer if user just hits enter / says nothing specific.",
        );
        set_property_description(
            &mut schema,
            "context",
            "Optional context explaining why you need this information.",
        );
        schema
    }

    async fn execute(
        &self,
        args: Value,
        _cancellation: &CancellationToken,
        _context: &ToolContext,
    ) -> protocol::ToolResult {
        let Some(question) = string(&args, "question") else {
            return text("Error: question is required and must be a non-empty string.");
        };
        if js_trim(question).is_empty() {
            return text("Error: question is required and must be a non-empty string.");
        }
        let kind = match args.get("type") {
            None | Some(Value::Null) => "free_text".to_string(),
            Some(Value::String(value)) => value.clone(),
            Some(other) => other.to_string(),
        };
        if !VALID_TYPES.contains(&kind.as_str()) {
            return text(format!(
                "Error: invalid type \"{kind}\". Must be one of: {}",
                VALID_TYPES.join(", ")
            ));
        }
        let choices = args::string_list(&args, "choices");
        if kind == "multiple_choice" && choices.as_ref().is_none_or(|items| items.len() < 2) {
            return text(
                "Error: multiple_choice requires a \"choices\" array with at least 2 options.",
            );
        }
        let mut parts = Vec::new();
        if let Some(context) = string(&args, "context").filter(|value| !value.is_empty()) {
            parts.push(format!("Context: {context}"));
            parts.push(String::new());
        }
        parts.push(format!("Question: {}", js_trim(question)));
        let default_value = string(&args, "default_value").filter(|value| !value.is_empty());
        if kind == "yes_no" {
            let hint = default_value
                .map(|value| format!(" (default: {value})"))
                .unwrap_or_default();
            parts.push(format!("Options: Yes / No{hint}"));
        } else if kind == "multiple_choice" {
            parts.push("Options:".to_string());
            if let Some(choices) = choices {
                for (index, choice) in choices.iter().enumerate() {
                    parts.push(format!("  {}. {choice}", index + 1));
                }
            }
            if let Some(value) = default_value {
                parts.push(format!("Default: {value}"));
            }
        } else if let Some(value) = default_value {
            parts.push(format!("Default: {value}"));
        }
        text(parts.join("\n"))
    }
}
