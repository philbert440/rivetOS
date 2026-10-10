mod registry;
mod request;
mod safe_id;
mod tokens;
mod trusted;
mod user_db;

pub use registry::{
    DEFAULT_OWNER_USER_ID, LoadOptions, ResolveUserResult, UserContext, UserRecord, UsersRegistry,
    load_users_registry, merge_user_dbs, owner_user_id_from_env, parse_users_registry,
    registry_from_env, resolve_user, resolve_user_by_id, session_visible_to,
    user_dbs_from_registry,
};
pub use request::{
    RequestIdentity, capture_env_for, is_loopback_remote, resolve_request_user, stamp_user_header,
};
pub use safe_id::is_safe_user_id;
pub use tokens::{
    TokenError, USER_TOKEN_ENV, USER_TOKEN_HEADER, clear_user_tokens, mint_user_token,
    user_for_token,
};
pub use trusted::{
    HeaderMap, HeaderVal, RoutedUser, TRUSTED_USER_HEADER, routed_user_from_headers,
    routed_user_result,
};
pub use user_db::{UserDbEntry, is_usable_user_db};
