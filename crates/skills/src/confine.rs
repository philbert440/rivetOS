use std::ffi::OsString;
use std::fs::OpenOptions;
use std::io::Write;
use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};

use nix::errno::Errno;
use nix::fcntl::{self, AtFlags, OFlag};
use nix::sys::stat::{FileStat, Mode, SFlag, fstatat, mkdirat};
use nix::unistd::{UnlinkatFlags, unlinkat};

const MAX_LINKS: u32 = 32;

struct DirFd(OwnedFd);

struct PreparedRoot {
    original: PathBuf,
    canonical: PathBuf,
}

pub(crate) async fn write_confined(
    path: &Path,
    content: &str,
    roots: &[String],
) -> Result<(), String> {
    let path = path.to_path_buf();
    let content = content.to_string();
    let roots = roots.to_vec();
    match tokio::task::spawn_blocking(move || write_blocking(&path, &content, &roots)).await {
        Ok(result) => result,
        Err(err) => Err(format!("Error: {err}")),
    }
}

pub(crate) async fn mkdir_confined(path: &Path, roots: &[String]) -> Result<(), String> {
    let path = path.to_path_buf();
    let roots = roots.to_vec();
    match tokio::task::spawn_blocking(move || mkdir_blocking(&path, &roots)).await {
        Ok(result) => result,
        Err(err) => Err(format!("Error: {err}")),
    }
}

pub(crate) async fn ensure_inside(path: &Path, roots: &[String]) -> Result<(), String> {
    let path = path.to_path_buf();
    let roots = roots.to_vec();
    match tokio::task::spawn_blocking(move || probe_blocking(&path, &roots)).await {
        Ok(result) => result,
        Err(err) => Err(format!("Error: {err}")),
    }
}

pub(crate) async fn rename_confined(
    from: &Path,
    to: &Path,
    roots: &[String],
) -> Result<(), String> {
    let from = from.to_path_buf();
    let to = to.to_path_buf();
    let roots = roots.to_vec();
    match tokio::task::spawn_blocking(move || rename_blocking(&from, &to, &roots)).await {
        Ok(result) => result,
        Err(err) => Err(format!("Error: {err}")),
    }
}

fn write_blocking(path: &Path, content: &str, roots: &[String]) -> Result<(), String> {
    let roots = scope_roots(&[path], roots);
    materialize_destination(path, &roots)?;
    let prepared = prepare_roots(&roots)?;
    let mut current = absolute_lexical(path);
    for _ in 0..MAX_LINKS {
        match write_here(&current, content, &prepared, path)? {
            None => return Ok(()),
            Some(next) => current = next,
        }
    }
    Err("Error: too many symlinks".to_string())
}

fn write_here(
    absolute: &Path,
    content: &str,
    roots: &[PreparedRoot],
    display: &Path,
) -> Result<Option<PathBuf>, String> {
    let (canonical, names) = locate_names(absolute, roots).map_err(|()| refuse(display))?;
    let mut dir = open_root(Path::new(&canonical))?;
    let last = names.len() - 1;
    for name in &names[..last] {
        dir = ensure_into(&dir, name, roots, 0, display)?;
    }
    let final_name = &names[last];
    match fstatat(
        dir.0.as_fd(),
        final_name.as_os_str(),
        AtFlags::AT_SYMLINK_NOFOLLOW,
    ) {
        Ok(stat) if is_symlink(&stat) => Ok(Some(link_target(&dir, final_name, roots, display)?)),
        Ok(_) | Err(Errno::ENOENT) => {
            place_file(&dir, final_name, content)?;
            Ok(None)
        }
        Err(err) => Err(format!("Error: {err}")),
    }
}

fn mkdir_blocking(path: &Path, roots: &[String]) -> Result<(), String> {
    let roots = scope_roots(&[path], roots);
    materialize_destination(path, &roots)?;
    let prepared = prepare_roots(&roots)?;
    let (canonical, names) =
        locate_names(&absolute_lexical(path), &prepared).map_err(|()| refuse(path))?;
    let mut dir = open_root(Path::new(&canonical))?;
    for name in &names {
        dir = ensure_into(&dir, name, &prepared, 0, path)?;
    }
    Ok(())
}

