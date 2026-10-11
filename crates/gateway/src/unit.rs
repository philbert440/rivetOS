use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt;

use identity::{
    HeaderMap, HeaderVal, RequestIdentity, ResolveUserResult, UserContext, UserDbEntry,
    capture_env_for, clear_user_tokens, mint_user_token, parse_users_registry, registry_from_env,
    resolve_request_user, resolve_user, resolve_user_by_id, stamp_user_header,
};

use crate::auth::{
    ConnInfo, UNAUTHORIZED_HTML, device_id_from_subject, is_device_client, is_gateway_authorized,
    is_loopback_host, wants_html_unauthorized,
};
use crate::config::{GatewayConfig, TermMux};
use crate::http_codec::{
    percent_decode, percent_decode_strict, split_target, ws_accept_matches_tungstenite,
};
use crate::mesh_view::{
    MeshNode, capturing_mesh_logs, load_mesh_file, local_mesh_identity, mesh_den_origins,
    mesh_file_paths,
};
use crate::origin::{OriginDecision, check_origin, hostname_of, normalize_origin, parse_list};
use crate::routes::{bind_refusal, security_lines};
use crate::session_key::den_join_key;
use crate::session_owners::SessionOwners;
use crate::standard_helpers::{int_env, parse_int_js};
use crate::test_support::{isolated, scratch, token_lock_blocking};

const HTML_401: &str = include_str!("../tests/fixtures/unauthorized.html");

fn user(id: &str, owner: bool) -> UserContext {
    UserContext {
        user_id: id.to_string(),
        device_id: None,
        db: UserDbEntry {
            pg_url: format!("postgres://{id}@db/{id}"),
            env_file: None,
        },
        persona: None,
        is_owner: owner,
    }
}

#[test]
fn html_401_fixture_matches_the_page() {
    assert_eq!(UNAUTHORIZED_HTML, HTML_401);
}

#[test]
fn auth_matches_the_typescript_cases() {
    assert!(is_device_client("device:phone", "client"));
    assert!(is_device_client("device:desk", ""));
    assert!(!is_device_client("node-c.mesh", ""));
    assert_eq!(
        device_id_from_subject("device:pixel", "client").as_deref(),
        Some("pixel")
    );
    let loopback = ConnInfo::plain("127.0.0.1");
    assert!(is_gateway_authorized(&loopback, false, true));
    assert!(!is_gateway_authorized(
        &ConnInfo::plain("192.0.2.50"),
        false,
        true
    ));
    let mut tls_loop = ConnInfo::plain("127.0.0.1");
    tls_loop.encrypted = true;
    assert!(is_gateway_authorized(&tls_loop, true, true));
    let mut device = ConnInfo::plain("192.0.2.50");
    device.encrypted = true;
    device.authorized = true;
    device.cn = "device:hub".to_string();
    device.ou = "client".to_string();
    assert!(is_gateway_authorized(&device, true, true));
    let mut node = device.clone();
    node.cn = "node-c.mesh".to_string();
    node.ou.clear();
    assert!(!is_gateway_authorized(&node, true, true));
    let mut unsigned = ConnInfo::plain("192.0.2.50");
    unsigned.encrypted = true;
    assert!(!is_gateway_authorized(&unsigned, true, true));
    assert!(is_gateway_authorized(&unsigned, true, false));
    assert!(is_loopback_host("127.0.0.1"));
    assert!(is_loopback_host("::1"));
    assert!(!is_loopback_host("0.0.0.0"));
    assert!(!is_loopback_host("127.0.0.2"));
    assert!(wants_html_unauthorized(
        "GET",
        "/",
        "text/html,application/xhtml+xml"
    ));
    assert!(wants_html_unauthorized("HEAD", "/den/", "text/html"));
    assert!(!wants_html_unauthorized(
        "GET",
        "/api/memory/stats",
        "text/html"
    ));
    assert!(!wants_html_unauthorized("POST", "/", "text/html"));
    assert!(!wants_html_unauthorized("GET", "/", "*/*"));
    assert!(!wants_html_unauthorized("GET", "/", ""));
}

