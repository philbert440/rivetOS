use std::path::Path;

pub fn map_file_err(err: &std::io::Error, path: &Path, directory: bool) -> String {
    let shown = path.display();
    match err.kind() {
        std::io::ErrorKind::NotFound => format!("Error: File not found: {shown}"),
        std::io::ErrorKind::PermissionDenied => format!("Error: Permission denied: {shown}"),
        std::io::ErrorKind::IsADirectory if directory => {
            format!("Error: Path is a directory: {shown}")
        }
        _ => format!("Error: {err}"),
    }
}

pub fn js_to_fixed(value: f64, digits: u32) -> String {
    let factor = 10_f64.powi(digits as i32);
    let rounded = (value * factor).round() / factor;
    format!("{rounded:.digits$}", digits = digits as usize)
}
