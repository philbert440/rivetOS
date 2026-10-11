use agent_client_protocol::schema::v1::{
    PermissionOption, PermissionOptionKind, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SelectedPermissionOutcome,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PermissionChoice {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PermissionDecision {
    Selected(String),
    Cancelled,
}

pub trait PermissionPolicy: Send + Sync {
    fn decide(&self, options: &[PermissionChoice]) -> PermissionDecision;
}

#[derive(Clone, Debug, Default)]
pub struct AllowOncePolicy;

impl PermissionPolicy for AllowOncePolicy {
    fn decide(&self, options: &[PermissionChoice]) -> PermissionDecision {
        for kind in ["allow_once", "allow_always"] {
            if let Some(option) = options.iter().find(|option| option.kind == kind) {
                return PermissionDecision::Selected(option.option_id.clone());
            }
        }
        PermissionDecision::Cancelled
    }
}

pub fn choices_of(request: &RequestPermissionRequest) -> Vec<PermissionChoice> {
    request.options.iter().map(choice_of).collect()
}

fn choice_of(option: &PermissionOption) -> PermissionChoice {
    PermissionChoice {
        option_id: option.option_id.to_string(),
        name: option.name.clone(),
        kind: kind_name(option.kind).to_string(),
    }
}

fn kind_name(kind: PermissionOptionKind) -> &'static str {
    match kind {
        PermissionOptionKind::AllowOnce => "allow_once",
        PermissionOptionKind::AllowAlways => "allow_always",
        PermissionOptionKind::RejectOnce => "reject_once",
        PermissionOptionKind::RejectAlways => "reject_always",
        _ => "other",
    }
}

pub fn response_for(decision: PermissionDecision) -> RequestPermissionResponse {
    match decision {
        PermissionDecision::Selected(id) => RequestPermissionResponse::new(
            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(id)),
        ),
        PermissionDecision::Cancelled => {
            RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled)
        }
    }
}
