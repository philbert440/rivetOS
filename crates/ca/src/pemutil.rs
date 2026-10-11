use base64::Engine;

use crate::error::{Error, wrap};

pub struct PemBlock {
    pub label: String,
    pub der: Vec<u8>,
}

pub fn decode_all(text: &str) -> Result<Vec<PemBlock>, Error> {
    let mut blocks = Vec::new();
    let mut label: Option<String> = None;
    let mut body = String::new();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("-----BEGIN ") {
            if let Some(name) = rest.strip_suffix("-----") {
                label = Some(name.to_string());
                body.clear();
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("-----END ") {
            if rest.ends_with("-----")
                && let Some(name) = label.take()
            {
                let der = base64::engine::general_purpose::STANDARD
                    .decode(body.trim())
                    .map_err(wrap)?;
                blocks.push(PemBlock { label: name, der });
                body.clear();
            }
            continue;
        }
        if label.is_some() {
            body.push_str(line.trim());
        }
    }
    Ok(blocks)
}

pub fn first_certificate(bytes: &[u8]) -> Result<Vec<u8>, Error> {
    if bytes.starts_with(b"-----") {
        let text = String::from_utf8_lossy(bytes);
        let blocks = decode_all(&text)?;
        return blocks
            .into_iter()
            .find(|block| block.label == "CERTIFICATE")
            .map(|block| block.der)
            .ok_or_else(|| Error::msg("no certificate in PEM"));
    }
    Ok(bytes.to_vec())
}

pub fn certificates(text: &str) -> Result<Vec<Vec<u8>>, Error> {
    Ok(decode_all(text)?
        .into_iter()
        .filter(|block| block.label == "CERTIFICATE")
        .map(|block| block.der)
        .collect())
}
