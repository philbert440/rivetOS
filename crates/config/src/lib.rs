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
    let path = path.as_ref();
    let text = protocol::host::read_text(path).map_err(|error| {
        ConfigError::Read(std::io::Error::new(io_kind(error.code), error.to_string()))
    })?;
    load_str(&text)
}

fn io_kind(code: &str) -> std::io::ErrorKind {
    match code {
        "ENOENT" => std::io::ErrorKind::NotFound,
        "EACCES" | "EPERM" => std::io::ErrorKind::PermissionDenied,
        "EISDIR" => std::io::ErrorKind::IsADirectory,
        _ => std::io::ErrorKind::Other,
    }
}

#[cfg(test)]
mod lossy_load {
    use super::load;

    #[test]
    fn load_reads_past_an_invalid_byte() {
        let path = std::env::temp_dir().join(format!("rr1-config-{}", std::process::id()));
        let mut bytes = b"# caf".to_vec();
        bytes.push(0x92);
        bytes.extend_from_slice(b"\n");
        std::fs::write(&path, &bytes).unwrap();
        let result = load(&path);
        let _ = std::fs::remove_file(&path);
        match result {
            Ok(_) => {}
            Err(error) => {
                let text = error.to_string();
                assert!(!text.contains("utf-8") && !text.contains("UTF-8"), "{text}");
            }
        }
    }
}
