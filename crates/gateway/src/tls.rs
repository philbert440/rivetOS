use std::sync::Arc;

use rustls::client::danger::HandshakeSignatureValid;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, UnixTime};
use rustls::server::WebPkiClientVerifier;
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::{DigitallySignedStruct, DistinguishedName, Error, RootCertStore, SignatureScheme};

pub struct TlsMaterial {
    pub acceptor: tokio_rustls::TlsAcceptor,
    pub checker: Arc<dyn ClientCertVerifier>,
}

pub fn load_server(
    cert_pem: &[u8],
    key_pem: &[u8],
    ca_pem: &[u8],
    offer_client: bool,
) -> Result<TlsMaterial, String> {
    let certs = pem_certs(cert_pem)?;
    let key = pem_key(key_pem)?;
    let mut roots = RootCertStore::empty();
    for cert in pem_certs(ca_pem)? {
        roots.add(cert).map_err(|err| err.to_string())?;
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let _ = rustls::crypto::ring::default_provider().install_default();
    let checker: Arc<dyn ClientCertVerifier> =
        WebPkiClientVerifier::builder_with_provider(Arc::new(roots), provider.clone())
            .build()
            .map_err(|err| err.to_string())?;
    let handshake = Arc::new(AcceptAny {
        offer: offer_client,
        subjects: Vec::<DistinguishedName>::new(),
    });
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|err| err.to_string())?
        .with_client_cert_verifier(handshake)
        .with_single_cert(certs, key)
        .map_err(|err| err.to_string())?;
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    Ok(TlsMaterial { acceptor, checker })
}

pub fn peer_auth(checker: &dyn ClientCertVerifier, chain: &[Vec<u8>]) -> (bool, String, String) {
    let Some(leaf) = chain.first() else {
        return (false, String::new(), String::new());
    };
    let (cn, ou) = subject_names(leaf);
    let end = CertificateDer::from(leaf.clone());
    let intermediates: Vec<CertificateDer<'static>> = chain
        .iter()
        .skip(1)
        .cloned()
        .map(CertificateDer::from)
        .collect();
    let authorized = checker
        .verify_client_cert(&end, &intermediates, UnixTime::now())
        .is_ok();
    (authorized, cn, ou)
}

fn subject_names(der: &[u8]) -> (String, String) {
    let Ok((_, cert)) = x509_parser::parse_x509_certificate(der) else {
        return (String::new(), String::new());
    };
    let cn = cert
        .subject()
        .iter_common_name()
        .next()
        .and_then(|name| name.as_str().ok())
        .unwrap_or("")
        .to_string();
    let ou = cert
        .subject()
        .iter_organizational_unit()
        .next()
        .and_then(|name| name.as_str().ok())
        .unwrap_or("")
        .to_string();
    (cn, ou)
}

fn pem_certs(pem: &[u8]) -> Result<Vec<CertificateDer<'static>>, String> {
    let mut cursor = std::io::Cursor::new(pem);
    rustls_pemfile::certs(&mut cursor)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn pem_key(pem: &[u8]) -> Result<PrivateKeyDer<'static>, String> {
    let mut cursor = std::io::Cursor::new(pem);
    rustls_pemfile::private_key(&mut cursor)
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "empty private key".to_string())
}

#[derive(Debug)]
struct AcceptAny {
    offer: bool,
    subjects: Vec<DistinguishedName>,
}

impl ClientCertVerifier for AcceptAny {
    fn offer_client_auth(&self) -> bool {
        self.offer
    }

    fn client_auth_mandatory(&self) -> bool {
        false
    }

    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &self.subjects
    }

    fn verify_client_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _now: UnixTime,
    ) -> Result<ClientCertVerified, Error> {
        Ok(ClientCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}
