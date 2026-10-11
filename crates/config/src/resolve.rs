use serde_json::{Map, Value};

pub fn resolve_env_vars(value: &Value) -> Value {
    resolve_env_vars_with(value, |name| std::env::var(name).ok())
}

pub fn resolve_env_vars_with(value: &Value, lookup: impl Fn(&str) -> Option<String>) -> Value {
    resolve_rec(value, &lookup)
}

fn resolve_rec(value: &Value, lookup: &dyn Fn(&str) -> Option<String>) -> Value {
    match value {
        Value::String(text) => Value::String(replace_env(text, lookup)),
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| resolve_rec(item, lookup)).collect())
        }
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, child) in map {
                out.insert(key.clone(), resolve_rec(child, lookup));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn replace_env(input: &str, lookup: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::new();
    let mut rest = input;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        if let Some(end) = after.find('}') {
            let name = &after[..end];
            if is_env_name(name) {
                out.push_str(&lookup(name).unwrap_or_default());
                rest = &after[end + 1..];
                continue;
            }
        }
        out.push_str("${");
        rest = after;
    }
    out.push_str(rest);
    out
}

fn is_env_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}
