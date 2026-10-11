use std::collections::BTreeSet;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};

use rsa::RsaPrivateKey;
use x509_cert::ext::pkix::SubjectAltName;
use x509_cert::name::Name;
use x509_parser::certificate::X509Certificate;
use x509_parser::prelude::FromDer;

use crate::certs::{
    CertSpec, ca_constraints, ca_usage, client_eku, client_usage, issuer_name_from_pem,
    leaf_constraints, parse_san_list, server_eku, server_usage, sign_certificate,
};
use crate::error::{Error, wrap};
use crate::fsutil;
use crate::index::{self, IndexRow};
use crate::namefmt::{
    cn_matches, cn_org_ou, cn_then_org, oneline, openssl_subject_line, org_then_cn,
};
use crate::paths::CaPaths;
use crate::pemutil;
use crate::serial::{self, hex_from_raw, random_serial};
use crate::signer::{generate_rsa, load_rsa_pem, private_key_matches_cert, private_pkcs8_pem};
use crate::timeutil::{self, format_enddate, format_index_time, unix_now};
use crate::verify as verify_mod;

const ORG: &str = "Rivet Collective";
const ROOT_CN: &str = "Rivet Root CA";
const INT_CN: &str = "Rivet Intermediate CA";
const DAYS_ROOT: u64 = 3650;
const DAYS_INT: u64 = 1825;
const DAYS_LEAF: u64 = 90;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

struct SavedFile {
    path: PathBuf,
    previous: Option<Vec<u8>>,
    mode: u32,
}

fn logged(lines: &[String]) -> CommandOutput {
    let mut stderr = String::new();
    for line in lines {
        stderr.push_str("rivet-ca: ");
        stderr.push_str(line);
        stderr.push('\n');
    }
    CommandOutput {
        stdout: String::new(),
        stderr,
        code: 0,
    }
}

fn pad(text: &str, width: usize) -> String {
    if text.len() >= width {
        text.to_string()
    } else {
        let mut out = text.to_string();
        out.extend(std::iter::repeat_n(' ', width - text.len()));
        out
    }
}

fn set_mode(path: &Path, mode: u32) -> Result<(), Error> {
    fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    Ok(())
}

fn ensure_dirs(paths: &CaPaths) -> Result<(), Error> {
    fsutil::ensure_dir(&paths.root_dir)?;
    fsutil::ensure_dir(&paths.int_dir())?;
    fsutil::ensure_dir(&paths.issued_dir())?;
    set_mode(&paths.root_dir, 0o700)?;
    Ok(())
}

fn openssl_cnf(int_dir: &Path) -> String {
    format!(
        "[ ca ]
default_ca = rivet_int

[ rivet_int ]
dir               = {dir}
certs             = $dir
new_certs_dir     = $dir
database          = $dir/index.txt
serial            = $dir/int.srl
private_key       = $dir/int.key
certificate       = $dir/int.crt
default_md        = sha256
default_days      = 90
policy            = policy_loose
unique_subject    = no
copy_extensions   = copy
crlnumber         = $dir/crlnumber
crl               = $dir/../crl.pem
default_crl_days  = 30

[ policy_loose ]
commonName              = supplied
organizationName        = optional
countryName             = optional
stateOrProvinceName     = optional
localityName            = optional
organizationalUnitName  = optional

[ v3_server ]
basicConstraints     = critical, CA:FALSE
keyUsage             = critical, digitalSignature, keyEncipherment
extendedKeyUsage     = serverAuth, clientAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer

[ v3_client ]
basicConstraints     = critical, CA:FALSE
keyUsage             = critical, digitalSignature
extendedKeyUsage     = clientAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
",
        dir = int_dir.display()
    )
}

fn write_if_missing(path: &Path, bytes: &[u8]) -> Result<(), Error> {
    fsutil::reject_symlink(path)?;
    if path.exists() {
        return Ok(());
    }
    fsutil::replace_bytes(path, bytes, 0o644, false)
}

