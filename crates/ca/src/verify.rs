use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rustls_pki_types::{CertificateDer, SignatureVerificationAlgorithm, UnixTime};
use webpki::{EndEntityCert, ExtendedKeyUsageValidator, KeyPurposeIdIter};
use x509_parser::certificate::X509Certificate;
use x509_parser::extensions::{GeneralName, NameConstraints};
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
    der: Vec<u8>,
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
    if let Some(output) = check_critical(&chain, cert_path) {
        return output;
    }
    if let Some(output) = check_extended_key_usage(&chain, cert_path) {
        return output;
    }
    if let Some(output) = check_ca_constraints(&chain, cert_path) {
        return output;
    }
    if let Some(output) = check_name_constraints(&chain, cert_path) {
        return output;
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0);
    if let Some(output) = check_times(&chain, cert_path, now) {
        return output;
    }
    if let Some(output) = webpki_blocks(&chain, cert_path, now) {
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
        if current.subject == current.issuer && signature_ok(&current, &current) {
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
        let cas_below = chain[1..depth]
            .iter()
            .filter(|item| item.subject != item.issuer)
            .count();
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
        der: der.to_vec(),
    })
}

fn load_cert(anchor: &Anchor) -> Result<X509Certificate<'_>, ()> {
    X509Certificate::from_der(&anchor.der)
        .map(|(_, certificate)| certificate)
        .map_err(|_| ())
}

fn check_critical(chain: &[Anchor], cert_path: &Path) -> Option<VerifyOutput> {
    for (depth, anchor) in chain.iter().enumerate() {
        let Ok(certificate) = load_cert(anchor) else {
            return Some(unhandled(anchor, cert_path, depth));
        };
        for ext in certificate.extensions() {
            let oid = ext.oid.to_id_string();
            if oid == "2.5.29.30" && subtree_minmax(ext.value) {
                continue;
            }
            if !ext.critical {
                continue;
            }
            if !processed_extension(&oid) {
                return Some(unhandled(anchor, cert_path, depth));
            }
            let parsed = ext.parsed_extension();
            if must_parse(&oid) && (parsed.error().is_some() || parsed.unsupported()) {
                return Some(unhandled(anchor, cert_path, depth));
            }
        }
    }
    None
}

fn unhandled(anchor: &Anchor, cert_path: &Path, depth: usize) -> VerifyOutput {
    fail_parsed(
        &anchor.dn,
        cert_path,
        depth,
        34,
        "unhandled critical extension",
    )
}

fn processed_extension(oid: &str) -> bool {
    matches!(
        oid,
        "2.5.29.15"
            | "2.5.29.17"
            | "2.5.29.19"
            | "2.5.29.30"
            | "2.5.29.32"
            | "2.5.29.33"
            | "2.5.29.36"
            | "2.5.29.37"
            | "2.5.29.54"
            | "1.3.6.1.5.5.7.1.7"
            | "1.3.6.1.5.5.7.1.8"
            | "1.3.6.1.5.5.7.1.14"
            | "2.16.840.1.113730.1.1"
    )
}

fn must_parse(oid: &str) -> bool {
    matches!(
        oid,
        "2.5.29.15" | "2.5.29.17" | "2.5.29.19" | "2.5.29.30" | "2.5.29.37"
    )
}

fn check_extended_key_usage(chain: &[Anchor], cert_path: &Path) -> Option<VerifyOutput> {
    for (depth, anchor) in chain.iter().enumerate() {
        let Ok(certificate) = load_cert(anchor) else {
            return Some(unhandled(anchor, cert_path, depth));
        };
        let usage = match certificate.extended_key_usage() {
            Ok(Some(ext)) => ext.value,
            Ok(None) => continue,
            Err(_) => return Some(unhandled(anchor, cert_path, depth)),
        };
        if usage.any || usage.server_auth || usage.client_auth {
            continue;
        }
        return Some(fail_parsed(
            &anchor.dn,
            cert_path,
            depth,
            26,
            "unsuitable certificate purpose",
        ));
    }
    None
}

