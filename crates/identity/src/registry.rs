use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use indexmap::IndexMap;
use protocol::js::js_trim;
use serde_json::Value;

use crate::user_db::{is_usable_user_db, UserDbEntry};

pub const DEFAULT_OWNER_USER_ID: &str = "owner";
const DEFAULT_SHARED_DIR: &str = "/rivet-shared";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserRecord {
    pub id: String,
    pub devices: Vec<String>,
    pub db: Option<UserDbEntry>,
    pub persona: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsersRegistry {
    pub owner_user_id: String,
    pub unmapped_is_owner: bool,
    pub users: IndexMap<String, UserRecord>,
    pub local_stores: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserContext {
    pub user_id: String,
    pub device_id: Option<String>,
    pub db: UserDbEntry,
    pub persona: Option<String>,
    pub is_owner: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveUserResult {
    Ok(UserContext),
    Err(String),
}

pub struct LoadOptions<'a> {
    pub path: Option<&'a str>,
    pub read_file: Option<&'a dyn Fn(&str) -> Option<String>>,
    pub homedir: Option<&'a dyn Fn() -> String>,
}

impl Default for LoadOptions<'static> {
    fn default() -> Self {
        Self {
            path: None,
            read_file: None,
            homedir: None,
        }
    }
}

fn as_device_id(raw: &str) -> String {
    let t = js_trim(raw);
    t.strip_prefix("device:").unwrap_or(t).to_string()
}

fn local_store() -> UserDbEntry {
    UserDbEntry {
        pg_url: String::new(),
        env_file: None,
    }
}

fn db_for(record: &UserRecord) -> Option<UserDbEntry> {
    let db = record.db.as_ref()?;
    let value = match &db.env_file {
        Some(env_file) => serde_json::json!({ "pgUrl": db.pg_url, "envFile": env_file }),
        None => serde_json::json!({ "pgUrl": db.pg_url }),
    };
    if is_usable_user_db(&value) {
        Some(db.clone())
    } else {
        None
    }
}

fn route_for(registry: &UsersRegistry, record: &UserRecord) -> Option<UserDbEntry> {
    db_for(record).or_else(|| {
        if registry.local_stores {
            Some(local_store())
        } else {
            None
        }
    })
}

fn context_for(
    registry: &UsersRegistry,
    record: &UserRecord,
    device_id: Option<String>,
    db: UserDbEntry,
) -> UserContext {
    UserContext {
        user_id: record.id.clone(),
        device_id,
        db,
        persona: record.persona.clone(),
        is_owner: record.id == registry.owner_user_id,
    }
}

pub fn parse_users_registry(raw: Option<&str>) -> Option<UsersRegistry> {
    let trimmed = raw.map(js_trim).unwrap_or("");
    if trimmed.is_empty() {
        return None;
    }
    let parsed: Value = match serde_json::from_str(trimmed) {
        Ok(value) => value,
        Err(_) => {
            eprintln!("[rivetos] users registry is not valid JSON — tenancy file ignored");
            return None;
        }
    };
    let Some(obj) = parsed.as_object() else {
        eprintln!("[rivetos] users registry is not a JSON object — tenancy file ignored");
        return None;
    };
    let owner_user_id = obj
        .get("ownerUserId")
        .and_then(Value::as_str)
        .map(js_trim)
        .unwrap_or("");
    if owner_user_id.is_empty() {
        eprintln!("[rivetos] users registry missing ownerUserId — tenancy file ignored");
        return None;
    }
    let unmapped_is_owner = obj.get("unmappedIsOwner") == Some(&Value::Bool(true));
    let Some(users_in) = obj.get("users").and_then(Value::as_object) else {
        eprintln!("[rivetos] users registry.users is not an object — tenancy file ignored");
        return None;
    };
    let mut users = IndexMap::new();
    for (id, rec) in users_in {
        let uid = js_trim(id);
        if uid.is_empty() {
            continue;
        }
        let Some(r) = rec.as_object() else {
            continue;
        };
        let mut devices = Vec::new();
        if let Some(list) = r.get("devices").and_then(Value::as_array) {
            for d in list {
                if let Some(text) = d.as_str()
                    && !js_trim(text).is_empty()
                {
                    devices.push(as_device_id(text));
                }
            }
        }
        let mut db = None;
        if let Some(pg) = r.get("pgUrl").and_then(Value::as_str) {
            let pg = js_trim(pg);
            if !pg.is_empty() {
                let mut entry = UserDbEntry {
                    pg_url: pg.to_string(),
                    env_file: None,
                };
                if let Some(env_file) = r.get("envFile").and_then(Value::as_str) {
                    let env_file = js_trim(env_file);
                    if !env_file.is_empty() {
                        entry.env_file = Some(env_file.to_string());
                    }
                }
                db = Some(entry);
            }
        }
        let persona = r
            .get("persona")
            .and_then(Value::as_str)
            .map(js_trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        users.insert(
            uid.to_string(),
            UserRecord {
                id: uid.to_string(),
                devices,
                db,
                persona,
            },
        );
    }
    if !users.contains_key(owner_user_id) {
        users.insert(
            owner_user_id.to_string(),
            UserRecord {
                id: owner_user_id.to_string(),
                devices: Vec::new(),
                db: None,
                persona: None,
            },
        );
    }
    Some(UsersRegistry {
        owner_user_id: owner_user_id.to_string(),
        unmapped_is_owner,
        users,
        local_stores: false,
    })
}

fn default_read_file(path: &str) -> Option<String> {
    if !Path::new(path).exists() {
        return None;
    }
    match fs::read_to_string(path) {
        Ok(text) => Some(text),
        Err(_) => {
            eprintln!("[rivetos] users registry \"{path}\" unreadable");
            None
        }
    }
}

fn default_homedir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
}

pub fn shared_dir_from(env: &BTreeMap<String, String>) -> String {
    env.get("RIVETOS_SHARED_DIR")
        .map(|s| js_trim(s))
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            std::env::var("RIVETOS_SHARED_DIR")
                .ok()
                .map(|s| js_trim(&s).to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| DEFAULT_SHARED_DIR.to_string())
        })
}