fn probe_blocking(path: &Path, roots: &[String]) -> Result<(), String> {
    let roots = scope_roots(&[path], roots);
    if destination_missing(path, &roots)? {
        return Ok(());
    }
    let prepared = prepare_roots(&roots)?;
    let (canonical, names) =
        locate_names(&absolute_lexical(path), &prepared).map_err(|()| refuse(path))?;
    let mut dir = open_root(Path::new(&canonical))?;
    for name in &names {
        match open_child(&dir, name) {
            Ok(next) => dir = next,
            Err(Errno::ENOENT) => return Ok(()),
            Err(err @ (Errno::ELOOP | Errno::ENOTDIR)) => {
                dir = follow_symlink(&dir, name, &prepared, 0, path, err)?;
            }
            Err(err) => return Err(format!("Error: {err}")),
        }
    }
    Ok(())
}

fn rename_blocking(from: &Path, to: &Path, roots: &[String]) -> Result<(), String> {
    let roots = scope_roots(&[from, to], roots);
    materialize_destination(to, &roots)?;
    let prepared = prepare_roots(&roots)?;
    let (from_root, from_names) =
        locate_names(&absolute_lexical(from), &prepared).map_err(|()| refuse(from))?;
    let (to_root, to_names) =
        locate_names(&absolute_lexical(to), &prepared).map_err(|()| refuse(to))?;
    let from_dir = open_parent(&from_root, &from_names, &prepared, from)?;
    let to_dir = open_parent(&to_root, &to_names, &prepared, to)?;
    let Some(from_name) = from_names.last() else {
        return Err(refuse(from));
    };
    let Some(to_name) = to_names.last() else {
        return Err(refuse(to));
    };
    if let Ok(stat) = fstatat(
        to_dir.0.as_fd(),
        to_name.as_os_str(),
        AtFlags::AT_SYMLINK_NOFOLLOW,
    ) && is_symlink(&stat)
    {
        let _ = link_target(&to_dir, to_name, &prepared, to)?;
    }
    fcntl::renameat(
        from_dir.0.as_fd(),
        from_name.as_os_str(),
        to_dir.0.as_fd(),
        to_name.as_os_str(),
    )
    .map_err(|err| format!("Error: {err}"))
}

fn open_parent(
    root: &Path,
    names: &[OsString],
    roots: &[PreparedRoot],
    display: &Path,
) -> Result<DirFd, String> {
    let mut dir = open_root(root)?;
    if names.len() <= 1 {
        return Ok(dir);
    }
    for name in &names[..names.len() - 1] {
        dir = step_into(&dir, name, roots, 0, display)?;
    }
    Ok(dir)
}

fn ensure_into(
    parent: &DirFd,
    name: &OsString,
    roots: &[PreparedRoot],
    depth: u32,
    display: &Path,
) -> Result<DirFd, String> {
    if depth > MAX_LINKS {
        return Err("Error: too many symlinks".to_string());
    }
    match open_child(parent, name) {
        Ok(fd) => Ok(fd),
        Err(Errno::ENOENT) => {
            match mkdirat(
                parent.0.as_fd(),
                name.as_os_str(),
                Mode::from_bits_truncate(0o755),
            ) {
                Ok(()) | Err(Errno::EEXIST) => {}
                Err(err) => return Err(format!("Error: {err}")),
            }
            match open_child(parent, name) {
                Ok(fd) => Ok(fd),
                Err(err @ (Errno::ELOOP | Errno::ENOTDIR)) => {
                    follow_symlink(parent, name, roots, depth, display, err)
                }
                Err(err) => Err(format!("Error: {err}")),
            }
        }
        Err(err @ (Errno::ELOOP | Errno::ENOTDIR)) => {
            follow_symlink(parent, name, roots, depth, display, err)
        }
        Err(err) => Err(format!("Error: {err}")),
    }
}

fn step_into(
    parent: &DirFd,
    name: &OsString,
    roots: &[PreparedRoot],
    depth: u32,
    display: &Path,
) -> Result<DirFd, String> {
    if depth > MAX_LINKS {
        return Err("Error: too many symlinks".to_string());
    }
    match open_child(parent, name) {
        Ok(fd) => Ok(fd),
        Err(err @ (Errno::ELOOP | Errno::ENOTDIR)) => {
            follow_symlink(parent, name, roots, depth, display, err)
        }
        Err(err) => Err(format!("Error: {err}")),
    }
}