fn check_name_constraints(chain: &[Anchor], cert_path: &Path) -> Option<VerifyOutput> {
    for depth in (0..chain.len()).rev() {
        if depth > 0 && chain[depth].subject == chain[depth].issuer {
            continue;
        }
        for issuer_depth in ((depth + 1)..chain.len()).rev() {
            match constrain_pair(&chain[depth], depth, &chain[issuer_depth]) {
                Ok(()) => {}
                Err(code) => {
                    return Some(fail_parsed(
                        &chain[depth].dn,
                        cert_path,
                        depth,
                        code,
                        constraint_message(code),
                    ));
                }
            }
        }
    }
    None
}

fn constraint_message(code: i32) -> &'static str {
    match code {
        47 => "permitted subtree violation",
        48 => "excluded subtree violation",
        49 => "name constraints minimum and maximum not supported",
        51 => "name constraint type cannot be verified",
        52 => "unsupported or invalid name constraint syntax",
        _ => "unsupported or invalid name syntax",
    }
}

fn constrain_pair(subject: &Anchor, depth: usize, issuer: &Anchor) -> Result<(), i32> {
    let subject_cert = load_cert(subject).map_err(|_| 34)?;
    let issuer_cert = load_cert(issuer).map_err(|_| 34)?;
    if raw_name_constraints(&issuer_cert).is_some_and(subtree_minmax) {
        return Err(49);
    }
    let Some(constraints) = name_constraints_of(&issuer_cert)? else {
        return Ok(());
    };
    if unsupported_name_constraint(constraints) {
        return Err(51);
    }
    if let Some(san) = subject_cert.subject_alternative_name().map_err(|_| 34)? {
        for name in &san.value.general_names {
            if let GeneralName::DNSName(value) = name {
                check_dns(value, constraints)?;
            }
        }
    }
    if depth == 0 && !has_dns_san(&subject_cert) {
        for cn in subject_cert.subject().iter_common_name() {
            if let Ok(value) = cn.as_str()
                && is_dns_name(value)
            {
                check_dns(value, constraints)?;
            }
        }
    }
    Ok(())
}

fn name_constraints_of<'a>(
    certificate: &'a X509Certificate<'a>,
) -> Result<Option<&'a NameConstraints<'a>>, i32> {
    match certificate.name_constraints() {
        Ok(Some(ext)) => Ok(Some(ext.value)),
        Ok(None) => Ok(None),
        Err(_) => Err(34),
    }
}

fn has_dns_san(certificate: &X509Certificate<'_>) -> bool {
    certificate
        .subject_alternative_name()
        .ok()
        .flatten()
        .is_some_and(|san| {
            san.value
                .general_names
                .iter()
                .any(|name| matches!(name, GeneralName::DNSName(_)))
        })
}

fn is_dns_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 255 || bytes[0] == b'.' || bytes[bytes.len() - 1] == b'.' {
        return false;
    }
    let mut label = 0usize;
    for &byte in bytes {
        if byte == b'.' {
            if label == 0 || label > 63 {
                return false;
            }
            label = 0;
            continue;
        }
        if !(byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_') {
            return false;
        }
        label += 1;
    }
    (1..=63).contains(&label)
}

fn unsupported_name_constraint(constraints: &NameConstraints<'_>) -> bool {
    let unsupported = |base: &GeneralName<'_>| {
        !matches!(base, GeneralName::DNSName(_) | GeneralName::IPAddress(_))
    };
    constraints
        .permitted_subtrees
        .iter()
        .flatten()
        .chain(constraints.excluded_subtrees.iter().flatten())
        .any(|subtree| unsupported(&subtree.base))
}

fn check_dns(name: &str, constraints: &NameConstraints<'_>) -> Result<(), i32> {
    excluded_then_permitted(constraints, |base| match base {
        GeneralName::DNSName(constraint) => Some(Ok(dns_match(name, constraint))),
        _ => None,
    })
}