fn env_trim<'a>(env: &'a BTreeMap<String, String>, key: &str) -> Option<&'a str> {
    env.get(key).map(|s| js_trim(s)).filter(|s| !s.is_empty())
}

fn with_store_kind(mut registry: UsersRegistry, env: &BTreeMap<String, String>) -> UsersRegistry {
    if env_trim(env, "RIVETOS_USER_STORES") == Some("local") {
        registry.local_stores = true;
    }
    registry
}

pub fn merge_user_dbs(
    registry: UsersRegistry,
    user_dbs: Option<&BTreeMap<String, UserDbEntry>>,
    owner_pg_url: Option<&str>,
) -> UsersRegistry {
    let mut users = IndexMap::new();
    for (id, rec) in registry.users {
        let db = rec.db.clone().or_else(|| {
            user_dbs
                .and_then(|map| map.get(&id).cloned())
                .or_else(|| {
                    if id == registry.owner_user_id {
                        owner_pg_url
                            .map(js_trim)
                            .filter(|s| !s.is_empty())
                            .map(|pg| UserDbEntry {
                                pg_url: pg.to_string(),
                                env_file: None,
                            })
                    } else {
                        None
                    }
                })
        });
        users.insert(
            id,
            UserRecord {
                db,
                ..rec
            },
        );
    }
    UsersRegistry { users, ..registry }
}

