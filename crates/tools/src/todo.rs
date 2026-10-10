use std::collections::BTreeMap;
use std::sync::Mutex;

use schemars::JsonSchema;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::args::{self, string};
use crate::context::ToolContext;
use crate::schema::{schema_of, set_property_description, set_property_enum};
use crate::textutil::js_trim;
use crate::{Tool, text};

const DESCRIPTION: &str = "Session-scoped task list. Track multi-step plans with add/update/complete/remove/list operations.";

#[derive(Clone, Copy, PartialEq, Eq)]
enum TaskStatus {
    Pending,
    InProgress,
    Done,
}

impl TaskStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Done => "done",
        }
    }

    fn icon(self) -> &'static str {
        match self {
            Self::Done => "✅",
            Self::InProgress => "🔧",
            Self::Pending => "  ",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "in_progress" => Some(Self::InProgress),
            "done" => Some(Self::Done),
            _ => None,
        }
    }
}

struct Task {
    text: String,
    status: TaskStatus,
}

pub struct TodoTool {
    tasks: Mutex<BTreeMap<i64, Task>>,
    next_id: Mutex<i64>,
}

#[derive(JsonSchema)]
struct TodoParams {
    operation: String,
    task: Option<String>,
    id: Option<f64>,
    status: Option<String>,
    new_text: Option<String>,
}

impl TodoTool {
    pub fn new() -> Self {
        Self {
            tasks: Mutex::new(BTreeMap::new()),
            next_id: Mutex::new(1),
        }
    }
}

impl Default for TodoTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl Tool for TodoTool {
    fn name(&self) -> &'static str {
        "todo"
    }

    fn description(&self) -> &str {
        DESCRIPTION
    }

    fn parameters(&self) -> Value {
        crate::anchor_schema!(TodoParams {
            operation,
            task,
            id,
            status,
            new_text
        });
        let mut schema = schema_of::<TodoParams>();
        set_property_description(&mut schema, "operation", "Operation to perform");
        set_property_enum(
            &mut schema,
            "operation",
            &["add", "update", "complete", "remove", "list"],
        );
        set_property_description(&mut schema, "task", "Task description (required for add)");
        set_property_description(
            &mut schema,
            "id",
            "Task ID (required for update, complete, remove)",
        );
        set_property_description(&mut schema, "status", "New status (for update)");
        set_property_enum(&mut schema, "status", &["pending", "in_progress", "done"]);
        set_property_description(&mut schema, "new_text", "New task description (for update)");
        schema
    }

    async fn execute(
        &self,
        args: Value,
        _cancellation: &CancellationToken,
        _context: &ToolContext,
    ) -> protocol::ToolResult {
        let operation = string(&args, "operation").unwrap_or("");
        match operation {
            "add" => self.add(&args),
            "update" => self.update(&args),
            "complete" => self.complete(&args),
            "remove" => self.remove(&args),
            "list" => self.list(),
            _ => text(format!(
                "Error: unknown operation \"{operation}\" — use add, update, complete, remove, or list"
            )),
        }
    }
}

impl TodoTool {
    fn add(&self, args: &Value) -> protocol::ToolResult {
        let task = js_trim(string(args, "task").unwrap_or(""));
        if task.is_empty() {
            return text("Error: task text is required for add");
        }
        let mut next = self.next_id.lock().unwrap_or_else(|err| err.into_inner());
        let id = *next;
        *next += 1;
        drop(next);
        self.tasks
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .insert(
                id,
                Task {
                    text: task.to_string(),
                    status: TaskStatus::Pending,
                },
            );
        text(format!("Added task #{id}: {task}"))
    }

    fn update(&self, args: &Value) -> protocol::ToolResult {
        let Some(id) = task_id(args) else {
            return text("Error: valid task id is required for update");
        };
        let mut tasks = self.tasks.lock().unwrap_or_else(|err| err.into_inner());
        let Some(task) = tasks.get_mut(&id) else {
            return text(format!("Error: task #{id} not found"));
        };
        if args.get("new_text").is_some() {
            let new_text = js_trim(string(args, "new_text").unwrap_or(""));
            if !new_text.is_empty() {
                task.text = new_text.to_string();
            }
        }
        if args.get("status").is_some() {
            let status = match args.get("status") {
                Some(Value::String(value)) => value.clone(),
                Some(other) => other.to_string(),
                None => String::new(),
            };
            match TaskStatus::parse(&status) {
                Some(parsed) => task.status = parsed,
                None => {
                    return text(format!(
                        "Error: invalid status \"{status}\" — use pending, in_progress, or done"
                    ));
                }
            }
        }
        text(format!(
            "Updated task #{id}: {} [{}]",
            task.text,
            task.status.as_str()
        ))
    }

    fn complete(&self, args: &Value) -> protocol::ToolResult {
        let Some(id) = task_id(args) else {
            return text("Error: valid task id is required for complete");
        };
        let mut tasks = self.tasks.lock().unwrap_or_else(|err| err.into_inner());
        let Some(task) = tasks.get_mut(&id) else {
            return text(format!("Error: task #{id} not found"));
        };
        task.status = TaskStatus::Done;
        text(format!("Completed task #{id}: {}", task.text))
    }

    fn remove(&self, args: &Value) -> protocol::ToolResult {
        let Some(id) = task_id(args) else {
            return text("Error: valid task id is required for remove");
        };
        let mut tasks = self.tasks.lock().unwrap_or_else(|err| err.into_inner());
        if tasks.remove(&id).is_none() {
            return text(format!("Error: task #{id} not found"));
        }
        text(format!("Removed task #{id}"))
    }

    fn list(&self) -> protocol::ToolResult {
        let tasks = self.tasks.lock().unwrap_or_else(|err| err.into_inner());
        if tasks.is_empty() {
            return text("No tasks yet.");
        }
        let done = tasks
            .values()
            .filter(|task| task.status == TaskStatus::Done)
            .count();
        let mut lines = vec![format!("Tasks ({done}/{} done):", tasks.len())];
        for (id, task) in tasks.iter() {
            lines.push(format!("[{}] #{id} {}", task.status.icon(), task.text));
        }
        text(lines.join("\n"))
    }
}

fn task_id(args: &Value) -> Option<i64> {
    let number = args::js_number(args.get("id"));
    if !number.is_finite() || number == 0.0 || number.fract() != 0.0 {
        return None;
    }
    if number < i64::MIN as f64 || number >= 9223372036854775808.0 {
        return None;
    }
    Some(number as i64)
}
