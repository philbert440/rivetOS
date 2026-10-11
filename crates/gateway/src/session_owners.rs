use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use identity::{UserContext, session_visible_to};
use serde_json::{Map, Value};

#[derive(Debug, Clone)]
pub struct SessionOwners {
    file: String,
    map: Map<String, Value>,
}

impl SessionOwners {
    pub fn load(file: impl Into<String>) -> Self {
        let file = file.into();
        let map = read_map(&file);
        Self { file, map }
    }

    pub fn get(&self, session_id: &str) -> Option<&str> {
        self.map.get(session_id).and_then(Value::as_str)
    }

    pub fn set(&mut self, session_id: &str, user_id: &str) {
        if session_id.is_empty() || user_id.is_empty() {
            return;
        }
        if self.get(session_id) == Some(user_id) {
            return;
        }
        self.map
            .insert(session_id.to_string(), Value::String(user_id.to_string()));
        self.persist();
    }

    pub fn visible(&self, session_id: &str, ctx: &UserContext, parent_id: Option<&str>) -> bool {
        if let Some(owner) = self.get(session_id) {
            return owner == ctx.user_id;
        }
        if let Some(parent) = parent_id {
            return session_visible_to(self.get(parent), ctx);
        }
        session_visible_to(None, ctx)
    }

    pub fn tag_if_absent(&mut self, session_id: &str, user_id: &str) -> bool {
        if session_id.is_empty() || user_id.is_empty() || self.get(session_id).is_some() {
            return false;
        }
        self.set(session_id, user_id);
        true
    }

    pub fn inherit(&mut self, child_id: &str, parent_id: Option<&str>) -> bool {
        let Some(parent_id) = parent_id else {
            return false;
        };
        if child_id.is_empty() || parent_id.is_empty() || child_id == parent_id {
            return false;
        }
        if self.get(child_id).is_some() {
            return false;
        }
        let Some(owner) = self.get(parent_id).map(str::to_string) else {
            return false;
        };
        self.set(child_id, &owner);
        true
    }

    fn persist(&self) {
        let Some(parent) = Path::new(&self.file).parent() else {
            return;
        };
        if let Err(err) = fs::create_dir_all(parent) {
            eprintln!("[den] session-owners persist failed: {err}");
            return;
        }
        let body = match serde_json::to_string_pretty(&self.map) {
            Ok(text) => format!("{text}\n"),
            Err(err) => {
                eprintln!("[den] session-owners persist failed: {err}");
                return;
            }
        };
        let tmp = format!("{}.tmp", self.file);
        if let Err(err) = fs::write(&tmp, body) {
            eprintln!("[den] session-owners persist failed: {err}");
            return;
        }
        if let Err(err) = fs::rename(&tmp, &self.file) {
            eprintln!("[den] session-owners persist failed: {err}");
            return;
        }
        if let Err(err) = fs::set_permissions(&self.file, fs::Permissions::from_mode(0o600)) {
            eprintln!("[den] session-owners persist failed: {err}");
        }
    }
}

fn read_map(file: &str) -> Map<String, Value> {
    if !Path::new(file).exists() {
        return Map::new();
    }
    let text = match fs::read_to_string(file) {
        Ok(text) => text,
        Err(_) => {
            eprintln!("[den] session-owners file \"{file}\" is unreadable — starting empty");
            return Map::new();
        }
    };
    let parsed = match serde_json::from_str::<Value>(&text) {
        Ok(value) => value,
        Err(_) => {
            eprintln!("[den] session-owners file \"{file}\" is unreadable — starting empty");
            return Map::new();
        }
    };
    let Some(object) = parsed.as_object() else {
        return Map::new();
    };
    let mut out = Map::new();
    for (key, value) in object {
        if key.is_empty() {
            continue;
        }
        if let Some(text) = value.as_str()
            && !text.is_empty()
        {
            out.insert(key.clone(), Value::String(text.to_string()));
        }
    }
    out
}

pub fn session_forbidden(
    owners: &SessionOwners,
    ctx: Option<&UserContext>,
    session_id: &str,
) -> bool {
    match ctx {
        Some(ctx) => !owners.visible(session_id, ctx, None),
        None => false,
    }
}

pub fn audit_tenancy_deny(route: &str, session_id: &str, ctx: &UserContext) {
    eprintln!(
        "[den] tenancy: refused {route} session={session_id} for user \"{}\" (owned by another user)",
        ctx.user_id
    );
}