fn write_int_cnf(paths: &CaPaths) -> Result<(), Error> {
    let dir = paths.int_dir();
    fsutil::replace_bytes(
        &dir.join("openssl.cnf"),
        openssl_cnf(&dir).as_bytes(),
        0o644,
        false,
    )?;
    write_if_missing(&dir.join("index.txt"), b"")?;
    write_if_missing(&dir.join("crlnumber"), b"1000\n")?;
    write_if_missing(&dir.join("int.srl"), b"1000\n")?;
    Ok(())
}

fn load_or_create_key(path: &Path, bits: usize) -> Result<RsaPrivateKey, Error> {
    fsutil::reject_symlink(path)?;
    if path.exists() {
        return load_rsa_pem(&fsutil::read_text(path)?);
    }
    let key = generate_rsa(bits)?;
    fsutil::create_secret(path, private_pkcs8_pem(&key)?.as_bytes())?;
    Ok(key)
}

fn require_matching_pair(
    key_path: &Path,
    crt_path: &Path,
    missing: &str,
) -> Result<(RsaPrivateKey, String), Error> {
    fsutil::reject_symlink(key_path)?;
    fsutil::reject_symlink(crt_path)?;
    if !key_path.is_file() || !crt_path.is_file() {
        return Err(Error::msg(missing));
    }
    let key = load_rsa_pem(&fsutil::read_text(key_path)?)?;
    let crt_pem = fsutil::read_text(crt_path)?;
    private_key_matches_cert(&key, &crt_pem)?;
    Ok((key, crt_pem))
}

fn parsed_cert(pem: &str) -> Result<Vec<u8>, Error> {
    pemutil::first_certificate(pem.as_bytes())
}

fn remember(path: &Path, mode: u32, saved: &mut Vec<SavedFile>) -> Result<(), Error> {
    saved.push(SavedFile {
        path: path.to_path_buf(),
        previous: fsutil::read_optional(path)?,
        mode,
    });
    Ok(())
}

fn restore(saved: &[SavedFile]) -> Result<(), Error> {
    for item in saved.iter().rev() {
        match &item.previous {
            Some(bytes) => fsutil::replace_bytes(&item.path, bytes, item.mode, false)?,
            None => fsutil::remove_file(&item.path)?,
        }
    }
    Ok(())
}

fn commit_file(
    path: &Path,
    bytes: &[u8],
    mode: u32,
    keep_old: bool,
    saved: &mut Vec<SavedFile>,
) -> Result<(), Error> {
    if let Err(err) = remember(path, mode, saved) {
        return restore_or(saved, err);
    }
    if let Err(err) = fsutil::replace_bytes(path, bytes, mode, keep_old) {
        return restore_or(saved, err);
    }
    Ok(())
}

fn restore_or(saved: &[SavedFile], err: Error) -> Result<(), Error> {
    match restore(saved) {
        Ok(()) => Err(err),
        Err(rollback) => Err(Error::msg(format!("{err}; rollback failed: {rollback}"))),
    }
}

fn index_serials(rows: &[IndexRow]) -> Result<BTreeSet<u128>, Error> {
    let mut seen = BTreeSet::new();
    for row in rows {
        let value = serial::parse_hex_u128(&row.serial)
            .map_err(|err| Error::msg(format!("bad serial {} in index: {err}", row.serial)))?;
        if !seen.insert(value) {
            return Err(Error::msg(format!(
                "duplicate serial {} in index",
                serial::hex_u128(value)
            )));
        }
    }
    Ok(seen)
}

fn reserve_serial(counter: u128, used: &BTreeSet<u128>) -> Result<u128, Error> {
    if !used.contains(&counter) {
        return Ok(counter);
    }
    let max = used
        .iter()
        .next_back()
        .copied()
        .ok_or_else(|| Error::msg("serial overflow"))?;
    let candidate = max
        .checked_add(1)
        .ok_or_else(|| Error::msg("serial overflow"))?;
    if used.contains(&candidate) {
        return Err(Error::msg(format!(
            "serial {} already present in db",
            serial::hex_u128(candidate)
        )));
    }
    Ok(candidate)
}

struct LeafFiles {
    enddate: String,
}

