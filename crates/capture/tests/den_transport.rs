use std::path::Path;

use capture::{
    CaptureTransport, CaptureUser, DenConfigScalars, MapEnv, acceptable_http_url, capture_user,
    capture_user_from_env, den_tls_configured, guard_den_url, resolve_capture_transport,
    resolve_den_url,
};

const DEN: &str = "https://127.0.0.1:5174";
const PG: &str = "postgres://localhost/rivet";

fn env(pairs: &[(&str, &str)]) -> MapEnv {
    MapEnv::from_pairs(pairs)
}

fn no_config() -> Option<String> {
    None
}

fn den(url: &str) -> CaptureTransport {
    CaptureTransport::Den {
        den_url: url.to_string(),
        warnings: None,
        user: None,
    }
}

fn pg(url: &str) -> CaptureTransport {
    CaptureTransport::Pg {
        pg_url: url.to_string(),
    }
}

fn none(reason: &str) -> CaptureTransport {
    CaptureTransport::None {
        reason: reason.to_string(),
    }
}

#[test]
fn prefers_launcher_url_and_ca() {
    let resolved = resolve_den_url(
        &env(&[
            ("RIVET_DEN_URL", "https://127.0.0.1:9999"),
            ("RIVET_DEN_CA", "/launch/ca"),
        ]),
        || Some("den:\n  port: 1234\n  tls_ca: /config/ca".to_string()),
        &|_: &Path| false,
    )
    .unwrap();
    assert_eq!(resolved.den_url, "https://127.0.0.1:9999");
    assert_eq!(resolved.ca_path, "/launch/ca");
    assert!(resolved.warnings.is_none());
}

#[test]
fn reads_den_scalars_and_ignores_other_sections() {
    let raw = "other:\n  port: 3\nden:\n  port: 1234 # comment\n  tls_ca: \"/config/ca\"\nrest:\n  port: 4";
    let resolved = resolve_den_url(
        &env(&[("RIVETOS_DEN_TLS_CA", "/env/ca")]),
        || Some(raw.to_string()),
        &|_: &Path| false,
    )
    .unwrap();
    assert_eq!(resolved.den_url, "https://127.0.0.1:1234");
    assert_eq!(resolved.ca_path, "/config/ca");
}

#[test]
fn resolves_defaults_and_fallback_ca() {
    let resolved = resolve_den_url(&env(&[]), no_config, &|_: &Path| false).unwrap();
    assert_eq!(resolved.den_url, "https://127.0.0.1:5174");
    assert_eq!(
        resolved.ca_path,
        "/rivet-shared/rivet-ca/intermediate/chain.pem"
    );
    let with_env = resolve_den_url(
        &env(&[("RIVETOS_DEN_TLS_CA", "/env/ca")]),
        no_config,
        &|_: &Path| false,
    )
    .unwrap();
    assert_eq!(with_env.ca_path, "/env/ca");
}

#[test]
fn rejects_malformed_endpoints() {
    assert!(
        resolve_den_url(
            &env(&[("RIVET_DEN_URL", "file:///tmp/den")]),
            no_config,
            &|_: &Path| false
        )
        .is_none()
    );
}

#[test]
fn ignores_nested_ports() {
    let first = resolve_den_url(
        &env(&[]),
        || Some("den:\n    port: 1234\n    tls:\n      port: 9999".to_string()),
        &|_: &Path| false,
    )
    .unwrap();
    assert_eq!(first.den_url, "https://127.0.0.1:1234");
    let nested = resolve_den_url(
        &env(&[]),
        || Some("den:\n    tls:\n      port: 9999".to_string()),
        &|_: &Path| false,
    )
    .unwrap();
    assert_eq!(nested.den_url, "https://127.0.0.1:5174");
}

#[test]
fn keeps_the_first_direct_value() {
    let raw = "den:\n  port: 1234\n  port: 9999\n  tls_ca: /first\n  tls_ca: /last";
    let resolved = resolve_den_url(&env(&[]), || Some(raw.to_string()), &|_: &Path| false).unwrap();
    assert_eq!(resolved.den_url, "https://127.0.0.1:1234");
    assert_eq!(resolved.ca_path, "/first");
}

#[test]
fn strips_inline_comments_outside_quotes() {
    let raw = "den:\n  port: 1234 # port\n  tls_ca: /config/ca # CA";
    let resolved = resolve_den_url(&env(&[]), || Some(raw.to_string()), &|_: &Path| false).unwrap();
    assert_eq!(resolved.den_url, "https://127.0.0.1:1234");
    assert_eq!(resolved.ca_path, "/config/ca");
}

