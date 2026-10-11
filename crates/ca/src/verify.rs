use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use x509_parser::certificate::X509Certificate;
use x509_parser::oid_registry::OID_PKCS1_SHA256WITHRSA;
use x509_parser::prelude::FromDer;
use x509_parser::revocation_list::CertificateRevocationList;

use crate::namefmt::openssl_dn;
use crate::pemutil;
use crate::serial::{hex_from_raw, same_serial};

pub struct VerifyOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

#[derive(Clone)]
struct Anchor {
    subject: Vec<u8>,
    issuer: Vec<u8>,
    spki: Vec<u8>,
    tbs: Vec<u8>,
    signature: Vec<u8>,
    sha256_rsa: bool,
    not_before: i64,
    not_after: i64,
    has_basic: bool,
    is_ca: bool,
    path_len: Option<u32>,
    key_cert_sign: Option<bool>,
    crl_sign: Option<bool>,
    dn: String,
    serial: String,
}

pub fn verify_cert(chain_pem: &Path, crl_pem: &Path, cert_path: &Path) -> VerifyOutput {
    let cert_bytes = match fs::read(cert_path) {
        Ok(bytes) => bytes,
        Err(_) => return fail_load(cert_path, "unable to load certificate"),
    };
    let cert_der = match pemutil::first_certificate(&cert_bytes) {
        Ok(der) => der,
        Err(_) => return fail_load(cert_path, "unable to load certificate"),
    };
    let Some(leaf) = parse_anchor(&cert_der) else {
        return fail_load(cert_path, "unable to load certificate");
    };
    let chain_bytes = match fs::read(chain_pem) {
        Ok(bytes) => bytes,
        Err(_) => {
            return fail_parsed(
                &leaf.dn,
                cert_path,
                0,
                20,
                "unable to get local issuer certificate",
            );
        }
    };
    let chain_text = String::from_utf8_lossy(&chain_bytes);
    let anchors = match pemutil::certificates(&chain_text) {
        Ok(certs) => certs,
        Err(_) => {
            return fail_parsed(
                &leaf.dn,
                cert_path,
                0,
                20,
                "unable to get local issuer certificate",
            );
        }
    };
    let mut trusted = Vec::new();
    for der in &anchors {
        if let Some(anchor) = parse_anchor(der) {
            trusted.push(anchor);
        }
    }
    let chain = match build_chain(&leaf, &trusted) {
        Ok(chain) => chain,
        Err(failure) => {
            return fail_parsed(
                &failure.dn,
                cert_path,
                failure.depth,
                failure.code,
                failure.message,
            );
        }
    };
    if let Some(output) = check_ca_constraints(&chain, cert_path) {
        return output;
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0);
    if let Some(output) = check_times(&chain, cert_path, now) {
        return output;
    }
    let signer = if chain.len() == 1 {
        &chain[0]
    } else {
        &chain[1]
    };
    check_crl(&leaf, signer, crl_pem, cert_path, now)
}

struct ChainFailure {
    dn: String,
    depth: usize,
    code: i32,
    message: &'static str,
}

fn build_chain(leaf: &Anchor, trusted: &[Anchor]) -> Result<Vec<Anchor>, ChainFailure> {
    if leaf.subject == leaf.issuer {
        let in_store = trusted
            .iter()
            .any(|anchor| anchor.subject == leaf.subject && anchor.spki == leaf.spki);
        if !in_store {
            return Err(fail_chain(leaf, 0, 18, "self-signed certificate"));
        }
        if !signature_ok(leaf, leaf) {
            return Err(fail_chain(leaf, 0, 7, "certificate signature failure"));
        }
        return Ok(vec![leaf.clone()]);
    }
    let mut chain = vec![leaf.clone()];
    for _ in 0..16 {
        let depth = chain.len() - 1;
        let current = chain[depth].clone();
        if current.subject == current.issuer {
            if !signature_ok(&current, &current) {
                return Err(fail_chain(
                    &current,
                    depth,
                    7,
                    "certificate signature failure",
                ));
            }
            return Ok(chain);
        }
        let named: Vec<&Anchor> = trusted
            .iter()
            .filter(|candidate| candidate.subject == current.issuer)
            .collect();
        if named.is_empty() {
            if depth == 0 {
                return Err(fail_chain(
                    &current,
                    depth,
                    20,
                    "unable to get local issuer certificate",
                ));
            }
            return Err(fail_chain(
                &current,
                depth,
                2,
                "unable to get issuer certificate",
            ));
        }
        if let Some(issuer) = named
            .into_iter()
            .find(|candidate| signature_ok(&current, candidate))
        {
            chain.push(issuer.clone());
            continue;
        }
        return Err(fail_chain(
            &current,
            depth,
            7,
            "certificate signature failure",
        ));
    }
    Err(fail_chain(leaf, 0, 22, "certificate chain too long"))
}

