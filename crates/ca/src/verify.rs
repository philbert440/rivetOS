use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use x509_parser::certificate::X509Certificate;
use x509_parser::oid_registry::OID_PKCS1_SHA256WITHRSA;
use x509_parser::prelude::FromDer;
use x509_parser::revocation_list::CertificateRevocationList;

use crate::namefmt::openssl_dn;
use crate::pemutil;
use crate::serial::hex_from_raw;

pub struct VerifyOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

pub fn verify_cert(chain_pem: &Path, crl_pem: &Path, cert_path: &Path) -> VerifyOutput {
    let cert_bytes = match fs::read(cert_path) {
        Ok(bytes) => bytes,
        Err(_) => {
            return fail_load(cert_path, "unable to load certificate");
        }
    };
    let cert_der = match pemutil::first_certificate(&cert_bytes) {
        Ok(der) => der,
        Err(_) => return fail_load(cert_path, "unable to load certificate"),
    };
    let certificate = match X509Certificate::from_der(&cert_der) {
        Ok((_, certificate)) => certificate,
        Err(_) => return fail_load(cert_path, "unable to load certificate"),
    };
    let subject = openssl_dn(certificate.subject());
    let chain_bytes = match fs::read(chain_pem) {
        Ok(bytes) => bytes,
        Err(_) => {
            return fail_parsed(
                &subject,
                cert_path,
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
                &subject,
                cert_path,
                20,
                "unable to get local issuer certificate",
            );
        }
    };
    let mut issuer_key: Option<Vec<u8>> = None;
    for anchor in &anchors {
        if let Ok((_, parsed)) = X509Certificate::from_der(anchor)
            && parsed.subject().as_raw() == certificate.issuer().as_raw()
        {
            issuer_key = Some(parsed.public_key().subject_public_key.data.to_vec());
            break;
        }
    }
    let Some(issuer_key) = issuer_key else {
        return fail_parsed(
            &subject,
            cert_path,
            20,
            "unable to get local issuer certificate",
        );
    };
    if certificate.signature_algorithm.oid() != &OID_PKCS1_SHA256WITHRSA {
        return fail_parsed(&subject, cert_path, 7, "certificate signature failure");
    }
    if crate::signer::verify_pkcs1_sha256(
        &issuer_key,
        certificate.tbs_certificate.as_ref(),
        certificate.signature_value.data.as_ref(),
    )
    .is_err()
    {
        return fail_parsed(&subject, cert_path, 7, "certificate signature failure");
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0);
    if certificate.validity().not_before.timestamp() > now {
        return fail_parsed(&subject, cert_path, 9, "certificate is not yet valid");
    }
    if certificate.validity().not_after.timestamp() < now {
        return fail_parsed(&subject, cert_path, 10, "certificate has expired");
    }
    let crl_bytes = match fs::read(crl_pem) {
        Ok(bytes) => bytes,
        Err(_) => return fail_parsed(&subject, cert_path, 3, "unable to get certificate CRL"),
    };
    let crl_der = match pemutil::decode_all(&String::from_utf8_lossy(&crl_bytes))
        .ok()
        .and_then(|blocks| blocks.into_iter().find(|block| block.label == "X509 CRL"))
    {
        Some(block) => block.der,
        None => return fail_parsed(&subject, cert_path, 3, "unable to get certificate CRL"),
    };
    let crl = match CertificateRevocationList::from_der(&crl_der) {
        Ok((_, crl)) => crl,
        Err(_) => return fail_parsed(&subject, cert_path, 3, "unable to get certificate CRL"),
    };
    if crl.issuer().as_raw() != certificate.issuer().as_raw() {
        return fail_parsed(&subject, cert_path, 3, "unable to get certificate CRL");
    }
    if crl.signature_algorithm.oid() != &OID_PKCS1_SHA256WITHRSA
        || crate::signer::verify_pkcs1_sha256(
            &issuer_key,
            crl.tbs_cert_list.as_ref(),
            crl.signature_value.data.as_ref(),
        )
        .is_err()
    {
        return fail_parsed(&subject, cert_path, 8, "CRL signature failure");
    }
    if let Some(next) = crl.next_update()
        && next.timestamp() < now
    {
        return fail_parsed(&subject, cert_path, 12, "CRL has expired");
    }
    let leaf_serial = hex_from_raw(certificate.raw_serial());
    for revoked in crl.iter_revoked_certificates() {
        if hex_from_raw(revoked.raw_serial()).eq_ignore_ascii_case(&leaf_serial) {
            return fail_parsed(&subject, cert_path, 23, "certificate revoked");
        }
    }
    VerifyOutput {
        stdout: format!("{}: OK\n", cert_path.display()),
        stderr: String::new(),
        code: 0,
    }
}

fn fail_load(path: &Path, message: &str) -> VerifyOutput {
    VerifyOutput {
        stdout: String::new(),
        stderr: format!("{message}\nerror {}: verification failed\n", path.display()),
        code: 2,
    }
}

fn fail_parsed(subject: &str, path: &Path, code: i32, message: &str) -> VerifyOutput {
    VerifyOutput {
        stdout: String::new(),
        stderr: format!(
            "{subject}\nerror {code} at 0 depth lookup: {message}\nerror {}: verification failed\n",
            path.display()
        ),
        code: 2,
    }
}
