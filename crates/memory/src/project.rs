use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use regex::Regex;
use serde_json::{Map, Value};

use crate::slug::{normalize_tag_value, TAG_KEY_PROJECT, TAG_VALUE_MAX};
use crate::text::utf16_prefix;

pub const PROJECT_RULE_FS_TIMEOUT_MS: u64 = 250;
pub const PROJECT_RULE_BUDGET_MS: u64 = 1500;
pub const PROJECT_RULE_MAX_WALK: usize = 16;
const CACHE_TTL_MS: i64 = 10 * 60_000;
const CACHE_NEGATIVE_TTL_MS: i64 = 30_000;
const CACHE_MAX: usize = 500;
const FILE_CAP: u64 = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectHit {
    pub key: String,
    pub value: String,
    pub display: String,
    pub rule: String,
    pub reason: String,
    pub git_root: Option<String>,
}

pub trait ProjectFs {
    fn is_directory(&self, path: &str) -> bool;
    fn read_file(&self, path: &str) -> Option<String>;
}

#[derive(Debug, Clone, Default)]
pub struct MapFs {
    pub dirs: BTreeSet<String>,
    pub files: BTreeMap<String, String>,
}

impl ProjectFs for MapFs {
    fn is_directory(&self, path: &str) -> bool {
        self.dirs.contains(path)
    }

    fn read_file(&self, path: &str) -> Option<String> {
        self.files.get(path).cloned()
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct NoFs;

impl ProjectFs for NoFs {
    fn is_directory(&self, _path: &str) -> bool {
        false
    }

    fn read_file(&self, _path: &str) -> Option<String> {
        None
    }
}

pub struct NodeFs;

impl ProjectFs for NodeFs {
    fn is_directory(&self, path: &str) -> bool {
        let owned = path.to_string();
        with_timeout(PROJECT_RULE_FS_TIMEOUT_MS, false, move || {
            std::fs::metadata(&owned).map(|meta| meta.is_dir()).unwrap_or(false)
        })
    }

    fn read_file(&self, path: &str) -> Option<String> {
        let owned = path.to_string();
        with_timeout(PROJECT_RULE_FS_TIMEOUT_MS, None, move || {
            let meta = std::fs::metadata(&owned).ok()?;
            if !meta.is_file() || meta.len() > FILE_CAP {
                return None;
            }
            std::fs::read_to_string(&owned).ok()
        })
    }
}

fn with_timeout<T: Send + 'static>(ms: u64, fallback: T, work: impl FnOnce() -> T + Send + 'static) -> T {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(work());
    });
    match rx.recv_timeout(Duration::from_millis(ms)) {
        Ok(value) => value,
        Err(_) => fallback,
    }
}

pub fn norm_path(path: &str) -> String {
    let s = path.replace('\\', "/");
    let stripped = s.trim_end_matches('/');
    if stripped.is_empty() {
        "/".to_string()
    } else {
        stripped.to_string()
    }
}

pub fn basename(path: &str) -> String {
    let s = norm_path(path);
    match s.rfind('/') {
        Some(i) => s[i + 1..].to_string(),
        None => s,
    }
}

fn dirname(path: &str) -> String {
    let s = norm_path(path);
    match s.rfind('/') {
        None => ".".to_string(),
        Some(0) => "/".to_string(),
        Some(i) => s[..i].to_string(),
    }
}

pub fn is_safe_absolute_path(raw: &str) -> bool {
    let s = raw.replace('\\', "/");
    let absolute = s.starts_with('/') || drive_prefix(&s);
    if !absolute {
        return false;
    }
    !s.split('/').any(|seg| seg == "." || seg == "..")
}

fn drive_prefix(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes[2] == b'/'
}

fn drive_any(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

const SYSTEM_ROOTS: &[&str] = &[
    "/",
    "/bin",
    "/dev",
    "/etc",
    "/home",
    "/lib",
    "/media",
    "/mnt",
    "/opt",
    "/private",
    "/private/tmp",
    "/private/var",
    "/proc",
    "/root",
    "/run",
    "/sbin",
    "/srv",
    "/sys",
    "/tmp",
    "/usr",
    "/usr/local",
    "/var",
    "/var/tmp",
    "/Users",
    "/Volumes",
];

fn home_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^([a-z]:)?/(home|users)/[^/]+(/(Downloads|Desktop|Documents|tmp|temp))?$").ok()
    })
    .as_ref()
}

pub fn is_root_like(path: &str) -> bool {
    let s = norm_path(path);
    if s == "." || drive_letter_only(&s) {
        return true;
    }
    if SYSTEM_ROOTS.contains(&s.as_str()) || s == "/var/root" {
        return true;
    }
    home_re().is_some_and(|re| re.is_match(&s))
}

