use std::process::ExitCode;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "rivetos", about = "RivetOS command line")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    #[command(about = "Schema migration commands (Postgres or embedded PGlite)")]
    Db(memory::cli::DbArgs),
}

fn main() -> ExitCode {
    if let Err(message) = memory::cli::reject_bad_config(std::env::args()) {
        eprintln!("{message}");
        return ExitCode::from(1);
    }
    if let Err(message) = memory::cli::migrate_url_error(std::env::args()) {
        eprintln!("{message}");
        return ExitCode::from(1);
    }
    let cli = Cli::parse();
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!("[migrate] fatal: {err}");
            return ExitCode::from(1);
        }
    };
    match cli.command {
        Some(Command::Db(args)) => runtime.block_on(memory::cli::run(args)),
        None => runtime.block_on(memory::cli::run(memory::cli::DbArgs::usage_only())),
    }
}