#[test]
fn origin_policy_matches_the_typescript_cases() {
    assert_eq!(
        normalize_origin("HTTPS://Node.Example:443/").as_deref(),
        Some("https://node.example")
    );
    assert_eq!(
        normalize_origin("http://127.0.0.1:5174").as_deref(),
        Some("http://127.0.0.1:5174")
    );
    assert_eq!(
        normalize_origin("app://bundle").as_deref(),
        Some("app://bundle")
    );
    assert_eq!(
        normalize_origin("APP://Bundle/").as_deref(),
        Some("app://bundle")
    );
    assert!(normalize_origin("null").is_none());
    assert!(normalize_origin("").is_none());
    assert!(normalize_origin("not a url").is_none());
    assert_eq!(hostname_of("Node.Example:5174"), "node.example");
    assert_eq!(hostname_of("localhost"), "localhost");
    assert_eq!(hostname_of("[::1]:5174"), "::1");
    let plain = ConnInfo::plain("127.0.0.1");
    assert_eq!(
        check_origin(&plain, false, "127.0.0.1:5174", None, &[], &[], &[]),
        OriginDecision::Allow { allow_origin: None }
    );
    assert_eq!(
        check_origin(
            &plain,
            false,
            "127.0.0.1:5174",
            Some("http://127.0.0.1:5174"),
            &[],
            &[],
            &[]
        ),
        OriginDecision::Allow {
            allow_origin: Some("http://127.0.0.1:5174".to_string())
        }
    );
    let remote = ConnInfo::plain("10.0.0.9");
    match check_origin(
        &remote,
        false,
        "node.example:5174",
        Some("https://node.example:5174"),
        &[],
        &[],
        &[],
    ) {
        OriginDecision::Allow { .. } => {}
        OriginDecision::Deny { reason } => panic!("{reason}"),
    }
    assert!(matches!(
        check_origin(
            &plain,
            false,
            "127.0.0.1:5174",
            Some("https://evil.example"),
            &[],
            &[],
            &[]
        ),
        OriginDecision::Deny { .. }
    ));
    assert!(matches!(
        check_origin(&plain, false, "127.0.0.1:5174", Some("null"), &[], &[], &[]),
        OriginDecision::Deny { .. }
    ));
    assert!(matches!(
        check_origin(
            &plain,
            false,
            "127.0.0.1:5174",
            Some("app://bundle.evil.com"),
            &[],
            &[],
            &[]
        ),
        OriginDecision::Deny { .. }
    ));
    let allowed = vec!["https://hub.example".to_string()];
    let peers = vec!["https://peer.example:5174".to_string()];
    for origin in [
        "app://bundle",
        "https://hub.example",
        "https://peer.example:5174",
    ] {
        assert_eq!(
            check_origin(
                &remote,
                true,
                "node.example:5174",
                Some(origin),
                &allowed,
                &[],
                &peers
            ),
            OriginDecision::Allow {
                allow_origin: Some(origin.to_string())
            }
        );
    }
    assert!(matches!(
        check_origin(
            &plain,
            false,
            "evil.example:5174",
            Some("http://evil.example:5174"),
            &[],
            &[],
            &[]
        ),
        OriginDecision::Deny { .. }
    ));
    assert!(matches!(
        check_origin(&plain, false, "app.localhost:5174", None, &[], &[], &[]),
        OriginDecision::Allow { .. }
    ));
    let hosts = vec!["den.example".to_string()];
    assert!(matches!(
        check_origin(&plain, false, "den.example:5174", None, &[], &hosts, &[]),
        OriginDecision::Allow { .. }
    ));
    let far = ConnInfo::plain("192.0.2.99");
    assert!(matches!(
        check_origin(&far, false, "192.0.2.10:5174", None, &[], &[], &[]),
        OriginDecision::Allow { .. }
    ));
    assert!(matches!(
        check_origin(&plain, true, "node.example:5174", None, &[], &[], &[]),
        OriginDecision::Allow { .. }
    ));
    assert_eq!(parse_list(Some(" a, b  c,,")), vec!["a", "b", "c"]);
    assert!(parse_list(None).is_empty());
}