fn issue_leaf(
    paths: &CaPaths,
    stem: &str,
    subject: Name,
    san: Option<SubjectAltName>,
    server: bool,
) -> Result<LeafFiles, Error> {
    write_int_cnf(paths)?;
    let key_path = paths.int_dir().join("int.key");
    let crt_path = paths.int_dir().join("int.crt");
    let (issuer_key, issuer_pem) = require_matching_pair(
        &key_path,
        &crt_path,
        "no intermediate — run 'issue-intermediate' first",
    )?;
    let issuer = issuer_name_from_pem(&issuer_pem)?;
    let leaf_key_path = paths.issued_dir().join(format!("{stem}.key"));
    let leaf_crt_path = paths.issued_dir().join(format!("{stem}.crt"));
    fsutil::reject_symlink(&leaf_key_path)?;
    fsutil::reject_symlink(&leaf_crt_path)?;
    let serial_path = paths.int_dir().join("int.srl");
    let index_path = paths.int_dir().join("index.txt");
    let mut rows = index::read_index(&index_path)?;
    let used = index_serials(&rows)?;
    let counter = serial::read_counter(&serial_path)?;
    let serial_value = reserve_serial(counter, &used)?;
    let next = serial_value
        .checked_add(1)
        .ok_or_else(|| Error::msg("serial overflow"))?;
    let serial_hex = serial::hex_u128(serial_value);
    let leaf_key = load_or_create_key(&leaf_key_path, 2048)?;
    let now = unix_now();
    let not_before = timeutil::time_at(now)?;
    let not_after = timeutil::time_at(now + DAYS_LEAF * 86400)?;
    let issued = sign_certificate(
        &leaf_key,
        &issuer_key,
        CertSpec {
            issuer,
            subject,
            serial: serial::serial_from_u128(serial_value)?,
            not_before,
            not_after,
            basic: leaf_constraints(),
            usage: if server {
                server_usage()
            } else {
                client_usage()
            },
            eku: Some(if server { server_eku() } else { client_eku() }),
            san,
        },
    )?;
    let der = parsed_cert(&issued.pem)?;
    let (_, certificate) = X509Certificate::from_der(&der)
        .map_err(|err| Error::msg(format!("parse issued cert: {err:?}")))?;
    let stamp = u64::try_from(certificate.validity().not_after.timestamp()).map_err(wrap)?;
    let when = timeutil::time_at(stamp)?;
    let row = IndexRow {
        status: "V".to_string(),
        expires: format_index_time(when),
        revoked: String::new(),
        serial: serial_hex.clone(),
        file: "unknown".to_string(),
        subject: oneline(certificate.subject()),
    };
    rows.push(row);
    let mut index_text = String::new();
    for item in &rows {
        index_text.push_str(&item.format_line());
    }
    let archive_path = paths.int_dir().join(format!("{serial_hex}.pem"));
    let mut saved = Vec::new();
    commit_file(
        &serial_path,
        format!("{}\n", serial::hex_u128(next)).as_bytes(),
        0o644,
        true,
        &mut saved,
    )?;
    commit_file(&index_path, index_text.as_bytes(), 0o644, true, &mut saved)?;
    commit_file(
        &leaf_crt_path,
        issued.pem.as_bytes(),
        0o644,
        false,
        &mut saved,
    )?;
    commit_file(
        &archive_path,
        issued.pem.as_bytes(),
        0o644,
        false,
        &mut saved,
    )?;
    fsutil::remove_file(&paths.issued_dir().join(format!("{stem}.csr")))?;
    index::ensure_attr(&paths.int_dir())?;
    Ok(LeafFiles {
        enddate: format_enddate(when),
    })
}

pub fn valid_path_component(id: &str) -> bool {
    if id.is_empty() || id.contains('\0') || id.contains('/') || id.contains("..") {
        return false;
    }
    let path = Path::new(id);
    match path.file_name().and_then(|name| name.to_str()) {
        Some(name) if name == id => {
            path.components().count() == 1
                && matches!(path.components().next(), Some(Component::Normal(_)))
        }
        _ => false,
    }
}