#[test]
fn preserves_quoted_hashes() {
    for value in ["\"/config/ # ca\"", "'/config/ # ca'"] {
        let raw = format!("den:\n  tls_ca: {value} # comment");
        let resolved = resolve_den_url(&env(&[]), || Some(raw.clone()), &|_: &Path| false).unwrap();
        assert_eq!(resolved.ca_path, "/config/ # ca");
    }
}

#[test]
fn defaults_empty_or_non_numeric_port() {
    for port in ["", "invalid", "12abc"] {
        let raw = format!("den:\n  port: {port}");
        let resolved = resolve_den_url(&env(&[]), || Some(raw.clone()), &|_: &Path| false).unwrap();
        assert_eq!(resolved.den_url, "https://127.0.0.1:5174");
    }
}

#[test]
fn den_tls_follows_config_then_env_then_issued_files() {
    let empty = DenConfigScalars::default();
    assert!(!den_tls_configured(&env(&[]), &empty, &|_: &Path| false));
    let both = DenConfigScalars {
        tls_cert: Some("/c".to_string()),
        tls_key: Some("/k".to_string()),
        ..DenConfigScalars::default()
    };
    assert!(den_tls_configured(&env(&[]), &both, &|_: &Path| false));
    let cert_only = DenConfigScalars {
        tls_cert: Some("/c".to_string()),
        ..DenConfigScalars::default()
    };
    assert!(!den_tls_configured(&env(&[]), &cert_only, &|_: &Path| {
        false
    }));
    assert!(den_tls_configured(
        &env(&[
            ("RIVETOS_DEN_TLS_CERT", "/c"),
            ("RIVETOS_DEN_TLS_KEY", "/k")
        ]),
        &empty,
        &|_: &Path| false,
    ));
    let node = DenConfigScalars {
        node_name: Some("tnode".to_string()),
        ..DenConfigScalars::default()
    };
    let issued = |path: &Path| {
        let text = path.to_string_lossy();
        text.ends_with("tnode.crt") || text.ends_with("tnode.key")
    };
    assert!(den_tls_configured(&env(&[]), &node, &issued));
    assert!(!den_tls_configured(&env(&[]), &node, &|path: &Path| {
        path.to_string_lossy().ends_with("tnode.crt")
    }));
    let named = DenConfigScalars {
        node_name: Some("n".to_string()),
        ..DenConfigScalars::default()
    };
    assert!(den_tls_configured(
        &env(&[("RIVETOS_SHARED_DIR", "/mnt/s")]),
        &named,
        &|path: &Path| {
            path.to_string_lossy()
                .starts_with("/mnt/s/rivet-ca/issued/n.")
        }
    ));
}

#[test]
fn guard_uses_the_first_origin() {
    let guarded = guard_den_url("https://127.0.0.1:5174, http://192.0.2.15:5174", false);
    assert_eq!(guarded.den_url, DEN);
    assert!(
        guarded
            .warnings
            .iter()
            .any(|line| line.contains("lists several origins"))
    );
}

#[test]
fn guard_rewrites_http_loopback_only_when_tls() {
    let rewritten = guard_den_url("http://127.0.0.1:5174", true);
    assert_eq!(rewritten.den_url, DEN);
    assert!(
        rewritten
            .warnings
            .iter()
            .any(|line| line.contains("serves https only"))
    );
    assert_eq!(
        guard_den_url("http://localhost:5174", true).den_url,
        "https://localhost:5174"
    );
    assert_eq!(
        guard_den_url("http://[::1]:5174", true).den_url,
        "https://[::1]:5174"
    );
    let plain = guard_den_url("http://127.0.0.1:5174", false);
    assert_eq!(plain.den_url, "http://127.0.0.1:5174");
    assert!(plain.warnings.is_empty());
    assert!(
        guard_den_url("http://192.0.2.15:5174", true)
            .warnings
            .is_empty()
    );
    assert!(
        guard_den_url("https://127.0.0.1:5174", true)
            .warnings
            .is_empty()
    );
}

#[test]
fn guard_applies_both_in_order() {
    let out = guard_den_url("http://127.0.0.1:5174,http://192.0.2.15:5174", true);
    assert_eq!(out.den_url, DEN);
    assert_eq!(out.warnings.len(), 2);
}