#[test]
fn config_load_matches_the_typescript_cases() {
    let missing = BTreeMap::from([
        (
            "RIVETOS_USERS_FILE".to_string(),
            "/nonexistent/definitely-not-here/users.json".to_string(),
        ),
        (
            "RIVETOS_PG_URL".to_string(),
            "postgres://owner@db/rivet_memory".to_string(),
        ),
        (
            "RIVETOS_SHARED_DIR".to_string(),
            scratch("cfg-miss").to_string_lossy().into_owned(),
        ),
    ]);
    let config = GatewayConfig::from_env(&missing);
    let registry = config.users_registry.as_ref().unwrap();
    assert!(!registry.unmapped_is_owner);
    assert!(matches!(
        resolve_user(registry, Some("win-coco")),
        ResolveUserResult::Err(_)
    ));
    assert!(matches!(
        resolve_user(registry, None),
        ResolveUserResult::Ok(_)
    ));

    let invalid = BTreeMap::from([
        ("RIVETOS_USERS_FILE".to_string(), "/dev/null".to_string()),
        (
            "RIVETOS_PG_URL".to_string(),
            "postgres://owner@db/rivet_memory".to_string(),
        ),
        (
            "RIVETOS_SHARED_DIR".to_string(),
            scratch("cfg-null").to_string_lossy().into_owned(),
        ),
    ]);
    let config = GatewayConfig::from_env(&invalid);
    assert!(!config.users_registry.unwrap().unmapped_is_owner);

    let dir = scratch("cfg-file");
    let file = dir.join("users.json");
    std::fs::write(
        &file,
        r#"{"ownerUserId":"owner","unmappedIsOwner":false,"users":{"owner":{"devices":[],"pgUrl":"postgres://owner@db/rivet_memory"},"coco":{"devices":["win-coco"],"pgUrl":"postgres://coco@db/coco_memory"}}}"#,
    )
    .unwrap();
    let mut env = BTreeMap::new();
    env.insert(
        "RIVETOS_USERS_FILE".to_string(),
        file.to_string_lossy().into_owned(),
    );
    env.insert(
        "RIVETOS_DEN_DEVICE_USERS".to_string(),
        r#"{"win-coco":"mallory"}"#.to_string(),
    );
    env.insert(
        "RIVETOS_USER_DBS".to_string(),
        r#"{"mallory":{"pgUrl":"postgres://mallory@db/mallory"}}"#.to_string(),
    );
    env.insert(
        "RIVETOS_PG_URL".to_string(),
        "postgres://owner@db/rivet_memory".to_string(),
    );
    env.insert(
        "RIVETOS_SHARED_DIR".to_string(),
        dir.to_string_lossy().into_owned(),
    );
    let config = GatewayConfig::from_env(&env);
    let registry = config.users_registry.unwrap();
    assert!(!registry.unmapped_is_owner);
    match resolve_user(&registry, Some("win-coco")) {
        ResolveUserResult::Ok(ctx) => assert_eq!(ctx.user_id, "coco"),
        ResolveUserResult::Err(err) => panic!("{err}"),
    }
    assert!(registry.users.get("mallory").is_none());
    assert!(matches!(
        resolve_user(&registry, Some("stranger")),
        ResolveUserResult::Err(_)
    ));

    let noroute = scratch("cfg-noroute");
    let mut env = BTreeMap::new();
    env.insert(
        "RIVETOS_SHARED_DIR".to_string(),
        noroute.to_string_lossy().into_owned(),
    );
    env.insert(
        "RIVETOS_USERS_FILE".to_string(),
        noroute.join("missing.json").to_string_lossy().into_owned(),
    );
    env.insert(
        "RIVETOS_USER_DBS".to_string(),
        r#"{"coco":{"pgUrl":"postgres://coco@db/coco_memory"}}"#.to_string(),
    );
    env.insert(
        "RIVETOS_DEN_DEVICE_USERS".to_string(),
        r#"{"win-coco":"coco"}"#.to_string(),
    );
    env.insert(
        "RIVETOS_PG_URL".to_string(),
        "postgres://owner@db/rivet_memory".to_string(),
    );
    let config = GatewayConfig::from_env(&env);
    let registry = config.users_registry.unwrap();
    assert!(registry.users.get("coco").is_none());
    assert!(matches!(
        resolve_user(&registry, Some("win-coco")),
        ResolveUserResult::Err(_)
    ));
    assert!(matches!(
        resolve_user(&registry, None),
        ResolveUserResult::Ok(_)
    ));

    let mut named = BTreeMap::new();
    named.insert(
        "RIVETOS_DEN_NODE_NAME".to_string(),
        " from-name ".to_string(),
    );
    named.insert("RIVETOS_DEN_NODE_ID".to_string(), "from-id".to_string());
    named.insert(
        "RIVETOS_SHARED_DIR".to_string(),
        scratch("name").to_string_lossy().into_owned(),
    );
    named.insert("RIVETOS_DEN_FILES_ROOT".to_string(), String::new());
    assert_eq!(GatewayConfig::from_env(&named).node_name, "from-name");
    let mut id_only = BTreeMap::new();
    id_only.insert("RIVETOS_DEN_NODE_ID".to_string(), " from-id ".to_string());
    id_only.insert(
        "RIVETOS_SHARED_DIR".to_string(),
        scratch("id").to_string_lossy().into_owned(),
    );
    id_only.insert("RIVETOS_DEN_FILES_ROOT".to_string(), String::new());
    assert_eq!(GatewayConfig::from_env(&id_only).node_name, "from-id");
    let mut blank = BTreeMap::new();
    blank.insert("RIVETOS_DEN_NODE_NAME".to_string(), "   ".to_string());
    blank.insert("RIVETOS_DEN_NODE_ID".to_string(), "from-id".to_string());
    blank.insert(
        "RIVETOS_SHARED_DIR".to_string(),
        scratch("blank").to_string_lossy().into_owned(),
    );
    blank.insert("RIVETOS_DEN_FILES_ROOT".to_string(), String::new());
    assert_eq!(GatewayConfig::from_env(&blank).node_name, "from-id");
    let mut empty = BTreeMap::new();
    empty.insert(
        "RIVETOS_SHARED_DIR".to_string(),
        scratch("host").to_string_lossy().into_owned(),
    );
    empty.insert("RIVETOS_DEN_FILES_ROOT".to_string(), String::new());
    let host = hostname::get().unwrap().to_string_lossy().into_owned();
    assert_eq!(GatewayConfig::from_env(&empty).node_name, host);
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    assert_eq!(
        GatewayConfig::from_env(&empty).agents_dir,
        format!("{home}/.rivetos/agents")
    );
    let mut agents = empty.clone();
    agents.insert(
        "RIVETOS_DEN_AGENTS_DIR".to_string(),
        "  /var/lib/rivetos/agents  ".to_string(),
    );
    assert_eq!(
        GatewayConfig::from_env(&agents).agents_dir,
        "/var/lib/rivetos/agents"
    );
    let mut blank_agents = empty.clone();
    blank_agents.insert("RIVETOS_DEN_AGENTS_DIR".to_string(), "   ".to_string());
    assert_eq!(
        GatewayConfig::from_env(&blank_agents).agents_dir,
        format!("{home}/.rivetos/agents")
    );
}

