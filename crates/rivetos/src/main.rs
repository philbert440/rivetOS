use std::process::ExitCode;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "rivetos", about = "RivetOS command line")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    #[command(about = "Schema migration commands (Postgres or embedded PGlite)")]
    Db(memory::cli::DbArgs),
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.iter().any(|arg| arg == "--help" || arg == "-h") {
        let _ = Cli::parse_from(std::env::args());
        return ExitCode::SUCCESS;
    }
    let command = Command::Db(memory::cli::DbArgs::from_argv(argv));
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
    match command {
        Command::Db(args) => runtime.block_on(memory::cli::run(args)),
    }
}
