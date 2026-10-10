use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use identity::{
    capture_env_for, clear_user_tokens, is_safe_user_id, is_usable_user_db, load_users_registry,
    merge_user_dbs, mint_user_token, parse_users_registry, registry_from_env, resolve_request_user,
    resolve_user, resolve_user_by_id, routed_user_result, session_visible_to, stamp_user_header,
    user_dbs_from_registry, user_for_token, HeaderVal, LoadOptions, RequestIdentity,
    ResolveUserResult, RoutedUser, UserContext, UserDbEntry, UserRecord, UsersRegistry,
    USER_TOKEN_HEADER,
};
use indexmap::IndexMap;
use serde_json::json;

fn coco_db() -> UserDbEntry {
    UserDbEntry {
        pg_url: "postgres://coco@db/coco_memory".to_string(),
        env_file: None,
    }
}

fn owner_db() -> UserDbEntry {
    UserDbEntry {
        pg_url: "postgres://owner@db/rivet_memory".to_string(),
        env_file: None,
    }
}

fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect()
}

fn temp_dir() -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "rr2a-users-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}

#[test]
fn parse_strips_device_prefix() {
    let reg = parse_users_registry(Some(
        &json!({
            "ownerUserId": "owner",
            "unmappedIsOwner": false,
            "users": {
                "owner": { "devices": ["pixel-owner"], "pgUrl": owner_db().pg_url, "persona": "owner" },
                "coco": { "devices": ["device:win-coco"], "pgUrl": coco_db().pg_url, "persona": "coco" }
            }
        })
        .to_string(),
    ))
    .expect("registry");
    assert_eq!(reg.owner_user_id, "owner");
    assert!(!reg.unmapped_is_owner);
    assert_eq!(reg.users["coco"].devices, vec!["win-coco".to_string()]);
    assert_eq!(reg.users["coco"].db, Some(coco_db()));
}

