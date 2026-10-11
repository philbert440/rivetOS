use std::fs;
use std::path::Path;

use crate::error::Error;
use crate::fsutil;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexRow {
    pub status: String,
    pub expires: String,
    pub revoked: String,
    pub serial: String,
    pub file: String,
    pub subject: String,
}

impl IndexRow {
    pub fn format_line(&self) -> String {
        format!(
            "{}\t{}\t{}\t{}\t{}\t{}\n",
            self.status, self.expires, self.revoked, self.serial, self.file, self.subject
        )
    }
}

pub fn read_index(path: &Path) -> Result<Vec<IndexRow>, Error> {
    let Some(bytes) = fsutil::read_optional(path)? else {
        return Ok(Vec::new());
    };
    let text = String::from_utf8_lossy(&bytes);
    let mut rows = Vec::new();
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if trimmed.is_empty() {
            continue;
        }
        let parts: Vec<&str> = trimmed.split('\t').collect();
        if parts.len() < 6 {
            return Err(Error::msg(format!("bad index line in {}", path.display())));
        }
        rows.push(IndexRow {
            status: parts[0].to_string(),
            expires: parts[1].to_string(),
            revoked: parts[2].to_string(),
            serial: parts[3].to_string(),
            file: parts[4].to_string(),
            subject: parts[5..].join("\t"),
        });
    }
    Ok(rows)
}

pub fn ensure_attr(dir: &Path) -> Result<(), Error> {
    let attr = dir.join("index.txt.attr");
    fsutil::reject_symlink(&attr)?;
    if !attr.exists() {
        fsutil::atomic_write(&attr, b"unique_subject = no\n", 0o644, false)?;
    }
    let bytes = fs::read(&attr)?;
    fsutil::atomic_write(&fsutil::old_path(&attr), &bytes, 0o644, false)?;
    Ok(())
}