fn bad_component(label: &str, id: &str) -> Error {
    Error::msg(format!(
        "{label} must be a single path component without '/' or '..' (got: {id})"
    ))
}

pub fn init(paths: &CaPaths) -> Result<CommandOutput, Error> {
    fsutil::ensure_dir(&paths.root_dir)?;
    fsutil::with_dir_lock(&paths.root_dir, || init_locked(paths))
}

fn init_locked(paths: &CaPaths) -> Result<CommandOutput, Error> {
    set_mode(&paths.root_dir, 0o700)?;
    let key_path = paths.root_dir.join("ca.key");
    fsutil::reject_symlink(&key_path)?;
    if key_path.exists() {
        return Err(Error::msg(format!(
            "root already exists at {} — refusing to overwrite",
            key_path.display()
        )));
    }
    let mut lines = vec![format!(
        "generating root key + self-signed cert ({DAYS_ROOT} days) at {}",
        paths.root_dir.display()
    )];
    let subject = org_then_cn(ORG, ROOT_CN).map_err(|err| err.with_lines(&lines))?;
    let key = generate_rsa(4096).map_err(|err| err.with_lines(&lines))?;
    let pem = private_pkcs8_pem(&key).map_err(|err| err.with_lines(&lines))?;
    fsutil::create_secret(&key_path, pem.as_bytes()).map_err(|err| err.with_lines(&lines))?;
    let now = unix_now();
    let not_before = timeutil::time_at(now).map_err(|err| err.with_lines(&lines))?;
    let not_after =
        timeutil::time_at(now + DAYS_ROOT * 86400).map_err(|err| err.with_lines(&lines))?;
    let serial = random_serial().map_err(|err| err.with_lines(&lines))?;
    let issued = sign_certificate(
        &key,
        &key,
        CertSpec {
            issuer: subject.clone(),
            subject,
            serial,
            not_before,
            not_after,
            basic: ca_constraints(None),
            usage: ca_usage(),
            eku: None,
            san: None,
        },
    )
    .map_err(|err| err.with_lines(&lines))?;
    fsutil::replace_bytes(
        &paths.root_dir.join("ca.crt"),
        issued.pem.as_bytes(),
        0o644,
        false,
    )
    .map_err(|err| err.with_lines(&lines))?;
    fsutil::replace_bytes(&paths.root_dir.join("ca.srl"), b"1000\n", 0o644, false)
        .map_err(|err| err.with_lines(&lines))?;
    lines.push(format!(
        "root cert: {}",
        paths.root_dir.join("ca.crt").display()
    ));
    lines.push(format!(
        "root key:  {}  (KEEP OFFLINE / LOCAL ONLY)",
        key_path.display()
    ));
    Ok(logged(&lines))
}

pub fn issue_intermediate(paths: &CaPaths) -> Result<CommandOutput, Error> {
    ensure_dirs(paths)?;
    fsutil::with_both_locks(&paths.root_dir, &paths.shared_dir, || {
        issue_intermediate_locked(paths)
    })
}

