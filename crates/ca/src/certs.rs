use std::net::IpAddr;

use const_oid::db::rfc5280::{ID_KP_CLIENT_AUTH, ID_KP_SERVER_AUTH};
use const_oid::db::rfc5912::SHA_256_WITH_RSA_ENCRYPTION;
use rsa::RsaPrivateKey;
use x509_cert::builder::profile::BuilderProfile;
use x509_cert::builder::{Builder, CertificateBuilder};
use x509_cert::certificate::Certificate;
use x509_cert::der::EncodePem;
use x509_cert::der::asn1::Ia5String;
use x509_cert::ext::pkix::name::GeneralName;
use x509_cert::ext::pkix::{
    AuthorityKeyIdentifier, BasicConstraints, ExtendedKeyUsage, KeyUsage, KeyUsages,
    SubjectAltName, SubjectKeyIdentifier,
};
use x509_cert::ext::{Extension, ToExtension};
use x509_cert::name::Name;
use x509_cert::serial_number::SerialNumber;
use x509_cert::spki::SubjectPublicKeyInfoRef;
use x509_cert::time::{Time, Validity};

use crate::error::{Error, wrap};
use crate::signer::{self, RsaSignature, RsaSigner};

struct RivetProfile {
    issuer: Name,
    subject: Name,
    basic: BasicConstraints,
    usage: KeyUsage,
    eku: Option<ExtendedKeyUsage>,
    san: Option<SubjectAltName>,
}

impl BuilderProfile for RivetProfile {
    fn get_issuer(&self, _subject: &Name) -> Name {
        self.issuer.clone()
    }

    fn get_subject(&self) -> Name {
        self.subject.clone()
    }

    fn build_extensions(
        &self,
        spk: SubjectPublicKeyInfoRef<'_>,
        issuer_spk: SubjectPublicKeyInfoRef<'_>,
        _tbs: &x509_cert::certificate::TbsCertificate,
    ) -> x509_cert::builder::Result<Vec<Extension>> {
        let mut extensions = Vec::new();
        extensions.push((&self.basic).to_extension(&self.subject, &[])?);
        extensions.push((&self.usage).to_extension(&self.subject, &[])?);
        if let Some(eku) = &self.eku {
            extensions.push(eku.to_extension(&self.subject, &[])?);
        }
        let ski = SubjectKeyIdentifier::try_from(spk)?;
        extensions.push((&ski).to_extension(&self.subject, &[])?);
        let aki = AuthorityKeyIdentifier::try_from(issuer_spk)?;
        extensions.push((&aki).to_extension(&self.subject, &[])?);
        if let Some(san) = &self.san {
            extensions.push(san.to_extension(&self.subject, &[])?);
        }
        Ok(extensions)
    }
}

pub struct Issued {
    pub pem: String,
}

pub struct CertSpec {
    pub issuer: Name,
    pub subject: Name,
    pub serial: SerialNumber,
    pub not_before: Time,
    pub not_after: Time,
    pub basic: BasicConstraints,
    pub usage: KeyUsage,
    pub eku: Option<ExtendedKeyUsage>,
    pub san: Option<SubjectAltName>,
}

pub fn sign_certificate(
    subject_key: &RsaPrivateKey,
    issuer_key: &RsaPrivateKey,
    spec: CertSpec,
) -> Result<Issued, Error> {
    let profile = RivetProfile {
        issuer: spec.issuer,
        subject: spec.subject,
        basic: spec.basic,
        usage: spec.usage,
        eku: spec.eku,
        san: spec.san,
    };
    let serial = spec.serial;
    let not_before = spec.not_before;
    let not_after = spec.not_after;
    let spki = signer::subject_spki(subject_key)?;
    let builder =
        CertificateBuilder::new(profile, serial, Validity::new(not_before, not_after), spki)
            .map_err(wrap)?;
    let signer = RsaSigner::new(issuer_key.clone());
    let certificate: Certificate =
        Builder::build::<_, RsaSignature>(builder, &signer).map_err(wrap)?;
    let pem = certificate
        .to_pem(x509_cert::der::pem::LineEnding::LF)
        .map_err(wrap)?;
    Ok(Issued { pem })
}

pub fn ca_constraints(path_len: Option<u8>) -> BasicConstraints {
    BasicConstraints {
        ca: true,
        path_len_constraint: path_len,
    }
}

pub fn leaf_constraints() -> BasicConstraints {
    BasicConstraints {
        ca: false,
        path_len_constraint: None,
    }
}

pub fn ca_usage() -> KeyUsage {
    KeyUsage(KeyUsages::KeyCertSign | KeyUsages::CRLSign)
}

pub fn server_usage() -> KeyUsage {
    KeyUsage(KeyUsages::DigitalSignature | KeyUsages::KeyEncipherment)
}

pub fn client_usage() -> KeyUsage {
    KeyUsage(KeyUsages::DigitalSignature.into())
}

pub fn server_eku() -> ExtendedKeyUsage {
    ExtendedKeyUsage(vec![ID_KP_SERVER_AUTH, ID_KP_CLIENT_AUTH])
}

pub fn client_eku() -> ExtendedKeyUsage {
    ExtendedKeyUsage(vec![ID_KP_CLIENT_AUTH])
}

pub fn parse_san_list(list: &str) -> Result<SubjectAltName, Error> {
    let mut names = Vec::new();
    for item in list.split(',') {
        if item.is_empty() {
            continue;
        }
        names.push(parse_general_name(item)?);
    }
    if names.is_empty() {
        return Err(Error::msg("empty subjectAltName"));
    }
    Ok(SubjectAltName(names))
}

fn parse_general_name(item: &str) -> Result<GeneralName, Error> {
    if let Some(value) = item.strip_prefix("DNS:") {
        return Ok(GeneralName::DnsName(ia5(value)?));
    }
    if let Some(value) = item.strip_prefix("IP:") {
        let addr: IpAddr = value
            .parse()
            .map_err(|_| Error::msg(format!("invalid SAN IP: {item}")))?;
        return Ok(GeneralName::from(addr));
    }
    if let Some(value) = item.strip_prefix("URI:") {
        return Ok(GeneralName::UniformResourceIdentifier(ia5(value)?));
    }
    if let Some(value) = item.strip_prefix("email:") {
        return Ok(GeneralName::Rfc822Name(ia5(value)?));
    }
    Ok(GeneralName::DnsName(ia5(item)?))
}

fn ia5(value: &str) -> Result<Ia5String, Error> {
    Ia5String::new(value).map_err(wrap)
}

pub fn issuer_name_from_pem(pem: &str) -> Result<Name, Error> {
    let der = crate::pemutil::first_certificate(pem.as_bytes())?;
    let (_, certificate) = x509_parser::parse_x509_certificate(&der)
        .map_err(|err| Error::msg(format!("parse certificate: {err:?}")))?;
    crate::namefmt::name_from_der(certificate.subject().as_raw())
}

pub fn sha256_rsa_algorithm() -> x509_cert::AlgorithmIdentifier {
    x509_cert::AlgorithmIdentifier {
        oid: SHA_256_WITH_RSA_ENCRYPTION,
        parameters: Some(x509_cert::der::asn1::Any::null()),
    }
}
