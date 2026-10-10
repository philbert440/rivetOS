use std::sync::{Mutex, MutexGuard};

pub(crate) fn with_lock<T, R>(mutex: &Mutex<T>, body: impl FnOnce(&mut T) -> R) -> R {
    let mut guard = lock(mutex);
    body(&mut guard)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}
