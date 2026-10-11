use std::str::FromStr;

use x509_cert::der::Decode;
use x509_cert::name::Name;
use x509_parser::oid_registry::{
    OID_PKCS9_EMAIL_ADDRESS, OID_X509_COMMON_NAME, OID_X509_COUNTRY_NAME, OID_X509_LOCALITY_NAME,
    OID_X509_ORGANIZATION_NAME, OID_X509_ORGANIZATIONAL_UNIT, OID_X509_STATE_OR_PROVINCE_NAME,
};
use x509_parser::prelude::X509Name;

use crate::error::{Error, wrap};

pub fn org_then_cn(org: &str, cn: &str) -> Result<Name, Error> {
    Name::from_str(&format!("CN={},O={}", escape(cn), escape(org))).map_err(wrap)
}

pub fn org_ou_then_cn(org: &str, ou: &str, cn: &str) -> Result<Name, Error> {
    Name::from_str(&format!(
        "CN={},OU={},O={}",
        escape(cn),
        escape(ou),
        escape(org)
    ))
    .map_err(wrap)
}

pub fn name_from_der(raw: &[u8]) -> Result<Name, Error> {
    Name::from_der(raw).map_err(wrap)
}

pub fn openssl_dn(name: &X509Name<'_>) -> String {
    name.iter_attributes()
        .map(|attr| {
            let value = attr.as_str().unwrap_or("");
            format!("{} = {value}", short_name(attr.attr_type()))
        })
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn openssl_subject_line(name: &X509Name<'_>) -> String {
    format!("subject={}", openssl_dn(name))
}

pub fn oneline(name: &X509Name<'_>) -> String {
    let mut text = String::new();
    for attr in name.iter_attributes() {
        text.push('/');
        text.push_str(short_name(attr.attr_type()));
        text.push('=');
        let value = attr.as_str().unwrap_or("");
        for byte in value.bytes() {
            if !(0x20..=0x7e).contains(&byte) || byte == b'/' {
                text.push_str(&format!("\\x{byte:02X}"));
            } else {
                text.push(char::from(byte));
            }
        }
    }
    text
}

pub fn cn_matches(subject_line: &str, cn: &str) -> bool {
    let bytes = subject_line.as_bytes();
    let mut index = 0;
    while index + 2 <= bytes.len() {
        if &bytes[index..index + 2] == b"CN" {
            let mut cursor = index + 2;
            if cursor < bytes.len() && bytes[cursor] == b' ' {
                cursor += 1;
            }
            if cursor < bytes.len() && bytes[cursor] == b'=' {
                cursor += 1;
                if cursor < bytes.len() && bytes[cursor] == b' ' {
                    cursor += 1;
                }
                if subject_line[cursor..].starts_with(cn) {
                    let end = cursor + cn.len();
                    match subject_line[end..].chars().next() {
                        None | Some(',') | Some(' ') => return true,
                        Some(_) => {}
                    }
                }
            }
        }
        index += 1;
    }
    false
}

fn short_name(oid: &x509_parser::oid_registry::Oid<'_>) -> &'static str {
    if oid == &OID_X509_COMMON_NAME {
        "CN"
    } else if oid == &OID_X509_ORGANIZATION_NAME {
        "O"
    } else if oid == &OID_X509_ORGANIZATIONAL_UNIT {
        "OU"
    } else if oid == &OID_X509_COUNTRY_NAME {
        "C"
    } else if oid == &OID_X509_STATE_OR_PROVINCE_NAME {
        "ST"
    } else if oid == &OID_X509_LOCALITY_NAME {
        "L"
    } else if oid == &OID_PKCS9_EMAIL_ADDRESS {
        "emailAddress"
    } else {
        "OID"
    }
}

fn escape(value: &str) -> String {
    let mut out = String::new();
    let chars: Vec<char> = value.chars().collect();
    for (index, ch) in chars.iter().enumerate() {
        let lead = index == 0;
        let trail = index + 1 == chars.len();
        if matches!(ch, '\\' | '"' | '+' | ',' | ';' | '<' | '>')
            || (*ch == ' ' && (lead || trail))
            || (*ch == '#' && lead)
        {
            out.push('\\');
        }
        out.push(*ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{oneline, org_ou_then_cn, org_then_cn};
    use x509_cert::der::Encode;
    use x509_parser::prelude::FromDer;
    use x509_parser::x509::X509Name;

    fn render(name: &x509_cert::name::Name) -> (Vec<&'static str>, String) {
        let der = name.to_der().unwrap();
        let (_, parsed) = X509Name::from_der(&der).unwrap();
        let kinds = parsed
            .iter_attributes()
            .map(|attr| super::short_name(attr.attr_type()))
            .collect();
        (kinds, oneline(&parsed))
    }

    #[test]
    fn subject_order_matches_openssl_subj() {
        let (kinds, line) = render(&org_then_cn("Rivet Collective", "node-a.mesh").unwrap());
        assert_eq!(kinds, ["O", "CN"]);
        assert_eq!(line, "/O=Rivet Collective/CN=node-a.mesh");
        let (kinds, line) =
            render(&org_ou_then_cn("Rivet Collective", "client", "device:pixel").unwrap());
        assert_eq!(kinds, ["O", "OU", "CN"]);
        assert_eq!(line, "/O=Rivet Collective/OU=client/CN=device:pixel");
    }

    #[test]
    fn oneline_escapes_slash() {
        let (_, line) = render(&org_then_cn("Rivet Collective", "a/b").unwrap());
        assert_eq!(line, "/O=Rivet Collective/CN=a\\x2Fb");
    }
}
