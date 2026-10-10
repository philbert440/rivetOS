use tracing_subscriber::EnvFilter;

pub fn init_tracing() {
    let filter = match std::env::var("RUST_LOG") {
        Ok(value) => EnvFilter::try_new(value).unwrap_or_else(|_| info_filter()),
        Err(_) => info_filter(),
    };
    let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();
}

fn info_filter() -> EnvFilter {
    EnvFilter::try_new("info").unwrap_or_else(|_| EnvFilter::default())
}
