use parking_lot::Mutex;

pub(crate) fn with_lock<T, R>(mutex: &Mutex<T>, body: impl FnOnce(&mut T) -> R) -> R {
    body(&mut mutex.lock())
}
