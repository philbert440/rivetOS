use std::fs;
use std::path::{Path, PathBuf};

use p12_keystore::{
    Certificate, EncryptionAlgorithm, KeyStore, KeyStoreEntry, MacAlgorithm, PrivateKey,
    PrivateKeyChain,
};

use crate::error::{Error, wrap};
use crate::fsutil;
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
    fsutil::with_dir_lock(&paths.shared_dir, || {
        mint_device_p12_locked(paths, device_id, password, output)
    })
}

fn mint_device_p12_locked(
    paths: &CaPaths,
    device_id: &str,
    password: &str,
    output: &Path,
) -> Result<(), Error> {
    let stem = format!("device-{device_id}");
    let key_path = paths.issued_dir().join(format!("{stem}.key"));
    let cert_path = paths.issued_dir().join(format!("{stem}.crt"));
    let key_pem = fsutil::read_to_string(&key_path)
        .map_err(|_| Error::msg(format!("no device key at {}", key_path.display())))?;
    let cert_pem = fsutil::read_to_string(&cert_path)
        .map_err(|_| Error::msg(format!("no device cert at {}", cert_path.display())))?;
    let chain_path = select_chain(paths)?;
    let chain_pem = fsutil::read_to_string(&chain_path)?;
    let bytes = export_pkcs12(&key_pem, &cert_pem, Some(&chain_pem), password)?;
    if let Some(parent) = output.parent()
        && !parent.as_os_str().is_empty()
    {
        fsutil::ensure_dir(parent)?;
    }
    fsutil::atomic_write(output, &bytes, 0o600, false)?;
    fsutil::remove_file(&key_path)?;
    Ok(())
}

fn select_chain(paths: &CaPaths) -> Result<PathBuf, Error> {
    let preferred = paths.int_dir().join("ca-chain.pem");
    let fallback = paths.chain_path();
    if let Some(path) = existing_chain(&preferred)? {
        return Ok(path);
    }
    if let Some(path) = existing_chain(&fallback)? {
        return Ok(path);
    }
    Err(Error::msg(format!(
        "no CA chain at {} or {}",
        preferred.display(),
        fallback.display()
    )))
}

fn existing_chain(path: &Path) -> Result<Option<PathBuf>, Error> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            Err(Error::msg(format!("refusing symlink {}", path.display())))
        }
        Ok(_) => Ok(Some(path.to_path_buf())),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}
