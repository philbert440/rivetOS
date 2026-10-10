use std::collections::BTreeMap;

use crate::registry::{ResolveUserResult, UserContext, UsersRegistry};
use crate::tokens::{mint_user_token, user_for_token, TokenError, USER_TOKEN_ENV, USER_TOKEN_HEADER};
use crate::trusted::{HeaderMap, HeaderVal, TRUSTED_USER_HEADER};

#[derive(Debug, Clone)]
pub struct RequestIdentity {
    pub remote_address: String,
    pub headers: HeaderMap,
    pub device_id: Option<String>,
}

pub fn is_loopback_remote(remote_address: &str) -> bool {
    let addr = remote_address
        .strip_prefix("::ffff:")
        .unwrap_or(remote_address);
    addr == "127.0.0.1" || addr == "::1" || addr == "localhost"
}

pub fn resolve_request_user(
    registry: &UsersRegistry,
    req: &RequestIdentity,
) -> ResolveUserResult {
    if let Some(token) = req.headers.get(USER_TOKEN_HEADER) {
        let HeaderVal::One(token) = token else {
            return ResolveUserResult::Err("malformed user token".to_string());
        };
        if !is_loopback_remote(&req.remote_address) {
            return ResolveUserResult::Err(
                "a user token is accepted from this machine only".to_string(),
            );
        }
        let Some(user_id) = user_for_token(token) else {
            return ResolveUserResult::Err("unknown user token".to_string());
        };
        return crate::registry::resolve_user_by_id(registry, &user_id);
    }
    if is_loopback_remote(&req.remote_address) {
        return crate::registry::resolve_user(registry, None);
    }
    let Some(dev) = req.device_id.as_deref() else {
        return ResolveUserResult::Err("no device identity on request".to_string());
    };
    crate::registry::resolve_user(registry, Some(dev))
}

pub fn stamp_user_header(req: &mut RequestIdentity, ctx: Option<&UserContext>) {
    req.headers.remove(TRUSTED_USER_HEADER);
    req.headers.remove(USER_TOKEN_HEADER);
    if let Some(ctx) = ctx
        && !ctx.is_owner
    {
        req.headers
            .insert(TRUSTED_USER_HEADER.to_string(), HeaderVal::One(ctx.user_id.clone()));
    }
}

pub fn capture_env_for(
    ctx: Option<&UserContext>,
) -> Result<Option<BTreeMap<String, String>>, TokenError> {
    let Some(ctx) = ctx else {
        return Ok(None);
    };
    if ctx.is_owner {
        return Ok(None);
    }
    let mut env = BTreeMap::new();
    env.insert("RIVETOS_USER_ID".to_string(), ctx.user_id.clone());
    if !ctx.db.pg_url.is_empty() {
        env.insert("RIVETOS_PG_URL".to_string(), ctx.db.pg_url.clone());
    } else {
        env.insert(USER_TOKEN_ENV.to_string(), mint_user_token(&ctx.user_id)?);
    }
    if let Some(env_file) = &ctx.db.env_file {
        env.insert("RIVETOS_ENV_FILE".to_string(), env_file.clone());
    }
    Ok(Some(env))
}