fn fail_chain(cert: &Anchor, depth: usize, code: i32, message: &'static str) -> ChainFailure {
    ChainFailure {
        dn: cert.dn.clone(),
        depth,
        code,
        message,
    }
}

fn signature_ok(cert: &Anchor, issuer: &Anchor) -> bool {
    cert.sha256_rsa
        && crate::signer::verify_pkcs1_sha256(&issuer.spki, &cert.tbs, &cert.signature).is_ok()
}

fn check_ca_constraints(chain: &[Anchor], cert_path: &Path) -> Option<VerifyOutput> {
    for (depth, cert) in chain.iter().enumerate().skip(1) {
        if !cert.has_basic || !cert.is_ca {
            return Some(fail_parsed(
                &cert.dn,
                cert_path,
                depth,
                24,
                "invalid CA certificate",
            ));
        }
        if cert.key_cert_sign != Some(true) {
            return Some(fail_parsed(
                &cert.dn,
                cert_path,
                depth,
                32,
                "key usage does not include certificate signing",
            ));
        }
        let cas_below = chain[1..depth].iter().filter(|item| item.is_ca).count();
        if let Some(limit) = cert.path_len
            && cas_below > usize::try_from(limit).unwrap_or(usize::MAX)
        {
            return Some(fail_parsed(
                &cert.dn,
                cert_path,
                depth,
                25,
                "path length constraint exceeded",
            ));
        }
    }
    None
}

fn check_times(chain: &[Anchor], cert_path: &Path, now: i64) -> Option<VerifyOutput> {
    for (depth, cert) in chain.iter().enumerate() {
        if cert.not_before > now {
            return Some(fail_parsed(
                &cert.dn,
                cert_path,
                depth,
                9,
                "certificate is not yet valid",
            ));
        }
        if cert.not_after < now {
            return Some(fail_parsed(
                &cert.dn,
                cert_path,
                depth,
                10,
                "certificate has expired",
            ));
        }
    }
    None
}

fn check_crl(
    leaf: &Anchor,
    signer: &Anchor,
    crl_pem: &Path,
    cert_path: &Path,
    now: i64,
) -> VerifyOutput {
    if signer.crl_sign != Some(true) {
        return fail_parsed(
            &leaf.dn,
            cert_path,
            0,
            35,
            "key usage does not include CRL signing",
        );
    }
    let crl_bytes = match fs::read(crl_pem) {
        Ok(bytes) => bytes,
        Err(_) => {
            return fail_parsed(&leaf.dn, cert_path, 0, 3, "unable to get certificate CRL");
        }
    };
    let crl_der = match pemutil::decode_all(&String::from_utf8_lossy(&crl_bytes))
        .ok()
        .and_then(|blocks| blocks.into_iter().find(|block| block.label == "X509 CRL"))
    {
        Some(block) => block.der,
        None => return fail_parsed(&leaf.dn, cert_path, 0, 3, "unable to get certificate CRL"),
    };
    let crl = match CertificateRevocationList::from_der(&crl_der) {
        Ok((_, crl)) => crl,
        Err(_) => return fail_parsed(&leaf.dn, cert_path, 0, 3, "unable to get certificate CRL"),
    };
    if crl.issuer().as_raw() != leaf.issuer.as_slice() {
        return fail_parsed(&leaf.dn, cert_path, 0, 3, "unable to get certificate CRL");
    }
    if crl.signature_algorithm.oid() != &OID_PKCS1_SHA256WITHRSA
        || crate::signer::verify_pkcs1_sha256(
            &signer.spki,
            crl.tbs_cert_list.as_ref(),
            crl.signature_value.data.as_ref(),
        )
        .is_err()
    {
        return fail_parsed(&leaf.dn, cert_path, 0, 8, "CRL signature failure");
    }
    if crl.last_update().timestamp() > now {
        return fail_parsed(&leaf.dn, cert_path, 0, 11, "CRL is not yet valid");
    }
    if let Some(next) = crl.next_update()
        && next.timestamp() < now
    {
        return fail_parsed(&leaf.dn, cert_path, 0, 12, "CRL has expired");
    }
    for revoked in crl.iter_revoked_certificates() {
        if same_serial(&hex_from_raw(revoked.raw_serial()), &leaf.serial) {
            return fail_parsed(&leaf.dn, cert_path, 0, 23, "certificate revoked");
        }
    }
    VerifyOutput {
        stdout: format!("{}: OK\n", cert_path.display()),
        stderr: String::new(),
        code: 0,
    }
}

