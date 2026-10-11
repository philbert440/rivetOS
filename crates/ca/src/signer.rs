use rsa::RsaPrivateKey;
use rsa::pkcs1v15::SigningKey;
use rsa::sha2::Sha256;
use rsa::traits::PublicKeyParts;
use x509_cert::der::Decode;
use x509_cert::der::asn1::{Any, BitString};
use x509_cert::spki::{
    AlgorithmIdentifierOwned, Document, DynSignatureAlgorithmIdentifier, EncodePublicKey,
    ObjectIdentifier, SignatureBitStringEncoding, SubjectPublicKeyInfoOwned,
};

use crate::error::{Error, wrap};

const SHA256_WITH_RSA: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.113549.1.1.11");

pub struct RsaSignature(Vec<u8>);

impl SignatureBitStringEncoding for RsaSignature {
    fn to_bitstring(&self) -> x509_cert::der::Result<BitString> {
        BitString::from_bytes(&self.0)
    }
}

#[derive(Clone)]
pub struct RsaVerifyingKey(rsa::RsaPublicKey);

impl EncodePublicKey for RsaVerifyingKey {
    fn to_public_key_der(&self) -> x509_cert::spki::Result<Document> {
        let doc = rsa::pkcs8::EncodePublicKey::to_public_key_der(&self.0)
            .map_err(|_| x509_cert::spki::Error::KeyMalformed)?;
        Document::from_der(doc.as_bytes()).map_err(x509_cert::spki::Error::Asn1)
    }
}

pub struct RsaSigner {
    key: RsaPrivateKey,
}

impl RsaSigner {
    pub fn new(key: RsaPrivateKey) -> Self {
        Self { key }
    }

    pub fn sign_bytes(&self, message: &[u8]) -> Result<RsaSignature, Error> {
        signature::Signer::try_sign(self, message).map_err(wrap)
    }
}

impl signature::Keypair for RsaSigner {
    type VerifyingKey = RsaVerifyingKey;

    fn verifying_key(&self) -> Self::VerifyingKey {
        RsaVerifyingKey(self.key.to_public_key())
    }
}

impl DynSignatureAlgorithmIdentifier for RsaSigner {
    fn signature_algorithm_identifier(&self) -> x509_cert::spki::Result<AlgorithmIdentifierOwned> {
        Ok(AlgorithmIdentifierOwned {
            oid: SHA256_WITH_RSA,
            parameters: Some(Any::null()),
        })
    }
}

impl signature::Signer<RsaSignature> for RsaSigner {
    fn try_sign(&self, message: &[u8]) -> signature::Result<RsaSignature> {
        let inner = SigningKey::<Sha256>::new(self.key.clone());
        let signature = rsa::signature::Signer::try_sign(&inner, message)
            .map_err(signature::Error::from_source)?;
        let bytes = Box::<[u8]>::from(signature);
        Ok(RsaSignature(bytes.into_vec()))
    }
}

pub fn subject_spki(key: &RsaPrivateKey) -> Result<SubjectPublicKeyInfoOwned, Error> {
    let document =
        rsa::pkcs8::EncodePublicKey::to_public_key_der(&key.to_public_key()).map_err(wrap)?;
    SubjectPublicKeyInfoOwned::from_der(document.as_bytes()).map_err(wrap)
}

struct OsEntropy;

impl rsa::rand_core::CryptoRng for OsEntropy {}

impl rsa::rand_core::RngCore for OsEntropy {
    fn next_u32(&mut self) -> u32 {
        rsa::rand_core::impls::next_u32_via_fill(self)
    }

    fn next_u64(&mut self) -> u64 {
        rsa::rand_core::impls::next_u64_via_fill(self)
    }

    fn fill_bytes(&mut self, dest: &mut [u8]) {
        if let Err(err) = getrandom::getrandom(dest) {
            panic!("os entropy unavailable: {err}");
        }
    }

    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), rsa::rand_core::Error> {
        getrandom::getrandom(dest).map_err(rsa::rand_core::Error::from)
    }
}

pub fn generate_rsa(bits: usize) -> Result<RsaPrivateKey, Error> {
    RsaPrivateKey::new(&mut OsEntropy, bits).map_err(wrap)
}

pub fn private_key_matches_cert(key: &RsaPrivateKey, cert_pem: &str) -> Result<(), Error> {
    let der = crate::pemutil::first_certificate(cert_pem.as_bytes())?;
    let (_, certificate) = x509_parser::parse_x509_certificate(&der)
        .map_err(|err| Error::msg(format!("parse certificate: {err:?}")))?;
    let parsed = certificate
        .public_key()
        .parsed()
        .map_err(|_| Error::msg("CA certificate public key is not RSA"))?;
    let x509_parser::public_key::PublicKey::RSA(rsa_key) = parsed else {
        return Err(Error::msg("CA certificate public key is not RSA"));
    };
    if strip_leading_zeros(rsa_key.modulus) != key.n().to_bytes_be().as_slice()
        || strip_leading_zeros(rsa_key.exponent) != key.e().to_bytes_be().as_slice()
    {
        return Err(Error::msg("CA private key does not match its certificate"));
    }
    Ok(())
}

fn strip_leading_zeros(bytes: &[u8]) -> &[u8] {
    let Some(start) = bytes.iter().position(|byte| *byte != 0) else {
        return &bytes[..bytes.len().min(1)];
    };
    &bytes[start..]
}

pub fn load_rsa_pem(text: &str) -> Result<RsaPrivateKey, Error> {
    if let Ok(key) = rsa::pkcs8::DecodePrivateKey::from_pkcs8_pem(text) {
        return Ok(key);
    }
    rsa::pkcs1::DecodeRsaPrivateKey::from_pkcs1_pem(text).map_err(wrap)
}

pub fn verify_pkcs1_sha256(
    public_pkcs1: &[u8],
    message: &[u8],
    signature: &[u8],
) -> Result<(), Error> {
    let public = rsa::pkcs1::DecodeRsaPublicKey::from_pkcs1_der(public_pkcs1).map_err(wrap)?;
    let signature = rsa::pkcs1v15::Signature::try_from(signature).map_err(wrap)?;
    let verifier = rsa::pkcs1v15::VerifyingKey::<Sha256>::new(public);
    rsa::signature::Verifier::verify(&verifier, message, &signature).map_err(wrap)
}

pub fn private_pkcs8_der(key: &RsaPrivateKey) -> Result<Vec<u8>, Error> {
    let document = rsa::pkcs8::EncodePrivateKey::to_pkcs8_der(key).map_err(wrap)?;
    Ok(document.as_bytes().to_vec())
}

pub fn private_pkcs8_pem(key: &RsaPrivateKey) -> Result<String, Error> {
    let pem = rsa::pkcs8::EncodePrivateKey::to_pkcs8_pem(key, rsa::pkcs8::LineEnding::LF)
        .map_err(wrap)?;
    Ok(pem.to_string())
}