#[test]
fn term_mux_probes_the_pinned_herdr() {
    let home = scratch("herdr");
    let mut env = isolated(&home);
    env.insert("RIVETOS_DEN_TERM".to_string(), "1".to_string());
    assert!(GatewayConfig::from_env(&env).term.mux.is_none());
    let bin_dir = home.join(".local").join("bin");
    std::fs::create_dir_all(&bin_dir).unwrap();
    let bin = bin_dir.join("herdr");
    std::fs::write(&bin, "#!/bin/sh\necho herdr 0.8.2\n").unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(GatewayConfig::from_env(&env).term.mux, Some(TermMux::Herdr));
    std::fs::write(&bin, "#!/bin/sh\necho herdr 0.9.0\n").unwrap();
    assert!(GatewayConfig::from_env(&env).term.mux.is_none());
    let mut explicit = env.clone();
    explicit.insert("RIVETOS_DEN_TERM_MUX".to_string(), "tmux".to_string());
    std::fs::write(&bin, "#!/bin/sh\necho herdr 0.8.2\n").unwrap();
    assert_eq!(
        GatewayConfig::from_env(&explicit).term.mux,
        Some(TermMux::Tmux)
    );
    explicit.insert("RIVETOS_DEN_TERM_MUX".to_string(), "none".to_string());
    assert_eq!(
        GatewayConfig::from_env(&explicit).term.mux,
        Some(TermMux::None)
    );
    explicit.insert("RIVETOS_DEN_TERM_MUX".to_string(), "zellij".to_string());
    assert_eq!(
        GatewayConfig::from_env(&explicit).term.mux,
        Some(TermMux::None)
    );
    let mut off = isolated(&home);
    assert!(GatewayConfig::from_env(&off).term.mux.is_none());
    off.insert("RIVETOS_DEN_TERM".to_string(), "0".to_string());
    assert!(GatewayConfig::from_env(&off).term.mux.is_none());
}

#[test]
fn session_owners_match_the_typescript_cases() {
    let dir = scratch("owners");
    let file = dir.join("state").join("session-owners.json");
    let owners = SessionOwners::load(file.to_string_lossy().as_ref());
    let coco = user("coco", false);
    let owner = user("owner", true);
    assert!(owners.visible("dead-owner-session", &owner, None));
    assert!(!owners.visible("dead-owner-session", &coco, None));

    let mut owners = SessionOwners::load(file.to_string_lossy().as_ref());
    owners.set("abc", "coco");
    let saved: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(saved, serde_json::json!({"abc": "coco"}));
    let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    let reloaded = SessionOwners::load(file.to_string_lossy().as_ref());
    assert!(reloaded.visible("abc", &coco, None));
    assert!(!reloaded.visible("abc", &owner, None));

    let mut owners = SessionOwners::load(
        dir.join("state")
            .join("nested.json")
            .to_string_lossy()
            .as_ref(),
    );
    owners.set("parent", "coco");
    assert!(owners.visible("child", &coco, Some("parent")));
    assert!(!owners.visible("child", &owner, Some("parent")));
    assert!(owners.visible("child", &owner, Some("untagged-parent")));
    assert!(!owners.visible("child", &coco, Some("untagged-parent")));
    assert!(owners.inherit("child", Some("parent")));
    assert_eq!(owners.get("child"), Some("coco"));
    assert!(!owners.inherit("child", Some("someone-else")));
    assert_eq!(owners.get("child"), Some("coco"));
    let rows = [("child", Some("parent"))];
    let kept: Vec<&str> = rows
        .iter()
        .filter(|(id, parent)| owners.visible(id, &coco, *parent))
        .map(|(id, _)| *id)
        .collect();
    assert_eq!(kept, vec!["child"]);
    assert!(
        rows.iter()
            .all(|(id, parent)| !owners.visible(id, &owner, *parent))
    );
}

