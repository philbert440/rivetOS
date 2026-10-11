use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

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
use crate::index::{self, IndexRow};
use crate::namefmt::{
    cn_matches, cn_org_ou, cn_then_org, oneline, openssl_subject_line, org_then_cn,
};
use crate::paths::CaPaths;
use crate::pemutil;
use crate::serial::{self, hex_from_raw, random_serial};
use crate::signer::{generate_rsa, load_rsa_pem, private_pkcs8_pem};
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
    fs::create_dir_all(&paths.root_dir)?;
    fs::create_dir_all(paths.int_dir())?;
    fs::create_dir_all(paths.issued_dir())?;
    set_mode(&paths.root_dir, 0o700)?;
    Ok(())
}

fn remove_if_exists(path: &Path) -> Result<(), Error> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
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

fn write_int_cnf(paths: &CaPaths) -> Result<(), Error> {
    let dir = paths.int_dir();
    fs::write(dir.join("openssl.cnf"), openssl_cnf(&dir))?;
    let index = dir.join("index.txt");
    if !index.exists() {
        fs::write(&index, "")?;
    }
    let crlnumber = dir.join("crlnumber");
    if !crlnumber.exists() {
        fs::write(&crlnumber, "1000\n")?;
    }
    let serial_path = dir.join("int.srl");
    if !serial_path.exists() {
        fs::write(&serial_path, "1000\n")?;
    }
    Ok(())
}

fn load_or_create_key(path: &Path, bits: usize) -> Result<RsaPrivateKey, Error> {
    if path.exists() {
        return load_rsa_pem(&fs::read_to_string(path)?);
    }
    let key = generate_rsa(bits)?;
    fs::write(path, private_pkcs8_pem(&key)?)?;
    set_mode(path, 0o600)?;
    Ok(key)
}

fn parsed_cert(pem: &str) -> Result<Vec<u8>, Error> {
    pemutil::first_certificate(pem.as_bytes())
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
    if !key_path.is_file() || !crt_path.is_file() {
        return Err(Error::msg(
            "no intermediate — run 'issue-intermediate' first",
        ));
    }
    let issuer_key = load_rsa_pem(&fs::read_to_string(&key_path)?)?;
    let issuer = issuer_name_from_pem(&fs::read_to_string(&crt_path)?)?;
    let leaf_key_path = paths.issued_dir().join(format!("{stem}.key"));
    let leaf_crt_path = paths.issued_dir().join(format!("{stem}.crt"));
    let leaf_key = load_or_create_key(&leaf_key_path, 2048)?;
    let serial_value = serial::use_then_increment(&paths.int_dir().join("int.srl"))?;
    let serial_hex = serial::hex_u128(serial_value);
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
    fs::write(&leaf_crt_path, &issued.pem)?;
    fs::write(
        paths.int_dir().join(format!("{serial_hex}.pem")),
        &issued.pem,
    )?;
    remove_if_exists(&paths.issued_dir().join(format!("{stem}.csr")))?;
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
    let index_path = paths.int_dir().join("index.txt");
    let mut rows = index::read_index(&index_path)?;
    rows.push(row.clone());
    index::write_index(&index_path, &rows)?;
    index::ensure_attr(&paths.int_dir())?;
    Ok(LeafFiles {
        enddate: format_enddate(when),
    })
}

pub fn init(paths: &CaPaths) -> Result<CommandOutput, Error> {
    ensure_dirs(paths)?;
    let key_path = paths.root_dir.join("ca.key");
    if key_path.exists() {
        return Err(Error::msg(format!(
            "root already exists at {} — refusing to overwrite",
            key_path.display()
        )));
    }
    let subject = org_then_cn(ORG, ROOT_CN)?;
    let key = generate_rsa(4096)?;
    fs::write(&key_path, private_pkcs8_pem(&key)?)?;
    set_mode(&key_path, 0o600)?;
    let now = unix_now();
    let issued = sign_certificate(
        &key,
        &key,
        CertSpec {
            issuer: subject.clone(),
            subject,
            serial: random_serial()?,
            not_before: timeutil::time_at(now)?,
            not_after: timeutil::time_at(now + DAYS_ROOT * 86400)?,
            basic: ca_constraints(None),
            usage: ca_usage(),
            eku: None,
            san: None,
        },
    )?;
    fs::write(paths.root_dir.join("ca.crt"), issued.pem)?;
    fs::write(paths.root_dir.join("ca.srl"), "1000\n")?;
    Ok(logged(&[
        format!(
            "generating root key + self-signed cert ({DAYS_ROOT} days) at {}",
            paths.root_dir.display()
        ),
        format!("root cert: {}", paths.root_dir.join("ca.crt").display()),
        format!(
            "root key:  {}  (KEEP OFFLINE / LOCAL ONLY)",
            key_path.display()
        ),
    ]))
}

