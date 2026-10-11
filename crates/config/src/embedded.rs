use protocol::js;
use serde_json::Value;

use crate::error::ConfigError;
use crate::validate::value::{is_falsy, js_i64};

pub fn assert_embedded_port(config: &Value) -> Result<(), ConfigError> {
    let Some(embedded) = config
        .get("memory")
        .and_then(|memory| memory.get("postgres"))
        .and_then(|postgres| postgres.get("embedded"))
    else {
        return Ok(());
    };
    if is_falsy(embedded) || !embedded.is_object() {
        return Ok(());
    }
    match embedded.get("port") {
        None | Some(Value::Null) => Ok(()),
        Some(port) if js_i64(port).is_some_and(|n| (1..=65535).contains(&n)) => Ok(()),
        Some(port) => {
            let rendered = js::stringify(&js::from_serde(port));
            Err(ConfigError::EmbeddedPort(format!(
                "memory.postgres.embedded.port must be an integer between 1 and 65535 (got {rendered})"
            )))
        }
    }
}
