use std::path::PathBuf;
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
    Capture {
        #[command(subcommand)]
        action: CaptureCommand,
    },
}

#[derive(Subcommand)]
enum CaptureCommand {
    #[command(about = "Read a Claude Code hook event from stdin and spool it")]
    Hook {
        #[arg(long, help = "Harness name (claude-code)")]
        harness: String,
    },
    #[command(about = "Replay spooled capture batches")]
    Replay {
        #[arg(long, help = "Spool file to replay; omit to sweep stale spool files")]
        file: Option<PathBuf>,
    },
    #[command(about = "Show whether Claude Code capture hooks are installed")]
    Status,
    #[command(about = "Install Claude Code capture hooks")]
    Install,
    #[command(about = "Remove Claude Code capture hooks")]
    Uninstall,
}

#[tokio::main]
async fn main() -> ExitCode {
    rivetos::init_logging();
    let cli = Cli::parse();
    let hook = matches!(
        cli.command,
        Commands::Capture {
            action: CaptureCommand::Hook { .. }
        }
    );
    match run(cli).await {
        Ok(code) => code,
        Err(error) => {
            let message = error.to_string();
            let _ = tokio::task::spawn_blocking(move || rivetos::log_fatal(&message)).await;
            if hook {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            }
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
                let settings = rivetos::settings_path(&capture::ProcessEnv);
                let text = tokio::task::spawn_blocking(move || rivetos::status_text(&settings))
                    .await
                    .map_err(|error| anyhow::Error::msg(error.to_string()))?
                    .map_err(anyhow::Error::msg)?;
                println!("{text}");
                Ok(ExitCode::SUCCESS)
            }
            CaptureCommand::Install => {
                let env = capture::ProcessEnv;
                let exe = std::env::current_exe()?;
                let settings = rivetos::settings_path(&env);
                let log = rivetos::log_path(&env);
                let command = rivetos::hook_command(&exe);
                let text = tokio::task::spawn_blocking(move || {
                    rivetos::install_hooks(&settings, &command, &log)
                })
                .await
                .map_err(|error| anyhow::Error::msg(error.to_string()))?
                .map_err(anyhow::Error::msg)?;
                println!("{text}");
                Ok(ExitCode::SUCCESS)
            }
            CaptureCommand::Uninstall => {
                let settings = rivetos::settings_path(&capture::ProcessEnv);
                let text = tokio::task::spawn_blocking(move || rivetos::uninstall_hooks(&settings))
                    .await
                    .map_err(|error| anyhow::Error::msg(error.to_string()))?
                    .map_err(anyhow::Error::msg)?;
                println!("{text}");
                Ok(ExitCode::SUCCESS)
            }
        },
    }
}