#[test]
fn resolve_guards_preset_http_loopback() {
    let tls = "mesh:\n  node_name: tnode\nden:\n  port: 5174\n";
    let both = |path: &Path| {
        let text = path.to_string_lossy();
        text.ends_with("tnode.crt") || text.ends_with("tnode.key")
    };
    let resolved = resolve_den_url(
        &env(&[("RIVET_DEN_URL", "http://127.0.0.1:5174")]),
        || Some(tls.to_string()),
        &both,
    )
    .unwrap();
    assert_eq!(resolved.den_url, DEN);
    assert_eq!(
        resolved.ca_path,
        "/rivet-shared/rivet-ca/intermediate/chain.pem"
    );
    let warnings = resolved.warnings.unwrap();
    assert!(
        warnings
            .iter()
            .any(|line| line.contains("serves https only"))
    );
    let open = resolve_den_url(
        &env(&[("RIVET_DEN_URL", "http://127.0.0.1:5174")]),
        || Some(tls.to_string()),
        &|_: &Path| false,
    )
    .unwrap();
    assert_eq!(open.den_url, "http://127.0.0.1:5174");
    assert!(open.warnings.is_none());
}

#[test]
fn resolve_reads_tls_material_without_disturbing_port() {
    let raw = "mesh:\n  node_name: x\n  tls:\n    cert_path: /nested\nden:\n  port: 9999\n  tls_cert: \"/c\"\n  tls_key: /k # key\n  tls_ca: /ca\n";
    let resolved = resolve_den_url(
        &env(&[("RIVET_DEN_URL", "http://127.0.0.1:9999")]),
        || Some(raw.to_string()),
        &|_: &Path| false,
    )
    .unwrap();
    assert_eq!(resolved.den_url, "https://127.0.0.1:9999");
    assert_eq!(resolved.ca_path, "/ca");
    assert!(
        resolved
            .warnings
            .unwrap()
            .iter()
            .any(|line| line.contains("serves https only"))
    );
}

const BLOCKS: &str = "RIVETOS_USER_ID is set — den transport would hit the owner pool on loopback — and RIVETOS_PG_URL is not set";

#[test]
fn forces_den_when_the_url_resolves() {
    let got = resolve_capture_transport(
        &env(&[
            ("RIVETOS_CAPTURE_TRANSPORT", "den"),
            ("RIVET_DEN_URL", DEN),
            ("RIVETOS_PG_URL", PG),
        ]),
        no_config,
    );
    assert_eq!(got, den(DEN));
}

#[test]
fn forced_den_without_a_url_is_none() {
    let reason = "RIVETOS_CAPTURE_TRANSPORT=den but RIVET_DEN_URL is not set";
    assert_eq!(
        resolve_capture_transport(
            &env(&[
                ("RIVETOS_CAPTURE_TRANSPORT", "den"),
                ("RIVET_DEN_URL", "file:///tmp/den"),
                ("RIVETOS_PG_URL", PG),
            ]),
            no_config,
        ),
        none(reason),
    );
    assert_eq!(
        resolve_capture_transport(
            &env(&[
                ("RIVETOS_CAPTURE_TRANSPORT", "den"),
                ("RIVET_DEN_URL", "ftp://den")
            ]),
            no_config,
        ),
        none(reason),
    );
}

#[test]
fn trims_a_forced_den_url() {
    let padded = format!("  {DEN}  ");
    assert_eq!(
        resolve_capture_transport(
            &env(&[
                ("RIVETOS_CAPTURE_TRANSPORT", " den "),
                ("RIVET_DEN_URL", &padded)
            ]),
            no_config,
        ),
        den(DEN),
    );
}

#[test]
fn forces_pg_when_the_url_is_set() {
    assert_eq!(
        resolve_capture_transport(
            &env(&[
                ("RIVETOS_CAPTURE_TRANSPORT", "pg"),
                ("RIVET_DEN_URL", DEN),
                ("RIVETOS_PG_URL", PG),
            ]),
            no_config,
        ),
        pg(PG),
    );
}

#[test]
fn forced_pg_without_a_url_is_none() {
    assert_eq!(
        resolve_capture_transport(
            &env(&[("RIVETOS_CAPTURE_TRANSPORT", "pg"), ("RIVET_DEN_URL", DEN)]),
            no_config
        ),
        none("RIVETOS_CAPTURE_TRANSPORT=pg but RIVETOS_PG_URL is not set"),
    );
}

