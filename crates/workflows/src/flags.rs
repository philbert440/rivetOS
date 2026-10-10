use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

fn flags() -> &'static Mutex<HashMap<String, bool>> {
    static FLAGS: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn set_kill_flag(run_id: &str) {
    let mut map = flags().lock().unwrap_or_else(|err| err.into_inner());
    map.insert(run_id.to_string(), true);
}

pub(crate) fn kill_flag(run_id: &str) -> bool {
    let map = flags().lock().unwrap_or_else(|err| err.into_inner());
    map.get(run_id).copied().unwrap_or(false)
}
