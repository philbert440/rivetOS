use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use p12_keystore::{
    Certificate, EncryptionAlgorithm, KeyStore, KeyStoreEntry, MacAlgorithm, PrivateKey,
    PrivateKeyChain,
};

use crate::error::{Error, wrap};
use crate::paths::CaPaths;
use crate::pemutil;
use crate::signer::{load_rsa_pem, private_pkcs8_der};

pub fn export_pkcs12(
    key_pem: &str,
    cert_pem: &str,
    chain_pem: Option<&str>,
    password: &str,
) -> Result<Vec<u8>, Error> {
    let key = load_rsa_pem(key_pem)?;
    let key_der = private_pkcs8_der(&key)?;
    let private = PrivateKey::from_der(&key_der).map_err(wrap)?;
    let mut ders = vec![pemutil::first_certificate(cert_pem.as_bytes())?];
    if let Some(chain) = chain_pem {
        ders.extend(pemutil::certificates(chain)?);
    }
    let mut certs = Vec::new();
    for der in ders {
        certs.push(Certificate::from_der(&der).map_err(wrap)?);
    }
    let chain = PrivateKeyChain::new("device", private, certs);
    let mut store = KeyStore::new();
    store.add_entry("device", KeyStoreEntry::PrivateKeyChain(chain));
    store
        .writer(password)
        .encryption_algorithm(EncryptionAlgorithm::PbeWithHmacSha256AndAes256)
        .encryption_iterations(2048)
        .mac_algorithm(MacAlgorithm::HmacSha256)
        .mac_iterations(2048)
        .write()
        .map_err(wrap)
}

pub fn mint_device_p12(
    paths: &CaPaths,
    device_id: &str,
    password: &str,
    output: &Path,
) -> Result<(), Error> {
    let stem = format!("device-{device_id}");
    let key_path = paths.issued_dir().join(format!("{stem}.key"));
    let cert_path = paths.issued_dir().join(format!("{stem}.crt"));
    let key_pem = fs::read_to_string(&key_path)
        .map_err(|_| Error::msg(format!("no device key at {}", key_path.display())))?;
    let cert_pem = fs::read_to_string(&cert_path)
        .map_err(|_| Error::msg(format!("no device cert at {}", cert_path.display())))?;
    let chain_pem = fs::read_to_string(paths.chain_path()).ok();
    let bytes = export_pkcs12(&key_pem, &cert_pem, chain_pem.as_deref(), password)?;
    if let Some(parent) = output.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent)?;
    }
    fs::write(output, bytes)?;
    fs::set_permissions(output, fs::Permissions::from_mode(0o600))?;
    fs::remove_file(&key_path)?;
    Ok(())
}
