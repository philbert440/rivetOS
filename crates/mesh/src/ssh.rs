use protocol::js::js_trim;

use crate::paths::{install_root, shared_path};

pub const SSH_CONNECT_TIMEOUT_SECS: u64 = 5;
pub const SSH_QUIET_TIMEOUT_MS: u64 = 10_000;
pub const RESTART_TIMEOUT_MS: u64 = 90_000;
pub const NPM_INSTALL_TIMEOUT_MS: u64 = 600_000;
pub const GIT_TIMEOUT_MS: u64 = 30_000;
pub const BUILD_TIMEOUT_MS: u64 = 180_000;
pub const MESH_HOSTS_TIMEOUT_MS: u64 = 15_000;
pub const NPM_GLOBAL_TIMEOUT_MS: u64 = 300_000;
pub const PLUGINS_SYNC_TIMEOUT_MS: u64 = 60_000;
pub const SEED_SYNC_TIMEOUT_MS: u64 = 10_000;
pub const LOCAL_RESTART_TIMEOUT_MS: u64 = 30_000;
pub const HEALTH_POLL_INTERVAL_MS: u64 = 3_000;
pub const HEALTH_SSH_TIMEOUT_MS: u64 = 5_000;

pub const REMOTE_OWNERSHIP_PATHS: &[&str] = &[
    ".",
    ".git",
    "node_modules",
    "apps/rivethub-electron/dist-electron",
    "apps/rivethub-electron/release",
    "apps/rivet-android/.gradle",
    "apps/rivet-android/build",
    "apps/rivethub-android/.gradle",
    "apps/rivethub-android/build",
];

pub fn ssh_base_opts() -> &'static [&'static str] {
    &[
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        "-o",
        "StrictHostKeyChecking=no",
    ]
}

pub fn is_safe_arg(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-' | '/' | '@' | ':'))
}

pub fn quote_shell_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', r#"'\''"#))
}

pub fn assert_safe_arg(value: &str, label: &str) -> Result<String, String> {
    if !is_safe_arg(value) {
        return Err(format!(
            "Refusing unsafe {label} \"{value}\" — only letters, digits and . _ - / @ : are allowed."
        ));
    }
    Ok(value.to_string())
}

pub fn is_unsafe_install_root(root: &str) -> bool {
    root.is_empty()
        || root
            .chars()
            .any(|ch| matches!(ch, '\'' | '"' | '`' | '$' | '\\' | ';' | '\n' | '\r'))
}

pub fn remote_install_root() -> String {
    install_root()
}

pub fn resolved_install_root(node_install_root: Option<&str>) -> String {
    match node_install_root
        .map(js_trim)
        .filter(|text| !text.is_empty())
    {
        Some(root) => root.to_string(),
        None => install_root(),
    }
}

pub fn remote_cd(root: &str, cmd: &str) -> String {
    format!("cd {} && {cmd}", quote_shell_arg(root))
}

pub fn restart_unit_command(unit: &str, ssh_user: &str) -> String {
    let mut attempts = vec![
        format!("systemctl restart {unit}"),
        format!("systemctl --user restart {unit}"),
    ];
    if ssh_user != "root" {
        attempts.push(format!("sudo systemctl restart {unit}"));
    }
    attempts.join(" || ")
}

pub fn local_restart_commands(unit: &str) -> Option<Vec<String>> {
    if !is_safe_arg(unit) {
        return None;
    }
    Some(vec![
        format!("systemctl restart {unit}"),
        format!("systemctl --user restart {unit}"),
        format!("sudo systemctl restart {unit}"),
    ])
}

pub fn local_is_active_commands(unit: &str) -> Vec<String> {
    vec![
        format!("systemctl is-active {unit}"),
        format!("sudo systemctl is-active {unit}"),
    ]
}

pub fn discover_local_workers_command() -> &'static str {
    "systemctl list-unit-files 'rivet-*.service' --state=enabled --no-legend --no-pager 2>/dev/null | awk '{print $1}'"
}

pub fn discover_remote_workers_command() -> &'static str {
    "systemctl list-unit-files 'rivet-*.service' --state=enabled --no-legend --no-pager 2>/dev/null | awk '{print \\$1}'"
}