fn fail_closed_owner(env: &BTreeMap<String, String>) -> UsersRegistry {
    let owner_user_id = env_trim(env, "RIVETOS_OWNER_USER_ID")
        .unwrap_or(DEFAULT_OWNER_USER_ID)
        .to_string();
    let mut users = IndexMap::new();
    users.insert(
        owner_user_id.clone(),
        UserRecord {
            id: owner_user_id.clone(),
            devices: Vec::new(),
            db: None,
            persona: None,
        },
    );
    with_store_kind(
        merge_user_dbs(
            UsersRegistry {
                owner_user_id,
                unmapped_is_owner: false,
                users,
                local_stores: false,
            },
            None,
            env_trim(env, "RIVETOS_PG_URL"),
        ),
        env,
    )
}

pub fn load_users_registry(
    env: &BTreeMap<String, String>,
    opts: LoadOptions<'_>,
) -> Option<UsersRegistry> {
    let read = opts.read_file.unwrap_or(&default_read_file);
    let home = opts.homedir;
    let explicit = opts
        .path
        .map(js_trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| env_trim(env, "RIVETOS_USERS_FILE").map(str::to_string));
    let shared_root = env_trim(env, "RIVETOS_SHARED_DIR")
        .map(str::to_string)
        .unwrap_or_else(|| shared_dir_from(env));
    let try_parse = |path: &str| -> Option<UsersRegistry> {
        let raw = read(path)?;
        parse_users_registry(Some(&raw))
    };
    if let Some(explicit) = explicit {
        let file_reg = try_parse(&explicit);
        if file_reg.is_none() {
            eprintln!(
                "[rivetos] RIVETOS_USERS_FILE=\"{explicit}\" missing or invalid — ALL device identities refused (fail closed); fix or unset the file"
            );
            return Some(fail_closed_owner(env));
        }
        return file_reg.map(|reg| {
            with_store_kind(merge_user_dbs(reg, None, env_trim(env, "RIVETOS_PG_URL")), env)
        });
    }
    let shared_file = Path::new(&shared_root)
        .join("rivetos")
        .join("users.json");
    let shared_display = shared_file.to_string_lossy().to_string();
    if let Some(shared_raw) = read(&shared_display) {
        let file_reg = parse_users_registry(Some(&shared_raw));
        if file_reg.is_none() {
            eprintln!(
                "[rivetos] users registry \"{shared_display}\" exists but is invalid — ALL device identities refused (fail closed); fix the file"
            );
            return Some(fail_closed_owner(env));
        }
        return file_reg.map(|reg| {
            with_store_kind(merge_user_dbs(reg, None, env_trim(env, "RIVETOS_PG_URL")), env)
        });
    }
    let home_dir = match home {
        Some(fun) => fun(),
        None => default_homedir(),
    };
    let home_file = Path::new(&home_dir)
        .join(".rivetos")
        .join("users.json")
        .to_string_lossy()
        .to_string();
    let home_reg = try_parse(&home_file)?;
    Some(with_store_kind(
        merge_user_dbs(home_reg, None, env_trim(env, "RIVETOS_PG_URL")),
        env,
    ))
}

pub fn user_dbs_from_registry(
    registry: Option<&UsersRegistry>,
) -> Option<BTreeMap<String, UserDbEntry>> {
    let registry = registry?;
    let mut out = BTreeMap::new();
    for rec in registry.users.values() {
        if rec.id == registry.owner_user_id {
            continue;
        }
        if let Some(db) = db_for(rec) {
            out.insert(rec.id.clone(), db);
        }
    }
    if out.is_empty() { None } else { Some(out) }
}

