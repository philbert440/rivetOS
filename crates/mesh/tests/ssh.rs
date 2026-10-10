use mesh::{
    ExecFailure, REMOTE_OWNERSHIP_PATHS, assert_safe_arg, build_local_mesh_hosts_command,
    build_local_mesh_hosts_command_as, build_remote_mesh_hosts_command, default_mesh_file,
    discover_local_workers_command, discover_remote_workers_command, filter_worker_units,
    format_exec_failure, format_mesh_hosts_skip_detail, git_update_command, install_root,
    is_process_root, is_safe_arg, is_unsafe_install_root, local_restart_commands,
    npm_global_install_with_sudo, npm_restart_command, ownership_exists_command,
    ownership_full_path, quote_shell_arg, remote_cd, remote_mesh_hosts_script,
    resolved_install_root, restart_unit_command, ssh_argv, worker_active_command,
};

#[test]
fn is_safe_arg_accepts_real_tokens_and_rejects_metacharacters() {
    for ok in [
        "main",
        "v0.4.0-beta.6",
        "0.4.0-beta.2",
        "latest",
        "beta",
        "rivet",
        "root",
        "rivet-embedder.service",
        "feat/some-branch",
        "user@host",
        "host:22",
        "2001:db8::1",
    ] {
        assert!(is_safe_arg(ok), "{ok}");
    }
    for bad in [
        "",
        "main; rm -rf /",
        "main && reboot",
        "$(whoami)",
        "`id`",
        "foo$bar",
        "a|b",
        "a b",
        "a>b",
        "a'b",
        "a\"b",
        "a\nb",
        "host;rm",
    ] {
        assert!(!is_safe_arg(bad), "{bad:?}");
    }
}

#[test]
fn quote_shell_arg_uses_posix_single_quotes() {
    assert_eq!(quote_shell_arg("/opt/rivetos"), "'/opt/rivetos'");
    assert_eq!(quote_shell_arg("/opt/rivet os"), "'/opt/rivet os'");
    assert_eq!(quote_shell_arg("/opt/rivet's"), "'/opt/rivet'\\''s'");
}

#[test]
fn assert_safe_arg_returns_or_refuses() {
    assert_eq!(assert_safe_arg("v1.2.3", "--version").unwrap(), "v1.2.3");
    assert_eq!(
        assert_safe_arg("x; rm -rf /", "--version").unwrap_err(),
        "Refusing unsafe --version \"x; rm -rf /\" — only letters, digits and . _ - / @ : are allowed."
    );
}

#[test]
fn unsafe_install_roots_are_the_banned_set() {
    assert!(is_unsafe_install_root(""));
    for ch in ['\'', '"', '`', '$', '\\', ';', '\n', '\r'] {
        assert!(is_unsafe_install_root(&format!("/opt{ch}rivetos")));
    }
    assert!(!is_unsafe_install_root("/opt/rivet os"));
    assert!(ownership_exists_command("/opt/rivetos; rm -rf /").is_none());
    assert_eq!(
        ownership_exists_command("/opt/rivet os").unwrap(),
        "test -d '/opt/rivet os' && echo yes || echo no"
    );
}

#[test]
fn restart_families_stay_distinct() {
    assert_eq!(
        restart_unit_command("rivetos", "rivet"),
        "systemctl restart rivetos || systemctl --user restart rivetos || sudo systemctl restart rivetos"
    );
    assert_eq!(
        restart_unit_command("rivetos", "root"),
        "systemctl restart rivetos || systemctl --user restart rivetos"
    );
    let user = restart_unit_command("rivetos", "rivet");
    assert!(user.find("--user").unwrap() < user.find("sudo").unwrap());
    assert!(
        restart_unit_command("rivet-embedder.service", "rivet")
            .contains("systemctl --user restart rivet-embedder.service")
    );
    assert_eq!(npm_restart_command("root"), "systemctl restart rivetos");
    assert_eq!(
        npm_restart_command("rivet"),
        "sudo systemctl restart rivetos"
    );
    assert_ne!(
        restart_unit_command("rivetos", "rivet"),
        npm_restart_command("rivet")
    );
    assert!(local_restart_commands("rivetos").unwrap().len() == 3);
    assert!(local_restart_commands("bad unit").is_none());
    assert_eq!(
        worker_active_command("rivetos", "root"),
        "systemctl is-active rivetos"
    );
    assert_eq!(
        worker_active_command("rivetos", "rivet"),
        "sudo systemctl is-active rivetos"
    );
}

#[test]
fn worker_discovery_commands_and_filter() {
    assert!(discover_local_workers_command().contains("awk '{print $1}'"));
    assert!(discover_remote_workers_command().contains("awk '{print \\$1}'"));
    assert_eq!(
        filter_worker_units(
            "rivet-compactor.service\nrivetos.service\n\nbad unit\nrivet-embedder.service\n"
        ),
        vec![
            "rivet-compactor.service".to_string(),
            "rivet-embedder.service".to_string(),
        ]
    );
}

