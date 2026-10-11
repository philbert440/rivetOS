use sha2::{Digest, Sha256};

use crate::js::JsString;

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub fn sha256_hex_js(text: &JsString) -> String {
    sha256_hex(text.to_utf8().as_bytes())
}

#[cfg(test)]
mod tests {
    use super::{sha256_hex, sha256_hex_js};
    use crate::js::JsString;

    #[test]
    fn empty_and_surrogate() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex_js(&JsString::from_text("abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex_js(&JsString::from_units(vec![0xD83D])),
            sha256_hex("\u{FFFD}".as_bytes())
        );
    }
}
