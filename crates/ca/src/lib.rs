mod certs;
mod cli;
mod crl;
mod error;
mod index;
mod namefmt;
mod p12;
mod paths;
mod pemutil;
mod serial;
mod signer;
mod store;
mod timeutil;
mod verify;

pub use error::Error;
pub use p12::{export_pkcs12, mint_device_p12};
pub use paths::CaPaths;
pub use store::{
    CommandOutput, crl, init, issue_agent, issue_client, issue_intermediate, issue_node,
    list_issued, revoke, valid_device_id, verify,
};

pub fn run(
    args: &[String],
    paths: &CaPaths,
    stdout: &mut dyn std::io::Write,
    stderr: &mut dyn std::io::Write,
) -> i32 {
    cli::run(args, paths, stdout, stderr)
}
