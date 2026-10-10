mod common;

use common::{assert_has_error, eval_fields, harness, with_base};

macro_rules! err {
    ($name:ident, $yaml:expr, $message:expr) => {
        #[test]
        fn $name() {
            let yaml = $yaml;
            assert_has_error(&yaml, $message);
        }
    };
}

err!(
    mesh_tls_required,
    with_base("mesh:\n  enabled: true\n  node_name: node-a\n"),
    "mesh.enabled requires tls configuration. TLS is mandatory when mesh is enabled — no plaintext fallback is allowed. Set tls: true (uses conventional /rivet-shared/rivet-ca/ paths) or provide a MeshTlsConfig object."
);
err!(
    mesh_node_name,
    with_base("mesh:\n  enabled: true\n  tls: true\n  node_name: \"  \"\n"),
    "mesh.node_name is required when mesh.enabled is true (used as CN for node cert)"
);
err!(
    mesh_tls_type,
    with_base("mesh:\n  tls: 1\n"),
    "mesh.tls must be boolean (true for defaults) or a MeshTlsConfig object { ca_path?, cert_path?, key_path? }"
);
err!(
    mesh_advertise_empty,
    with_base("mesh:\n  advertise_host: \"\"\n"),
    "mesh.advertise_host must be a non-empty string (IP or DNS name)"
);
err!(
    mesh_advertise_shell,
    with_base("mesh:\n  advertise_host: bad host\n"),
    "mesh.advertise_host contains shell-unsafe characters"
);

err!(
    den_enabled,
    with_base("den:\n  enabled: 1\n"),
    "\"den.enabled\" must be a boolean"
);
err!(
    den_host,
    with_base("den:\n  host: \"\"\n"),
    "\"den.host\" must be a non-empty string (bind address, e.g. 127.0.0.1 or 0.0.0.0)"
);
err!(
    den_port,
    with_base("den:\n  port: 0\n"),
    "\"den.port\" must be an integer between 1 and 65535"
);
err!(
    den_token,
    with_base("den:\n  token: 1\n"),
    "\"den.token\" must be a string"
);
err!(
    den_terminal_object,
    with_base("den:\n  terminal: []\n"),
    "\"den.terminal\" must be an object (e.g. { enabled: true })"
);
err!(
    den_terminal_enabled,
    with_base("den:\n  terminal:\n    enabled: 1\n"),
    "\"den.terminal.enabled\" must be a boolean"
);
err!(
    den_terminal_open,
    with_base("den:\n  terminal:\n    open: 1\n"),
    "\"den.terminal.open\" must be a boolean"
);
err!(
    den_terminal_idle,
    with_base("den:\n  terminal:\n    idle_ttl_ms: -1\n"),
    "\"den.terminal.idle_ttl_ms\" must be a non-negative integer (ms; 0 disables)"
);
err!(
    den_devices_object,
    with_base("den:\n  devices: []\n"),
    "\"den.devices\" must be an object (e.g. { enabled: true })"
);
err!(
    den_devices_enabled,
    with_base("den:\n  devices:\n    enabled: 1\n"),
    "\"den.devices.enabled\" must be a boolean"
);
err!(
    den_devices_relay_sudo,
    with_base("den:\n  devices:\n    relay_sudo: 1\n"),
    "\"den.devices.relay_sudo\" must be a boolean"
);

macro_rules! den_string {
    ($name:ident, $key:literal) => {
        err!(
            $name,
            with_base(concat!("den:\n  devices:\n    ", $key, ": 1\n")),
            concat!("\"den.devices.", $key, "\" must be a string")
        );
    };
}

den_string!(den_relay_ssh, "relay_ssh");
den_string!(den_wg_interface, "wg_interface");
den_string!(den_pool, "pool");
den_string!(den_wg_endpoint, "wg_endpoint");
den_string!(den_wg_public_key, "wg_public_key");
den_string!(den_allowed_ips, "allowed_ips");
den_string!(den_home_subnet, "home_subnet");
den_string!(den_relay_forward_src, "relay_forward_src");
den_string!(den_relay_forward_dest, "relay_forward_dest");
den_string!(den_shared_host, "shared_host");
den_string!(den_shared_export, "shared_export");
den_string!(den_roster_path, "roster_path");
den_string!(den_gateway_url, "gateway_url");
den_string!(den_pg_admin_url, "pg_admin_url");
den_string!(den_pg_device_group, "pg_device_group");

err!(
    den_allowed_origins,
    with_base("den:\n  allowed_origins: [\"\"]\n"),
    "\"den.allowed_origins\" must be a list of non-empty strings"
);
err!(
    den_allowed_hosts,
    with_base("den:\n  allowed_hosts: [1]\n"),
    "\"den.allowed_hosts\" must be a list of non-empty strings"
);
err!(
    den_allowed_harnesses,
    with_base("den:\n  allowed_harnesses: [1]\n"),
    "\"den.allowed_harnesses\" must be a list of non-empty harness ids (omit the key to allow all)"
);
err!(
    den_static_dir,
    with_base("den:\n  static_dir: \"\"\n"),
    "\"den.static_dir\" must be a non-empty string path"
);
err!(
    den_files_root,
    with_base("den:\n  files_root: 1\n"),
    "\"den.files_root\" must be a string path (\"\" disables the files browser)"
);
err!(
    den_files_open,
    with_base("den:\n  files_open: 1\n"),
    "\"den.files_open\" must be a boolean"
);
err!(
    den_advertise_mdns,
    with_base("den:\n  advertise_mdns: 1\n"),
    "\"den.advertise_mdns\" must be a boolean"
);
err!(
    den_tls_gate,
    with_base("den:\n  enabled: true\n  host: 0.0.0.0\n  terminal:\n    enabled: true\n"),
    "\"den.tls_cert\" (and den.tls_key) is required when den.terminal.enabled is true and den.host is not loopback (127.0.0.1/::1/localhost) — an exposed terminal without TLS would hang an unauthenticated shell on the network. Set den.tls_cert/tls_key, bind den.host to loopback, disable terminals, or set den.terminal.open: true on a trusted private network."
);

