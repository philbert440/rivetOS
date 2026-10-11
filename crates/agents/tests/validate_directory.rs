mod common;
pub use common::contract::*;
pub use common::*;

use std::os::unix::fs::{PermissionsExt, symlink};

use agents::{
    DIRECTORY_INSIDE_SHARED, EnsureAgentDirectoryOptions, agents_json_file_in, canonical_path,
    default_directory_for, den_state_dir_from, directory_warnings, ensure_agent_directory,
    is_color, is_effort, posix_join, slugify, validate_directory,
};
use serde_json::json;

#[test]
fn slugify_matches_the_registry_cases() {
    let cases = [
        ("Hello World", "hello-world"),
        ("  Foo__Bar!! ", "foo-bar"),
        ("Hello---World", "hello-world"),
        ("123 Agent", "123-agent"),
        ("---", "agent"),
        ("", "agent"),
        ("...", "agent"),
    ];
    for (name, expected) in cases {
        assert_eq!(slugify(name), expected);
    }
    assert_eq!(slugify(&"A".repeat(80)), "a".repeat(48));
    assert_eq!(slugify(&format!("{}b", "a".repeat(48))), "a".repeat(48));
}

#[test]
fn default_directory_joins_the_root_and_the_slug() {
    assert_eq!(
        default_directory_for("/home/agents", "Hello World"),
        "/home/agents/hello-world"
    );
}

#[test]
fn validate_directory_rejects_relative_paths() {
    assert!(validate_directory(&json!("agents/reviewer")).is_none());
    assert!(validate_directory(&json!("..")).is_none());
    assert!(validate_directory(&json!("../etc")).is_none());
}

#[test]
fn validate_directory_normalises_slashes() {
    assert_eq!(
        validate_directory(&json!("/a//b/")).as_deref(),
        Some("/a/b")
    );
    assert_eq!(
        validate_directory(&json!("  /tmp/ok  ")).as_deref(),
        Some("/tmp/ok")
    );
}

#[test]
fn validate_directory_resolves_dot_dot_and_rejects_nul_and_non_strings() {
    assert_eq!(
        validate_directory(&json!("/a/b/../c")).as_deref(),
        Some("/a/c")
    );
    assert!(validate_directory(&json!("/tmp/\u{0}hidden")).is_none());
    assert!(validate_directory(&json!(12)).is_none());
}

#[test]
fn validate_directory_rejects_paths_longer_than_512_and_the_root() {
    assert!(validate_directory(&json!(format!("/{}", "a".repeat(512)))).is_none());
    assert_eq!(
        validate_directory(&json!(format!("/{}", "a".repeat(511)))).as_deref(),
        Some(format!("/{}", "a".repeat(511)).as_str())
    );
    assert!(validate_directory(&json!("/")).is_none());
    assert!(validate_directory(&json!("//")).is_none());
    assert!(validate_directory(&json!("/.")).is_none());
}

#[test]
fn directory_warnings_only_when_inside_the_shared_directory() {
    assert!(
        directory_warnings(
            "/home/agents/reviewer",
            Some("/nonexistent-shared-root-for-tests")
        )
        .is_empty()
    );
    assert!(
        directory_warnings(
            "/nonexistent-shared-root-other/reviewer",
            Some("/nonexistent-shared-root")
        )
        .is_empty()
    );
    assert!(directory_warnings("/tmp/a", None).is_empty());
    let warned = directory_warnings(
        "/nonexistent-shared-root/agents/reviewer",
        Some("/nonexistent-shared-root/"),
    );
    assert_eq!(warned.len(), 1);
    assert!(warned[0].contains("rivet-shared"));
    assert!(warned[0].contains("ancestor"));
    assert_eq!(warned[0], DIRECTORY_INSIDE_SHARED);
    assert_eq!(
        directory_warnings("/nonexistent-shared-root", Some("/nonexistent-shared-root")).len(),
        1
    );
}

#[test]
fn directory_warnings_follow_a_shared_symlink() {
    let root = TempDir::new("agent-registry-warn");
    let real = root.join("real-shared");
    let via_link = root.join("link-shared");
    std::fs::create_dir(&real).unwrap();
    symlink(&real, &via_link).unwrap();
    let directory = real.join("agents").join("reviewer");
    std::fs::create_dir_all(&directory).unwrap();
    let directory = directory.to_string_lossy().into_owned();
    let via = via_link.to_string_lossy().into_owned();
    let real_text = real.to_string_lossy().into_owned();
    assert_eq!(directory_warnings(&directory, Some(&via)).len(), 1);
    let via_child = format!("{via}/agents/reviewer");
    assert_eq!(directory_warnings(&via_child, Some(&real_text)).len(), 1);
    let outside = root.join("other");
    std::fs::create_dir(&outside).unwrap();
    assert!(directory_warnings(&outside.to_string_lossy(), Some(&via)).is_empty());
    let _ = canonical_path(&directory);
}

