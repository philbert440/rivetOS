mod request;
mod registry;
mod safe_id;
mod tokens;
mod trusted;
mod user_db;

pub use request::{
    RequestIdentity, capture_env_for, is_loopback_remote, resolve_request_user, stamp_user_header,
};
pub use registry::{
    LoadOptions, ResolveUserResult, UserContext, UserRecord, UsersRegistry, load_users_registry,
    merge_user_dbs, owner_user_id_from_env, parse_users_registry, registry_from_env, resolve_user,
    resolve_user_by_id, session_visible_to, user_dbs_from_registry, DEFAULT_OWNER_USER_ID,
};
pub use safe_id::is_safe_user_id;
pub use tokens::{
    clear_user_tokens, mint_user_token, user_for_token, TokenError, USER_TOKEN_ENV,
    USER_TOKEN_HEADER,
};
pub use trusted::{
    routed_user_from_headers, routed_user_result, HeaderMap, HeaderVal, RoutedUser,
    TRUSTED_USER_HEADER,
};
pub use user_db::{is_usable_user_db, UserDbEntry};