fn excluded_then_permitted(
    constraints: &NameConstraints<'_>,
    same: impl Fn(&GeneralName<'_>) -> Option<Result<bool, i32>>,
) -> Result<(), i32> {
    if let Some(excluded) = &constraints.excluded_subtrees {
        for subtree in excluded {
            if let Some(matched) = same(&subtree.base)
                && matched?
            {
                return Err(48);
            }
        }
    }
    let mut saw_type = false;
    if let Some(permitted) = &constraints.permitted_subtrees {
        for subtree in permitted {
            if let Some(matched) = same(&subtree.base) {
                saw_type = true;
                if matched? {
                    return Ok(());
                }
            }
        }
    }
    if saw_type { Err(47) } else { Ok(()) }
}

fn dns_match(name: &str, base: &str) -> bool {
    let name = name.as_bytes();
    let base = base.as_bytes();
    if base.is_empty() {
        return true;
    }
    if name.len() > base.len() {
        let start = name.len() - base.len();
        if !eq_ascii(&name[start..], base) {
            return false;
        }
        return base[0] == b'.' || name[start - 1] == b'.';
    }
    name.len() == base.len() && eq_ascii(name, base)
}

fn eq_ascii(left: &[u8], right: &[u8]) -> bool {
    left.eq_ignore_ascii_case(right)
}

fn ip_match(addr: &[u8], base: &[u8]) -> Result<bool, i32> {
    if addr.len() != 4 && addr.len() != 16 {
        return Err(53);
    }
    let other_family = if addr.len() == 4 { 32 } else { 8 };
    if base.len() == other_family {
        return Ok(false);
    }
    if base.len() != addr.len() * 2 {
        return Err(52);
    }
    let (network, mask) = base.split_at(addr.len());
    if !prefix_mask(mask) {
        return Err(52);
    }
    Ok(addr
        .iter()
        .zip(network)
        .zip(mask)
        .all(|((addr, network), mask)| addr & mask == network & mask))
}

fn prefix_mask(mask: &[u8]) -> bool {
    let mut seen_zero = false;
    for &byte in mask {
        if seen_zero && byte != 0 {
            return false;
        }
        if byte.leading_ones() + byte.trailing_zeros() != 8 {
            return false;
        }
        if byte != 0xff {
            seen_zero = true;
        }
    }
    true
}

fn excluded_ip_matches(chain: &[Anchor]) -> bool {
    for depth in 0..chain.len() {
        if depth > 0 && chain[depth].subject == chain[depth].issuer {
            continue;
        }
        let Ok(subject_cert) = load_cert(&chain[depth]) else {
            continue;
        };
        let Ok(Some(san)) = subject_cert.subject_alternative_name() else {
            continue;
        };
        let ips: Vec<&[u8]> = san
            .value
            .general_names
            .iter()
            .filter_map(|name| match name {
                GeneralName::IPAddress(addr) => Some(*addr),
                _ => None,
            })
            .collect();
        if ips.is_empty() {
            continue;
        }
        for issuer in chain.iter().skip(depth + 1) {
            let Ok(issuer_cert) = load_cert(issuer) else {
                continue;
            };
            let Ok(Some(ext)) = issuer_cert.name_constraints() else {
                continue;
            };
            let Some(excluded) = &ext.value.excluded_subtrees else {
                continue;
            };
            for subtree in excluded {
                let GeneralName::IPAddress(constraint) = &subtree.base else {
                    continue;
                };
                if ips
                    .iter()
                    .any(|addr| ip_match(addr, constraint) == Ok(true))
                {
                    return true;
                }
            }
        }
    }
    false
}

fn raw_name_constraints<'a>(certificate: &'a X509Certificate<'a>) -> Option<&'a [u8]> {
    certificate.extensions().iter().find_map(|ext| {
        if ext.oid.to_id_string() == "2.5.29.30" {
            Some(ext.value)
        } else {
            None
        }
    })
}

struct DerCursor<'a> {
    rest: &'a [u8],
}