#[test]
fn defaults_to_den_when_the_user_id_is_empty() {
    assert_eq!(
        resolve_capture_transport(
            &env(&[("RIVET_DEN_URL", DEN), ("RIVETOS_PG_URL", PG)]),
            no_config
        ),
        den(DEN)
    );
    assert_eq!(
        resolve_capture_transport(
            &env(&[("RIVET_DEN_URL", DEN), ("RIVETOS_USER_ID", "")]),
            no_config
        ),
        den(DEN)
    );
    assert_eq!(
        resolve_capture_transport(
            &env(&[
                ("RIVETOS_CAPTURE_TRANSPORT", "den"),
                ("RIVET_DEN_URL", DEN),
                ("RIVETOS_PG_URL", PG),
                ("RIVETOS_USER_ID", ""),
            ]),
            no_config,
        ),
        den(DEN),
    );
    assert_eq!(
        resolve_capture_transport(&env(&[]), || Some("den:\n  port: 5999".to_string())),
        den("https://127.0.0.1:5999"),
    );
}

#[test]
fn blocks_a_whitespace_user_id() {
    for forced in [Some("den"), None] {
        let mut pairs = vec![("RIVET_DEN_URL", DEN), ("RIVETOS_USER_ID", "   ")];
        if let Some(value) = forced {
            pairs.insert(0, ("RIVETOS_CAPTURE_TRANSPORT", value));
        }
        assert_eq!(
            resolve_capture_transport(&env(&pairs), no_config),
            none(BLOCKS)
        );
        let mut with_pg = pairs.clone();
        with_pg.push(("RIVETOS_PG_URL", PG));
        assert_eq!(resolve_capture_transport(&env(&with_pg), no_config), pg(PG));
    }
}

#[test]
fn keeps_pg_for_a_routed_user_when_den_is_forced() {
    assert_eq!(
        resolve_capture_transport(
            &env(&[
                ("RIVETOS_CAPTURE_TRANSPORT", "den"),
                ("RIVET_DEN_URL", DEN),
                ("RIVETOS_PG_URL", PG),
                ("RIVETOS_USER_ID", "alice"),
            ]),
            no_config,
        ),
        pg(PG),
    );
}

#[test]
fn defaults_to_pg_when_a_routed_user_has_a_den_url() {
    assert_eq!(
        resolve_capture_transport(
            &env(&[
                ("RIVET_DEN_URL", DEN),
                ("RIVETOS_PG_URL", PG),
                ("RIVETOS_USER_ID", "alice")
            ]),
            no_config,
        ),
        pg(PG),
    );
}

#[test]
fn routed_user_without_postgres_is_none() {
    assert_eq!(
        resolve_capture_transport(
            &env(&[("RIVET_DEN_URL", DEN), ("RIVETOS_USER_ID", "alice")]),
            no_config
        ),
        none(BLOCKS),
    );
}

#[test]
fn defaults_to_pg_when_den_is_disabled() {
    let padded = format!("  {PG}  ");
    assert_eq!(
        resolve_capture_transport(
            &env(&[("RIVETOS_PG_URL", &padded), ("RIVETOS_USER_ID", "alice")]),
            || { Some("den:\n  port: invalid".to_string()) }
        ),
        pg(PG),
    );
}

#[test]
fn rejects_an_out_of_range_port_like_the_whatwg_parser() {
    assert!(!acceptable_http_url("http://host:99999"));
    assert!(acceptable_http_url("HTTP://127.0.0.1:5174"));
    assert_eq!(
        resolve_capture_transport(
            &env(&[
                ("RIVET_DEN_URL", "http://host:99999"),
                ("RIVETOS_PG_URL", PG)
            ]),
            no_config,
        ),
        pg(PG),
    );
    assert_eq!(
        resolve_capture_transport(&env(&[("RIVET_DEN_URL", "HTTP://127.0.0.1:9")]), no_config),
        den("HTTP://127.0.0.1:9"),
    );
}

#[test]
fn none_when_neither_is_configured() {
    assert_eq!(
        resolve_capture_transport(&env(&[("RIVET_DEN_URL", "ftp://den")]), no_config),
        none("RIVET_DEN_URL and RIVETOS_PG_URL are not set"),
    );
}

#[test]
fn ignores_an_unknown_transport_value() {
    assert_eq!(
        resolve_capture_transport(
            &env(&[
                ("RIVETOS_CAPTURE_TRANSPORT", "http"),
                ("RIVET_DEN_URL", DEN)
            ]),
            no_config
        ),
        den(DEN),
    );
}

#[test]
fn launcher_cleared_den_url_falls_back_to_pg() {
    assert_eq!(
        resolve_capture_transport(
            &env(&[("RIVET_DEN_CA", "/missing-ca.pem"), ("RIVETOS_PG_URL", PG)]),
            no_config
        ),
        pg(PG),
    );
    assert_eq!(
        resolve_capture_transport(
            &env(&[
                ("RIVETOS_CAPTURE_TRANSPORT", "den"),
                ("RIVET_DEN_CA", "/missing-ca.pem")
            ]),
            no_config,
        ),
        none("RIVETOS_CAPTURE_TRANSPORT=den but RIVET_DEN_URL is not set"),
    );
}

