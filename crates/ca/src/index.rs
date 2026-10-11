use std::fs;
use std::path::Path;

use crate::error::Error;
use crate::serial;

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
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(path)?;
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

pub fn write_index(path: &Path, rows: &[IndexRow]) -> Result<(), Error> {
    serial::backup(path)?;
    let mut text = String::new();
    for row in rows {
        text.push_str(&row.format_line());
    }
    fs::write(path, text)?;
    Ok(())
}

pub fn ensure_attr(dir: &Path) -> Result<(), Error> {
    let attr = dir.join("index.txt.attr");
    if !attr.exists() {
        fs::write(&attr, "unique_subject = no\n")?;
    }
    fs::copy(&attr, serial::old_path(&attr))?;
    Ok(())
}
