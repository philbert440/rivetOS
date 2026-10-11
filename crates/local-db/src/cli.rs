pub fn run() -> i32 {
    let mut args = std::env::args();
    let _program = args.next();
    match args.next().as_deref() {
        Some("pg-supervisor") => crate::supervisor::run_supervisor_args(args),
        Some("--help") | Some("-h") => {
            eprintln!(
                "local-db supervises an embedded Postgres cluster until its owner exits.\n\nUsage: local-db pg-supervisor --pgdata <path> --pg-ctl <path> --port <port> [--timeout-secs <n>] [--config <key=value>]..."
            );
            0
        }
        Some(other) => {
            eprintln!("local-db: unknown command {other}");
            2
        }
        None => {
            eprintln!("local-db: missing command");
            2
        }
    }
}
