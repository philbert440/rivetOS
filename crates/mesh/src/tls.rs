use std::io::Cursor;
use std::sync::Arc;

use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::{ClientConfig, RootCertStore, ServerConfig};

use crate::error::MeshError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TlsMaterial {
    pub ca_pem: Vec<u8>,
    pub cert_pem: Vec<u8>,
    pub key_pem: Vec<u8>,
}

pub fn server_config(material: &TlsMaterial) -> Result<Arc<ServerConfig>, MeshError> {
    install_ring();
    let roots = root_store(&material.ca_pem)?;
    let verifier = rustls::server::WebPkiClientVerifier::builder(Arc::new(roots))
        .build()
        .map_err(|err| MeshError::message(err.to_string()))?;
    let certs = load_certs(&material.cert_pem)?;
    let key = load_key(&material.key_pem)?;
    let mut config = ServerConfig::builder()
        .with_client_cert_verifier(verifier)
        .with_single_cert(certs, key)
        .map_err(|err| MeshError::message(err.to_string()))?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(config))
}

pub fn client_config(material: &TlsMaterial) -> Result<ClientConfig, MeshError> {
    install_ring();
    let roots = root_store(&material.ca_pem)?;
    let certs = load_certs(&material.cert_pem)?;
    let key = load_key(&material.key_pem)?;
    let mut config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_client_auth_cert(certs, key)
        .map_err(|err| MeshError::message(err.to_string()))?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(config)
}

fn install_ring() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

fn root_store(pem: &[u8]) -> Result<RootCertStore, MeshError> {
    let mut reader = Cursor::new(pem);
    let mut roots = RootCertStore::empty();
    for cert in rustls_pemfile::certs(&mut reader) {
        let cert = cert.map_err(|err| MeshError::message(err.to_string()))?;
        roots
            .add(cert)
            .map_err(|err| MeshError::message(err.to_string()))?;
    }
    if roots.is_empty() {
        return Err(MeshError::message("TLS CA PEM contained no certificates"));
    }
    Ok(roots)
}

pub fn load_certs(pem: &[u8]) -> Result<Vec<CertificateDer<'static>>, MeshError> {
    let mut reader = Cursor::new(pem);
    let certs = rustls_pemfile::certs(&mut reader)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| MeshError::message(err.to_string()))?;
    if certs.is_empty() {
        return Err(MeshError::message(
            "TLS certificate PEM contained no certificates",
        ));
    }
    Ok(certs)
}

pub fn load_key(pem: &[u8]) -> Result<PrivateKeyDer<'static>, MeshError> {
    let mut reader = Cursor::new(pem);
    rustls_pemfile::private_key(&mut reader)
        .map_err(|err| MeshError::message(err.to_string()))?
        .ok_or_else(|| MeshError::message("TLS key PEM contained no private key"))
}