#[test]
fn den_state_dir_keeps_a_blank_override_and_otherwise_uses_home() {
    assert_eq!(den_state_dir_from(Some("/tmp/den-state")), "/tmp/den-state");
    assert_eq!(den_state_dir_from(Some("")), "");
    let joined = den_state_dir_from(None);
    match std::env::var("HOME") {
        Ok(home) => {
            assert_eq!(joined, posix_join(&[&home, ".rivetos", "den"]));
        }
        Err(_) => {
            assert!(joined.starts_with('/'), "{joined}");
        }
    }
    assert_eq!(
        agents_json_file_in("/tmp/den-state"),
        "/tmp/den-state/agents.json"
    );
}

fn empty_opts<'a>() -> EnsureAgentDirectoryOptions<'a> {
    EnsureAgentDirectoryOptions {
        shared_dir: None,
        link_name: None,
        log: None,
    }
}

fn opts<'a>(shared: &'a str) -> EnsureAgentDirectoryOptions<'a> {
    EnsureAgentDirectoryOptions {
        shared_dir: Some(shared),
        link_name: None,
        log: None,
    }
}

#[test]
fn ensure_creates_mode_0700_and_the_shared_symlink() {
    let root = TempDir::new("agent-registry-dir");
    let shared = root.path_str("shared");
    std::fs::create_dir(&shared).unwrap();
    let directory = root.path_str("agents/reviewer");
    let result = ensure_agent_directory(Some(&directory), Some(true), &opts(&shared)).unwrap();
    assert!(result.created);
    assert!(result.linked);
    assert!(result.reason.is_none());
    let mode = std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o700);
    let link = root.join("agents/reviewer/rivet-shared");
    assert!(
        std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        std::fs::read_link(&link).unwrap(),
        std::path::Path::new(&shared)
    );
}

#[test]
fn ensure_is_a_noop_the_second_time() {
    let root = TempDir::new("agent-registry-dir");
    let shared = root.path_str("shared");
    std::fs::create_dir(&shared).unwrap();
    let directory = root.path_str("agent");
    ensure_agent_directory(Some(&directory), None, &opts(&shared)).unwrap();
    let again = ensure_agent_directory(Some(&directory), None, &opts(&shared)).unwrap();
    assert!(!again.created);
    assert!(again.linked);
    assert!(again.reason.is_none());
}

#[test]
fn ensure_leaves_a_real_directory_at_the_link_path() {
    let root = TempDir::new("agent-registry-dir");
    let directory = root.path_str("agent");
    let link_dir = root.join("agent/rivet-shared");
    std::fs::create_dir_all(&link_dir).unwrap();
    let marker = link_dir.join("keep");
    std::fs::write(&marker, "stay").unwrap();
    let shared = root.path_str("shared");
    let result = ensure_agent_directory(Some(&directory), None, &opts(&shared)).unwrap();
    assert!(!result.created);
    assert!(!result.linked);
    assert!(result.reason.unwrap().contains("directory"));
    assert!(std::fs::symlink_metadata(&link_dir).unwrap().is_dir());
    assert_eq!(std::fs::read_to_string(marker).unwrap(), "stay");
}

#[test]
fn ensure_skips_the_link_when_shared_link_is_false() {
    let root = TempDir::new("agent-registry-dir");
    let directory = root.path_str("agent");
    let shared = root.path_str("shared");
    let result = ensure_agent_directory(Some(&directory), Some(false), &opts(&shared)).unwrap();
    assert!(result.created);
    assert!(!result.linked);
    assert!(!root.join("agent/rivet-shared").exists());
}

