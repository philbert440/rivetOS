mod embedded;
mod error;
mod resolve;
mod validate;

pub use embedded::assert_embedded_port;
pub use error::ConfigError;
pub use resolve::{resolve_env_vars, resolve_env_vars_with};
pub use validate::{
    KNOWN_MEMORY_SQLITE_KEYS, LoadedConfig, ValidationIssue, ValidationResult, ValidationSeverity,
    format_validation_result, validate_config,
};

use std::path::Path;

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
    let text = std::fs::read_to_string(path)?;
    load_str(&text)
}