impl<'a> DerCursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { rest: bytes }
    }

    fn done(&self) -> bool {
        self.rest.is_empty()
    }

    fn tlv(&mut self) -> Option<(u8, &'a [u8])> {
        let tag = *self.rest.first()?;
        let (len, header) = der_length(self.rest.get(1..)?)?;
        let rest = self.rest.get(1 + header..)?;
        if rest.len() < len {
            return None;
        }
        let (body, tail) = rest.split_at(len);
        self.rest = tail;
        Some((tag, body))
    }

    fn sequence(&mut self) -> Option<&'a [u8]> {
        let (tag, body) = self.tlv()?;
        if tag == 0x30 { Some(body) } else { None }
    }
}

fn der_length(bytes: &[u8]) -> Option<(usize, usize)> {
    let first = *bytes.first()?;
    if first < 0x80 {
        return Some((usize::from(first), 1));
    }
    let octets = usize::from(first & 0x7f);
    if octets == 0 || octets > 3 || bytes.len() < 1 + octets {
        return None;
    }
    let mut len = 0usize;
    for &byte in &bytes[1..1 + octets] {
        len = len.checked_shl(8)?.checked_add(usize::from(byte))?;
    }
    Some((len, 1 + octets))
}

fn subtree_minmax(der: &[u8]) -> bool {
    let mut outer = DerCursor::new(der);
    let Some(body) = outer.sequence() else {
        return false;
    };
    if !outer.done() {
        return false;
    }
    let mut fields = DerCursor::new(body);
    while !fields.done() {
        let Some((tag, content)) = fields.tlv() else {
            return false;
        };
        if tag != 0xa0 && tag != 0xa1 {
            return false;
        }
        if field_has_minmax(content) {
            return true;
        }
    }
    false
}

fn field_has_minmax(content: &[u8]) -> bool {
    if let Some(found) = subtrees_have_extra(content) {
        return found;
    }
    let mut wrapped = DerCursor::new(content);
    let Some(list) = wrapped.sequence() else {
        return false;
    };
    if !wrapped.done() {
        return false;
    }
    subtrees_have_extra(list).unwrap_or(false)
}

fn subtrees_have_extra(list: &[u8]) -> Option<bool> {
    let mut items = DerCursor::new(list);
    let mut extra = false;
    if items.done() {
        return Some(false);
    }
    while !items.done() {
        let subtree = items.sequence()?;
        let mut parts = DerCursor::new(subtree);
        let (tag, _) = parts.tlv()?;
        if tag == 0x30 {
            return None;
        }
        if !parts.done() {
            extra = true;
        }
    }
    Some(extra)
}

const EKU_SERVER: &[usize] = &[1, 3, 6, 1, 5, 5, 7, 3, 1];
const EKU_CLIENT: &[usize] = &[1, 3, 6, 1, 5, 5, 7, 3, 2];
const EKU_ANY: &[usize] = &[2, 5, 29, 37, 0];

struct ClientOrServerAuth;

impl ExtendedKeyUsageValidator for ClientOrServerAuth {
    fn validate(&self, iter: KeyPurposeIdIter<'_, '_>) -> Result<(), webpki::Error> {
        let mut empty = true;
        let mut present = Vec::new();
        for id in iter {
            empty = false;
            let id = id?;
            let decoded = id.to_decoded_oid();
            if decoded.as_slice() == EKU_SERVER
                || decoded.as_slice() == EKU_CLIENT
                || decoded.as_slice() == EKU_ANY
            {
                return Ok(());
            }
            present.push(decoded);
        }
        if empty {
            return Ok(());
        }
        Err(webpki::Error::RequiredEkuNotFoundContext(
            webpki::RequiredEkuNotFoundContext {
                required: webpki::KeyUsage::client_auth(),
                present,
            },
        ))
    }
}