#[test]
fn identity_capture_and_tokens_match_the_typescript_cases() {
    let _guard = token_lock_blocking();
    clear_user_tokens();
    let mut devices = BTreeMap::new();
    devices.insert("win-coco".to_string(), "coco".to_string());
    let mut dbs = BTreeMap::new();
    dbs.insert(
        "coco".to_string(),
        UserDbEntry {
            pg_url: "postgres://coco@db/coco_memory".to_string(),
            env_file: Some("/tmp/coco.env".to_string()),
        },
    );
    let registry = registry_from_env(
        Some(&devices),
        Some(&dbs),
        Some("postgres://owner@db/rivet_memory"),
        None,
    )
    .unwrap();
    match resolve_user(&registry, None) {
        ResolveUserResult::Ok(ctx) => assert!(capture_env_for(Some(&ctx)).unwrap().is_none()),
        ResolveUserResult::Err(err) => panic!("{err}"),
    }
    match resolve_user(&registry, Some("win-coco")) {
        ResolveUserResult::Ok(ctx) => {
            let env = capture_env_for(Some(&ctx)).unwrap().unwrap();
            assert_eq!(env.get("RIVETOS_USER_ID").map(String::as_str), Some("coco"));
            assert_eq!(
                env.get("RIVETOS_PG_URL").map(String::as_str),
                Some("postgres://coco@db/coco_memory")
            );
            assert_eq!(
                env.get("RIVETOS_ENV_FILE").map(String::as_str),
                Some("/tmp/coco.env")
            );
            assert!(!env.contains_key("RIVETOS_USER_DBS"));
        }
        ResolveUserResult::Err(err) => panic!("{err}"),
    }

    clear_user_tokens();
    let mut registry = parse_users_registry(Some(
        r#"{"ownerUserId":"alice","unmappedIsOwner":false,"users":{"alice":{"devices":[]},"guest":{"devices":["dev1"]}}}"#,
    ))
    .unwrap();
    registry.local_stores = true;
    match resolve_user_by_id(&registry, "guest") {
        ResolveUserResult::Ok(ctx) => {
            let env = capture_env_for(Some(&ctx)).unwrap().unwrap();
            let token = mint_user_token("guest").unwrap();
            assert_eq!(
                env.get("RIVETOS_USER_ID").map(String::as_str),
                Some("guest")
            );
            assert_eq!(
                env.get("RIVETOS_USER_TOKEN").map(String::as_str),
                Some(token.as_str())
            );
            assert!(!env.contains_key("RIVETOS_PG_URL"));
        }
        ResolveUserResult::Err(err) => panic!("{err}"),
    }
    clear_user_tokens();
    let token = mint_user_token("guest").unwrap();
    let with_token = RequestIdentity {
        remote_address: "127.0.0.1".to_string(),
        headers: HeaderMap::from([(
            "x-rivetos-user-token".to_string(),
            HeaderVal::One(token.clone()),
        )]),
        device_id: None,
    };
    match resolve_request_user(&registry, &with_token) {
        ResolveUserResult::Ok(ctx) => {
            assert_eq!(ctx.user_id, "guest");
            assert!(!ctx.is_owner);
        }
        ResolveUserResult::Err(err) => panic!("{err}"),
    }
    let owner_req = RequestIdentity {
        remote_address: "127.0.0.1".to_string(),
        headers: HeaderMap::new(),
        device_id: None,
    };
    match resolve_request_user(&registry, &owner_req) {
        ResolveUserResult::Ok(ctx) => {
            assert_eq!(ctx.user_id, "alice");
            assert!(ctx.is_owner);
        }
        ResolveUserResult::Err(err) => panic!("{err}"),
    }
    let many = RequestIdentity {
        remote_address: "127.0.0.1".to_string(),
        headers: HeaderMap::from([(
            "x-rivetos-user-token".to_string(),
            HeaderVal::Many(vec![token.clone(), token.clone()]),
        )]),
        device_id: None,
    };
    let remote = RequestIdentity {
        remote_address: "198.51.100.7".to_string(),
        headers: HeaderMap::from([(
            "x-rivetos-user-token".to_string(),
            HeaderVal::One(token.clone()),
        )]),
        device_id: None,
    };
    let empty = RequestIdentity {
        remote_address: "127.0.0.1".to_string(),
        headers: HeaderMap::from([(
            "x-rivetos-user-token".to_string(),
            HeaderVal::One(String::new()),
        )]),
        device_id: None,
    };
    let unknown = RequestIdentity {
        remote_address: "127.0.0.1".to_string(),
        headers: HeaderMap::from([(
            "x-rivetos-user-token".to_string(),
            HeaderVal::One("not-a-token-this-node-minted".to_string()),
        )]),
        device_id: None,
    };
    for req in [&many, &remote, &empty, &unknown] {
        assert!(matches!(
            resolve_request_user(&registry, req),
            ResolveUserResult::Err(_)
        ));
    }
    clear_user_tokens();
    let stale_req = RequestIdentity {
        remote_address: "127.0.0.1".to_string(),
        headers: HeaderMap::from([("x-rivetos-user-token".to_string(), HeaderVal::One(token))]),
        device_id: None,
    };
    assert!(matches!(
        resolve_request_user(&registry, &stale_req),
        ResolveUserResult::Err(_)
    ));
    let stale = mint_user_token("visitor").unwrap();
    let visitor = RequestIdentity {
        remote_address: "127.0.0.1".to_string(),
        headers: HeaderMap::from([("x-rivetos-user-token".to_string(), HeaderVal::One(stale))]),
        device_id: None,
    };
    assert!(matches!(
        resolve_request_user(&registry, &visitor),
        ResolveUserResult::Err(_)
    ));
    clear_user_tokens();
    let mut stamped = RequestIdentity {
        remote_address: "127.0.0.1".to_string(),
        headers: HeaderMap::from([
            (
                "x-rivetos-user-token".to_string(),
                HeaderVal::One(mint_user_token("guest").unwrap()),
            ),
            (
                "x-rivetos-user".to_string(),
                HeaderVal::One("alice".to_string()),
            ),
        ]),
        device_id: None,
    };
    match resolve_request_user(&registry, &stamped) {
        ResolveUserResult::Ok(ctx) => {
            stamp_user_header(&mut stamped, Some(&ctx));
            assert_eq!(
                stamped.headers.get("x-rivetos-user"),
                Some(&HeaderVal::One("guest".to_string()))
            );
            assert!(!stamped.headers.contains_key("x-rivetos-user-token"));
        }
        ResolveUserResult::Err(err) => panic!("{err}"),
    }
}

