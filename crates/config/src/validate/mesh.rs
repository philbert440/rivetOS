use serde_json::{Map, Value};

use super::Issues;
use super::patterns::is_shell_unsafe;
use super::value::js_trim;

pub(crate) fn validate_mesh(mesh: &Map<String, Value>, issues: &mut Issues) {
    if mesh.get("enabled") == Some(&Value::Bool(true)) {
        let tls_missing = match mesh.get("tls") {
            None | Some(Value::Bool(false)) => true,
            Some(_) => false,
        };
        if tls_missing {
            issues.error(
                "mesh.tls",
                "mesh.enabled requires tls configuration. TLS is mandatory when mesh is enabled — no plaintext fallback is allowed. Set tls: true (uses conventional /rivet-shared/rivet-ca/ paths) or provide a MeshTlsConfig object.",
            );
        }
        let name_ok = mesh
            .get("node_name")
            .and_then(Value::as_str)
            .is_some_and(|text| !js_trim(text).is_empty());
        if !name_ok {
            issues.error(
                "mesh.node_name",
                "mesh.node_name is required when mesh.enabled is true (used as CN for node cert)",
            );
        }
    }

    if let Some(tls) = mesh.get("tls")
        && !tls.is_boolean()
        && !tls.is_object()
    {
        issues.error(
                "mesh.tls",
                "mesh.tls must be boolean (true for defaults) or a MeshTlsConfig object { ca_path?, cert_path?, key_path? }",
            );
    }

    if let Some(host) = mesh.get("advertise_host") {
        match host.as_str() {
            Some(text) if !js_trim(text).is_empty() => {
                if is_shell_unsafe(text) {
                    issues.error(
                        "mesh.advertise_host",
                        "mesh.advertise_host contains shell-unsafe characters",
                    );
                }
            }
            _ => issues.error(
                "mesh.advertise_host",
                "mesh.advertise_host must be a non-empty string (IP or DNS name)",
            ),
        }
    }

    if mesh.contains_key("secret") {
        issues.warning(
            "mesh.secret",
            "mesh.secret is ignored — agent-channel authentication is mTLS only. Remove this key from your config.",
        );
    }
}
