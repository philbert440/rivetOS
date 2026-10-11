use std::path::Path;

use protocol::host::{Env, FsError, ProcessEnv};
use protocol::js::posix_join;

pub const DEFAULT_SHARED_DIR: &str = "/rivet-shared";
pub const DEFAULT_INSTALL_ROOT: &str = "/opt/rivetos";

pub fn shared_path(segments: &[&str]) -> String {
    config::paths::shared_path(&ProcessEnv, segments)
}

pub fn install_root() -> String {
    config::paths::install_root(&ProcessEnv)
}

pub fn install_root_from(raw: Option<&str>) -> String {
    let mut env = protocol::host::MapEnv::new();
    if let Some(raw) = raw {
        env.set("RIVETOS_INSTALL_ROOT", raw);
    }
    config::paths::install_root(&env)
}

pub fn install_path(segments: &[&str]) -> String {
    config::paths::install_path(&ProcessEnv, segments)
}

pub fn path_join(root: &str, segments: &[&str]) -> String {
    let mut parts = Vec::with_capacity(segments.len() + 1);
    parts.push(root);
    parts.extend_from_slice(segments);
    posix_join(&parts)
}

pub fn mesh_file_paths(mesh_file: &str, shared_root: Option<&str>) -> Result<Vec<String>, FsError> {
    mesh_file_paths_in(mesh_file, shared_root, &ProcessEnv)
}

fn mesh_file_paths_in(
    mesh_file: &str,
    shared_root: Option<&str>,
    env: &dyn Env,
) -> Result<Vec<String>, FsError> {
    if !mesh_file.is_empty() {
        return Ok(vec![mesh_file.to_string()]);
    }
    let shared = match shared_root {
        Some(root) => root.to_string(),
        None => config::paths::shared_dir(env),
    };
    let mut paths = vec![path_join(&shared, &["mesh.json"])];
    push_instance_mesh(&mut paths, protocol::host::home_dir(env).as_deref())?;
    Ok(paths)
}

fn push_instance_mesh(paths: &mut Vec<String>, home: Option<&str>) -> Result<(), FsError> {
    let Some(home) = home else {
        return Err(homedir_failure());
    };
    paths.push(path_join(home, &[".rivetos", "mesh.json"]));
    Ok(())
}

fn homedir_failure() -> FsError {
    protocol::host::fs_error(
        "uv_os_homedir",
        None,
        None,
        &std::io::Error::from_raw_os_error(2),
    )
}

pub fn cli_mesh_paths(root: Option<&str>) -> Vec<String> {
    let mut paths = vec![shared_path(&["mesh.json"])];
    if let Some(root) = root {
        paths.push(resolve_under(root, "mesh.json"));
    }
    paths
}

fn resolve_under(root: &str, name: &str) -> String {
    let joined = Path::new(root).join(name);
    if joined.is_absolute() {
        return joined.to_string_lossy().into_owned();
    }
    match std::env::current_dir() {
        Ok(cwd) => cwd.join(joined).to_string_lossy().into_owned(),
        Err(_) => joined.to_string_lossy().into_owned(),
    }
}

#[cfg(test)]
mod posix_join_table {
    use protocol::host::MapEnv;
    use protocol::js::posix_join;

    use super::{mesh_file_paths_in, path_join, push_instance_mesh};

    #[test]
    fn node_documented_join_cases() {
        let cases = [
            (
                &["/foo", "bar", "baz/asdf", "quux", ".."][..],
                "/foo/bar/baz/asdf",
            ),
            (
                &["/opt/rivetos", "/config.yaml"][..],
                "/opt/rivetos/config.yaml",
            ),
            (&["/opt/rivetos", "a", "..", "b"][..], "/opt/rivetos/b"),
            (&["/opt//rivetos/", "a//b"][..], "/opt/rivetos/a/b"),
            (&["/opt/rivetos/foo/bar", ".."][..], "/opt/rivetos/foo"),
            (&["/opt", "..", ".."][..], "/"),
            (&["foo", "..", ".."][..], ".."),
            (&["/foo", "../../../bar"][..], "/bar"),
            (&["/mnt/shared/"][..], "/mnt/shared/"),
            (&["/rivet-shared"][..], "/rivet-shared"),
            (&["/opt/rivetos/", ""][..], "/opt/rivetos/"),
            (&["foo", "bar"][..], "foo/bar"),
            (&[""][..], "."),
            (&["", ""][..], "."),
            (&["/foo", ".", "bar"][..], "/foo/bar"),
            (&["foo/bar", "../baz"][..], "foo/baz"),
            (&["/foo/", "bar/"][..], "/foo/bar/"),
            (&["foo", "/bar", "baz"][..], "foo/bar/baz"),
            (&["/foo/bar//baz/asdf/quux/.."][..], "/foo/bar/baz/asdf"),
            (&["./"][..], "./"),
            (&["foo/bar", ".."][..], "foo"),
        ];
        for (parts, expected) in cases {
            assert_eq!(posix_join(parts), expected, "{parts:?}");
        }
    }

    #[test]
    fn failed_home_lookup_is_the_node_homedir_error() {
        let mut paths = vec![path_join("/rivet-shared", &["mesh.json"])];
        let err = push_instance_mesh(&mut paths, None).unwrap_err();
        assert_eq!(err.code, "ENOENT");
        assert_eq!(err.errno, -2);
        assert_eq!(err.syscall, "uv_os_homedir");
        assert_eq!(err.path, None);
        assert_eq!(err.dest, None);
        assert_eq!(
            err.to_string(),
            "ENOENT: no such file or directory, uv_os_homedir"
        );
        assert_eq!(
            err.node_string(),
            "Error: ENOENT: no such file or directory, uv_os_homedir"
        );
        assert_eq!(paths, vec!["/rivet-shared/mesh.json".to_string()]);
        push_instance_mesh(&mut paths, Some("/home/example")).unwrap();
        assert_eq!(
            paths,
            vec![
                "/rivet-shared/mesh.json".to_string(),
                "/home/example/.rivetos/mesh.json".to_string(),
            ]
        );
    }

    #[test]
    fn unset_home_uses_the_passwd_entry() {
        let mut env = MapEnv::new();
        env.set("RIVETOS_SHARED_DIR", "/data/shared");
        let home = protocol::host::home_dir(&env).expect("passwd home");
        assert!(home.starts_with('/'));
        assert_eq!(
            mesh_file_paths_in("", None, &env).unwrap(),
            vec![
                "/data/shared/mesh.json".to_string(),
                path_join(&home, &[".rivetos", "mesh.json"]),
            ]
        );
    }

    #[test]
    fn supplied_home_is_the_instance_candidate() {
        let mut env = MapEnv::new();
        env.set("HOME", "/home/example");
        env.set("RIVETOS_SHARED_DIR", "/data/shared");
        assert_eq!(
            mesh_file_paths_in("", None, &env).unwrap(),
            vec![
                "/data/shared/mesh.json".to_string(),
                "/home/example/.rivetos/mesh.json".to_string(),
            ]
        );
        env.set("HOME", "");
        assert_eq!(
            mesh_file_paths_in("", Some("/gateway/shared"), &env).unwrap(),
            vec![
                "/gateway/shared/mesh.json".to_string(),
                ".rivetos/mesh.json".to_string(),
            ]
        );
        assert_eq!(
            mesh_file_paths_in("/x/mesh.json", None, &env).unwrap(),
            vec!["/x/mesh.json".to_string()]
        );
    }
}