fn drive_letter_only(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn resolve_relative(base: &str, target: &str) -> String {
    let t = target.replace('\\', "/");
    if t.starts_with('/') || drive_prefix(&t) {
        return norm_path(&t);
    }
    let mut parts: Vec<String> = norm_path(base).split('/').map(str::to_string).collect();
    for seg in t.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            parts.pop();
        } else {
            parts.push(seg.to_string());
        }
    }
    let joined = parts.join("/");
    if joined.is_empty() { "/".to_string() } else { joined }
}

pub fn find_git_root(cwd: &str, fs: &dyn ProjectFs) -> Option<(String, String)> {
    let mut dir = norm_path(cwd);
    for _ in 0..PROJECT_RULE_MAX_WALK {
        let dot_git = format!("{dir}/.git");
        if fs.is_directory(&dot_git) {
            return Some((dir, dot_git));
        }
        if let Some(pointer) = fs.read_file(&dot_git) {
            if let Some(git_dir) = gitdir_from_pointer(&pointer) {
                let git_dir = resolve_relative(&dir, &git_dir);
                if let Some(main) = worktree_main(&git_dir) {
                    return Some((main.clone(), format!("{main}/.git")));
                }
                return Some((dir, git_dir));
            }
        }
        let parent = dirname(&dir);
        if parent == dir || parent == "." {
            break;
        }
        dir = parent;
    }
    None
}

fn gitdir_from_pointer(pointer: &str) -> Option<String> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    let re = RE
        .get_or_init(|| Regex::new(r"(?m)^\s*gitdir:\s*(.+?)\s*$").ok())
        .as_ref()?;
    re.captures(pointer).and_then(|cap| cap.get(1).map(|m| m.as_str().to_string()))
}

fn worktree_main(git_dir: &str) -> Option<String> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    let re = RE
        .get_or_init(|| Regex::new(r"^(.*)/\.git/worktrees/[^/]+$").ok())
        .as_ref()?;
    re.captures(git_dir).and_then(|cap| cap.get(1).map(|m| m.as_str().to_string()))
}

pub fn repo_name_from_remote(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let last = trimmed.split(['/', ':']).next_back().unwrap_or("");
    let name = if last.len() >= 4 && last[last.len() - 4..].eq_ignore_ascii_case(".git") {
        &last[..last.len() - 4]
    } else {
        last
    };
    if name.is_empty() || name == "." || name == ".." {
        None
    } else {
        Some(name.to_string())
    }
}

pub fn sanitize_remote(url: &str) -> Option<String> {
    let mut s = url.trim().replace('\\', "/");
    s = s.trim_end_matches('/').to_string();
    if s.is_empty() {
        return None;
    }
    if let Some(idx) = s.find(['?', '#']) {
        s.truncate(idx);
    }
    if s.starts_with('/') || s.starts_with("./") || s.starts_with("../") || s.starts_with('~') || drive_any(&s)
    {
        return None;
    }
    if s.len() >= 5 && s[..5].eq_ignore_ascii_case("file:") {
        return None;
    }
    if let Some(rest) = scheme_rest(&s) {
        let slash = rest.find('/').unwrap_or(rest.len());
        let authority = &rest[..slash];
        let path = &rest[slash..];
        let host = authority[authority.rfind('@').map(|i| i + 1).unwrap_or(0)..].to_string();
        let host = strip_port(&host);
        if host.is_empty() {
            return None;
        }
        s = format!("{host}{path}");
    } else {
        static RE: OnceLock<Option<Regex>> = OnceLock::new();
        let re = RE
            .get_or_init(|| Regex::new(r"^(?:[^@/]*@)?([^:/@]+):(.+)$").ok())
            .as_ref()?;
        let caps = re.captures(&s)?;
        let host = caps.get(1)?.as_str();
        let path = caps.get(2)?.as_str();
        s = format!("{host}/{path}");
    }
    s = s.trim_end_matches('/').to_string();
    if s.len() >= 4 && s[s.len() - 4..].eq_ignore_ascii_case(".git") {
        s.truncate(s.len() - 4);
    }
    while s.contains("//") {
        s = s.replace("//", "/");
    }
    static OK: OnceLock<Option<Regex>> = OnceLock::new();
    let ok = OK.get_or_init(|| Regex::new(r"^[^/\s@]+/[^\s@]+$").ok()).as_ref()?;
    if ok.is_match(&s) { Some(s) } else { None }
}

fn scheme_rest(s: &str) -> Option<String> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    let re = RE
        .get_or_init(|| Regex::new(r"^([a-zA-Z][a-zA-Z0-9+.-]*)://").ok())
        .as_ref()?;
    let m = re.find(s)?;
    Some(s[m.end()..].to_string())
}