fn issue_intermediate_locked(paths: &CaPaths) -> Result<CommandOutput, Error> {
    let root_key_path = paths.root_dir.join("ca.key");
    let root_crt_path = paths.root_dir.join("ca.crt");
    let int_key_path = paths.int_dir().join("int.key");
    fsutil::reject_symlink(&root_key_path)?;
    fsutil::reject_symlink(&root_crt_path)?;
    fsutil::reject_symlink(&int_key_path)?;
    if !root_key_path.is_file() || !root_crt_path.is_file() {
        return Err(Error::msg("no root — run 'init' first"));
    }
    if int_key_path.exists() {
        return Err(Error::msg(format!(
            "intermediate already exists at {}",
            int_key_path.display()
        )));
    }
    let root_key = load_rsa_pem(&fsutil::read_text(&root_key_path)?)?;
    let root_pem = fsutil::read_text(&root_crt_path)?;
    private_key_matches_cert(&root_key, &root_pem)?;
    let mut lines = vec![format!(
        "generating intermediate key + CSR ({DAYS_INT} days)"
    )];
    let issuer = issuer_name_from_pem(&root_pem).map_err(|err| err.with_lines(&lines))?;
    let subject = org_then_cn(ORG, INT_CN).map_err(|err| err.with_lines(&lines))?;
    let key = generate_rsa(4096).map_err(|err| err.with_lines(&lines))?;
    let key_pem = private_pkcs8_pem(&key).map_err(|err| err.with_lines(&lines))?;
    fsutil::create_secret(&int_key_path, key_pem.as_bytes())
        .map_err(|err| err.with_lines(&lines))?;
    lines.push("signing intermediate with root".to_string());
    let serial_path = paths.root_dir.join("ca.srl");
    let current = serial::read_counter(&serial_path).map_err(|err| err.with_lines(&lines))?;
    let serial_value = current
        .checked_add(1)
        .ok_or_else(|| Error::msg("serial overflow"))
        .map_err(|err| err.with_lines(&lines))?;
    let now = unix_now();
    let serial = serial::serial_from_u128(serial_value).map_err(|err| err.with_lines(&lines))?;
    let not_before = timeutil::time_at(now).map_err(|err| err.with_lines(&lines))?;
    let not_after =
        timeutil::time_at(now + DAYS_INT * 86400).map_err(|err| err.with_lines(&lines))?;
    let issued = sign_certificate(
        &key,
        &root_key,
        CertSpec {
            issuer,
            subject,
            serial,
            not_before,
            not_after,
            basic: ca_constraints(Some(0)),
            usage: ca_usage(),
            eku: None,
            san: None,
        },
    )
    .map_err(|err| err.with_lines(&lines))?;
    serial::write_counter(&serial_path, serial_value, false)
        .map_err(|err| err.with_lines(&lines))?;
    let int_crt = paths.int_dir().join("int.crt");
    fsutil::replace_bytes(&int_crt, issued.pem.as_bytes(), 0o644, false)
        .map_err(|err| err.with_lines(&lines))?;
    fsutil::remove_file(&paths.int_dir().join("int.csr")).map_err(|err| err.with_lines(&lines))?;
    let mut chain = fsutil::read_optional(&int_crt)
        .map_err(|err| err.with_lines(&lines))?
        .ok_or_else(|| Error::msg("intermediate cert missing after write"))
        .map_err(|err| err.with_lines(&lines))?;
    chain.extend(
        fsutil::read_optional(&root_crt_path)
            .map_err(|err| err.with_lines(&lines))?
            .ok_or_else(|| Error::msg("root cert missing"))
            .map_err(|err| err.with_lines(&lines))?,
    );
    let chain_path = paths.chain_path();
    fsutil::replace_bytes(&chain_path, &chain, 0o644, false)
        .map_err(|err| err.with_lines(&lines))?;
    fsutil::replace_bytes(&paths.int_dir().join("ca-chain.pem"), &chain, 0o644, false)
        .map_err(|err| err.with_lines(&lines))?;
    let crl_out = crl_locked(paths).map_err(|err| err.with_lines(&lines))?;
    let mut stderr = logged(&lines).stderr;
    stderr.push_str(&crl_out.stderr);
    stderr.push_str(
        &logged(&[
            format!("intermediate cert: {}", int_crt.display()),
            format!("chain bundle:      {}", chain_path.display()),
        ])
        .stderr,
    );
    Ok(CommandOutput {
        stdout: String::new(),
        stderr,
        code: crl_out.code,
    })
}

pub fn node_sans(node_id: &str, extras: &[String]) -> String {
    let mut sans =
        format!("DNS:{node_id}.mesh,DNS:{node_id}-mcp.mesh,DNS:{node_id}-runtime-rpc.mesh");
    for extra in extras {
        sans.push(',');
        if extra.starts_with("DNS:")
            || extra.starts_with("IP:")
            || extra.starts_with("URI:")
            || extra.starts_with("email:")
        {
            sans.push_str(extra);
        } else {
            sans.push_str("DNS:");
            sans.push_str(extra);
        }
    }
    sans
}