#[test]
fn session_keys_and_ints() {
    assert_eq!(den_join_key("hermes:ops"), "ops");
    assert_eq!(
        den_join_key("11111111-2222-4333-8444-555555555555"),
        "11111111-2222-4333-8444-555555555555"
    );
    assert_eq!(den_join_key(" task:1"), " task:1");
    assert_eq!(parse_int_js("10abc"), Some(10));
    assert_eq!(parse_int_js("  -12x"), Some(-12));
    let env = BTreeMap::from([("N".to_string(), String::new())]);
    assert_eq!(int_env(&env, "N", 7), 7);
    assert_eq!(int_env(&env, "MISSING", 7), 7);
}

#[test]
fn http_target_keeps_percent_encoding() {
    assert_eq!(split_target("/heal%74hz").0, "/heal%74hz");
    assert_eq!(split_target("/healthz/").0, "/healthz/");
    assert_eq!(split_target("/files/").0, "/files/");
    assert_eq!(split_target("/a/./b/../c").0, "/a/c");
    assert_eq!(split_target("/../../etc/passwd").0, "/etc/passwd");
    assert_eq!(split_target("//healthz").0, "/");
    assert_eq!(split_target("*").0, "/*");
    assert_eq!(percent_decode("a+b%2F"), "a b/");
    assert!(percent_decode_strict("a+b").is_ok());
    assert_eq!(percent_decode_strict("a+b").unwrap(), "a+b");
    assert!(percent_decode_strict("%").is_err());
    assert!(ws_accept_matches_tungstenite("dGhlIHNhbXBsZSBub25jZQ=="));
    let (path, query) = split_target("/state?session=a&session=b");
    assert_eq!(path, "/state");
    assert_eq!(query[0].1, "a");
}