#[test]
fn parse_rejects_malformed() {
    assert!(parse_users_registry(Some("{nope")).is_none());
    assert!(parse_users_registry(Some("[]")).is_none());
    assert!(parse_users_registry(Some(r#"{"users":{}}"#)).is_none());
}

#[test]
fn registry_from_env_synthesizes_owner() {
    let mut devices = BTreeMap::new();
    devices.insert("win-coco".to_string(), "coco".to_string());
    let mut dbs = BTreeMap::new();
    dbs.insert("coco".to_string(), coco_db());
    let reg = registry_from_env(Some(&devices), Some(&dbs), Some(&owner_db().pg_url), Some("owner"))
        .expect("reg");
    assert!(reg.unmapped_is_owner);
    assert_eq!(reg.users["coco"].devices, vec!["win-coco".to_string()]);
    assert_eq!(reg.users["coco"].db, Some(coco_db()));
    assert_eq!(reg.users["owner"].db, Some(owner_db()));
}

fn closed_reg() -> UsersRegistry {
    let parsed = parse_users_registry(Some(
        &json!({
            "ownerUserId": "owner",
            "unmappedIsOwner": false,
            "users": {
                "owner": { "devices": ["pixel-owner"], "persona": "owner" },
                "coco": { "devices": ["win-coco"], "persona": "coco" }
            }
        })
        .to_string(),
    ))
    .expect("parsed");
    let mut dbs = BTreeMap::new();
    dbs.insert("coco".to_string(), coco_db());
    merge_user_dbs(parsed, Some(&dbs), Some(&owner_db().pg_url))
}

#[test]
fn resolve_loopback_owner() {
    let r = resolve_user(&closed_reg(), None);
    let ResolveUserResult::Ok(ctx) = r else {
        panic!("expected owner");
    };
    assert_eq!(ctx.user_id, "owner");
    assert!(ctx.is_owner);
    assert!(ctx.device_id.is_none());
}

#[test]
fn resolve_mapped_device() {
    let r = resolve_user(&closed_reg(), Some("win-coco"));
    let ResolveUserResult::Ok(ctx) = r else {
        panic!("expected coco");
    };
    assert_eq!(ctx.user_id, "coco");
    assert!(!ctx.is_owner);
    assert_eq!(ctx.db, coco_db());
}

#[test]
fn resolve_unknown_device_fails_closed() {
    let r = resolve_user(&closed_reg(), Some("stranger"));
    let ResolveUserResult::Err(err) = r else {
        panic!("expected error");
    };
    assert!(err.contains("not in the users registry"));
}

#[test]
fn resolve_mapped_without_db_fails() {
    let broken = parse_users_registry(Some(
        &json!({
            "ownerUserId": "owner",
            "unmappedIsOwner": false,
            "users": {
                "owner": { "devices": [], "pgUrl": owner_db().pg_url },
                "coco": { "devices": ["win-coco"] }
            }
        })
        .to_string(),
    ))
    .expect("parsed");
    let r = resolve_user(&broken, Some("win-coco"));
    let ResolveUserResult::Err(err) = r else {
        panic!("expected error");
    };
    assert!(err.contains("no usable database"));
}

#[test]
fn env_bootstrap_unmapped_is_owner() {
    let mut devices = BTreeMap::new();
    devices.insert("win-coco".to_string(), "coco".to_string());
    let mut dbs = BTreeMap::new();
    dbs.insert("coco".to_string(), coco_db());
    let reg = registry_from_env(Some(&devices), Some(&dbs), Some(&owner_db().pg_url), None)
        .expect("reg");
    let r = resolve_user(&reg, Some("pixel-owner"));
    let ResolveUserResult::Ok(ctx) = r else {
        panic!("expected owner");
    };
    assert_eq!(ctx.user_id, "owner");
    assert!(ctx.is_owner);
}

#[test]
fn load_explicit_fills_owner_pg() {
    let dir = temp_dir();
    let file = dir.join("users.json");
    fs::write(
        &file,
        json!({
            "ownerUserId": "owner",
            "unmappedIsOwner": false,
            "users": {
                "owner": { "devices": [] },
                "coco": { "devices": ["win-coco"], "pgUrl": coco_db().pg_url }
            }
        })
        .to_string(),
    )
    .expect("write");
    let path = file.to_string_lossy().to_string();
    let home = dir.to_string_lossy().to_string();
    let reg = load_users_registry(
        &env(&[("RIVETOS_PG_URL", &owner_db().pg_url)]),
        LoadOptions {
            path: Some(&path),
            read_file: None,
            homedir: Some(&|| home.clone()),
        },
    )
    .expect("reg");
    assert_eq!(reg.users["owner"].db, Some(owner_db()));
    assert_eq!(reg.users["coco"].db, Some(coco_db()));
    let ResolveUserResult::Ok(ctx) = resolve_user(&reg, Some("win-coco")) else {
        panic!("coco");
    };
    assert_eq!(ctx.user_id, "coco");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn load_shared_file() {
    let dir = temp_dir();
    fs::create_dir_all(dir.join("rivetos")).expect("dir");
    fs::write(
        dir.join("rivetos/users.json"),
        json!({
            "ownerUserId": "owner",
            "unmappedIsOwner": false,
            "users": {
                "owner": { "devices": [], "pgUrl": owner_db().pg_url },
                "coco": { "devices": ["win-coco"], "pgUrl": coco_db().pg_url }
            }
        })
        .to_string(),
    )
    .expect("write");
    let shared = dir.to_string_lossy().to_string();
    let home = dir.join("no-home").to_string_lossy().to_string();
    let reg = load_users_registry(
        &env(&[("RIVETOS_SHARED_DIR", &shared)]),
        LoadOptions {
            path: None,
            read_file: None,
            homedir: Some(&|| home.clone()),
        },
    )
    .expect("reg");
    assert!(matches!(resolve_user(&reg, Some("win-coco")), ResolveUserResult::Ok(_)));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn invalid_shared_file_fails_closed() {
    let dir = temp_dir();
    fs::create_dir_all(dir.join("rivetos")).expect("dir");
    fs::write(dir.join("rivetos/users.json"), "{nope").expect("write");
    let home = dir.join("home");
    fs::create_dir_all(home.join(".rivetos")).expect("home");
    fs::write(
        home.join(".rivetos/users.json"),
        json!({
            "ownerUserId": "owner",
            "unmappedIsOwner": false,
            "users": {
                "owner": { "devices": [], "pgUrl": owner_db().pg_url },
                "coco": { "devices": ["win-coco"], "pgUrl": coco_db().pg_url }
            }
        })
        .to_string(),
    )
    .expect("write");
    let shared = dir.to_string_lossy().to_string();
    let home_s = home.to_string_lossy().to_string();
    let reg = load_users_registry(
        &env(&[
            ("RIVETOS_SHARED_DIR", &shared),
            ("RIVETOS_PG_URL", &owner_db().pg_url),
        ]),
        LoadOptions {
            path: None,
            read_file: None,
            homedir: Some(&|| home_s.clone()),
        },
    )
    .expect("reg");
    assert!(!reg.unmapped_is_owner);
    assert!(reg.users.get("coco").is_none());
    assert!(matches!(resolve_user(&reg, Some("win-coco")), ResolveUserResult::Err(_)));
    assert!(matches!(resolve_user(&reg, None), ResolveUserResult::Ok(_)));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn absent_shared_falls_through_home() {
    let dir = temp_dir();
    let home = dir.join("home");
    fs::create_dir_all(home.join(".rivetos")).expect("home");
    fs::write(
        home.join(".rivetos/users.json"),
        json!({
            "ownerUserId": "owner",
            "unmappedIsOwner": false,
            "users": {
                "owner": { "devices": [], "pgUrl": owner_db().pg_url },
                "coco": { "devices": ["win-coco"], "pgUrl": coco_db().pg_url }
            }
        })
        .to_string(),
    )
    .expect("write");
    let shared = dir.to_string_lossy().to_string();
    let home_s = home.to_string_lossy().to_string();
    let reg = load_users_registry(
        &env(&[("RIVETOS_SHARED_DIR", &shared)]),
        LoadOptions {
            path: None,
            read_file: None,
            homedir: Some(&|| home_s.clone()),
        },
    )
    .expect("reg");
    assert!(matches!(resolve_user(&reg, Some("win-coco")), ResolveUserResult::Ok(_)));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn missing_explicit_file_fails_closed() {
    let dir = temp_dir();
    let missing = dir.join("missing.json").to_string_lossy().to_string();
    let home = dir.to_string_lossy().to_string();
    let reg = load_users_registry(
        &env(&[
            ("RIVETOS_USERS_FILE", &missing),
            ("RIVETOS_PG_URL", &owner_db().pg_url),
        ]),
        LoadOptions {
            path: None,
            read_file: None,
            homedir: Some(&|| home.clone()),
        },
    )
    .expect("reg");
    assert!(!reg.unmapped_is_owner);
    assert!(matches!(resolve_user(&reg, Some("win-coco")), ResolveUserResult::Err(_)));
    assert!(matches!(resolve_user(&reg, None), ResolveUserResult::Ok(_)));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn env_maps_do_not_synthesize_registry() {
    let dir = temp_dir();
    let shared = dir.to_string_lossy().to_string();
    let home = dir.to_string_lossy().to_string();
    let reg = load_users_registry(
        &env(&[
            ("RIVETOS_USER_DBS", r#"{"coco":{"pgUrl":"postgres://coco@db/coco_memory"}}"#),
            ("RIVETOS_DEN_DEVICE_USERS", r#"{"win-coco":"coco"}"#),
            ("RIVETOS_PG_URL", &owner_db().pg_url),
            ("RIVETOS_SHARED_DIR", &shared),
        ]),
        LoadOptions {
            path: None,
            read_file: None,
            homedir: Some(&|| home.clone()),
        },
    );
    assert!(reg.is_none());
    assert!(user_dbs_from_registry(reg.as_ref()).is_none());
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn user_dbs_omit_owner_and_unusable() {
    let reg = parse_users_registry(Some(
        &json!({
            "ownerUserId": "owner",
            "unmappedIsOwner": false,
            "users": {
                "owner": { "devices": [], "pgUrl": owner_db().pg_url },
                "coco": { "devices": ["win-coco"], "pgUrl": coco_db().pg_url },
                "ghost": { "devices": ["win-ghost"] }
            }
        })
        .to_string(),
    ));
    let dbs = user_dbs_from_registry(reg.as_ref()).expect("dbs");
    assert_eq!(dbs.len(), 1);
    assert_eq!(dbs.get("coco"), Some(&coco_db()));
}

#[test]
fn session_visibility() {
    let coco = UserContext {
        user_id: "coco".to_string(),
        device_id: Some("win-coco".to_string()),
        db: coco_db(),
        persona: None,
        is_owner: false,
    };
    let owner = UserContext {
        user_id: "owner".to_string(),
        device_id: None,
        db: owner_db(),
        persona: None,
        is_owner: true,
    };
    assert!(!session_visible_to(None, &coco));
    assert!(session_visible_to(None, &owner));
    assert!(session_visible_to(Some("coco"), &coco));
    assert!(!session_visible_to(Some("coco"), &owner));
    assert!(session_visible_to(Some("owner"), &owner));
}

#[test]
fn local_stores_routes_without_pg_url() {
    let dir = temp_dir();
    let file = dir.join("users.json");
    let doc = json!({
        "ownerUserId": "alice",
        "unmappedIsOwner": false,
        "users": {
            "alice": { "devices": ["desktop-1"] },
            "guest": { "devices": ["phone-2"] }
        }
    });
    fs::write(&file, doc.to_string()).expect("write");
    let path = file.to_string_lossy().to_string();
    let home = dir.to_string_lossy().to_string();
    let refused = load_users_registry(
        &BTreeMap::new(),
        LoadOptions {
            path: Some(&path),
            read_file: None,
            homedir: Some(&|| home.clone()),
        },
    )
    .expect("reg");
    assert!(!refused.local_stores);
    assert_eq!(
        resolve_user(&refused, None),
        ResolveUserResult::Err("owner user \"alice\" has no usable database".to_string())
    );
    assert!(matches!(resolve_user(&refused, Some("phone-2")), ResolveUserResult::Err(_)));
    let local = load_users_registry(
        &env(&[("RIVETOS_USER_STORES", "local")]),
        LoadOptions {
            path: Some(&path),
            read_file: None,
            homedir: Some(&|| home.clone()),
        },
    )
    .expect("local");
    assert!(local.local_stores);
    let ResolveUserResult::Ok(owner) = resolve_user(&local, None) else {
        panic!("owner");
    };
    assert_eq!(owner.user_id, "alice");
    assert!(owner.is_owner);
    assert_eq!(owner.db.pg_url, "");
    let ResolveUserResult::Ok(guest) = resolve_user(&local, Some("device:phone-2")) else {
        panic!("guest");
    };
    assert_eq!(guest.user_id, "guest");
    assert!(!guest.is_owner);
    assert_eq!(guest.db.pg_url, "");
    assert!(matches!(resolve_user(&local, Some("stranger")), ResolveUserResult::Err(_)));
    assert!(user_dbs_from_registry(Some(&local)).is_none());
    let _ = fs::remove_dir_all(&dir);

    let dir = temp_dir();
    let file = dir.join("users.json");
    fs::write(
        &file,
        json!({
            "ownerUserId": "alice",
            "unmappedIsOwner": false,
            "users": {
                "alice": { "devices": ["desktop-1"] },
                "guest": { "devices": ["phone-2"], "pgUrl": "postgres://guest@db/guest_memory" }
            }
        })
        .to_string(),
    )
    .expect("write");
    let path = file.to_string_lossy().to_string();
    let home = dir.to_string_lossy().to_string();
    let reg = load_users_registry(
        &env(&[("RIVETOS_USER_STORES", "local")]),
        LoadOptions {
            path: Some(&path),
            read_file: None,
            homedir: Some(&|| home.clone()),
        },
    )
    .expect("reg");
    let ResolveUserResult::Ok(guest) = resolve_user(&reg, Some("phone-2")) else {
        panic!("guest");
    };
    assert_eq!(guest.db.pg_url, "postgres://guest@db/guest_memory");
    let _ = fs::remove_dir_all(&dir);

    let dir = temp_dir();
    let file = dir.join("users.json");
    fs::write(&file, "{not json").expect("write");
    let path = file.to_string_lossy().to_string();
    let home = dir.to_string_lossy().to_string();
    let reg = load_users_registry(
        &env(&[("RIVETOS_USER_STORES", "local")]),
        LoadOptions {
            path: Some(&path),
            read_file: None,
            homedir: Some(&|| home.clone()),
        },
    )
    .expect("reg");
    assert!(matches!(resolve_user(&reg, None), ResolveUserResult::Ok(_)));
    assert!(matches!(
        resolve_user(&reg, Some("desktop-1")),
        ResolveUserResult::Err(_)
    ));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn usable_user_db_policy() {
    assert!(is_usable_user_db(&json!({"pgUrl": "postgres://db"})));
    assert!(is_usable_user_db(&json!({"pgUrl": " postgres://db ", "envFile": " /tmp/x "})));
    assert!(!is_usable_user_db(&json!({"pgUrl": "  "})));
    assert!(!is_usable_user_db(&json!({"pgUrl": "postgres://db", "envFile": "  "})));
    assert!(!is_usable_user_db(&json!({"envFile": "/tmp/x"})));
    assert!(!is_usable_user_db(&json!([])));
    assert!(!is_usable_user_db(&json!(null)));
}

#[test]
fn trusted_header_trichotomy() {
    let mut headers = BTreeMap::new();
    assert_eq!(routed_user_result(&headers), RoutedUser::Owner);
    headers.insert(identity::TRUSTED_USER_HEADER.to_string(), HeaderVal::One(String::new()));
    assert_eq!(routed_user_result(&headers), RoutedUser::Invalid);
    headers.insert(
        identity::TRUSTED_USER_HEADER.to_string(),
        HeaderVal::Many(vec!["a".to_string(), "b".to_string()]),
    );
    assert_eq!(routed_user_result(&headers), RoutedUser::Invalid);
    headers.insert(
        identity::TRUSTED_USER_HEADER.to_string(),
        HeaderVal::One("coco".to_string()),
    );
    assert_eq!(routed_user_result(&headers), RoutedUser::User("coco".to_string()));
}

#[test]
fn safe_user_id_rejects_dots_and_shape() {
    assert!(is_safe_user_id("owner"));
    assert!(is_safe_user_id("a.b_c-d"));
    assert!(!is_safe_user_id(""));
    assert!(!is_safe_user_id(".owner"));
    assert!(!is_safe_user_id("a..b"));
    assert!(!is_safe_user_id("has space"));
    assert!(!is_safe_user_id(&"a".repeat(65)));
}

#[test]
fn capture_env_and_tokens() {
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
    let reg = registry_from_env(Some(&devices), Some(&dbs), Some(&owner_db().pg_url), None)
        .expect("reg");
    let ResolveUserResult::Ok(owner) = resolve_user(&reg, None) else {
        panic!("owner");
    };
    assert!(capture_env_for(Some(&owner)).expect("env").is_none());
    let ResolveUserResult::Ok(coco) = resolve_user(&reg, Some("win-coco")) else {
        panic!("coco");
    };
    let spawned = capture_env_for(Some(&coco)).expect("env").expect("map");
    assert_eq!(spawned.get("RIVETOS_USER_ID").map(String::as_str), Some("coco"));
    assert_eq!(
        spawned.get("RIVETOS_PG_URL").map(String::as_str),
        Some("postgres://coco@db/coco_memory")
    );
    assert_eq!(spawned.get("RIVETOS_ENV_FILE").map(String::as_str), Some("/tmp/coco.env"));
    assert!(!spawned.contains_key("RIVETOS_USER_DBS"));

    clear_user_tokens();
    let mut users = IndexMap::new();
    users.insert(
        "alice".to_string(),
        UserRecord {
            id: "alice".to_string(),
            devices: Vec::new(),
            db: None,
            persona: None,
        },
    );
    users.insert(
        "guest".to_string(),
        UserRecord {
            id: "guest".to_string(),
            devices: vec!["dev1".to_string()],
            db: None,
            persona: None,
        },
    );
    let registry = UsersRegistry {
        owner_user_id: "alice".to_string(),
        unmapped_is_owner: false,
        users,
        local_stores: true,
    };
    let ResolveUserResult::Ok(guest) = resolve_user_by_id(&registry, "guest") else {
        panic!("guest");
    };
    let token_env = capture_env_for(Some(&guest)).expect("env").expect("map");
    assert_eq!(token_env.get("RIVETOS_USER_ID").map(String::as_str), Some("guest"));
    assert!(!token_env.contains_key("RIVETOS_PG_URL"));
    assert_eq!(
        token_env.get("RIVETOS_USER_TOKEN").map(String::as_str),
        Some(mint_user_token("guest").expect("mint").as_str())
    );
    let token = mint_user_token("guest").expect("mint");
    assert_eq!(user_for_token(&token).as_deref(), Some("guest"));
    assert!(user_for_token("short").is_none());
    let with_token = resolve_request_user(
        &registry,
        &RequestIdentity {
            remote_address: "127.0.0.1".to_string(),
            headers: BTreeMap::from([(USER_TOKEN_HEADER.to_string(), HeaderVal::One(token.clone()))]),
            device_id: None,
        },
    );
    let ResolveUserResult::Ok(ctx) = with_token else {
        panic!("token user");
    };
    assert_eq!(ctx.user_id, "guest");
    assert!(!ctx.is_owner);
    let loopback = resolve_request_user(
        &registry,
        &RequestIdentity {
            remote_address: "::ffff:127.0.0.1".to_string(),
            headers: BTreeMap::new(),
            device_id: None,
        },
    );
    let ResolveUserResult::Ok(ctx) = loopback else {
        panic!("owner");
    };
    assert_eq!(ctx.user_id, "alice");
    for req in [
        RequestIdentity {
            remote_address: "127.0.0.1".to_string(),
            headers: BTreeMap::from([(
                USER_TOKEN_HEADER.to_string(),
                HeaderVal::One("not-a-token-this-node-minted".to_string()),
            )]),
            device_id: None,
        },
        RequestIdentity {
            remote_address: "127.0.0.1".to_string(),
            headers: BTreeMap::from([(USER_TOKEN_HEADER.to_string(), HeaderVal::One(String::new()))]),
            device_id: None,
        },
        RequestIdentity {
            remote_address: "127.0.0.1".to_string(),
            headers: BTreeMap::from([(
                USER_TOKEN_HEADER.to_string(),
                HeaderVal::Many(vec![token.clone(), token.clone()]),
            )]),
            device_id: None,
        },
        RequestIdentity {
            remote_address: "198.51.100.7".to_string(),
            headers: BTreeMap::from([(USER_TOKEN_HEADER.to_string(), HeaderVal::One(token.clone()))]),
            device_id: None,
        },
    ] {
        assert!(matches!(resolve_request_user(&registry, &req), ResolveUserResult::Err(_)));
    }
    clear_user_tokens();
    assert!(matches!(
        resolve_request_user(
            &registry,
            &RequestIdentity {
                remote_address: "127.0.0.1".to_string(),
                headers: BTreeMap::from([(USER_TOKEN_HEADER.to_string(), HeaderVal::One(token))]),
                device_id: None,
            }
        ),
        ResolveUserResult::Err(_)
    ));
    let stale = mint_user_token("visitor").expect("stale");
    assert!(matches!(
        resolve_request_user(
            &registry,
            &RequestIdentity {
                remote_address: "::1".to_string(),
                headers: BTreeMap::from([(USER_TOKEN_HEADER.to_string(), HeaderVal::One(stale))]),
                device_id: None,
            }
        ),
        ResolveUserResult::Err(_)
    ));
    clear_user_tokens();
    let mut req = RequestIdentity {
        remote_address: "127.0.0.1".to_string(),
        headers: BTreeMap::from([
            (
                USER_TOKEN_HEADER.to_string(),
                HeaderVal::One(mint_user_token("guest").expect("mint")),
            ),
            (
                identity::TRUSTED_USER_HEADER.to_string(),
                HeaderVal::One("alice".to_string()),
            ),
        ]),
        device_id: None,
    };
    let resolved = resolve_request_user(&registry, &req);
    let ResolveUserResult::Ok(ctx) = resolved else {
        panic!("resolved");
    };
    stamp_user_header(&mut req, Some(&ctx));
    assert_eq!(req.headers.len(), 1);
    assert_eq!(
        req.headers.get(identity::TRUSTED_USER_HEADER),
        Some(&HeaderVal::One("guest".to_string()))
    );
    assert!(mint_user_token(&"x".repeat(257)).is_err());
}
