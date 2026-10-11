mod embedded;
mod error;
pub mod paths;
mod resolve;
mod validate;

pub use embedded::assert_embedded_port;
pub use error::ConfigError;
pub use resolve::{resolve_env_vars, resolve_env_vars_with};
pub use validate::{
    KNOWN_MEMORY_SQLITE_KEYS, LoadedConfig, ValidationIssue, ValidationResult, ValidationSeverity,
    format_validation_result, validate_config,
};

use std::io;
use std::path::Path;

use protocol::host::read_text;
use serde_json::Value;

pub fn parse_yaml(text: &str) -> Result<Value, ConfigError> {
    serde_saphyr::from_str(text).map_err(|err| ConfigError::Parse(err.to_string()))
}

pub fn load_str(yaml: &str) -> Result<LoadedConfig, ConfigError> {
    let raw = parse_yaml(yaml)?;
    let validation = validate_config(&raw);
    if !validation.valid {
        return Err(ConfigError::Validation {
            formatted: format_validation_result(&validation),
            result: validation,
        });
    }
    Ok(LoadedConfig {
        document: resolve_env_vars(&raw),
        validation,
    })
}

pub fn load(path: impl AsRef<Path>) -> Result<LoadedConfig, ConfigError> {
    let text = read_text(path.as_ref()).map_err(|err| io::Error::other(err.to_string()))?;
    load_str(&text)
}