fn follow_symlink(
    parent: &DirFd,
    name: &OsString,
    roots: &[PreparedRoot],
    depth: u32,
    display: &Path,
    err: Errno,
) -> Result<DirFd, String> {
    if let Ok(stat) = fstatat(
        parent.0.as_fd(),
        name.as_os_str(),
        AtFlags::AT_SYMLINK_NOFOLLOW,
    ) && is_symlink(&stat)
    {
        let target = link_target(parent, name, roots, display)?;
        return open_resolved(&target, roots, depth + 1, display);
    }
    Err(format!("Error: {err}"))
}

fn open_resolved(
    target: &Path,
    roots: &[PreparedRoot],
    depth: u32,
    display: &Path,
) -> Result<DirFd, String> {
    if depth > MAX_LINKS {
        return Err("Error: too many symlinks".to_string());
    }
    let (canonical, names) = locate_names(target, roots).map_err(|()| refuse(display))?;
    let mut dir = open_root(Path::new(&canonical))?;
    for name in &names {
        dir = step_into(&dir, name, roots, depth, display)?;
    }
    Ok(dir)
}

fn link_target(
    parent: &DirFd,
    name: &OsString,
    roots: &[PreparedRoot],
    display: &Path,
) -> Result<PathBuf, String> {
    let raw = fcntl::readlinkat(parent.0.as_fd(), name.as_os_str())
        .map_err(|err| format!("Error: {err}"))?;
    let parent_real = std::fs::read_link(format!("/proc/self/fd/{}", parent.0.as_raw_fd()))
        .map_err(|err| format!("Error: {err}"))?;
    let joined = if Path::new(&raw).is_absolute() {
        absolute_lexical(Path::new(&raw))
    } else {
        absolute_lexical(&parent_real.join(raw))
    };
    if !inside_any(&joined, roots) {
        return Err(refuse(display));
    }
    Ok(joined)
}

fn place_file(parent: &DirFd, name: &OsString, content: &str) -> Result<(), String> {
    let mut tmp = name.clone();
    tmp.push(".tmp");
    let _ = unlinkat(
        parent.0.as_fd(),
        tmp.as_os_str(),
        UnlinkatFlags::NoRemoveDir,
    );
    let proc_path = format!(
        "/proc/self/fd/{}/{}",
        parent.0.as_raw_fd(),
        tmp.to_string_lossy()
    );
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o644)
        .open(&proc_path)
        .map_err(|err| format!("Error: {err}"))?;
    file.write_all(content.as_bytes())
        .map_err(|err| format!("Error: {err}"))?;
    drop(file);
    fcntl::renameat(
        parent.0.as_fd(),
        tmp.as_os_str(),
        parent.0.as_fd(),
        name.as_os_str(),
    )
    .map_err(|err| format!("Error: {err}"))
}

fn open_root(path: &Path) -> Result<DirFd, String> {
    let flags = OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW;
    let fd = fcntl::open(path, flags, Mode::empty()).map_err(|err| format!("Error: {err}"))?;
    Ok(DirFd(fd))
}

fn open_child(parent: &DirFd, name: &OsString) -> Result<DirFd, Errno> {
    let flags = OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW;
    let fd = fcntl::openat(parent.0.as_fd(), name.as_os_str(), flags, Mode::empty())?;
    Ok(DirFd(fd))
}

fn prepare_roots(roots: &[String]) -> Result<Vec<PreparedRoot>, String> {
    let mut out = Vec::new();
    for root in roots {
        if root.is_empty() {
            continue;
        }
        let original = absolute_lexical(Path::new(root));
        match std::fs::symlink_metadata(&original) {
            Ok(meta) if meta.file_type().is_symlink() => continue,
            Ok(meta) if !meta.is_dir() => return Err(refuse(Path::new(root))),
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(format!("Error: {err}")),
        }
        let Ok(meta) = std::fs::symlink_metadata(&original) else {
            continue;
        };
        if meta.file_type().is_symlink() || !meta.is_dir() {
            continue;
        }
        let Ok(canonical) = std::fs::canonicalize(&original) else {
            continue;
        };
        out.push(PreparedRoot {
            original,
            canonical,
        });
    }
    Ok(out)
}

fn materialize_destination(path: &Path, roots: &[String]) -> Result<(), String> {
    let Some(root) = destination_root(path, roots) else {
        return Ok(());
    };
    match std::fs::symlink_metadata(&root) {
        Ok(_) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => materialize_missing(&root),
        Err(err) => Err(format!("Error: {err}")),
    }
}