pub fn filter_worker_units(listing: &str) -> Vec<String> {
    listing
        .lines()
        .map(str::trim)
        .filter(|unit| !unit.is_empty() && *unit != "rivetos.service" && is_safe_arg(unit))
        .map(str::to_string)
        .collect()
}

pub fn git_update_command(root: &str, version: Option<&str>) -> String {
    match version {
        Some(version) => remote_cd(root, &format!("git fetch --tags && git checkout {version}")),
        None => remote_cd(
            root,
            "git fetch origin && git checkout main && git reset --hard origin/main",
        ),
    }
}

pub fn npm_install_command(root: &str) -> String {
    remote_cd(root, "npm install --no-audit --no-fund")
}

pub fn worker_build_command(root: &str) -> String {
    remote_cd(
        root,
        "npx nx reset && npx nx run-many -t build -p @rivetos/embedding-worker,@rivetos/compaction-worker",
    )
}

pub fn agent_build_command(root: &str) -> String {
    remote_cd(
        root,
        "npx nx reset && npx nx run-many -t build --exclude container-rivetos,site",
    )
}

pub fn commit_sha_command(root: &str) -> String {
    remote_cd(root, "git rev-parse --short HEAD")
}

pub fn config_validate_command(root: &str) -> String {
    remote_cd(
        root,
        &format!(
            "node {} config validate 2>&1 | tail -2",
            ["packages", "cli", "dist", "index.js"].join("/")
        ),
    )
}

pub fn plugins_sync_command(root: &str) -> String {
    remote_cd(
        root,
        &format!(
            "npx tsx {} plugins sync",
            ["packages", "cli", "src", "index.ts"].join("/")
        ),
    )
}

pub fn worker_active_command(unit: &str, ssh_user: &str) -> String {
    if ssh_user == "root" {
        format!("systemctl is-active {unit}")
    } else {
        format!("sudo systemctl is-active {unit}")
    }
}

pub fn npm_global_install_command(channel: &str) -> String {
    format!("npm install -g @rivetos/cli@{channel} --no-audit --no-fund")
}

pub fn npm_global_install_with_sudo(channel: &str, ssh_user: &str) -> String {
    let install = npm_global_install_command(channel);
    if ssh_user == "root" {
        install
    } else {
        format!("sudo {install}")
    }
}

pub fn npm_restart_command(ssh_user: &str) -> String {
    if ssh_user == "root" {
        "systemctl restart rivetos".to_string()
    } else {
        "sudo systemctl restart rivetos".to_string()
    }
}

pub fn which_rivetos_command() -> &'static str {
    "which rivetos 2>/dev/null || true"
}

pub fn rivetos_version_command() -> &'static str {
    "rivetos version 2>/dev/null || echo unknown"
}

pub fn systemd_execstart_rewrite_command(ssh_user: &str, rivetos_bin: &str) -> String {
    let sudo_prefix = if ssh_user == "root" { "" } else { "sudo " };
    format!(
        "{sudo_prefix}sh -c \"if grep -q '^ExecStart=.*npx tsx' /etc/systemd/system/rivetos.service 2>/dev/null; then sed -i 's|^ExecStart=.*|ExecStart={rivetos_bin} start --config %h/.rivetos/config.yaml|' /etc/systemd/system/rivetos.service && systemctl daemon-reload && echo rewrote; else echo skipped; fi\""
    )
}

pub fn health_ssh_command(user: &str, host: &str) -> String {
    let svc = if user == "root" {
        "systemctl is-active rivetos"
    } else {
        "sudo systemctl is-active rivetos"
    };
    format!(
        "ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no {user}@{host} \"{svc}\" 2>/dev/null"
    )
}

pub fn ssh_argv(ssh_user: &str, host: &str, command: &str) -> Vec<String> {
    let mut argv = vec!["ssh".to_string()];
    argv.extend(ssh_base_opts().iter().map(|part| (*part).to_string()));
    argv.push(format!("{ssh_user}@{host}"));
    argv.push(command.to_string());
    argv
}

pub fn ssh_exec_quiet_shell(ssh_user: &str, host: &str, command: &str) -> String {
    format!(
        "ssh -o ConnectTimeout=5 -o BatchMode=yes -o StrictHostKeyChecking=no {ssh_user}@{host} \"{command}\""
    )
}