fn strip_port(host: &str) -> String {
    if let Some(idx) = host.rfind(':') {
        if host[idx + 1..].chars().all(|ch| ch.is_ascii_digit()) && !host[idx + 1..].is_empty() {
            return host[..idx].to_string();
        }
    }
    host.to_string()
}

pub fn origin_url_from_config(config: &str) -> Option<String> {
    let mut in_origin = false;
    for raw in config.split(['\n', '\r']) {
        let line = raw.trim();
        if line.starts_with('[') {
            in_origin = origin_header(line);
            continue;
        }
        if !in_origin {
            continue;
        }
        if let Some(value) = url_assignment(line) {
            return Some(strip_inline_comment(value));
        }
    }
    None
}

fn url_assignment(line: &str) -> Option<&str> {
    let lower = line.to_ascii_lowercase();
    let rest = lower.strip_prefix("url")?.trim_start();
    if !rest.starts_with('=') {
        return None;
    }
    line.split_once('=').map(|(_, value)| value.trim())
}

fn origin_header(line: &str) -> bool {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    let Some(re) = RE
        .get_or_init(|| Regex::new(r#"(?i)^\[remote\s+"origin"\](?:[ \t]*[#;].*)?$"#).ok())
        .as_ref()
    else {
        return false;
    };
    re.is_match(line) && line.contains("\"origin\"")
}

fn strip_inline_comment(value: &str) -> String {
    let mut out = String::new();
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch.is_whitespace() {
            if matches!(chars.peek(), Some('#' | ';')) {
                break;
            }
        }
        out.push(ch);
    }
    out.trim().to_string()
}

pub fn resolve_project_from_cwd(cwd: &str, fs: &dyn ProjectFs) -> Option<ProjectHit> {
    let trimmed = protocol::js::js_trim(cwd);
    if trimmed.is_empty() || !is_safe_absolute_path(trimmed) {
        return None;
    }
    let normalized = norm_path(trimmed);
    if is_root_like(&normalized) {
        return None;
    }
    if let Some((root, git_dir)) = find_git_root(&normalized, fs) {
        if is_root_like(&root) {
            return None;
        }
        let config = fs.read_file(&format!("{git_dir}/config"));
        let origin = config.as_deref().and_then(origin_url_from_config);
        let safe = origin.as_deref().and_then(sanitize_remote);
        let remote_name = safe.as_deref().and_then(|s| s.rsplit('/').next()).filter(|s| !s.is_empty());
        if let (Some(safe), Some(remote_name)) = (safe.as_deref(), remote_name) {
            if let Some(hit) = make(remote_name, "git-remote", Some(&root), safe) {
                return Some(hit);
            }
        }
        let root_name = basename(&root);
        if !root_name.is_empty() {
            if let Some(hit) = make(&root_name, "git-root", Some(&root), &root_name) {
                return Some(hit);
            }
        }
    }
    let name = basename(&normalized);
    if name.is_empty() {
        None
    } else {
        make(&name, "cwd-basename", None, &name)
    }
}

fn make(display: &str, rule: &str, git_root: Option<&str>, why: &str) -> Option<ProjectHit> {
    let value = normalize_tag_value(display);
    if value.is_empty() {
        return None;
    }
    let cleaned = display_line(display);
    let shown: String = cleaned.chars().take(TAG_VALUE_MAX).collect();
    let reason = utf16_prefix(&format!("{rule}: {why}"), 200);
    Some(ProjectHit {
        key: TAG_KEY_PROJECT.to_string(),
        value,
        display: shown,
        rule: rule.to_string(),
        reason,
        git_root: git_root.map(str::to_string),
    })
}

fn display_line(display: &str) -> String {
    let mut spaced = String::new();
    for ch in display.chars() {
        if ch.is_control() {
            spaced.push(' ');
        } else {
            spaced.push(ch);
        }
    }
    let collapsed = collapse_ws(&spaced);
    protocol::js::js_trim(&collapsed).to_string()
}

fn collapse_ws(text: &str) -> String {
    let mut out = String::new();
    let mut prev = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            if !prev {
                out.push(' ');
                prev = true;
            }
        } else {
            out.push(ch);
            prev = false;
        }
    }
    out
}

fn local_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^local_.+").ok()).as_ref()
}

