use std::collections::BTreeMap;
use std::process::ExitCode;

use tokio::signal::unix::{SignalKind, signal};

use crate::config::GatewayConfig;
use crate::listen::serve;

#[derive(clap::Args, Debug, Clone, Copy)]
#[command(about = "Serve the den gateway on HTTP and WebSocket")]
pub struct GatewayArgs;

pub async fn run(_args: GatewayArgs) -> ExitCode {
    let env: BTreeMap<String, String> = std::env::vars().collect();
    let config = GatewayConfig::from_env(&env);
    let running = match serve(config).await {
        Ok(running) => running,
        Err(err) => {
            eprint!("{}", err.node_stderr());
            return ExitCode::from(1);
        }
    };
    println!("{}", running.listen_line);
    eprintln!("{}", running.discovery_line);
    for line in &running.mesh_logs {
        eprintln!("{line}");
    }
    let mut terminate = match signal(SignalKind::terminate()) {
        Ok(signal) => signal,
        Err(err) => {
            eprintln!("Error: {err}");
            running.shutdown().await;
            return ExitCode::from(1);
        }
    };
    let mut interrupt = match signal(SignalKind::interrupt()) {
        Ok(signal) => signal,
        Err(err) => {
            eprintln!("Error: {err}");
            running.shutdown().await;
            return ExitCode::from(1);
        }
    };
    tokio::select! {
        _ = terminate.recv() => {}
        _ = interrupt.recv() => {}
    }
    running.shutdown().await;
    ExitCode::SUCCESS
}