#[test]
fn mesh_reader_matches_the_typescript_cases() {
    let dir = scratch("mesh");
    let home = dir.to_string_lossy().into_owned();
    let shared = dir.join("shared").to_string_lossy().into_owned();
    assert_eq!(
        mesh_file_paths("", &shared, &home),
        vec![
            format!("{shared}/mesh.json"),
            format!("{home}/.rivetos/mesh.json"),
        ]
    );
    assert_eq!(
        mesh_file_paths("/x/mesh.json", &shared, &home),
        vec!["/x/mesh.json".to_string()]
    );
    let b = dir.join("b.json");
    let a = dir.join("a.json");
    std::fs::write(&b, r#"{"version":1,"updatedAt":22,"nodes":{}}"#).unwrap();
    let loaded = load_mesh_file(
        &[
            a.to_string_lossy().into_owned(),
            b.to_string_lossy().into_owned(),
        ],
        &shared,
    )
    .unwrap()
    .unwrap();
    assert_eq!(loaded.updated_at, 22.0);
    std::fs::write(&a, r#"{"version":1,"updatedAt":11,"nodes":{}}"#).unwrap();
    let loaded = load_mesh_file(
        &[
            a.to_string_lossy().into_owned(),
            b.to_string_lossy().into_owned(),
        ],
        &shared,
    )
    .unwrap()
    .unwrap();
    assert_eq!(loaded.updated_at, 11.0);
    assert!(
        load_mesh_file(
            &[dir.join("nope.json").to_string_lossy().into_owned()],
            &shared
        )
        .unwrap()
        .is_none()
    );

    let flat = dir.join("flat.json");
    std::fs::write(
        &flat,
        r#"{"nodes":[{"name":"legacy-node","ip":"192.0.2.1"}],"updatedAt":99}"#,
    )
    .unwrap();
    let err = load_mesh_file(&[flat.to_string_lossy().into_owned()], &shared).unwrap_err();
    assert_eq!(err.code, "MESH_FLAT_ARRAY");
    assert!(err.message.contains("pre-capabilities flat-array"));

    let mixed = dir.join("mixed.json");
    std::fs::write(
        &mixed,
        r#"{"version":1,"updatedAt":1234,"nodes":{"good":{"id":"good","name":"good","host":"192.0.2.10","port":3000,"agents":[],"providers":[],"capabilities":[],"status":"online"},"bad":{"host":"h","port":"3100"}}}"#,
    )
    .unwrap();
    let (file, logs) = capturing_mesh_logs(|| {
        load_mesh_file(&[mixed.to_string_lossy().into_owned()], &shared).unwrap()
    });
    let file = file.unwrap();
    assert_eq!(file.nodes.len(), 1);
    assert_eq!(file.nodes[0].0, "good");
    assert!(logs.iter().any(|line| line.contains("\"bad\"")));

    let roster_path = dir.join("roster.json");
    std::fs::write(
        &roster_path,
        r#"{"version":1,"updatedAt":1,"nodes":{"plain":{"id":"plain","host":"192.0.2.10","port":3000,"capabilities":[]},"tls":{"id":"tls","host":"192.0.2.10","metadata":{"denUrl":"https://tls.example:5174/"}},"port":{"id":"port","host":"192.0.2.20","metadata":{"denPort":5175}},"tag":{"id":"tag","host":"192.0.2.30","capabilities":["den"]},"evil":{"id":"evil","host":"192.0.2.9","metadata":{"denUrl":"ftp://192.0.2.9/pub"}}}}"#,
    )
    .unwrap();
    let roster = load_mesh_file(&[roster_path.to_string_lossy().into_owned()], &shared)
        .unwrap()
        .unwrap();
    let mut origins = mesh_den_origins(&roster);
    origins.sort();
    let mut expected = vec![
        "https://tls.example:5174".to_string(),
        "http://192.0.2.20:5175".to_string(),
        "https://192.0.2.20:5175".to_string(),
        "http://192.0.2.30:5174".to_string(),
        "https://192.0.2.30:5174".to_string(),
    ];
    expected.sort();
    assert_eq!(origins, expected);
    let node = MeshNode {
        id: "node-g".to_string(),
        name: "node-g".to_string(),
        host: "192.0.2.116".to_string(),
        port: 3000.0,
        capabilities: Vec::new(),
        metadata: serde_json::Map::new(),
        ssh_user: Some("user".to_string()),
    };
    let file = crate::mesh_view::MeshFile {
        updated_at: 1.0,
        nodes: vec![("node-g".to_string(), node)],
    };
    let ident = local_mesh_identity(Some(&file), "node-g", "box");
    assert_eq!(ident.host, "192.0.2.116");
    assert_eq!(ident.ssh_user, "user");
    let missing = local_mesh_identity(None, "node-g", "box");
    assert_eq!(missing.host, "box");
    assert_eq!(missing.ssh_user, "rivet");
    let alias = MeshNode {
        id: "node-g".to_string(),
        name: "alias".to_string(),
        host: "192.0.2.10".to_string(),
        port: 1.0,
        capabilities: Vec::new(),
        metadata: serde_json::Map::new(),
        ssh_user: Some("rivet".to_string()),
    };
    let aliased = crate::mesh_view::MeshFile {
        updated_at: 1.0,
        nodes: vec![("alias".to_string(), alias)],
    };
    let ident = local_mesh_identity(Some(&aliased), "node-g", "box");
    assert_eq!(ident.host, "192.0.2.10");
}

#[test]
fn security_refusal_strings() {
    let dir = scratch("sec");
    let mut env = isolated(&dir);
    env.insert("RIVETOS_DEN_HOST".to_string(), "192.0.2.10".to_string());
    env.insert("RIVETOS_DEN_TERM".to_string(), "1".to_string());
    env.insert("RIVETOS_DEN_AUDIO".to_string(), "1".to_string());
    env.insert(
        "RIVETOS_DEN_FILES_ROOT".to_string(),
        "/var/files".to_string(),
    );
    let config = GatewayConfig::from_env(&env);
    let lines = security_lines(&config);
    assert_eq!(lines.len(), 3);
    assert!(lines[0].contains("refusing to enable terminals"));
    assert!(lines[1].contains("refusing to enable MicBridge"));
    assert!(lines[2].contains("refusing to enable /api/files"));
    let refusal = bind_refusal(&config).unwrap();
    assert!(refusal.contains("refusing to bind 192.0.2.10"));
    assert!(refusal.contains("RIVETOS_DEN_TLS_CERT"));
}

#[test]
fn mesh_shape_log_is_twelve_node_lines() {
    let dir = scratch("mesh-log");
    let mesh = dir.join("mesh.json");
    let shared = dir.join("shared");
    let repo = crate::standard_helpers::repo_root();
    assert!(
        std::path::Path::new(&repo)
            .join("packages")
            .join("types")
            .is_dir()
    );
    let path = mesh.to_string_lossy().into_owned();
    let shared_s = shared.to_string_lossy().into_owned();
    std::fs::write(&mesh, "[]\n").unwrap();
    let err = load_mesh_file(std::slice::from_ref(&path), &shared_s).unwrap_err();
    assert_eq!(err.code, "MESH_INVALID_SHAPE");
    assert_eq!(err.line, 216);
    assert_node_mesh_log(&err.log_block(), &repo, 216, "MESH_INVALID_SHAPE", &path);

    std::fs::write(&mesh, "{\"nodes\":[]}\n").unwrap();
    let err = load_mesh_file(std::slice::from_ref(&path), &shared_s).unwrap_err();
    assert_eq!(err.code, "MESH_FLAT_ARRAY");
    assert_eq!(err.line, 221);
    let live = shared.join("mesh.json");
    assert!(err.message.contains(live.to_string_lossy().as_ref()));
    assert_node_mesh_log(&err.log_block(), &repo, 221, "MESH_FLAT_ARRAY", &path);

    std::fs::write(&mesh, "{\"version\":1,\"nodes\":5}\n").unwrap();
    let err = load_mesh_file(std::slice::from_ref(&path), &shared_s).unwrap_err();
    assert_eq!(err.code, "MESH_INVALID_SHAPE");
    assert_eq!(err.line, 224);
    assert!(
        err.message
            .contains("nodes must be an object keyed by node id")
    );
    assert_node_mesh_log(&err.log_block(), &repo, 224, "MESH_INVALID_SHAPE", &path);
}

#[test]
fn gateway_args_reject_unknown_flags() {
    use clap::{Parser, Subcommand};

    #[derive(Parser)]
    #[command(name = "rivetos")]
    struct Cli {
        #[command(subcommand)]
        command: Cmd,
    }

    #[derive(Subcommand)]
    enum Cmd {
        #[command(about = "Serve the den gateway on HTTP and WebSocket")]
        Gateway(crate::cli::GatewayArgs),
    }

    assert!(Cli::try_parse_from(["rivetos", "gateway"]).is_ok());
    assert!(Cli::try_parse_from(["rivetos", "gateway", "--bogus"]).is_err());
}

fn assert_node_mesh_log(block: &str, repo: &str, line: u32, code: &str, path: &str) {
    let types_mesh = ["packages", "types", "dist", "mesh.js"].join("/");
    let den_mesh = ["services", "den-server", "dist", "mesh.js"].join("/");
    let lines: Vec<&str> = block.split('\n').collect();
    assert_eq!(lines.len(), 12, "{block}");
    assert!(lines[0].starts_with("mesh.json parse failed: MeshParseError: "));
    assert_eq!(
        lines[1],
        format!("    at assertRecordMeshFile ({repo}/{types_mesh}:{line}:15)")
    );
    assert_eq!(
        lines[2],
        format!("    at parseMeshFile ({repo}/{types_mesh}:272:12)")
    );
    assert_eq!(
        lines[3],
        format!("    at loadMeshFile (file://{repo}/{den_mesh}:60:20)")
    );
    assert_eq!(
        lines[4],
        format!("    at async build (file://{repo}/{den_mesh}:192:22) {{")
    );
    assert_eq!(lines[5], format!("  code: '{code}',"));
    assert_eq!(lines[6], "  severity: 'fatal',");
    assert_eq!(lines[7], format!("  context: {{ path: '{path}' }},"));
    assert_eq!(lines[8], "  retryable: false,");
    let stamp = lines[9]
        .strip_prefix("  timestamp: ")
        .and_then(|rest| rest.strip_suffix(','))
        .unwrap_or("");
    assert!(!stamp.is_empty() && stamp.chars().all(|ch| ch.is_ascii_digit()));
    assert_eq!(lines[10], format!("  path: '{path}'"));
    assert_eq!(lines[11], "}");
}