fn parse_anchor(der: &[u8]) -> Option<Anchor> {
    let (_, certificate) = X509Certificate::from_der(der).ok()?;
    let basic = certificate.basic_constraints().ok()?;
    let usage = certificate.key_usage().ok()?;
    Some(Anchor {
        subject: certificate.subject().as_raw().to_vec(),
        issuer: certificate.issuer().as_raw().to_vec(),
        spki: certificate.public_key().subject_public_key.data.to_vec(),
        tbs: certificate.tbs_certificate.as_ref().to_vec(),
        signature: certificate.signature_value.data.to_vec(),
        sha256_rsa: certificate.signature_algorithm.oid() == &OID_PKCS1_SHA256WITHRSA,
        not_before: certificate.validity().not_before.timestamp(),
        not_after: certificate.validity().not_after.timestamp(),
        has_basic: basic.is_some(),
        is_ca: basic.as_ref().is_some_and(|ext| ext.value.ca),
        path_len: basic.as_ref().and_then(|ext| ext.value.path_len_constraint),
        key_cert_sign: usage.as_ref().map(|ext| ext.value.key_cert_sign()),
        crl_sign: usage.as_ref().map(|ext| ext.value.crl_sign()),
        dn: openssl_dn(certificate.subject()),
        serial: hex_from_raw(certificate.raw_serial()),
    })
}

fn fail_load(path: &Path, message: &str) -> VerifyOutput {
    VerifyOutput {
        stdout: String::new(),
        stderr: format!("{message}\nerror {}: verification failed\n", path.display()),
        code: 2,
    }
}

