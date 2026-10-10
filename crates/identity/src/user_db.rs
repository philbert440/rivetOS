use protocol::js::js_trim;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserDbEntry {
    pub pg_url: String,
    pub env_file: Option<String>,
}

pub fn is_usable_user_db(entry: &Value) -> bool {
    let Some(obj) = entry.as_object() else {
        return false;
    };
    let ok_string = |v: &Value| v.as_str().is_some_and(|s| !js_trim(s).is_empty());
    let Some(pg) = obj.get("pgUrl") else {
        return false;
    };
    if !ok_string(pg) {
        return false;
    }
    if let Some(env_file) = obj.get("envFile")
        && !env_file.is_null()
        && !ok_string(env_file)
    {
        return false;
    }
    true
}
