use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "rivetos")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    Capture {
        #[command(subcommand)]
        action: CaptureCommand,
    },
}

#[derive(Subcommand)]
enum CaptureCommand {
    Hook {
        #[arg(long)]
        harness: String,
    },
    Replay {
        #[arg(long)]
        file: Option<PathBuf>,
    },
    Status,
    Install,
    Uninstall,
}

#[tokio::main]
async fn main() -> ExitCode {
    rivetos::init_logging();
    let cli = Cli::parse();
    match run(cli).await {
        Ok(code) => code,
        Err(error) => {
            rivetos::log_fatal(&error.to_string());
            ExitCode::SUCCESS
        }
    }
}

async fn run(cli: Cli) -> anyhow::Result<ExitCode> {
    match cli.command {
        Commands::Capture { action } => match action {
            CaptureCommand::Hook { harness } => {
                rivetos::run_hook(&harness)
                    .await
                    .map_err(anyhow::Error::msg)?;
                Ok(ExitCode::SUCCESS)
            }
            CaptureCommand::Replay { file } => {
                rivetos::run_replay(file)
                    .await
                    .map_err(anyhow::Error::msg)?;
                Ok(ExitCode::SUCCESS)
            }
            CaptureCommand::Status => {
                println!(
                    "{}",
                    rivetos::status_text(&rivetos::settings_path(&capture::ProcessEnv))
                );
                Ok(ExitCode::SUCCESS)
            }
            CaptureCommand::Install => {
                let env = capture::ProcessEnv;
                let exe = std::env::current_exe()?;
                let settings = rivetos::settings_path(&env);
                let log = rivetos::log_path(&env);
                let command = rivetos::hook_command(&exe);
                println!("{}", rivetos::install_hooks(&settings, &command, &log));
                Ok(ExitCode::SUCCESS)
            }
            CaptureCommand::Uninstall => {
                println!(
                    "{}",
                    rivetos::uninstall_hooks(&rivetos::settings_path(&capture::ProcessEnv))
                );
                Ok(ExitCode::SUCCESS)
            }
        },
    }
}
