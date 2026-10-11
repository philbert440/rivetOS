use x509_cert::Version;
use x509_cert::crl::{CertificateList, RevokedCert, TbsCertList};
use x509_cert::der::Encode;
use x509_cert::der::EncodePem;
use x509_cert::ext::ToExtension;
use x509_cert::ext::pkix::CrlNumber;
use x509_cert::name::Name;

use crate::certs::sha256_rsa_algorithm;
use crate::error::{Error, wrap};
use crate::index::IndexRow;
use crate::serial::serial_from_u128;
use crate::signer::RsaSigner;
use crate::timeutil::{parse_index_time, time_at};

pub fn build_crl_pem(
    issuer_key_pem: &str,
    issuer: Name,
    rows: &[IndexRow],
    crl_number: u128,
    this_update_unix: u64,
) -> Result<String, Error> {
    let key = crate::signer::load_rsa_pem(issuer_key_pem)?;
    let signer = RsaSigner::new(key);
    let algorithm = sha256_rsa_algorithm();
    let mut revoked = Vec::new();
    for row in rows {
        if row.status != "R" {
            continue;
        }
        let serial = serial_from_u128(crate::serial::parse_hex_u128(&row.serial)?)?;
        revoked.push(RevokedCert {
            serial_number: serial,
            revocation_date: parse_index_time(&row.revoked)?,
            crl_entry_extensions: None,
        });
    }
    let number = CrlNumber::try_from(crl_number).map_err(wrap)?;
    let extension = (&number).to_extension(&issuer, &[]).map_err(wrap)?;
    let tbs = TbsCertList {
        version: Version::V2,
        signature: algorithm.clone(),
        issuer,
        this_update: time_at(this_update_unix)?,
        next_update: Some(time_at(this_update_unix + 30 * 86400)?),
        revoked_certificates: if revoked.is_empty() {
            None
        } else {
            Some(revoked)
        },
        crl_extensions: Some(vec![extension]),
    };
    let der = tbs.to_der().map_err(wrap)?;
    let signature = signer.sign_bytes(&der)?;
    let list = CertificateList {
        tbs_cert_list: tbs,
        signature_algorithm: algorithm,
        signature: x509_cert::spki::SignatureBitStringEncoding::to_bitstring(&signature)
            .map_err(wrap)?,
    };
    list.to_pem(x509_cert::der::pem::LineEnding::LF)
        .map_err(wrap)
}