pub fn issue_node(
    paths: &CaPaths,
    node_id: &str,
    extras: &[String],
) -> Result<CommandOutput, Error> {
    if node_id.is_empty() {
        return Err(Error::msg("usage: issue-node <node-id> [extra-san ...]"));
    }
    if !valid_path_component(node_id) {
        return Err(bad_component("node-id", node_id));
    }
    ensure_dirs(paths)?;
    fsutil::with_dir_lock(&paths.shared_dir, || {
        issue_node_locked(paths, node_id, extras)
    })
}

fn issue_node_locked(
    paths: &CaPaths,
    node_id: &str,
    extras: &[String],
) -> Result<CommandOutput, Error> {
    let crt = paths.issued_dir().join(format!("{node_id}.crt"));
    let mut lines = Vec::new();
    if crt.exists() {
        lines.push(format!(
            "WARN: {} exists — renewing (key reused if present)",
            crt.display()
        ));
    }
    let sans = node_sans(node_id, extras);
    let subject =
        cn_then_org(ORG, &format!("{node_id}.mesh")).map_err(|err| err.with_lines(&lines))?;
    let san = parse_san_list(&sans).map_err(|err| err.with_lines(&lines))?;
    let leaf = issue_leaf(paths, node_id, subject, Some(san), true)
        .map_err(|err| err.with_lines(&lines))?;
    lines.push(format!("issued node cert: {}", crt.display()));
    lines.push(format!("  SANs: {sans}"));
    lines.push(format!("  expires: {}", leaf.enddate));
    Ok(logged(&lines))
}

pub fn issue_agent(paths: &CaPaths, agent_id: &str, node_id: &str) -> Result<CommandOutput, Error> {
    if agent_id.is_empty() || node_id.is_empty() {
        return Err(Error::msg("usage: issue-agent <agent-id> <node-id>"));
    }
    if !valid_path_component(agent_id) {
        return Err(bad_component("agent-id", agent_id));
    }
    if !valid_path_component(node_id) {
        return Err(bad_component("node-id", node_id));
    }
    ensure_dirs(paths)?;
    fsutil::with_dir_lock(&paths.shared_dir, || {
        issue_agent_locked(paths, agent_id, node_id)
    })
}

fn issue_agent_locked(
    paths: &CaPaths,
    agent_id: &str,
    node_id: &str,
) -> Result<CommandOutput, Error> {
    let cn = format!("{agent_id}@{node_id}");
    let crt = paths.issued_dir().join(format!("{cn}.crt"));
    let subject = cn_then_org(ORG, &cn)?;
    let leaf = issue_leaf(paths, &cn, subject, None, false)?;
    Ok(logged(&[
        format!("issued agent cert: {}  (CN={cn})", crt.display()),
        format!("  expires: {}", leaf.enddate),
    ]))
}

pub fn valid_device_id(device_id: &str) -> bool {
    let mut chars = device_id.chars();
    match chars.next() {
        Some(ch) if ch.is_ascii_alphanumeric() => {
            chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        }
        _ => false,
    }
}

pub fn issue_client(paths: &CaPaths, device_id: &str) -> Result<CommandOutput, Error> {
    if device_id.is_empty() {
        return Err(Error::msg(
            "usage: issue-client <device-id>   (e.g. pixel-owner, desk-chrome)",
        ));
    }
    if !valid_device_id(device_id) {
        return Err(Error::msg(format!(
            "device-id must be alphanumeric / . _ - (got: {device_id})"
        )));
    }
    ensure_dirs(paths)?;
    fsutil::with_dir_lock(&paths.shared_dir, || issue_client_locked(paths, device_id))
}

fn issue_client_locked(paths: &CaPaths, device_id: &str) -> Result<CommandOutput, Error> {
    let cn = format!("device:{device_id}");
    let stem = format!("device-{device_id}");
    let crt = paths.issued_dir().join(format!("{stem}.crt"));
    let subject = cn_org_ou(ORG, "client", &cn)?;
    let leaf = issue_leaf(paths, &stem, subject, None, false)?;
    Ok(logged(&[
        format!(
            "issued device client cert: {}  (CN={cn} OU=client)",
            crt.display()
        ),
        "  install on the device only — do not publish the .key".to_string(),
        format!("  expires: {}", leaf.enddate),
    ]))
}

