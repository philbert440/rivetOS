use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Args, Subcommand};

use crate::env::ProcessEnv;
use crate::hooks::{
    HOMEDIR_MISSING, hook_command, install_hooks, log_fatal, log_path, require_home, run_hook,
    run_replay, settings_path, status_text, uninstall_hooks,
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
    run_with(args, || protocol::host::home_dir(&ProcessEnv), log_fatal).await
}

async fn run_with(
    args: CaptureArgs,
    home: impl Fn() -> Option<String> + Send,
    report: impl Fn(&str) + Send + 'static,
) -> ExitCode {
    let hook = matches!(args.action, CaptureCommand::Hook { .. });
    match dispatch(args, home).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let code = exit_for(hook, &error);
            let _ = tokio::task::spawn_blocking(move || report(&error)).await;
            code
        }
    }
}

fn exit_for(hook: bool, error: &str) -> ExitCode {
    if hook && error != HOMEDIR_MISSING {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

async fn dispatch(args: CaptureArgs, home: impl Fn() -> Option<String>) -> Result<(), String> {
    match args.action {
        CaptureCommand::Hook { harness } => {
            require_home(home())?;
            run_hook(&harness).await
        }
        CaptureCommand::Replay { file } => {
            require_home(home())?;
            run_replay(file).await
        }
        CaptureCommand::Status => {
            let settings = settings_path(&ProcessEnv)?;
            let text = tokio::task::spawn_blocking(move || status_text(&settings))
                .await
                .map_err(|error| error.to_string())??;
            println!("{text}");
            Ok(())
        }
        CaptureCommand::Install => {
            let env = ProcessEnv;
            let exe = std::env::current_exe().map_err(|error| error.to_string())?;
            let settings = settings_path(&env)?;
            let log = log_path(&env)?;
            let command = hook_command(&exe);
            let text =
                tokio::task::spawn_blocking(move || install_hooks(&settings, &command, &log))
                    .await
                    .map_err(|error| error.to_string())??;
            println!("{text}");
            Ok(())
        }
        CaptureCommand::Uninstall => {
            let settings = settings_path(&ProcessEnv)?;
            let text = tokio::task::spawn_blocking(move || uninstall_hooks(&settings))
                .await
                .map_err(|error| error.to_string())??;
            println!("{text}");
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use std::process::ExitCode;
    use std::sync::Arc;

    use parking_lot::Mutex;

    use super::{CaptureArgs, CaptureCommand, exit_for, run_with};
    use crate::hooks::HOMEDIR_MISSING;

    fn hook_args(harness: &str) -> CaptureArgs {
        CaptureArgs {
            action: CaptureCommand::Hook {
                harness: harness.to_string(),
            },
        }
    }

    fn replay_args(file: Option<std::path::PathBuf>) -> CaptureArgs {
        CaptureArgs {
            action: CaptureCommand::Replay { file },
        }
    }

    #[tokio::test]
    async fn missing_home_fails_hook_and_replay_before_work() {
        let commands = [
            hook_args("claude-code"),
            hook_args("other"),
            replay_args(None),
            replay_args(Some(std::path::PathBuf::from("/no/such/spool.json"))),
        ];
        for args in commands {
            let seen = Arc::new(Mutex::new(Vec::new()));
            let log = Arc::clone(&seen);
            let code = run_with(
                args,
                || None,
                move |message| log.lock().push(message.to_string()),
            )
            .await;
            assert_eq!(code, ExitCode::from(1));
            assert_eq!(seen.lock().as_slice(), [HOMEDIR_MISSING]);
        }
    }

    #[test]
    fn hook_stays_open_for_later_errors() {
        assert_eq!(exit_for(true, "hook spool failed"), ExitCode::SUCCESS);
        assert_eq!(exit_for(false, "hook spool failed"), ExitCode::from(1));
        assert_eq!(exit_for(true, HOMEDIR_MISSING), ExitCode::from(1));
    }
}
