use std::collections::BTreeMap;

pub const TRUSTED_USER_HEADER: &str = "x-rivetos-user";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeaderVal {
    One(String),
    Many(Vec<String>),
}

pub type HeaderMap = BTreeMap<String, HeaderVal>;

pub fn routed_user_from_headers(headers: &HeaderMap) -> Option<&str> {
    match headers.get(TRUSTED_USER_HEADER) {
        Some(HeaderVal::One(raw)) if !raw.is_empty() => Some(raw.as_str()),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoutedUser {
    Owner,
    Invalid,
    User(String),
}

pub fn routed_user_result(headers: &HeaderMap) -> RoutedUser {
    let Some(raw) = headers.get(TRUSTED_USER_HEADER) else {
        return RoutedUser::Owner;
    };
    match raw {
        HeaderVal::One(value) if !value.is_empty() => RoutedUser::User(value.clone()),
        _ => RoutedUser::Invalid,
    }
}
