use std::process::ExitCode;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "rivetos", about = "RivetOS command line")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    #[command(about = "Capture Claude Code sessions into RivetOS")]
    Capture(capture::cli::CaptureArgs),
}

#[tokio::main]
async fn main() -> ExitCode {
    rivetos::init_logging();
    let cli = Cli::parse();
    match cli.command {
        Commands::Capture(args) => capture::cli::run(args).await,
    }
}