pub fn ownership_exists_command(root: &str) -> Option<String> {
    if is_unsafe_install_root(root) {
        return None;
    }
    Some(format!(
        "test -d {} && echo yes || echo no",
        quote_shell_arg(root)
    ))
}

pub fn ownership_writability_command(full: &str) -> String {
    let quoted = quote_shell_arg(full);
    format!(
        "if test -e {quoted}; then if test -w {quoted}; then echo OK; else echo BLOCKED; fi; else echo SKIP; fi"
    )
}

pub fn ownership_owner_command(full: &str) -> String {
    format!(
        "stat -c %U:%G {} 2>/dev/null || echo unknown",
        quote_shell_arg(full)
    )
}

pub fn ownership_full_path(root: &str, relative: &str) -> String {
    if relative == "." {
        root.to_string()
    } else {
        format!("{root}/{relative}")
    }
}

pub fn default_mesh_file() -> String {
    shared_path(&["mesh.json"])
}

pub fn remote_mesh_hosts_script(root: Option<&str>) -> String {
    let base = root
        .map(js_trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .unwrap_or_else(install_root);
    install_path_from(&base, &["infra", "scripts", "setup-mesh-hosts.sh"])
}

fn install_path_from(root: &str, segments: &[&str]) -> String {
    let mut path = std::path::PathBuf::from(root);
    for segment in segments {
        path.push(segment);
    }
    path.to_string_lossy().into_owned()
}

pub fn is_process_root() -> bool {
    match std::fs::read_to_string("/proc/self/status") {
        Ok(text) => text.lines().any(|line| {
            let Some(rest) = line.strip_prefix("Uid:") else {
                return false;
            };
            rest.split_whitespace().next() == Some("0")
        }),
        Err(_) => false,
    }
}

pub fn build_local_mesh_hosts_command(script_path: &str, mesh_file: Option<&str>) -> String {
    let mesh_file = mesh_file
        .map(str::to_string)
        .unwrap_or_else(default_mesh_file);
    let prefix = if is_process_root() { "" } else { "sudo -n " };
    format!("{prefix}{script_path} {mesh_file} --quiet")
}

pub fn build_local_mesh_hosts_command_as(
    script_path: &str,
    mesh_file: &str,
    process_is_root: bool,
) -> String {
    let prefix = if process_is_root { "" } else { "sudo -n " };
    format!("{prefix}{script_path} {mesh_file} --quiet")
}

pub fn build_remote_mesh_hosts_command(ssh_user: &str, root: Option<&str>) -> String {
    let mesh_file = default_mesh_file();
    let script = quote_shell_arg(&remote_mesh_hosts_script(root));
    if ssh_user == "root" {
        format!("{script} {mesh_file} --quiet")
    } else {
        format!("sudo -n {script} {mesh_file} --quiet")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecFailure {
    pub stderr: Option<String>,
    pub stdout: Option<String>,
    pub message: Option<String>,
    pub status: Option<i32>,
}

pub fn format_exec_failure(err: Option<&ExecFailure>) -> String {
    let Some(err) = err else {
        return "unknown error".to_string();
    };
    if let Some(stderr) = err.stderr.as_deref().filter(|text| !text.is_empty()) {
        return pick_lines(stderr);
    }
    if let Some(stdout) = err.stdout.as_deref().filter(|text| !text.is_empty()) {
        return pick_lines(stdout);
    }
    if let Some(message) = &err.message {
        return message.clone();
    }
    if let Some(status) = err.status {
        return format!("exited with code {status}");
    }
    "unknown error".to_string()
}

fn pick_lines(text: &str) -> String {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let start = lines.len().saturating_sub(3);
    lines[start..].join(" | ")
}

pub fn format_mesh_hosts_skip_detail(err: Option<&ExecFailure>) -> String {
    let detail = format_exec_failure(err);
    let lower = detail.to_ascii_lowercase();
    if lower.contains("password is required")
        || lower.contains("a terminal is required")
        || lower.contains("no tty")
        || lower.contains("a password is required")
    {
        format!("{detail} — configure passwordless sudo for setup-mesh-hosts.sh, or re-run as root")
    } else {
        detail
    }
}
