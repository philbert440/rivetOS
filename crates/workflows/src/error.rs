use std::fmt;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::types::Field;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContractReason {
    Missing,
    TypeMismatch,
    FileMissing,
    Invalid,
}

impl ContractReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::TypeMismatch => "type_mismatch",
            Self::FileMissing => "file_missing",
            Self::Invalid => "invalid",
        }
    }
}

impl fmt::Display for ContractReason {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContractValidationIssue {
    pub field: String,
    pub reason: ContractReason,
    pub message: String,
}

#[derive(Debug, Error)]
pub enum WorkflowError {
    #[error("{message}")]
    Suspension {
        message: String,
        step_id: String,
        label: String,
        seq: i64,
    },
    #[error("{message}")]
    Killed { run_id: String, message: String },
    #[error("{message}")]
    Contract {
        message: String,
        issues: Vec<ContractValidationIssue>,
    },
    #[error("{message}")]
    UnknownCallNamespace {
        message: String,
        reference: String,
        namespace: String,
        known_namespaces: Vec<String>,
    },
    #[error("{message}")]
    WorkflowNotFound { message: String, reference: String },
    #[error("{message}")]
    RunNotFound { message: String, run_id: String },
    #[error("{message}")]
    StepTimeout {
        message: String,
        step_id: String,
        timeout_ms: f64,
    },
    #[error("{message}")]
    RunTimeout {
        message: String,
        run_id: String,
        timeout_ms: f64,
    },
    #[error("{message}")]
    BudgetExceeded {
        message: String,
        budget: &'static str,
        limit: f64,
        spent: f64,
    },
    #[error("{message}")]
    MaxConcurrentRuns {
        message: String,
        workflow_id: String,
        max: f64,
        current: usize,
    },
    #[error("{0}")]
    Message(String),
}

impl WorkflowError {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Suspension { .. } => "WorkflowSuspension",
            Self::Killed { .. } => "WorkflowKilled",
            Self::Contract { .. } => "ContractValidationError",
            Self::UnknownCallNamespace { .. } => "UnknownCallNamespaceError",
            Self::WorkflowNotFound { .. } => "WorkflowNotFoundError",
            Self::RunNotFound { .. } => "RunNotFoundError",
            Self::StepTimeout { .. } => "StepTimeoutError",
            Self::RunTimeout { .. } => "RunTimeoutError",
            Self::BudgetExceeded { .. } => "BudgetExceededError",
            Self::MaxConcurrentRuns { .. } => "MaxConcurrentRunsError",
            Self::Message(_) => "Error",
        }
    }

    pub fn is_suspension(&self) -> bool {
        matches!(self, Self::Suspension { .. })
    }

    pub fn is_killed_error(&self) -> bool {
        matches!(self, Self::Killed { .. })
    }

    pub fn is_budget(&self) -> bool {
        matches!(self, Self::BudgetExceeded { .. })
    }

    pub fn is_max_concurrent(&self) -> bool {
        matches!(self, Self::MaxConcurrentRuns { .. })
    }

    pub fn suspension(step_id: impl Into<String>, label: impl Into<String>, seq: i64) -> Self {
        let step_id = step_id.into();
        let label = label.into();
        let message = format!("Workflow suspended at human gate \"{label}\" ({step_id})");
        Self::Suspension {
            message,
            step_id,
            label,
            seq,
        }
    }

    pub fn killed(run_id: impl Into<String>) -> Self {
        let run_id = run_id.into();
        let message = format!("Run {run_id} was killed");
        Self::Killed { run_id, message }
    }

    pub fn contract(issues: Vec<ContractValidationIssue>) -> Self {
        let summary = issues
            .iter()
            .map(|issue| format!("{}: {}", issue.field, issue.message))
            .collect::<Vec<_>>()
            .join("; ");
        let message = format!("Contract validation failed: {summary}");
        Self::Contract { message, issues }
    }

    pub fn missing_fields(fields: &[Field]) -> Self {
        let issues = fields
            .iter()
            .map(|field| ContractValidationIssue {
                field: field.name.clone(),
                reason: ContractReason::Missing,
                message: format!(
                    "required {} field \"{}\" is missing",
                    field.field_type.as_str(),
                    field.name
                ),
            })
            .collect();
        Self::contract(issues)
    }

    pub fn unknown_namespace(
        reference: impl Into<String>,
        namespace: impl Into<String>,
        known: Vec<String>,
    ) -> Self {
        let reference = reference.into();
        let namespace = namespace.into();
        let shown = if namespace.is_empty() {
            "(empty)".to_string()
        } else {
            namespace.clone()
        };
        let known_text = if known.is_empty() {
            "(none)".to_string()
        } else {
            known.join(", ")
        };
        let message = format!(
            "Unknown call namespace \"{shown}\" in ref \"{reference}\". Known namespaces: {known_text}"
        );
        Self::UnknownCallNamespace {
            message,
            reference,
            namespace,
            known_namespaces: known,
        }
    }

    pub fn workflow_not_found(reference: impl Into<String>, detail: Option<String>) -> Self {
        let reference = reference.into();
        let message = detail.unwrap_or_else(|| format!("Workflow not found: {reference}"));
        Self::WorkflowNotFound { message, reference }
    }

    pub fn run_not_found(run_id: impl Into<String>) -> Self {
        let run_id = run_id.into();
        let message = format!("Run not found: {run_id}");
        Self::RunNotFound { run_id, message }
    }

    pub fn step_timeout(step_id: impl Into<String>, timeout_ms: f64) -> Self {
        let step_id = step_id.into();
        let message = format!(
            "Step {step_id} timed out after {}ms",
            crate::timeutil::js_number_text(timeout_ms)
        );
        Self::StepTimeout {
            message,
            step_id,
            timeout_ms,
        }
    }

    pub fn run_timeout(run_id: impl Into<String>, timeout_ms: f64) -> Self {
        let run_id = run_id.into();
        let message = format!(
            "Run {run_id} exceeded max runtime of {}ms",
            crate::timeutil::js_number_text(timeout_ms)
        );
        Self::RunTimeout {
            message,
            run_id,
            timeout_ms,
        }
    }

    pub fn budget(budget: &'static str, limit: f64, spent: f64) -> Self {
        let unit = if budget == "maxTokens" {
            "tokens"
        } else {
            "costUsd"
        };
        let message = format!(
            "Budget exceeded: {budget} limit is {} but spend is {} {unit}",
            crate::timeutil::js_number_text(limit),
            crate::timeutil::js_number_text(spent)
        );
        Self::BudgetExceeded {
            message,
            budget,
            limit,
            spent,
        }
    }

    pub fn max_concurrent(workflow_id: impl Into<String>, max: f64, current: usize) -> Self {
        let workflow_id = workflow_id.into();
        let message = format!(
            "Too many concurrent runs of workflow \"{workflow_id}\": {current} active (maxConcurrentRuns={})",
            crate::timeutil::js_number_text(max)
        );
        Self::MaxConcurrentRuns {
            message,
            workflow_id,
            max,
            current,
        }
    }

    pub fn message(text: impl Into<String>) -> Self {
        Self::Message(text.into())
    }

    pub fn io(path: &std::path::Path, err: std::io::Error) -> Self {
        Self::Message(format!("failed to access {}: {err}", path.display()))
    }

    pub fn not_paused(run_id: &str, status: &str) -> Self {
        Self::message(format!(
            "Run {run_id} is not paused_human (status={status})"
        ))
    }

    pub fn terminal_continue(run_id: &str, status: &str) -> Self {
        Self::message(format!(
            "Run {run_id} is {status} (terminal); cannot continue"
        ))
    }

    pub fn paused_gate(run_id: &str) -> Self {
        Self::message(format!(
            "Run {run_id} is paused at a human gate; use resumeRun with a gateResponse"
        ))
    }

    pub fn kind_mismatch(label: &str, seq: i64, journaled: &str, declared: &str) -> Self {
        Self::message(format!(
            "Journal kind mismatch for step \"{label}#{seq}\": journaled as \"{journaled}\", script now declares \"{declared}\". The orchestration script changed incompatibly mid-run; start a fresh run."
        ))
    }

    pub fn human_kind_mismatch(label: &str, seq: i64, declared: &str) -> Self {
        Self::message(format!(
            "Journal kind mismatch for step \"{label}#{seq}\": journaled as a human gate, script now declares \"{declared}\". Start a fresh run."
        ))
    }

    pub fn child_suspended(name: &str, step_id: &str) -> Self {
        Self::message(format!(
            "Child workflow \"{name}\" suspended at human gate {step_id}; nested human gates during step.call are not auto-resumed in v1"
        ))
    }

    pub fn child_ended(name: &str, status: &str, error: &str) -> Self {
        Self::message(format!(
            "Child workflow \"{name}\" ended with status {status}: {error}"
        ))
    }
}

pub fn is_workflow_suspension(err: &WorkflowError) -> bool {
    err.is_suspension()
}

pub fn is_workflow_killed(err: &WorkflowError) -> bool {
    err.is_killed_error()
}

pub fn is_budget_exceeded(err: &WorkflowError) -> bool {
    err.is_budget()
}

pub fn is_max_concurrent_runs(err: &WorkflowError) -> bool {
    err.is_max_concurrent()
}