pub fn registry_from_env(
    device_users: Option<&BTreeMap<String, String>>,
    user_dbs: Option<&BTreeMap<String, UserDbEntry>>,
    owner_pg_url: Option<&str>,
    owner_user_id: Option<&str>,
) -> Option<UsersRegistry> {
    let owner_user_id = owner_user_id
        .map(js_trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_OWNER_USER_ID)
        .to_string();
    let mut users = IndexMap::new();
    let owner_db = owner_pg_url
        .map(js_trim)
        .filter(|s| !s.is_empty())
        .map(|pg| UserDbEntry {
            pg_url: pg.to_string(),
            env_file: None,
        });
    users.insert(
        owner_user_id.clone(),
        UserRecord {
            id: owner_user_id.clone(),
            devices: Vec::new(),
            db: owner_db,
            persona: None,
        },
    );
    if let Some(device_users) = device_users {
        for (device_id, user_id) in device_users {
            let id = js_trim(user_id);
            let dev = as_device_id(device_id);
            if id.is_empty() || dev.is_empty() {
                continue;
            }
            let rec = users.entry(id.to_string()).or_insert_with(|| UserRecord {
                id: id.to_string(),
                devices: Vec::new(),
                db: None,
                persona: None,
            });
            if !rec.devices.iter().any(|d| d == &dev) {
                rec.devices.push(dev);
            }
        }
    }
    if let Some(user_dbs) = user_dbs {
        for (user_id, db) in user_dbs {
            let id = js_trim(user_id);
            if id.is_empty() {
                continue;
            }
            let rec = users.entry(id.to_string()).or_insert_with(|| UserRecord {
                id: id.to_string(),
                devices: Vec::new(),
                db: None,
                persona: None,
            });
            rec.db = Some(db.clone());
        }
    }
    let has_extra = users.keys().any(|id| id != &owner_user_id);
    if !has_extra && device_users.is_none() && user_dbs.is_none() {
        return None;
    }
    Some(UsersRegistry {
        owner_user_id,
        unmapped_is_owner: true,
        users,
        local_stores: false,
    })
}

pub fn resolve_user(registry: &UsersRegistry, device_id: Option<&str>) -> ResolveUserResult {
    let Some(owner) = registry.users.get(&registry.owner_user_id) else {
        return ResolveUserResult::Err(format!(
            "owner user \"{}\" is missing",
            registry.owner_user_id
        ));
    };
    let Some(device_id) = device_id else {
        let Some(db) = route_for(registry, owner) else {
            return ResolveUserResult::Err(format!(
                "owner user \"{}\" has no usable database",
                owner.id
            ));
        };
        return ResolveUserResult::Ok(context_for(registry, owner, None, db));
    };
    let bare = as_device_id(device_id);
    let matched = registry
        .users
        .values()
        .find(|rec| rec.devices.iter().any(|d| d == &bare));
    let Some(matched) = matched else {
        if !registry.unmapped_is_owner {
            return ResolveUserResult::Err(format!(
                "device \"{bare}\" is not in the users registry"
            ));
        }
        let Some(db) = route_for(registry, owner) else {
            return ResolveUserResult::Err(format!(
                "owner user \"{}\" has no usable database",
                owner.id
            ));
        };
        return ResolveUserResult::Ok(context_for(registry, owner, Some(bare), db));
    };
    let Some(db) = route_for(registry, matched) else {
        return ResolveUserResult::Err(format!(
            "user \"{}\" has no usable database (mapped device \"{bare}\")",
            matched.id
        ));
    };
    ResolveUserResult::Ok(context_for(registry, matched, Some(bare), db))
}

pub fn owner_user_id_from_env(env: &BTreeMap<String, String>) -> String {
    load_users_registry(env, LoadOptions::default())
        .map(|reg| reg.owner_user_id)
        .unwrap_or_else(|| DEFAULT_OWNER_USER_ID.to_string())
}

pub fn resolve_user_by_id(registry: &UsersRegistry, user_id: &str) -> ResolveUserResult {
    let Some(record) = registry.users.values().find(|rec| rec.id == user_id) else {
        return ResolveUserResult::Err(format!("user \"{user_id}\" is not in the users registry"));
    };
    let Some(db) = route_for(registry, record) else {
        return ResolveUserResult::Err(format!(
            "user \"{}\" has no usable database",
            record.id
        ));
    };
    ResolveUserResult::Ok(context_for(registry, record, None, db))
}

pub fn session_visible_to(owner_user_id: Option<&str>, ctx: &UserContext) -> bool {
    match owner_user_id {
        None => ctx.is_owner,
        Some(owner) => owner == ctx.user_id,
    }
}
