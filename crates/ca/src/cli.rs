use std::io::Write;
use std::path::Path;

use crate::error::Error;
use crate::paths::CaPaths;
use crate::store::{self, CommandOutput};

const HELP: &str = "\
rivet-ca.sh — single-CA trust root for the Rivet collective.

See docs/mcp-auth.md for the design. Layout:

  $ROOT_DIR (default /var/lib/rivet-ca/root, CA-host local disk only)
    ├── ca.crt                self-signed root (10y)
    ├── ca.key                root private key — chmod 600, do not copy
    ├── ca.srl                serial state for root signing
    └── index.txt             (unused, kept for future openssl ca)

  $SHARED_DIR (default /rivet-shared/rivet-ca, NFS-visible)
    ├── intermediate/
    │   ├── int.crt           5y, signed by root
    │   ├── int.key           600
    │   ├── int.srl
    │   ├── chain.pem         root + intermediate
    │   ├── index.txt         openssl ca DB (issued/revoked log)
    │   └── openssl.cnf       config used by `openssl ca`
    ├── crl.pem               regenerated on every revoke
    └── issued/
        ├── <node-id>.{crt,key}                 server cert, multi-SAN (mesh/gateway)
        ├── <agent-id>@<node-id>.{crt,key}      mesh agent client cert
        └── device-<id>.{crt,key}               Hub/device client cert (OU=client)

Subcommands:
  init                              generate root (idempotent: bails if exists)
  issue-intermediate                generate intermediate signed by root
  issue-node <node-id> [san ...]    issue server cert with SANs
  issue-agent <agent-id> <node-id>  issue mesh agent client cert
  issue-client <device-id>          issue Hub/device client cert (admin enroll)
  revoke <cn>                       revoke a leaf, rebuild CRL
  crl                               regenerate CRL (no revoke)
  verify <cert-path>                verify a cert against the chain
  list                              list issued certs

Cert lifetimes:
  Root: 10y    Intermediate: 5y    Node/Agent leaf: 90d (renew at 60d)

set -euo pipefail
";

pub fn run(
    args: &[String],
    paths: &CaPaths,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> i32 {
    let sub = args.first().map(String::as_str).unwrap_or("");
    tracing::info!(subcommand = sub, "rivet-ca invoked");
    let result = dispatch(sub, args, paths);
    match result {
        Ok(output) => emit(stdout, stderr, &output),
        Err(err) => {
            let _ = writeln!(stderr, "rivet-ca: {err}");
            1
        }
    }
}

fn emit(stdout: &mut dyn Write, stderr: &mut dyn Write, output: &CommandOutput) -> i32 {
    if stdout.write_all(output.stdout.as_bytes()).is_err() {
        return 1;
    }
    if stderr.write_all(output.stderr.as_bytes()).is_err() {
        return 1;
    }
    let _ = stdout.flush();
    let _ = stderr.flush();
    output.code
}

fn dispatch(sub: &str, args: &[String], paths: &CaPaths) -> Result<CommandOutput, Error> {
    match sub {
        "" | "-h" | "--help" => Ok(CommandOutput {
            stdout: HELP.to_string(),
            stderr: String::new(),
            code: 0,
        }),
        "init" => store::init(paths),
        "issue-intermediate" => store::issue_intermediate(paths),
        "issue-node" => {
            let node_id = args.get(1).map(String::as_str).unwrap_or("");
            let extras = if args.len() > 2 {
                args[2..].to_vec()
            } else {
                Vec::new()
            };
            store::issue_node(paths, node_id, &extras)
        }
        "issue-agent" => store::issue_agent(
            paths,
            args.get(1).map(String::as_str).unwrap_or(""),
            args.get(2).map(String::as_str).unwrap_or(""),
        ),
        "issue-client" => store::issue_client(paths, args.get(1).map(String::as_str).unwrap_or("")),
        "revoke" => store::revoke(paths, args.get(1).map(String::as_str).unwrap_or("")),
        "crl" => store::crl(paths),
        "verify" => store::verify(
            paths,
            Path::new(args.get(1).map(String::as_str).unwrap_or("")),
        ),
        "list" => store::list_issued(paths),
        other => Err(Error::msg(format!(
            "unknown subcommand: {other}  (try --help)"
        ))),
    }
}
