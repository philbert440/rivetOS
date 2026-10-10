use std::process::ExitCode;

use clap::{Parser, Subcommand};
use memory::{format_applied_at, migrate_database, migration_status, MigrationStatus};

#[derive(Parser)]
#[command(name = "rivetos", about = "RivetOS command line")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    #[command(about = "Schema migration commands (Postgres or embedded PGlite)")]
    Db {
        #[command(subcommand)]
        action: Option<DbAction>,
    },
}

#[derive(Subcommand)]
enum DbAction {
    #[command(about = "Apply pending migrations to Postgres (--url or RIVETOS_PG_URL)")]
    Migrate {
        #[arg(long, help = "Bypass configuration and target that Postgres URL")]
        url: Option<String>,
        #[arg(long, help = "Record pending migrations as applied without running them")]
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

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        let _ = Cli::parse_from(std::env::args());
        return ExitCode::SUCCESS;
    }
    match dispatch(&args) {
        Ok(code) => code,
        Err(message) => {
            eprintln!("[migrate] fatal: {message}");
            ExitCode::from(1)
        }
    }
}

fn dispatch(args: &[String]) -> Result<ExitCode, String> {
    if args.first().map(String::as_str) != Some("db") {
        print_usage();
        return Ok(if args.is_empty() { ExitCode::SUCCESS } else { ExitCode::from(1) });
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
        Some("migrate") => migrate(&rest[1..]),
        Some("status") => status(),
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

fn migrate(args: &[String]) -> Result<ExitCode, String> {
    let baseline = args.iter().any(|arg| arg == "--baseline");
    let url = if let Some(index) = args.iter().position(|arg| arg == "--url") {
        args.get(index + 1).cloned().filter(|value| !value.is_empty())
    } else {
        std::env::var("RIVETOS_PG_URL").ok().filter(|value| !value.is_empty())
    };
    let Some(url) = url else {
        eprintln!("[migrate] RIVETOS_PG_URL not set (or pass --url <pg-url>)");
        return Ok(ExitCode::from(1));
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| err.to_string())?;
    runtime.block_on(migrate_database(&url, baseline)).map_err(|err| err.to_string())?;
    Ok(ExitCode::SUCCESS)
}

fn status() -> Result<ExitCode, String> {
    let url = std::env::var("RIVETOS_PG_URL").ok().filter(|value| !value.is_empty());
    let Some(url) = url else {
        eprintln!("[db status] RIVETOS_PG_URL not set");
        return Ok(ExitCode::from(1));
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| err.to_string())?;
    let report = match runtime.block_on(migration_status(&url)) {
        Ok(report) => report,
        Err(err) => {
            eprintln!("{err}");
            return Ok(ExitCode::from(1));
        }
    };
    match report {
        MigrationStatus::MissingTable => {
            println!("[db status] _rivetos_migrations table does not exist (no migrations applied yet)");
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