pub fn issue_intermediate(paths: &CaPaths) -> Result<CommandOutput, Error> {
    ensure_dirs(paths)?;
    let root_key_path = paths.root_dir.join("ca.key");
    if !root_key_path.is_file() {
        return Err(Error::msg("no root — run 'init' first"));
    }
    let int_key_path = paths.int_dir().join("int.key");
    if int_key_path.exists() {
        return Err(Error::msg(format!(
            "intermediate already exists at {}",
            int_key_path.display()
        )));
    }
    let root_key = load_rsa_pem(&fs::read_to_string(&root_key_path)?)?;
    let issuer = issuer_name_from_pem(&fs::read_to_string(paths.root_dir.join("ca.crt"))?)?;
    let subject = org_then_cn(ORG, INT_CN)?;
    let key = generate_rsa(4096)?;
    fs::write(&int_key_path, private_pkcs8_pem(&key)?)?;
    set_mode(&int_key_path, 0o600)?;
    let serial_value = serial::increment_then_use(&paths.root_dir.join("ca.srl"))?;
    let now = unix_now();
    let issued = sign_certificate(
        &key,
        &root_key,
        CertSpec {
            issuer,
            subject,
            serial: serial::serial_from_u128(serial_value)?,
            not_before: timeutil::time_at(now)?,
            not_after: timeutil::time_at(now + DAYS_INT * 86400)?,
            basic: ca_constraints(Some(0)),
            usage: ca_usage(),
            eku: None,
            san: None,
        },
    )?;
    let int_crt = paths.int_dir().join("int.crt");
    fs::write(&int_crt, &issued.pem)?;
    remove_if_exists(&paths.int_dir().join("int.csr"))?;
    let mut chain = fs::read(&int_crt)?;
    chain.extend(fs::read(paths.root_dir.join("ca.crt"))?);
    let chain_path = paths.chain_path();
    fs::write(&chain_path, &chain)?;
    fs::write(paths.int_dir().join("ca-chain.pem"), &chain)?;
    let crl_out = crl(paths)?;
    let mut stderr = logged(&[
        format!("generating intermediate key + CSR ({DAYS_INT} days)"),
        "signing intermediate with root".to_string(),
    ])
    .stderr;
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
    ensure_dirs(paths)?;
    let crt = paths.issued_dir().join(format!("{node_id}.crt"));
    let mut lines = Vec::new();
    if crt.exists() {
        lines.push(format!(
            "WARN: {} exists — renewing (key reused if present)",
            crt.display()
        ));
    }
    let sans = node_sans(node_id, extras);
    let subject = cn_then_org(ORG, &format!("{node_id}.mesh"))?;
    let leaf = issue_leaf(paths, node_id, subject, Some(parse_san_list(&sans)?), true)?;
    lines.push(format!("issued node cert: {}", crt.display()));
    lines.push(format!("  SANs: {sans}"));
    lines.push(format!("  expires: {}", leaf.enddate));
    Ok(logged(&lines))
}

pub fn issue_agent(paths: &CaPaths, agent_id: &str, node_id: &str) -> Result<CommandOutput, Error> {
    if agent_id.is_empty() || node_id.is_empty() {
        return Err(Error::msg("usage: issue-agent <agent-id> <node-id>"));
    }
    ensure_dirs(paths)?;
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
    let index_path = paths.int_dir().join("index.txt");
    let mut rows = index::read_index(&index_path)?;
    let mut found = false;
    for row in &mut rows {
        if row.serial.eq_ignore_ascii_case(&serial_hex) {
            if row.status == "R" {
                return Err(Error::msg(format!(
                    "ERROR:Already revoked, serial number {}",
                    row.serial
                )));
            }
            row.status = "R".to_string();
            let now = timeutil::time_at(unix_now())?;
            row.revoked = format_index_time(now);
            found = true;
            break;
        }
    }
    if !found {
        return Err(Error::msg(format!(
            "ERROR:Serial number {serial_hex} not present in db"
        )));
    }
    index::write_index(&index_path, &rows)?;
    index::ensure_attr(&paths.int_dir())?;
    let crl_out = crl(paths)?;
    let mut stderr = logged(&[format!("revoking {}", path.display())]).stderr;
    stderr.push_str(&crl_out.stderr);
    Ok(CommandOutput {
        stdout: String::new(),
        stderr,
        code: crl_out.code,
    })
}

pub fn crl(paths: &CaPaths) -> Result<CommandOutput, Error> {
    write_int_cnf(paths)?;
    let key_path = paths.int_dir().join("int.key");
    let crt_path = paths.int_dir().join("int.crt");
    if !key_path.is_file() || !crt_path.is_file() {
        return Err(Error::msg(
            "no intermediate — run 'issue-intermediate' first",
        ));
    }
    let key_pem = fs::read_to_string(&key_path)?;
    let issuer = issuer_name_from_pem(&fs::read_to_string(&crt_path)?)?;
    let number_path = paths.int_dir().join("crlnumber");
    let crl_number = serial::use_then_increment(&number_path)?;
    let rows = index::read_index(&paths.int_dir().join("index.txt"))?;
    let pem = crate::crl::build_crl_pem(&key_pem, issuer, &rows, crl_number, unix_now())?;
    fs::write(paths.crl_path(), pem)?;
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