#[test]
fn ensure_rejects_an_existing_file_and_a_dangling_symlink() {
    let root = TempDir::new("agent-registry-dir");
    let file = root.path_str("notes.txt");
    std::fs::write(&file, "x").unwrap();
    let err = ensure_agent_directory(Some(&file), Some(false), &empty_opts()).unwrap_err();
    assert!(err.to_string().contains("EEXIST") || err.to_string().contains("exist"));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "x");
    let dangling = root.path_str("dangling");
    symlink(root.join("missing-target"), &dangling).unwrap();
    let err = ensure_agent_directory(Some(&dangling), Some(false), &empty_opts()).unwrap_err();
    assert!(err.to_string().contains("EEXIST") || err.to_string().contains("exist"));
    assert!(
        std::fs::symlink_metadata(&dangling)
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

#[test]
fn ensure_rejects_an_empty_or_non_absolute_directory() {
    let err = ensure_agent_directory(Some(""), None, &empty_opts()).unwrap_err();
    assert_eq!(err.to_string(), "agent directory is empty");
    let err = ensure_agent_directory(Some("   "), None, &empty_opts()).unwrap_err();
    assert_eq!(err.to_string(), "agent directory is empty");
    for directory in [
        None,
        Some("agents/reviewer"),
        Some("../etc"),
        Some("/tmp/\u{0}hidden"),
        Some("/"),
    ] {
        let err = ensure_agent_directory(directory, None, &empty_opts()).unwrap_err();
        assert_eq!(err.to_string(), "agent directory must be an absolute path");
    }
}

#[test]
fn ensure_leaves_an_existing_symlink_alone() {
    let root = TempDir::new("agent-registry-dir");
    let directory = root.path_str("agent");
    let elsewhere = root.path_str("elsewhere");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::create_dir(&elsewhere).unwrap();
    let link = root.join("agent/rivet-shared");
    symlink(&elsewhere, &link).unwrap();
    let shared = root.path_str("shared");
    std::fs::create_dir(&shared).unwrap();
    let result = ensure_agent_directory(Some(&directory), None, &opts(&shared)).unwrap();
    assert!(!result.created);
    assert!(result.linked);
    assert!(result.reason.is_none());
    assert_eq!(
        std::fs::read_link(&link).unwrap(),
        std::path::Path::new(&elsewhere)
    );
}

#[test]
fn ensure_reports_a_dangling_symlink_from_its_own_target() {
    let root = TempDir::new("agent-registry-dir");
    let directory = root.path_str("agent");
    std::fs::create_dir(&directory).unwrap();
    let missing = root.path_str("gone");
    let link = root.join("agent/rivet-shared");
    symlink(&missing, &link).unwrap();
    let shared = root.path_str("shared");
    std::fs::create_dir(&shared).unwrap();
    let result = ensure_agent_directory(Some(&directory), None, &opts(&shared)).unwrap();
    assert!(!result.created);
    assert!(result.linked);
    let reason = result.reason.unwrap();
    assert!(reason.contains("dangle"));
    assert!(reason.contains(&missing));
    assert!(!reason.contains(&shared));
    assert_eq!(
        std::fs::read_link(link).unwrap(),
        std::path::Path::new(&missing)
    );
}

#[test]
fn ensure_leaves_a_regular_file_at_the_link_path() {
    let root = TempDir::new("agent-registry-dir");
    let directory = root.path_str("agent");
    std::fs::create_dir(&directory).unwrap();
    let link = root.join("agent/rivet-shared");
    std::fs::write(&link, "not-a-directory").unwrap();
    let shared = root.path_str("shared");
    let result = ensure_agent_directory(Some(&directory), None, &opts(&shared)).unwrap();
    assert!(!result.created);
    assert!(!result.linked);
    assert!(result.reason.unwrap().contains("file"));
    assert_eq!(std::fs::read_to_string(&link).unwrap(), "not-a-directory");
    assert!(std::fs::symlink_metadata(&link).unwrap().is_file());
}

#[test]
fn ensure_symlinks_even_when_the_shared_directory_is_missing() {
    let root = TempDir::new("agent-registry-dir");
    let directory = root.path_str("agent");
    let shared = root.path_str("missing-shared");
    let result = ensure_agent_directory(Some(&directory), None, &opts(&shared)).unwrap();
    assert!(result.created);
    assert!(result.linked);
    assert!(result.reason.unwrap().contains("dangle"));
    let link = root.join("agent/rivet-shared");
    assert!(
        std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        std::fs::read_link(link).unwrap(),
        std::path::Path::new(&shared)
    );
}

#[test]
fn color_and_effort_charsets_match_the_static_patterns() {
    assert!(is_color("#abc"));
    assert!(is_color("#a1B2c3"));
    assert!(!is_color("abc"));
    assert!(!is_color("#abcd"));
    assert!(is_effort(""));
    assert!(is_effort("aZ0._[]:-"));
    assert!(!is_effort("has space"));
    assert!(!is_effort(&"a".repeat(65)));
}
