use std::process::ExitCode;

use clap::{Args, Parser, Subcommand};

use crate::{MigrationStatus, format_applied_at, migrate_database, migration_status};

#[derive(Parser)]
#[command(name = "rivetos", about = "RivetOS command line")]
struct HelpCli {
    #[command(subcommand)]
    command: HelpCommand,
}

#[derive(Subcommand)]
enum HelpCommand {
    #[command(about = "Schema migration commands (Postgres or embedded PGlite)")]
    Db {
        #[command(subcommand)]
        action: Option<DbAction>,
    },
}

#[derive(Args, Debug)]
#[command(about = "Schema migration commands (Postgres or embedded PGlite)")]
pub struct DbArgs {
    #[command(subcommand)]
    pub action: Option<DbAction>,
    #[arg(skip)]
    argv: Vec<String>,
    #[arg(skip)]
    from_raw: bool,
}

impl DbArgs {
    pub fn from_argv(argv: Vec<String>) -> Self {
        Self {
            action: None,
            argv,
            from_raw: true,
        }
    }
}

#[derive(Subcommand, Debug)]
pub enum DbAction {
    #[command(about = "Apply pending migrations to Postgres (--url or RIVETOS_PG_URL)")]
    Migrate {
        #[arg(long, help = "Bypass configuration and target that Postgres URL")]
        url: Option<String>,
        #[arg(
            long,
            help = "Record pending migrations as applied without running them"
        )]
        baseline: bool,
        #[arg(
            long,
            short = 'c',
            help = "Path to config.yaml (not forwarded to the migrator)"
        )]
        config: Option<String>,
    },
    #[command(about = "Show applied migrations on the configured Postgres")]
    Status {
        #[arg(
            long,
            short = 'c',
            help = "Path to config.yaml (not forwarded to the migrator)"
        )]
        config: Option<String>,
    },
}

pub async fn run(args: DbArgs) -> ExitCode {
    if args.from_raw {
        if args.argv.iter().any(|arg| arg == "--help" || arg == "-h") {
            let mut full = vec!["rivetos".to_string()];
            full.extend(args.argv.iter().cloned());
            let _ = HelpCli::parse_from(full);
            return ExitCode::SUCCESS;
        }
        return match dispatch(&args.argv).await {
            Ok(code) => code,
            Err(message) => {
                eprintln!("[migrate] fatal: {message}");
                ExitCode::from(1)
            }
        };
    }
    run_parsed(args).await
}

async fn run_parsed(args: DbArgs) -> ExitCode {
    match args.action {
        None => {
            print_usage();
            ExitCode::SUCCESS
        }
        Some(DbAction::Migrate {
            url,
            baseline,
            config,
        }) => {
            let _embedded_config_deferred = config;
            let mut flags = Vec::new();
            if baseline {
                flags.push("--baseline".to_string());
            }
            if let Some(url) = url {
                flags.push("--url".to_string());
                flags.push(url);
            }
            match migrate(&flags).await {
                Ok(code) => code,
                Err(message) => {
                    eprintln!("[migrate] fatal: {message}");
                    ExitCode::from(1)
                }
            }
        }
        Some(DbAction::Status { config }) => {
            let _embedded_config_deferred = config;
            match status().await {
                Ok(code) => code,
                Err(message) => {
                    eprintln!("[migrate] fatal: {message}");
                    ExitCode::from(1)
                }
            }
        }
    }
}

async fn dispatch(args: &[String]) -> Result<ExitCode, String> {
    if args.first().map(String::as_str) != Some("db") {
        print_usage();
        return Ok(if args.is_empty() {
            ExitCode::SUCCESS
        } else {
            ExitCode::from(1)
        });
    }
    let (config, rest) = match take_config(&args[1..]) {
        Ok(parsed) => parsed,
        Err(()) => return Ok(ExitCode::from(1)),
    };
    let _embedded_config_deferred = config;
    match rest.first().map(String::as_str) {
        None => {
            print_usage();
            Ok(ExitCode::SUCCESS)
        }
        Some("migrate") => migrate(&rest[1..]).await,
        Some("status") => status().await,
        Some(_) => {
            print_usage();
            Ok(ExitCode::from(1))
        }
    }
}

fn take_config(args: &[String]) -> Result<(Option<String>, Vec<String>), ()> {
    let mut rest = Vec::new();
    let mut config = None;
    let mut index = 0;
    while index < args.len() {
        if args[index] == "--config" || args[index] == "-c" {
            let next = args.get(index + 1);
            if next.is_none() || next.is_some_and(|value| value.starts_with('-')) {
                eprintln!("db: --config requires a path");
                return Err(());
            }
            config = next.cloned();
            index += 2;
            continue;
        }
        rest.push(args[index].clone());
        index += 1;
    }
    Ok((config, rest))
}

async fn migrate(args: &[String]) -> Result<ExitCode, String> {
    let baseline = args.iter().any(|arg| arg == "--baseline");
    let url = if let Some(index) = args.iter().position(|arg| arg == "--url") {
        args.get(index + 1)
            .cloned()
            .filter(|value| !value.is_empty())
    } else {
        std::env::var("RIVETOS_PG_URL")
            .ok()
            .filter(|value| !value.is_empty())
    };
    let Some(url) = url else {
        eprintln!("[migrate] RIVETOS_PG_URL not set (or pass --url <pg-url>)");
        return Ok(ExitCode::from(1));
    };
    migrate_database(&url, baseline)
        .await
        .map_err(|err| err.to_string())?;
    Ok(ExitCode::SUCCESS)
}

async fn status() -> Result<ExitCode, String> {
    let url = std::env::var("RIVETOS_PG_URL")
        .ok()
        .filter(|value| !value.is_empty());
    let Some(url) = url else {
        eprintln!("[db status] RIVETOS_PG_URL not set");
        return Ok(ExitCode::from(1));
    };
    let report = match migration_status(&url).await {
        Ok(report) => report,
        Err(err) => {
            eprintln!("{err}");
            return Ok(ExitCode::from(1));
        }
    };
    match report {
        MigrationStatus::MissingTable => {
            println!(
                "[db status] _rivetos_migrations table does not exist (no migrations applied yet)"
            );
        }
        MigrationStatus::Empty => println!("[db status] no migrations applied"),
        MigrationStatus::Applied(rows) => {
            println!("[db status] {} migration(s) applied:", rows.len());
            for row in rows {
                println!("  {}  ({})", row.name, format_applied_at(row.applied_at));
            }
        }
    }
    Ok(ExitCode::SUCCESS)
}

fn print_usage() {
    println!(
        "
rivetos db — schema migration commands (Postgres or embedded PGlite)

Usage:
  rivetos db migrate [--config <path>] [--url <pg>]   Apply pending migrations (embedded: acquire or attach)
  rivetos db status [--config <path>]                 Show applied migrations (embedded: data dir, size, owner, port)

  --config / -c   Path to config.yaml (not forwarded to the migrator)
  --url           Bypass the embedded engine and target that Postgres URL
"
    );
}