fn webpki_blocks(chain: &[Anchor], cert_path: &Path, now: i64) -> Option<VerifyOutput> {
    let now = u64::try_from(now).unwrap_or(0);
    match webpki_verify(chain, now) {
        Ok(()) => None,
        Err(err) if webpki_gap(chain, &err) => None,
        Err(err) => Some(webpki_failure(chain, cert_path, &err)),
    }
}

fn webpki_verify(chain: &[Anchor], now: u64) -> Result<(), webpki::Error> {
    let leaf_der = CertificateDer::from(chain[0].der.as_slice());
    let end = EndEntityCert::try_from(&leaf_der)?;
    let anchor_der = CertificateDer::from(chain[chain.len() - 1].der.as_slice());
    let anchor = webpki::anchor_from_trusted_cert(&anchor_der)?;
    let anchors = [anchor];
    let mut mids = Vec::new();
    if chain.len() > 2 {
        for cert in &chain[1..chain.len() - 1] {
            mids.push(CertificateDer::from(cert.der.as_slice()));
        }
    }
    let algs: &[&dyn SignatureVerificationAlgorithm] = &[
        webpki::ring::RSA_PKCS1_2048_8192_SHA256,
        webpki::ring::RSA_PKCS1_2048_8192_SHA256_ABSENT_PARAMS,
    ];
    let time = UnixTime::since_unix_epoch(Duration::from_secs(now));
    end.verify_for_usage(algs, &anchors, &mids, time, ClientOrServerAuth, None, None)
        .map(|_| ())
}

fn webpki_gap(chain: &[Anchor], err: &webpki::Error) -> bool {
    match err {
        webpki::Error::PathLenConstraintViolated
        | webpki::Error::UnsupportedCriticalExtension
        | webpki::Error::CaUsedAsEndEntity => true,
        webpki::Error::InvalidSignatureForPublicKey => chain_has_self_issued(chain),
        _ => false,
    }
}

fn chain_has_self_issued(chain: &[Anchor]) -> bool {
    chain
        .iter()
        .any(|cert| cert.subject == cert.issuer && !signature_ok(cert, cert))
}

fn webpki_failure(chain: &[Anchor], cert_path: &Path, err: &webpki::Error) -> VerifyOutput {
    let (code, message) = match err {
        webpki::Error::InvalidSignatureForPublicKey => (7, "certificate signature failure"),
        webpki::Error::CertExpired { .. } => (10, "certificate has expired"),
        webpki::Error::CertNotValidYet { .. } => (9, "certificate is not yet valid"),
        webpki::Error::RequiredEkuNotFoundContext(_) => (26, "unsuitable certificate purpose"),
        webpki::Error::EmptyEkuExtension => (26, "unsuitable certificate purpose"),
        webpki::Error::EndEntityUsedAsCa | webpki::Error::CaUsedAsEndEntity => {
            (24, "invalid CA certificate")
        }
        webpki::Error::UnknownIssuer => {
            if chain.len() > 1 {
                let depth = chain.len() - 1;
                return fail_parsed(
                    &chain[depth].dn,
                    cert_path,
                    depth,
                    2,
                    "unable to get issuer certificate",
                );
            }
            (20, "unable to get local issuer certificate")
        }
        webpki::Error::InvalidNetworkMaskConstraint | webpki::Error::MalformedNameConstraint => {
            (52, "unsupported or invalid name constraint syntax")
        }
        webpki::Error::MalformedDnsIdentifier => (53, "unsupported or invalid name syntax"),
        webpki::Error::NameConstraintViolation => {
            if excluded_ip_matches(chain) {
                (48, "excluded subtree violation")
            } else {
                (47, "permitted subtree violation")
            }
        }
        webpki::Error::PathLenConstraintViolated => (25, "path length constraint exceeded"),
        webpki::Error::UnsupportedCriticalExtension => (34, "unhandled critical extension"),
        _ => (34, "unhandled critical extension"),
    };
    fail_parsed(&chain[0].dn, cert_path, 0, code, message)
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