fn fail_parsed(subject: &str, path: &Path, depth: usize, code: i32, message: &str) -> VerifyOutput {
    VerifyOutput {
        stdout: String::new(),
        stderr: format!(
            "{subject}\nerror {code} at {depth} depth lookup: {message}\nerror {}: verification failed\n",
            path.display()
        ),
        code: 2,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use rsa::RsaPrivateKey;
    use x509_cert::ext::pkix::{BasicConstraints, ExtendedKeyUsage, KeyUsage};
    use x509_cert::name::Name;

    use super::verify_cert;
    use crate::certs::{
        CertSpec, ca_constraints, ca_usage, client_eku, client_usage, leaf_constraints,
        sign_certificate,
    };
    use crate::crl::build_crl_pem;
    use crate::namefmt::org_then_cn;
    use crate::serial::serial_from_u128;
    use crate::signer::{generate_rsa, private_pkcs8_pem};
    use crate::timeutil::{time_at, unix_now};

    struct Scratch {
        dir: PathBuf,
    }

    impl Scratch {
        fn new() -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("rr9c-verify-{nanos}"));
            fs::create_dir_all(&dir).unwrap();
            Self { dir }
        }

        fn write(&self, name: &str, bytes: impl AsRef<[u8]>) -> PathBuf {
            let path = self.dir.join(name);
            fs::write(&path, bytes.as_ref()).unwrap();
            path
        }
    }

    struct IssuedSpec {
        subject: Name,
        issuer: Name,
        basic: BasicConstraints,
        usage: KeyUsage,
        eku: Option<ExtendedKeyUsage>,
        not_before: u64,
        not_after: u64,
        serial: u128,
    }

    fn signed(subject_key: &RsaPrivateKey, issuer_key: &RsaPrivateKey, spec: IssuedSpec) -> String {
        sign_certificate(
            subject_key,
            issuer_key,
            CertSpec {
                issuer: spec.issuer,
                subject: spec.subject,
                serial: serial_from_u128(spec.serial).unwrap(),
                not_before: time_at(spec.not_before).unwrap(),
                not_after: time_at(spec.not_after).unwrap(),
                basic: spec.basic,
                usage: spec.usage,
                eku: spec.eku,
                san: None,
            },
        )
        .unwrap()
        .pem
    }

    #[test]
    fn walks_chain_constraints_and_crl_window() {
        let root_key = generate_rsa(2048).unwrap();
        let int_key = generate_rsa(2048).unwrap();
        let sub_key = generate_rsa(2048).unwrap();
        let leaf_key = generate_rsa(2048).unwrap();
        let now = unix_now();
        let root_name = org_then_cn("Rivet Collective", "Root").unwrap();
        let int_name = org_then_cn("Rivet Collective", "Int").unwrap();
        let sub_name = org_then_cn("Rivet Collective", "Sub").unwrap();
        let leaf_name = org_then_cn("Rivet Collective", "Leaf").unwrap();
        let root_pem = signed(
            &root_key,
            &root_key,
            IssuedSpec {
                subject: root_name.clone(),
                issuer: root_name.clone(),
                basic: ca_constraints(None),
                usage: ca_usage(),
                eku: None,
                not_before: now,
                not_after: now + 3_650 * 86_400,
                serial: 1,
            },
        );
        let int_pem = signed(
            &int_key,
            &root_key,
            IssuedSpec {
                subject: int_name.clone(),
                issuer: root_name.clone(),
                basic: ca_constraints(Some(0)),
                usage: ca_usage(),
                eku: None,
                not_before: now,
                not_after: now + 1_000 * 86_400,
                serial: 2,
            },
        );
        let expired_int = signed(
            &int_key,
            &root_key,
            IssuedSpec {
                subject: int_name.clone(),
                issuer: root_name.clone(),
                basic: ca_constraints(Some(0)),
                usage: ca_usage(),
                eku: None,
                not_before: now.saturating_sub(10 * 86_400),
                not_after: now.saturating_sub(60),
                serial: 3,
            },
        );
        let weak_int = signed(
            &int_key,
            &root_key,
            IssuedSpec {
                subject: int_name.clone(),
                issuer: root_name,
                basic: ca_constraints(Some(0)),
                usage: client_usage(),
                eku: Some(client_eku()),
                not_before: now,
                not_after: now + 1_000 * 86_400,
                serial: 4,
            },
        );
        let sub_pem = signed(
            &sub_key,
            &int_key,
            IssuedSpec {
                subject: sub_name.clone(),
                issuer: int_name.clone(),
                basic: ca_constraints(None),
                usage: ca_usage(),
                eku: None,
                not_before: now,
                not_after: now + 1_000 * 86_400,
                serial: 5,
            },
        );
        let leaf_pem = signed(
            &leaf_key,
            &int_key,
            IssuedSpec {
                subject: leaf_name.clone(),
                issuer: int_name.clone(),
                basic: leaf_constraints(),
                usage: client_usage(),
                eku: Some(client_eku()),
                not_before: now,
                not_after: now + 90 * 86_400,
                serial: 6,
            },
        );
        let deep_pem = signed(
            &leaf_key,
            &sub_key,
            IssuedSpec {
                subject: leaf_name,
                issuer: sub_name.clone(),
                basic: leaf_constraints(),
                usage: client_usage(),
                eku: Some(client_eku()),
                not_before: now,
                not_after: now + 90 * 86_400,
                serial: 7,
            },
        );
        let int_key_pem = private_pkcs8_pem(&int_key).unwrap();
        let crl = build_crl_pem(&int_key_pem, int_name.clone(), &[], 1, now).unwrap();
        let future = build_crl_pem(&int_key_pem, int_name, &[], 1, now + 3_600).unwrap();
        let sub_crl =
            build_crl_pem(&private_pkcs8_pem(&sub_key).unwrap(), sub_name, &[], 1, now).unwrap();
        let scratch = Scratch::new();
        let leaf = scratch.write("leaf.pem", &leaf_pem);
        let chain = scratch.write("chain.pem", format!("{int_pem}{root_pem}"));
        let crl_path = scratch.write("crl.pem", &crl);
        let good = verify_cert(&chain, &crl_path, &leaf);
        assert_eq!(good.code, 0, "{}", good.stderr);
        assert!(good.stdout.ends_with(": OK\n"), "{}", good.stdout);
        assert_eq!(good.stderr, "");

        let truncated = scratch.write("int-only.pem", &int_pem);
        let missing_root = verify_cert(&truncated, &crl_path, &leaf);
        assert_eq!(missing_root.code, 2);
        assert!(
            missing_root
                .stderr
                .contains("error 2 at 1 depth lookup: unable to get issuer certificate"),
            "{}",
            missing_root.stderr
        );

        let expired_chain = scratch.write("expired.pem", format!("{expired_int}{root_pem}"));
        let expired = verify_cert(&expired_chain, &crl_path, &leaf);
        assert!(
            expired
                .stderr
                .contains("error 10 at 1 depth lookup: certificate has expired"),
            "{}",
            expired.stderr
        );

        let future_crl = scratch.write("future.pem", &future);
        let not_yet = verify_cert(&chain, &future_crl, &leaf);
        assert!(
            not_yet
                .stderr
                .contains("error 11 at 0 depth lookup: CRL is not yet valid"),
            "{}",
            not_yet.stderr
        );

        let weak_chain = scratch.write("weak.pem", format!("{weak_int}{root_pem}"));
        let weak = verify_cert(&weak_chain, &crl_path, &leaf);
        assert!(
            weak.stderr.contains(
                "error 32 at 1 depth lookup: key usage does not include certificate signing"
            ),
            "{}",
            weak.stderr
        );

        let deep = scratch.write("deep.pem", &deep_pem);
        let deep_chain = scratch.write("deep-chain.pem", format!("{sub_pem}{int_pem}{root_pem}"));
        let deep_crl = scratch.write("deep-crl.pem", &sub_crl);
        let path_len = verify_cert(&deep_chain, &deep_crl, &deep);
        assert!(
            path_len
                .stderr
                .contains("error 25 at 2 depth lookup: path length constraint exceeded"),
            "{}",
            path_len.stderr
        );
    }
}
