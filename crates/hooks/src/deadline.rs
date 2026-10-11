use std::future::Future;
use std::time::Duration;

pub(crate) const IO_DEADLINE: Duration = Duration::from_secs(30);

pub(crate) async fn within_deadline<T, E, F>(
    work: F,
    on_timeout: impl FnOnce() -> E,
) -> Result<T, E>
where
    F: Future<Output = Result<T, E>>,
{
    match tokio::time::timeout(IO_DEADLINE, work).await {
        Ok(result) => result,
        Err(_) => {
            tracing::warn!("file operation timed out");
            Err(on_timeout())
        }
    }
}