fn issued_certs(dir: &Path) -> Result<Vec<PathBuf>, Error> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("crt") {
            files.push(path);
        }
    }
    files.sort();
    Ok(files)
}

pub fn revoke(paths: &CaPaths, cn: &str) -> Result<CommandOutput, Error> {
    if cn.is_empty() {
        return Err(Error::msg(
            "usage: revoke <cn>   (e.g. node-b.mesh, opus@node-b)",
        ));
    }
    fsutil::with_dir_lock(&paths.shared_dir, || revoke_locked(paths, cn))
}

fn revoke_failed(path: &Path, message: &str) -> CommandOutput {
    CommandOutput {
        stdout: String::new(),
        stderr: format!("rivet-ca: revoking {}\n{message}\n", path.display()),
        code: 1,
    }
}

fn revoke_locked(paths: &CaPaths, cn: &str) -> Result<CommandOutput, Error> {
    write_int_cnf(paths)?;
    let mut target = None;
    for path in issued_certs(&paths.issued_dir())? {
        let bytes = fs::read(&path)?;
        let Ok(der) = pemutil::first_certificate(&bytes) else {
            continue;
        };
        let Ok((_, certificate)) = X509Certificate::from_der(&der) else {
            continue;
        };
        if cn_matches(&openssl_subject_line(certificate.subject()), cn) {
            target = Some((path, hex_from_raw(certificate.raw_serial())));
            break;
        }
    }
    let Some((path, serial_hex)) = target else {
        return Err(Error::msg(format!("no issued cert with CN={cn}")));
    };
    let prefix = vec![format!("revoking {}", path.display())];
    let index_path = paths.int_dir().join("index.txt");
    let mut rows = index::read_index(&index_path).map_err(|err| err.with_lines(&prefix))?;
    index_serials(&rows).map_err(|err| err.with_lines(&prefix))?;
    let mut found = false;
    for row in &mut rows {
        if serial::same_serial(&row.serial, &serial_hex) {
            if row.status == "R" {
                return Ok(revoke_failed(
                    &path,
                    &format!("ERROR:Already revoked, serial number {}", row.serial),
                ));
            }
            row.status = "R".to_string();
            let now = timeutil::time_at(unix_now()).map_err(|err| err.with_lines(&prefix))?;
            row.revoked = format_index_time(now);
            found = true;
            break;
        }
    }
    if !found {
        return Ok(revoke_failed(
            &path,
            &format!("ERROR:Serial number {serial_hex} not present in db"),
        ));
    }
    let mut saved = Vec::new();
    let mut index_text = String::new();
    for row in &rows {
        index_text.push_str(&row.format_line());
    }
    commit_file(&index_path, index_text.as_bytes(), 0o644, true, &mut saved)
        .map_err(|err| err.with_lines(&prefix))?;
    let crl_out = crl_locked(paths).map_err(|err| err.with_lines(&prefix))?;
    index::ensure_attr(&paths.int_dir()).map_err(|err| err.with_lines(&prefix))?;
    let mut stderr = logged(&prefix).stderr;
    stderr.push_str(&crl_out.stderr);
    Ok(CommandOutput {
        stdout: String::new(),
        stderr,
        code: crl_out.code,
    })
}

pub fn crl(paths: &CaPaths) -> Result<CommandOutput, Error> {
    fsutil::with_dir_lock(&paths.shared_dir, || crl_locked(paths))
}