pub fn is_task_sandbox_cwd(cwd: &str) -> bool {
    let norm = norm_path(&cwd.replace('\\', "/"));
    if norm == "/private/var/empty" {
        return true;
    }
    let parts: Vec<&str> = norm.split('/').collect();
    let last = parts.last().copied().unwrap_or("");
    let parent = if parts.len() >= 2 { parts[parts.len() - 2] } else { "" };
    let local = local_re();
    if local.is_some_and(|re| re.is_match(last)) {
        return true;
    }
    if last == "outputs" && local.is_some_and(|re| re.is_match(parent)) {
        return true;
    }
    last == "outputs" && parts.contains(&"local-agent-mode-sessions")
}

pub fn cwd_from_settings(settings: Option<&Map<String, Value>>) -> Option<String> {
    let raw = settings?.get("cwd")?.as_str()?;
    let cwd = protocol::js::js_trim(raw);
    if cwd.is_empty() || cwd.len() > 4096 || !is_safe_absolute_path(cwd) {
        None
    } else {
        Some(cwd.to_string())
    }
}

fn is_cowork(settings: Option<&Map<String, Value>>, channel: Option<&str>) -> bool {
    if channel == Some("cowork") {
        return true;
    }
    matches!(
        settings.and_then(|map| map.get("source")).and_then(Value::as_str),
        Some("cowork-hook" | "cowork-transcript")
    )
}

fn folders_from_settings(settings: Option<&Map<String, Value>>) -> Vec<String> {
    let Some(raw) = settings.and_then(|map| map.get("folders")).and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in raw {
        let Some(text) = item.as_str() else {
            continue;
        };
        let folder = protocol::js::js_trim(text);
        if folder.is_empty() || folder.len() > 4096 || !is_safe_absolute_path(folder) {
            continue;
        }
        if is_task_sandbox_cwd(folder) {
            continue;
        }
        out.push(folder.to_string());
    }
    out
}

struct CacheEntry {
    at: i64,
    hit: Option<ProjectHit>,
}

fn cache() -> &'static Mutex<VecDeque<(String, CacheEntry)>> {
    static CACHE: OnceLock<Mutex<VecDeque<(String, CacheEntry)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(VecDeque::new()))
}

pub fn clear_project_rule_cache() {
    cache_lock().clear();
}

fn cache_lock() -> std::sync::MutexGuard<'static, VecDeque<(String, CacheEntry)>> {
    cache().lock().unwrap_or_else(|err| err.into_inner())
}

fn cached_resolve(cwd: &str) -> Option<ProjectHit> {
    let now = crate::error::now_ms();
    {
        let guard = cache_lock();
        if let Some((_, entry)) = guard.iter().find(|(key, _)| key == cwd) {
            let ttl = if entry.hit.is_some() { CACHE_TTL_MS } else { CACHE_NEGATIVE_TTL_MS };
            if now.saturating_sub(entry.at) < ttl {
                return entry.hit.clone();
            }
        }
    }
    let hit = with_timeout(PROJECT_RULE_BUDGET_MS, None, {
        let cwd = cwd.to_string();
        move || resolve_project_from_cwd(&cwd, &NodeFs)
    });
    let mut guard = cache_lock();
    guard.retain(|(key, _)| key != cwd);
    if guard.len() >= CACHE_MAX {
        guard.pop_front();
    }
    guard.push_back((
        cwd.to_string(),
        CacheEntry {
            at: now,
            hit: hit.clone(),
        },
    ));
    hit
}

pub fn plan_project_rule_tag(
    settings: Option<&Map<String, Value>>,
    allow_filesystem: bool,
    disabled: bool,
    channel: Option<&str>,
) -> Option<ProjectHit> {
    if disabled {
        return None;
    }
    if is_cowork(settings, channel) {
        for folder in folders_from_settings(settings) {
            if let Some(hit) = resolve_one(&folder, allow_filesystem) {
                return Some(hit);
            }
        }
        return None;
    }
    let cwd = cwd_from_settings(settings)?;
    if is_task_sandbox_cwd(&cwd) {
        return None;
    }
    resolve_one(&cwd, allow_filesystem)
}

fn resolve_one(cwd: &str, allow_filesystem: bool) -> Option<ProjectHit> {
    if !allow_filesystem {
        return resolve_project_from_cwd(cwd, &NoFs);
    }
    cached_resolve(cwd)
}

pub fn plan_with_fs(settings: Option<&Map<String, Value>>, fs: &dyn ProjectFs, channel: Option<&str>) -> Option<ProjectHit> {
    if is_cowork(settings, channel) {
        for folder in folders_from_settings(settings) {
            if let Some(hit) = resolve_project_from_cwd(&folder, fs) {
                return Some(hit);
            }
        }
        return None;
    }
    let cwd = cwd_from_settings(settings)?;
    if is_task_sandbox_cwd(&cwd) {
        return None;
    }
    resolve_project_from_cwd(&cwd, fs)
}