fn destination_missing(path: &Path, roots: &[String]) -> Result<bool, String> {
    let Some(root) = destination_root(path, roots) else {
        return Ok(false);
    };
    match std::fs::symlink_metadata(&root) {
        Ok(_) => Ok(false),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(err) => Err(format!("Error: {err}")),
    }
}

fn scope_roots(paths: &[&Path], roots: &[String]) -> Vec<String> {
    let mut chosen = Vec::new();
    for path in paths {
        let Some(root) = destination_root(path, roots) else {
            continue;
        };
        let text = root.to_string_lossy().into_owned();
        if chosen.iter().any(|item| item == &text) {
            continue;
        }
        chosen.push(text);
    }
    chosen
}

fn destination_root(path: &Path, roots: &[String]) -> Option<PathBuf> {
    let absolute = absolute_lexical(path);
    let mut best: Option<PathBuf> = None;
    for root in roots {
        if root.is_empty() {
            continue;
        }
        let original = absolute_lexical(Path::new(root));
        if !absolute.starts_with(&original) {
            continue;
        }
        let replace = match &best {
            None => true,
            Some(previous) => original.components().count() > previous.components().count(),
        };
        if replace {
            best = Some(original);
        }
    }
    best
}

fn materialize_missing(root: &Path) -> Result<(), String> {
    let mut ancestor = root.to_path_buf();
    let mut missing = Vec::new();
    loop {
        match std::fs::symlink_metadata(&ancestor) {
            Ok(meta) if meta.file_type().is_symlink() => return Err(refuse(root)),
            Ok(meta) if meta.is_dir() => break,
            Ok(_) => return Err(refuse(root)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                let Some(name) = ancestor.file_name().map(|name| name.to_os_string()) else {
                    return Err(refuse(root));
                };
                missing.push(name);
                if !ancestor.pop() {
                    return Err(refuse(root));
                }
            }
            Err(err) => return Err(format!("Error: {err}")),
        }
    }
    if missing.is_empty() {
        return Ok(());
    }
    missing.reverse();
    let mut dir = open_root(&ancestor)?;
    for name in &missing {
        match mkdirat(
            dir.0.as_fd(),
            name.as_os_str(),
            Mode::from_bits_truncate(0o755),
        ) {
            Ok(()) | Err(Errno::EEXIST) => {}
            Err(err) => return Err(format!("Error: {err}")),
        }
        dir = match open_child(&dir, name) {
            Ok(next) => next,
            Err(Errno::ELOOP | Errno::ENOTDIR) => return Err(refuse(root)),
            Err(err) => return Err(format!("Error: {err}")),
        };
    }
    let meta = std::fs::symlink_metadata(root).map_err(|err| format!("Error: {err}"))?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(refuse(root));
    }
    Ok(())
}

fn locate_names(path: &Path, roots: &[PreparedRoot]) -> Result<(PathBuf, Vec<OsString>), ()> {
    let absolute = absolute_lexical(path);
    let mut best: Option<(PathBuf, PathBuf)> = None;
    for root in roots {
        for base in [&root.original, &root.canonical] {
            if let Ok(rel) = absolute.strip_prefix(base) {
                let replace = match &best {
                    None => true,
                    Some((_, previous)) => rel.components().count() < previous.components().count(),
                };
                if replace {
                    best = Some((root.canonical.clone(), rel.to_path_buf()));
                }
            }
        }
    }
    let Some((canonical, rel)) = best else {
        return Err(());
    };
    let names = component_names(&rel)?;
    if names.is_empty() {
        Err(())
    } else {
        Ok((canonical, names))
    }
}

fn inside_any(path: &Path, roots: &[PreparedRoot]) -> bool {
    roots
        .iter()
        .any(|root| path.starts_with(&root.canonical) || path.starts_with(&root.original))
}

fn component_names(path: &Path) -> Result<Vec<OsString>, ()> {
    let mut names = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(name) => names.push(name.to_os_string()),
            Component::CurDir => {}
            _ => return Err(()),
        }
    }
    Ok(names)
}

fn absolute_lexical(path: &Path) -> PathBuf {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        match std::env::current_dir() {
            Ok(cwd) => cwd.join(path),
            Err(_) => PathBuf::from("/").join(path),
        }
    };
    crate::helpers::normalize(&joined)
}

fn is_symlink(stat: &FileStat) -> bool {
    SFlag::from_bits_truncate(stat.st_mode).contains(SFlag::S_IFLNK)
}

fn refuse(path: &Path) -> String {
    format!(
        "Refusing to write outside skill directories: {}",
        path.display()
    )
}