#[test]
fn den_transport_carries_guard_warnings() {
    let tls = || Some("den:\n  tls_cert: /c\n  tls_key: /k\n".to_string());
    match resolve_capture_transport(
        &env(&[
            ("RIVET_DEN_URL", "http://127.0.0.1:5174"),
            ("RIVETOS_PG_URL", PG),
        ]),
        tls,
    ) {
        CaptureTransport::Den {
            den_url,
            warnings,
            user,
        } => {
            assert_eq!(den_url, DEN);
            assert!(user.is_none());
            assert!(
                warnings
                    .unwrap()
                    .iter()
                    .any(|line| line.contains("serves https only"))
            );
        }
        other => panic!("expected den, got {other:?}"),
    }
    match resolve_capture_transport(
        &env(&[
            ("RIVETOS_CAPTURE_TRANSPORT", "den"),
            (
                "RIVET_DEN_URL",
                "https://127.0.0.1:5174,http://10.0.0.9:5174",
            ),
        ]),
        no_config,
    ) {
        CaptureTransport::Den {
            den_url, warnings, ..
        } => {
            assert_eq!(den_url, DEN);
            assert!(
                warnings
                    .unwrap()
                    .iter()
                    .any(|line| line.contains("several origins"))
            );
        }
        other => panic!("expected den, got {other:?}"),
    }
    assert_eq!(
        resolve_capture_transport(&env(&[("RIVET_DEN_URL", DEN)]), no_config),
        den(DEN)
    );
}

#[test]
fn routed_user_with_a_token_uses_the_den() {
    for forced in [Some("den"), None] {
        let mut pairs = vec![
            ("RIVET_DEN_URL", "https://127.0.0.1:5174"),
            ("RIVETOS_USER_ID", "guest"),
            ("RIVETOS_USER_TOKEN", " tok-123 "),
        ];
        if let Some(value) = forced {
            pairs.insert(0, ("RIVETOS_CAPTURE_TRANSPORT", value));
        }
        assert_eq!(
            resolve_capture_transport(&env(&pairs), no_config),
            CaptureTransport::Den {
                den_url: DEN.to_string(),
                warnings: None,
                user: Some(CaptureUser {
                    id: "guest".to_string(),
                    token: "tok-123".to_string(),
                }),
            },
        );
    }
    assert_eq!(
        resolve_capture_transport(
            &env(&[("RIVET_DEN_URL", DEN), ("RIVETOS_USER_TOKEN", "tok-123")]),
            no_config
        ),
        den(DEN),
    );
    assert!(matches!(
        resolve_capture_transport(
            &env(&[
                ("RIVET_DEN_URL", DEN),
                ("RIVETOS_USER_ID", "guest"),
                ("RIVETOS_USER_TOKEN", "  "),
            ]),
            no_config,
        ),
        CaptureTransport::None { .. }
    ));
}

#[test]
fn token_prefix_overrides_the_fallback_id() {
    let token = "Z3Vlc3Q.secret-secret-secret";
    assert_eq!(
        capture_user("visitor", token),
        CaptureUser {
            id: "guest".to_string(),
            token: token.to_string(),
        },
    );
    assert_eq!(capture_user("visitor", "tok-123").id, "visitor");
    assert_eq!(capture_user("visitor", ".tok").id, "visitor");
    assert_eq!(capture_user("visitor", "!!!.tok").id, "visitor");
}

#[test]
fn routed_session_without_a_token_is_refused() {
    assert_eq!(capture_user_from_env(&env(&[])).unwrap(), None);
    assert_eq!(
        capture_user_from_env(&env(&[("RIVETOS_USER_ID", "")])).unwrap(),
        None
    );
    let user = capture_user_from_env(&env(&[
        ("RIVETOS_USER_ID", "guest"),
        ("RIVETOS_USER_TOKEN", "tok-123"),
    ]))
    .unwrap()
    .unwrap();
    assert_eq!(user.id, "guest");
    assert_eq!(user.token, "tok-123");
    let missing = capture_user_from_env(&env(&[("RIVETOS_USER_ID", "guest")])).unwrap_err();
    assert!(missing.to_string().contains("refusing to write to the den"));
    assert!(
        capture_user_from_env(&env(&[
            ("RIVETOS_USER_ID", " "),
            ("RIVETOS_USER_TOKEN", " ")
        ]))
        .is_err()
    );
}
