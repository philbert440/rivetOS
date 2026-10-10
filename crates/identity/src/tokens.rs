use std::collections::HashMap;
use std::sync::Mutex;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const USER_TOKEN_HEADER: &str = "x-rivetos-user-token";
pub const USER_TOKEN_ENV: &str = "RIVETOS_USER_TOKEN";

const MAX_USER_ID_BYTES: usize = 256;
const MAX_TOKEN_LENGTH: usize = (MAX_USER_ID_BYTES * 4).div_ceil(3) + 1 + 43;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TokenError {
    #[error("user id is too long for a session token (over {MAX_USER_ID_BYTES} bytes)")]
    UserIdTooLong,
    #[error("user token entropy failed")]
    Entropy,
}

struct TokenStore {
    by_user: HashMap<String, String>,
    by_digest: HashMap<String, String>,
}

fn store() -> &'static Mutex<TokenStore> {
    static STORE: std::sync::OnceLock<Mutex<TokenStore>> = std::sync::OnceLock::new();
    STORE.get_or_init(|| {
        Mutex::new(TokenStore {
            by_user: HashMap::new(),
            by_digest: HashMap::new(),
        })
    })
}

fn lock() -> std::sync::MutexGuard<'static, TokenStore> {
    store().lock().unwrap_or_else(|err| err.into_inner())
}

fn digest(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

pub fn mint_user_token(user_id: &str) -> Result<String, TokenError> {
    let mut guard = lock();
    if let Some(existing) = guard.by_user.get(user_id) {
        return Ok(existing.clone());
    }
    if user_id.len() > MAX_USER_ID_BYTES {
        return Err(TokenError::UserIdTooLong);
    }
    let mut secret = [0_u8; 32];
    getrandom::getrandom(&mut secret).map_err(|_| TokenError::Entropy)?;
    let token = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(user_id.as_bytes()),
        URL_SAFE_NO_PAD.encode(secret)
    );
    guard.by_user.insert(user_id.to_string(), token.clone());
    guard.by_digest.insert(digest(&token), user_id.to_string());
    Ok(token)
}

pub fn user_for_token(token: &str) -> Option<String> {
    if token.len() < 16 || token.len() > MAX_TOKEN_LENGTH {
        return None;
    }
    lock().by_digest.get(&digest(token)).cloned()
}

pub fn clear_user_tokens() {
    let mut guard = lock();
    guard.by_user.clear();
    guard.by_digest.clear();
}
