use std::ffi::OsString;
use std::process::ExitCode;

use clap::{Args, Subcommand};

use crate::{MigrationStatus, format_applied_at, migrate_database, migration_status};

#[derive(Args, Debug)]
#[command(about = "Schema migration commands (Postgres or embedded PGlite)")]
pub struct DbArgs {
    #[command(subcommand)]
    pub action: Option<DbAction>,
    #[arg(
        long,
        short = 'c',
        global = true,
        help = "Path to config.yaml (not forwarded to the migrator)"
    )]
    pub config: Option<String>,
}

impl DbArgs {
    pub fn usage_only() -> Self {
        Self {
            action: None,
            config: None,
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
            trailing_var_arg = true,
            allow_hyphen_values = true,
            hide = true,
            help = "Additional arguments are ignored"
        )]
        extra: Vec<String>,
    },
    #[command(about = "Show applied migrations on the configured Postgres")]
    Status {
        #[arg(
            trailing_var_arg = true,
            allow_hyphen_values = true,
            hide = true,
            help = "Additional arguments are ignored"
        )]
        extra: Vec<String>,
    },
    #[command(external_subcommand, hide = true, about = "Unrecognized db action")]
    Other(Vec<OsString>),
}

pub fn reject_bad_config(args: impl IntoIterator<Item = String>) -> Result<(), String> {
    let args: Vec<String> = args.into_iter().collect();
    if args.get(1).map(String::as_str) != Some("db") {
        return Ok(());
    }
    let mut index = 2;
    while index < args.len() {
        if args[index] == "--config" || args[index] == "-c" {
            let next = args.get(index + 1);
            if next.is_none() || next.is_some_and(|value| value.starts_with('-')) {
                return Err("db: --config requires a path".to_string());
            }
            index += 2;
            continue;
        }
        index += 1;
    }
    Ok(())
}

pub fn migrate_url_error(args: impl IntoIterator<Item = String>) -> Result<(), String> {
    let args: Vec<String> = args.into_iter().collect();
    if args.get(1).map(String::as_str) != Some("db") {
        return Ok(());
    }
    let mut rest = Vec::new();
    let mut index = 2;
    while index < args.len() {
        if args[index] == "--config" || args[index] == "-c" {
            index += 2;
            continue;
        }
        rest.push(args[index].clone());
        index += 1;
    }
    if rest.first().map(String::as_str) != Some("migrate") {
        return Ok(());
    }
    if let Some(pos) = rest.iter().position(|arg| arg == "--url")
        && rest.get(pos + 1).is_none()
    {
        return Err("[migrate] RIVETOS_PG_URL not set (or pass --url <pg-url>)".to_string());
    }
    Ok(())
}

pub async fn run(args: DbArgs) -> ExitCode {
    let _embedded_config_deferred = args.config;
    match args.action {
        None => {
            print_usage();
            ExitCode::SUCCESS
        }
        Some(DbAction::Migrate {
            url,
            baseline,
            extra: _,
        }) => match migrate(url, baseline).await {
            Ok(code) => code,
            Err(message) => {
                eprintln!("[migrate] fatal: {message}");
                ExitCode::from(1)
            }
        },
        Some(DbAction::Status { extra: _ }) => match status().await {
            Ok(code) => code,
            Err(message) => {
                eprintln!("[migrate] fatal: {message}");
                ExitCode::from(1)
            }
        },
        Some(DbAction::Other(_)) => {
            print_usage();
            ExitCode::from(1)
        }
    }
}

async fn migrate(url_flag: Option<String>, baseline: bool) -> Result<ExitCode, String> {
    let url = match url_flag {
        Some(url) if !url.is_empty() => Some(url),
        Some(_) => None,
        None => std::env::var("RIVETOS_PG_URL")
            .ok()
            .filter(|value| !value.is_empty()),
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

#[cfg(test)]
mod tests {
    use clap::{Parser, Subcommand};

    use super::{DbAction, DbArgs, migrate_url_error, reject_bad_config};

    #[derive(Parser)]
    #[command(name = "rivetos")]
    struct Probe {
        #[command(subcommand)]
        command: Option<ProbeCommand>,
    }

    #[derive(Subcommand)]
    enum ProbeCommand {
        Db(DbArgs),
    }

    fn parse(args: &[&str]) -> Probe {
        Probe::try_parse_from(args).expect("parse")
    }

    #[test]
    fn composed_db_keeps_config_before_the_action() {
        let probe = parse(&[
            "rivetos",
            "db",
            "--config",
            "c.yaml",
            "migrate",
            "--url",
            "postgres://db",
            "--baseline",
        ]);
        let ProbeCommand::Db(args) = probe.command.expect("db");
        assert_eq!(args.config.as_deref(), Some("c.yaml"));
        match args.action {
            Some(DbAction::Migrate {
                url,
                baseline,
                extra,
            }) => {
                assert_eq!(url.as_deref(), Some("postgres://db"));
                assert!(baseline);
                assert!(extra.is_empty());
            }
            other => panic!("migrate, got {other:?}"),
        }
        let after = parse(&[
            "rivetos", "db", "status", "-c", "c.yaml", "--url", "ignored",
        ]);
        let ProbeCommand::Db(args) = after.command.expect("db");
        assert_eq!(args.config.as_deref(), Some("c.yaml"));
        assert!(matches!(args.action, Some(DbAction::Status { .. })));
        assert!(parse(&["rivetos"]).command.is_none());
        let unknown = parse(&["rivetos", "db", "nope"]);
        let ProbeCommand::Db(args) = unknown.command.expect("db");
        assert!(matches!(args.action, Some(DbAction::Other(_))));
        assert_eq!(
            reject_bad_config(
                ["rivetos", "db", "--config"]
                    .into_iter()
                    .map(str::to_string)
            )
            .expect_err("missing"),
            "db: --config requires a path"
        );
        assert!(
            reject_bad_config(
                ["rivetos", "db", "migrate", "--config", "c.yaml"]
                    .into_iter()
                    .map(str::to_string)
            )
            .is_ok()
        );
        assert_eq!(
            migrate_url_error(
                ["rivetos", "db", "migrate", "--config", "c.yaml", "--url"]
                    .into_iter()
                    .map(str::to_string)
            )
            .expect_err("bare url"),
            "[migrate] RIVETOS_PG_URL not set (or pass --url <pg-url>)"
        );
        assert!(
            migrate_url_error(
                ["rivetos", "db", "migrate", "--url", "postgres://db"]
                    .into_iter()
                    .map(str::to_string)
            )
            .is_ok()
        );
        assert!(
            migrate_url_error(
                ["rivetos", "db", "status", "--url"]
                    .into_iter()
                    .map(str::to_string)
            )
            .is_ok()
        );
    }
}
