use std::io;
use std::os::unix::fs::DirBuilderExt;
use std::path::Path;

use protocol::js::posix_join;

use crate::error::{DIRECTORY_EMPTY, DIRECTORY_MUST_BE_ABSOLUTE, LINK_NAME, PresetError};
use crate::validate::{resolve_fs, validate_directory_str};

pub struct EnsureAgentDirectoryOptions<'a> {
    pub shared_dir: Option<&'a str>,
    pub link_name: Option<&'a str>,
    pub log: Option<&'a dyn Fn(&str)>,
}

#[derive(Debug)]
pub struct EnsureAgentDirectoryResult {
    pub created: bool,
    pub linked: bool,
    pub reason: Option<String>,
}

pub fn ensure_agent_directory(
    directory: Option<&str>,
    shared_link: Option<bool>,
    opts: &EnsureAgentDirectoryOptions<'_>,
) -> Result<EnsureAgentDirectoryResult, PresetError> {
    if let Some(raw) = directory
        && protocol::js::js_trim(raw).is_empty()
    {
        return Err(PresetError::message(DIRECTORY_EMPTY));
    }
    let Some(directory) = validate_directory_str(directory) else {
        return Err(PresetError::message(DIRECTORY_MUST_BE_ABSOLUTE));
    };
    let path = Path::new(&directory);
    let existed = path_exists(path);
    mkdir_p_700(path)?;
    let created = !existed;
    if created {
        log_line(opts, &format!("created agent directory {directory}"));
    }
    let Some(shared_dir) = opts.shared_dir.filter(|value| !value.is_empty()) else {
        return Ok(EnsureAgentDirectoryResult {
            created,
            linked: false,
            reason: None,
        });
    };
    if shared_link == Some(false) {
        return Ok(EnsureAgentDirectoryResult {
            created,
            linked: false,
            reason: None,
        });
    }
    let link_name = opts.link_name.unwrap_or(LINK_NAME);
    let link = posix_join(&[&directory, link_name]);
    let link_path = Path::new(&link);
    match symlink_metadata(link_path) {
        Ok(meta) => finish_existing(created, &link, &meta, opts),
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            match std::os::unix::fs::symlink(shared_dir, link_path) {
                Ok(()) => {
                    log_line(opts, &format!("linked {link} -> {shared_dir}"));
                    Ok(linked_result(created, &link))
                }
                Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
                    let meta = symlink_metadata(link_path)?;
                    finish_existing(created, &link, &meta, opts)
                }
                Err(err) => Err(err.into()),
            }
        }
        Err(err) => Err(err.into()),
    }
}

pub async fn ensure_agent_directory_async(
    directory: Option<String>,
    shared_link: Option<bool>,
    shared_dir: Option<String>,
    link_name: Option<String>,
    log: Option<crate::store::LogCallback>,
) -> Result<EnsureAgentDirectoryResult, PresetError> {
    tokio::task::spawn_blocking(move || {
        let shared = shared_dir.clone();
        let name = link_name.clone();
        let logger = log.clone();
        let opts = EnsureAgentDirectoryOptions {
            shared_dir: shared.as_deref(),
            link_name: name.as_deref(),
            log: logger
                .as_ref()
                .map(|callback| callback.as_ref() as &dyn Fn(&str)),
        };
        ensure_agent_directory(directory.as_deref(), shared_link, &opts)
    })
    .await
    .map_err(|err| PresetError::message(err.to_string()))?
}

fn finish_existing(
    created: bool,
    link: &str,
    meta: &std::fs::Metadata,
    opts: &EnsureAgentDirectoryOptions<'_>,
) -> Result<EnsureAgentDirectoryResult, PresetError> {
    if meta.file_type().is_symlink() {
        return Ok(linked_result(created, link));
    }
    let kind = if meta.is_dir() { "directory" } else { "file" };
    let reason = format!(
        "leaving existing {kind} at {link}; not replacing it with the shared-directory symlink"
    );
    log_line(opts, &reason);
    Ok(EnsureAgentDirectoryResult {
        created,
        linked: false,
        reason: Some(reason),
    })
}

fn linked_result(created: bool, link: &str) -> EnsureAgentDirectoryResult {
    let reason = existing_symlink_reason(link);
    EnsureAgentDirectoryResult {
        created,
        linked: true,
        reason,
    }
}

fn existing_symlink_reason(link: &str) -> Option<String> {
    let target = std::fs::read_link(link).ok()?;
    let parent = Path::new(link).parent().unwrap_or_else(|| Path::new("/"));
    let resolved = if target.is_absolute() {
        resolve_fs(&target.to_string_lossy())
    } else {
        resolve_fs(&posix_join(&[
            &parent.to_string_lossy(),
            &target.to_string_lossy(),
        ]))
    };
    if path_exists(Path::new(&resolved)) {
        None
    } else {
        Some(format!(
            "shared directory {} does not exist; symlink may dangle",
            target.display()
        ))
    }
}

fn log_line(opts: &EnsureAgentDirectoryOptions<'_>, message: &str) {
    if let Some(log) = opts.log {
        log(message);
    }
}

fn path_exists(path: &Path) -> bool {
    std::fs::metadata(path).is_ok()
}

fn symlink_metadata(path: &Path) -> io::Result<std::fs::Metadata> {
    std::fs::symlink_metadata(path)
}

pub fn mkdir_p_700(path: &Path) -> io::Result<()> {
    if path.as_os_str().is_empty() {
        return Ok(());
    }
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_dir() => return Ok(()),
        Ok(_) => {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "EEXIST: file already exists",
            ));
        }
        Err(_) => {}
    }
    if std::fs::symlink_metadata(path).is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "EEXIST: file already exists",
        ));
    }
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
        && parent != path
    {
        mkdir_p_700(parent)?;
    }
    let mut builder = std::fs::DirBuilder::new();
    builder.mode(0o700);
    match builder.create(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => match std::fs::metadata(path) {
            Ok(meta) if meta.is_dir() => Ok(()),
            _ => Err(err),
        },
        Err(err) => Err(err),
    }
}