err!(
    tasks_enabled,
    with_base("tasks:\n  enabled: 1\n"),
    "\"tasks.enabled\" must be a boolean"
);
err!(
    tasks_sqlite_path,
    with_base("tasks:\n  sqlite_path: \"\"\n"),
    "\"tasks.sqlite_path\" must be a non-empty file path"
);
err!(
    tasks_eval_object,
    with_base("tasks:\n  eval: []\n"),
    "\"tasks.eval\" must be an object"
);
err!(
    tasks_harnesses_object,
    with_base("tasks:\n  harnesses: []\n"),
    "\"tasks.harnesses\" must be an object keyed by harness id"
);
err!(
    harness_section_object,
    with_base("tasks:\n  harnesses:\n    claude-code: []\n"),
    "\"tasks.harnesses.claude-code\" must be an object"
);

macro_rules! harness_string {
    ($name:ident, $key:literal) => {
        err!(
            $name,
            harness(concat!("      ", $key, ": 1\n")),
            concat!(
                "\"tasks.harnesses.claude-code.",
                $key,
                "\" must be a string"
            )
        );
    };
}

harness_string!(harness_binary, "binary");
harness_string!(harness_model, "model");
harness_string!(harness_cwd, "cwd");
harness_string!(harness_home, "home");

err!(
    harness_effort,
    harness("      effort: max\n"),
    "\"tasks.harnesses.claude-code.effort\" must be 'low', 'medium' or 'high'"
);
err!(
    harness_isolation,
    harness("      isolation: nope\n"),
    "\"tasks.harnesses.claude-code.isolation\" must be 'inherit' or 'isolated'"
);
err!(
    harness_allowed_tools,
    harness("      allowed_tools: [\"-rm\"]\n"),
    "\"tasks.harnesses.claude-code.allowed_tools\" must be an array of permission rules: non-empty strings of at most 200 characters, not starting with \"-\", with no control characters"
);
err!(
    harness_models_mode,
    harness("      models_mode: nope\n"),
    "\"tasks.harnesses.claude-code.models_mode\" must be 'discover', 'replace' or 'merge'"
);
err!(
    harness_models,
    harness("      models: nope\n"),
    "\"tasks.harnesses.claude-code.models\" must be an array"
);
err!(
    harness_efforts,
    harness("      efforts: nope\n"),
    "\"tasks.harnesses.claude-code.efforts\" must be an array"
);

err!(
    workflows_enabled,
    with_base("workflows:\n  enabled: 1\n"),
    "\"workflows.enabled\" must be a boolean"
);
err!(
    workflows_runs_dir,
    with_base("workflows:\n  runs_dir: 1\n"),
    "\"workflows.runs_dir\" must be a string path"
);
err!(
    workflows_defs_roots,
    with_base("workflows:\n  defs_roots: nope\n"),
    "\"workflows.defs_roots\" must be an array of paths"
);
err!(
    workflows_defs_entries,
    with_base("workflows:\n  defs_roots: [1]\n"),
    "\"workflows.defs_roots\" entries must be strings"
);
err!(
    workflows_allowlist,
    with_base("workflows:\n  agent_allowlist: nope\n"),
    "\"workflows.agent_allowlist\" must be an array of workflow ids (or [\"*\"]). Empty/absent = agents may start nothing."
);
err!(
    workflows_allowlist_entry,
    with_base("workflows:\n  agent_allowlist: [\"\"]\n"),
    "\"workflows.agent_allowlist\" entries must be non-empty strings"
);

err!(
    eval_enabled,
    eval_fields("    enabled: 1\n"),
    "\"tasks.eval.enabled\" must be a boolean"
);
err!(
    eval_require_criteria,
    eval_fields("    require_criteria: 1\n"),
    "\"tasks.eval.require_criteria\" must be a boolean"
);
err!(
    eval_derive_internal,
    eval_fields("    derive_internal: 1\n"),
    "\"tasks.eval.derive_internal\" must be a boolean"
);
err!(
    eval_max_retries,
    eval_fields("    max_retries: -1\n"),
    "\"tasks.eval.max_retries\" must be a non-negative integer"
);
err!(
    eval_skip_origins,
    eval_fields("    skip_origins: [1]\n"),
    "\"tasks.eval.skip_origins\" must be an array of strings"
);
err!(
    eval_verifier_object,
    eval_fields("    verifier: 1\n"),
    "\"tasks.eval.verifier\" must be an object"
);
err!(
    eval_verifier_executor,
    eval_fields("    verifier:\n      executor: nope\n"),
    "\"tasks.eval.verifier.executor\" must be 'chat-loop' or 'harness-session'"
);
err!(
    eval_escalation_object,
    eval_fields("    escalation: 1\n"),
    "\"tasks.eval.escalation\" must be an object"
);
err!(
    eval_escalation_channel,
    eval_fields("    escalation:\n      channel: 1\n"),
    "\"tasks.eval.escalation.channel\" must be a string"
);

err!(
    deployment_target_missing,
    with_base("deployment: {}\n"),
    "Missing required field \"deployment.target\" — must be one of: docker, proxmox, kubernetes, manual"
);
err!(
    deployment_target_invalid,
    with_base("deployment:\n  target: nope\n"),
    "Invalid deployment target \"nope\" — must be one of: docker, proxmox, kubernetes, manual"
);
