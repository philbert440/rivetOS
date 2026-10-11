use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Args, Subcommand};

use crate::env::ProcessEnv;
use crate::hooks::{
    hook_command, install_hooks, log_fatal, log_path, run_hook, run_replay, settings_path,
    status_text, uninstall_hooks,
};

#[derive(Args)]
#[command(about = "Capture Claude Code sessions into RivetOS")]
pub struct CaptureArgs {
    #[command(subcommand)]
    action: CaptureCommand,
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

pub async fn run(args: CaptureArgs) -> ExitCode {
    let hook = matches!(args.action, CaptureCommand::Hook { .. });
    match dispatch(args).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let _ = tokio::task::spawn_blocking(move || log_fatal(&error)).await;
            if hook {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            }
        }
    }
}

async fn dispatch(args: CaptureArgs) -> Result<(), String> {
    match args.action {
        CaptureCommand::Hook { harness } => run_hook(&harness).await,
        CaptureCommand::Replay { file } => run_replay(file).await,
        CaptureCommand::Status => {
            let settings = settings_path(&ProcessEnv);
            let text = tokio::task::spawn_blocking(move || status_text(&settings))
                .await
                .map_err(|error| error.to_string())??;
            println!("{text}");
            Ok(())
        }
        CaptureCommand::Install => {
            let env = ProcessEnv;
            let exe = std::env::current_exe().map_err(|error| error.to_string())?;
            let settings = settings_path(&env);
            let log = log_path(&env);
            let command = hook_command(&exe);
            let text =
                tokio::task::spawn_blocking(move || install_hooks(&settings, &command, &log))
                    .await
                    .map_err(|error| error.to_string())??;
            println!("{text}");
            Ok(())
        }
        CaptureCommand::Uninstall => {
            let settings = settings_path(&ProcessEnv);
            let text = tokio::task::spawn_blocking(move || uninstall_hooks(&settings))
                .await
                .map_err(|error| error.to_string())??;
            println!("{text}");
            Ok(())
        }
    }
}