#[test]
fn remote_commands_quote_the_install_root() {
    assert_eq!(resolved_install_root(None), install_root());
    assert_eq!(resolved_install_root(Some("   ")), install_root());
    assert_eq!(
        resolved_install_root(Some("/node/rivetos")),
        "/node/rivetos"
    );
    assert_eq!(
        git_update_command("/opt/rivetos", None),
        "cd '/opt/rivetos' && git fetch origin && git checkout main && git reset --hard origin/main"
    );
    assert_eq!(
        git_update_command("/srv/rivetos", Some("v1.2.3")),
        "cd '/srv/rivetos' && git fetch --tags && git checkout v1.2.3"
    );
    assert!(remote_cd("/opt/rivet os", "true").starts_with("cd '/opt/rivet os' && "));
    assert_eq!(
        mesh::config_validate_command("/opt/rivetos"),
        format!(
            "cd '/opt/rivetos' && node {} config validate 2>&1 | tail -2",
            ["packages", "cli", "dist", "index.js"].join("/")
        )
    );
    assert_eq!(
        mesh::plugins_sync_command("/opt/rivetos"),
        format!(
            "cd '/opt/rivetos' && npx tsx {} plugins sync",
            ["packages", "cli", "src", "index.ts"].join("/")
        )
    );
    assert_eq!(
        npm_global_install_with_sudo("beta", "rivet"),
        "sudo npm install -g @rivetos/cli@beta --no-audit --no-fund"
    );
    assert_eq!(
        npm_global_install_with_sudo("beta", "root"),
        "npm install -g @rivetos/cli@beta --no-audit --no-fund"
    );
    assert_eq!(ownership_full_path("/opt/rivetos", "."), "/opt/rivetos");
    assert_eq!(
        ownership_full_path("/opt/rivetos", "apps/rivethub-electron/release"),
        "/opt/rivetos/apps/rivethub-electron/release"
    );
    assert!(REMOTE_OWNERSHIP_PATHS.contains(&"apps/rivet-android/.gradle"));
    assert!(REMOTE_OWNERSHIP_PATHS.contains(&"apps/rivethub-android/build"));
}

#[test]
fn format_exec_failure_prefers_stderr_then_message_then_status() {
    assert_eq!(
        format_exec_failure(Some(&ExecFailure {
            stderr: Some("[setup-mesh-hosts] ERROR: mesh file not readable\n".to_string()),
            stdout: None,
            message: Some("Command failed: sudo …".to_string()),
            status: None,
        })),
        "[setup-mesh-hosts] ERROR: mesh file not readable"
    );
    assert_eq!(
        format_exec_failure(Some(&ExecFailure {
            stderr: Some("line1\nline2\nline3\nline4\n".to_string()),
            stdout: None,
            message: None,
            status: None,
        })),
        "line2 | line3 | line4"
    );
    assert_eq!(
        format_exec_failure(Some(&ExecFailure {
            stderr: None,
            stdout: None,
            message: Some("boom".to_string()),
            status: None,
        })),
        "boom"
    );
    assert_eq!(
        format_exec_failure(Some(&ExecFailure {
            stderr: None,
            stdout: None,
            message: None,
            status: Some(1),
        })),
        "exited with code 1"
    );
    assert_eq!(format_exec_failure(None), "unknown error");
}

#[test]
fn format_mesh_hosts_skip_detail_adds_the_sudo_hint() {
    let password = format_mesh_hosts_skip_detail(Some(&ExecFailure {
        stderr: Some("sudo: a password is required\n".to_string()),
        stdout: None,
        message: Some("mesh-hosts exited with code 1".to_string()),
        status: Some(1),
    }));
    assert!(password.contains("password is required"));
    assert!(password.contains("passwordless sudo"));
    let tty = format_mesh_hosts_skip_detail(Some(&ExecFailure {
        stderr: Some("sudo: a terminal is required to read the password".to_string()),
        stdout: None,
        message: None,
        status: None,
    }));
    assert!(tty.contains("terminal is required"));
    assert!(tty.contains("passwordless sudo"));
    assert_eq!(
        format_mesh_hosts_skip_detail(Some(&ExecFailure {
            stderr: Some("[setup-mesh-hosts] ERROR: mesh file not readable\n".to_string()),
            stdout: None,
            message: Some("mesh-hosts exited with code 1".to_string()),
            status: None,
        })),
        "[setup-mesh-hosts] ERROR: mesh file not readable"
    );
    assert_eq!(
        format_mesh_hosts_skip_detail(Some(&ExecFailure {
            stderr: None,
            stdout: None,
            message: Some("mesh-hosts exited with code 1".to_string()),
            status: Some(1),
        })),
        "mesh-hosts exited with code 1"
    );
}

#[test]
fn mesh_hosts_commands_follow_root_and_the_live_paths() {
    let script = "/opt/rivetos/infra/scripts/setup-mesh-hosts.sh";
    let mesh_file = default_mesh_file();
    assert_eq!(mesh_file, mesh::shared_path(&["mesh.json"]));
    assert_eq!(
        build_local_mesh_hosts_command_as(script, &mesh_file, true),
        format!("{script} {mesh_file} --quiet")
    );
    assert_eq!(
        build_local_mesh_hosts_command_as(script, &mesh_file, false),
        format!("sudo -n {script} {mesh_file} --quiet")
    );
    let live = build_local_mesh_hosts_command(script, None);
    if is_process_root() {
        assert_eq!(live, format!("{script} {mesh_file} --quiet"));
    } else {
        assert_eq!(live, format!("sudo -n {script} {mesh_file} --quiet"));
    }
    let remote_script = remote_mesh_hosts_script(None);
    assert_eq!(
        build_remote_mesh_hosts_command("root", None),
        format!("{} {mesh_file} --quiet", quote_shell_arg(&remote_script))
    );
    assert_eq!(
        build_remote_mesh_hosts_command("rivet", None),
        format!(
            "sudo -n {} {mesh_file} --quiet",
            quote_shell_arg(&remote_script)
        )
    );
    assert!(
        remote_mesh_hosts_script(Some("/node/rivetos"))
            .ends_with("/node/rivetos/infra/scripts/setup-mesh-hosts.sh")
    );
    let argv = ssh_argv("rivet", "192.0.2.10", "true");
    assert_eq!(argv[0], "ssh");
    assert!(argv.iter().any(|part| part == "BatchMode=yes"));
    assert_eq!(argv[argv.len() - 2], "rivet@192.0.2.10");
    assert_eq!(argv[argv.len() - 1], "true");
}