fn crl_locked(paths: &CaPaths) -> Result<CommandOutput, Error> {
    write_int_cnf(paths)?;
    let key_path = paths.int_dir().join("int.key");
    let crt_path = paths.int_dir().join("int.crt");
    let (key, crt_pem) = require_matching_pair(
        &key_path,
        &crt_path,
        "no intermediate — run 'issue-intermediate' first",
    )?;
    let issuer = issuer_name_from_pem(&crt_pem)?;
    let number_path = paths.int_dir().join("crlnumber");
    let crl_number = serial::read_counter(&number_path)?;
    let next = crl_number
        .checked_add(1)
        .ok_or_else(|| Error::msg("serial overflow"))?;
    let rows = index::read_index(&paths.int_dir().join("index.txt"))?;
    let key_pem = private_pkcs8_pem(&key)?;
    let pem = crate::crl::build_crl_pem(&key_pem, issuer, &rows, crl_number, unix_now())?;
    let mut saved = Vec::new();
    commit_file(
        &number_path,
        format!("{}\n", serial::hex_u128(next)).as_bytes(),
        0o644,
        true,
        &mut saved,
    )?;
    commit_file(
        paths.crl_path().as_path(),
        pem.as_bytes(),
        0o644,
        false,
        &mut saved,
    )?;
    index::ensure_attr(&paths.int_dir())?;
    Ok(logged(&[format!(
        "CRL written: {}",
        paths.crl_path().display()
    )]))
}

pub fn verify(paths: &CaPaths, cert: &Path) -> Result<CommandOutput, Error> {
    if !cert.is_file() {
        return Err(Error::msg("usage: verify <cert-path>"));
    }
    let out = verify_mod::verify_cert(&paths.chain_path(), &paths.crl_path(), cert);
    Ok(CommandOutput {
        stdout: out.stdout,
        stderr: out.stderr,
        code: out.code,
    })
}

pub fn list_issued(paths: &CaPaths) -> Result<CommandOutput, Error> {
    let mut stdout = format!("{} {} {}\n", pad("CN", 40), pad("EXPIRES", 25), "FILE");
    for path in issued_certs(&paths.issued_dir())? {
        let bytes = fs::read(&path)?;
        let der = pemutil::first_certificate(&bytes)?;
        let (_, certificate) = X509Certificate::from_der(&der)
            .map_err(|err| Error::msg(format!("parse {}: {err:?}", path.display())))?;
        let subject = openssl_subject_line(certificate.subject());
        let stamp = u64::try_from(certificate.validity().not_after.timestamp()).map_err(wrap)?;
        let expires = format_enddate(timeutil::time_at(stamp)?);
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        stdout.push_str(&format!(
            "{} {} {}\n",
            pad(&subject, 40),
            pad(&expires, 25),
            name
        ));
    }
    Ok(CommandOutput {
        stdout,
        stderr: String::new(),
        code: 0,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::{index_serials, reserve_serial, valid_path_component};
    use crate::index::IndexRow;

    fn row(serial: &str) -> IndexRow {
        IndexRow {
            status: "V".to_string(),
            expires: "270101000000Z".to_string(),
            revoked: String::new(),
            serial: serial.to_string(),
            file: "unknown".to_string(),
            subject: "/CN=node".to_string(),
        }
    }

    #[test]
    fn path_component_rejects_traversal() {
        assert!(valid_path_component("node-a"));
        assert!(valid_path_component("opus"));
        assert!(!valid_path_component("../x"));
        assert!(!valid_path_component("a/b"));
        assert!(!valid_path_component("a..b"));
        assert!(!valid_path_component("a\0b"));
        assert!(!valid_path_component("."));
        assert!(!valid_path_component(".."));
        assert!(!valid_path_component(""));
    }

    #[test]
    fn reserve_skips_a_serial_already_recorded() {
        let mut used = BTreeSet::new();
        used.insert(0x1000);
        assert_eq!(reserve_serial(0x1000, &used).unwrap(), 0x1001);
        used.insert(0x1005);
        assert_eq!(reserve_serial(0x1000, &used).unwrap(), 0x1006);
        assert_eq!(reserve_serial(0x1002, &used).unwrap(), 0x1002);
    }

    #[test]
    fn duplicate_serials_fail_closed() {
        let err = index_serials(&[row("1000"), row("01000")]).unwrap_err();
        assert_eq!(err.to_string(), "duplicate serial 1000 in index");
        assert!(index_serials(&[row("1000"), row("1001")]).is_ok());
    }
}
