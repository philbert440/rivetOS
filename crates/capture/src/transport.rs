use thiserror::Error;

use crate::base64url;
use crate::den_url::{self, ResolvedDenUrl};
use crate::env::{self, EnvLookup};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureUser {
    pub id: String,
    pub token: String,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[error(
    "RIVETOS_USER_ID is set without RIVETOS_USER_TOKEN: refusing to write to the den as the node owner"
)]
pub struct MissingUserToken;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureTransport {
    Den {
        den_url: String,
        warnings: Option<Vec<String>>,
        user: Option<CaptureUser>,
    },
    Pg {
        pg_url: String,
    },
    None {
        reason: String,
    },
}

const USER_BLOCKS_DEN: &str = "RIVETOS_USER_ID is set — den transport would hit the owner pool on loopback — and RIVETOS_PG_URL is not set";

pub fn capture_user(fallback_id: &str, token: &str) -> CaptureUser {
    if let Some((prefix, _)) = token.split_once('.')
        && !prefix.is_empty()
        && let Some(bytes) = base64url::decode(prefix)
        && let Ok(id) = String::from_utf8(bytes)
        && !id.is_empty()
        && base64url::encode(id.as_bytes()) == prefix
    {
        return CaptureUser {
            id,
            token: token.to_string(),
        };
    }
    CaptureUser {
        id: fallback_id.to_string(),
        token: token.to_string(),
    }
}

pub fn capture_user_from_env(env: &dyn EnvLookup) -> Result<Option<CaptureUser>, MissingUserToken> {
    match env.get("RIVETOS_USER_ID") {
        None => Ok(None),
        Some(id) if id.is_empty() => Ok(None),
        Some(id) => {
            let token = env::trimmed(env, "RIVETOS_USER_TOKEN");
            if token.is_empty() {
                Err(MissingUserToken)
            } else {
                Ok(Some(capture_user(&id, &token)))
            }
        }
    }
}

pub fn resolve_capture_transport(
    env: &dyn EnvLookup,
    mut read_config: impl FnMut() -> Option<String>,
) -> CaptureTransport {
    let forced = env::trimmed(env, "RIVETOS_CAPTURE_TRANSPORT");
    let launcher_disabled = env::trimmed(env, "RIVET_DEN_URL").is_empty()
        && !env::trimmed(env, "RIVET_DEN_CA").is_empty();
    let resolved = if launcher_disabled {
        None
    } else {
        den_url::resolve_den_url(env, &mut read_config, &den_url::path_exists)
    };
    let routed_user = env::present_non_empty(env, "RIVETOS_USER_ID");
    let user_token = if routed_user {
        env::trimmed(env, "RIVETOS_USER_TOKEN")
    } else {
        String::new()
    };
    let pg_url = env::trimmed(env, "RIVETOS_PG_URL");
    let user_blocks_den = routed_user && user_token.is_empty();
    if forced == "den" {
        let Some(url) = resolved.as_ref().map(|item| item.den_url.clone()) else {
            return CaptureTransport::None {
                reason: "RIVETOS_CAPTURE_TRANSPORT=den but RIVET_DEN_URL is not set".to_string(),
            };
        };
        if user_blocks_den {
            if !pg_url.is_empty() {
                return CaptureTransport::Pg { pg_url };
            }
            return CaptureTransport::None {
                reason: USER_BLOCKS_DEN.to_string(),
            };
        }
        return den_transport(url, resolved.as_ref(), env, &user_token, routed_user);
    }
    if forced == "pg" {
        if pg_url.is_empty() {
            return CaptureTransport::None {
                reason: "RIVETOS_CAPTURE_TRANSPORT=pg but RIVETOS_PG_URL is not set".to_string(),
            };
        }
        return CaptureTransport::Pg { pg_url };
    }
    if let Some(resolved) = resolved.as_ref()
        && !user_blocks_den
    {
        return den_transport(
            resolved.den_url.clone(),
            Some(resolved),
            env,
            &user_token,
            routed_user,
        );
    }
    if !pg_url.is_empty() {
        return CaptureTransport::Pg { pg_url };
    }
    if user_blocks_den && resolved.is_some() {
        return CaptureTransport::None {
            reason: USER_BLOCKS_DEN.to_string(),
        };
    }
    CaptureTransport::None {
        reason: "RIVET_DEN_URL and RIVETOS_PG_URL are not set".to_string(),
    }
}

fn den_transport(
    den_url: String,
    resolved: Option<&ResolvedDenUrl>,
    env: &dyn EnvLookup,
    user_token: &str,
    routed_user: bool,
) -> CaptureTransport {
    let warnings = resolved.and_then(|item| item.warnings.clone());
    let user = if routed_user && !user_token.is_empty() {
        env.get("RIVETOS_USER_ID")
            .map(|id| capture_user(&id, user_token))
    } else {
        None
    };
    CaptureTransport::Den {
        den_url,
        warnings,
        user,
    }
}
