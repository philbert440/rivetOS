use std::path::Path;

use protocol::host::{Env, PasswdLookup, ProcessEnv, SystemError};
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

pub fn mesh_file_paths(
    mesh_file: &str,
    shared_root: Option<&str>,
) -> Result<Vec<String>, SystemError> {
    mesh_file_paths_in(
        mesh_file,
        shared_root,
        &ProcessEnv,
        &protocol::host::CurrentPasswd,
    )
}

fn mesh_file_paths_in(
    mesh_file: &str,
    shared_root: Option<&str>,
    env: &dyn Env,
    lookup: &dyn PasswdLookup,
) -> Result<Vec<String>, SystemError> {
    if !mesh_file.is_empty() {
        return Ok(vec![mesh_file.to_string()]);
    }
    let shared = match shared_root {
        Some(root) => root.to_string(),
        None => config::paths::shared_dir(env),
    };
    let home = protocol::host::os_homedir(env, lookup)?;
    Ok(vec![
        path_join(&shared, &["mesh.json"]),
        path_join(&home, &[".rivetos", "mesh.json"]),
    ])
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
    use protocol::host::{MapEnv, PasswdLookup};
    use protocol::js::posix_join;

    use super::{mesh_file_paths_in, path_join};

    struct StaticPasswd {
        result: Result<String, i32>,
    }

    impl PasswdLookup for StaticPasswd {
        fn current_home(&self) -> Result<String, i32> {
            self.result.clone()
        }
    }

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
        let rows: serde_json::Value =
            serde_json::from_str(include_str!("../tests/golden/homedir-system-error.json"))
                .unwrap();
        let env = MapEnv::new();
        for row in rows.as_array().unwrap() {
            let errno = i32::try_from(row["errno"].as_i64().unwrap()).unwrap();
            let lookup = StaticPasswd { result: Err(errno) };
            let err = mesh_file_paths_in("", Some("/rivet-shared"), &env, &lookup).unwrap_err();
            let direct = protocol::host::os_homedir(&env, &lookup).unwrap_err();
            assert_eq!(err, direct, "{}", row["label"]);
            assert_eq!(err.code, row["code"].as_str().unwrap(), "{}", row["label"]);
            assert_eq!(
                err.errno,
                i32::try_from(row["errno_value"].as_i64().unwrap()).unwrap(),
                "{}",
                row["label"]
            );
            assert_eq!(
                err.syscall,
                row["syscall"].as_str().unwrap(),
                "{}",
                row["label"]
            );
            assert_eq!(
                err.message,
                row["message"].as_str().unwrap(),
                "{}",
                row["label"]
            );
            assert_eq!(
                err.to_string(),
                row["string"].as_str().unwrap(),
                "{}",
                row["label"]
            );
            assert_eq!(
                err.info.code,
                row["info_code"].as_str().unwrap(),
                "{}",
                row["label"]
            );
            assert_eq!(
                err.info.errno,
                i32::try_from(row["info_errno"].as_i64().unwrap()).unwrap(),
                "{}",
                row["label"]
            );
            assert_eq!(
                err.info.syscall,
                row["info_syscall"].as_str().unwrap(),
                "{}",
                row["label"]
            );
            assert_eq!(
                err.info.message,
                row["info_message"].as_str().unwrap(),
                "{}",
                row["label"]
            );
        }
        let missing = StaticPasswd { result: Err(2) };
        assert_eq!(
            mesh_file_paths_in("/x/mesh.json", None, &env, &missing).unwrap(),
            vec!["/x/mesh.json".to_string()]
        );
        let found = StaticPasswd {
            result: Ok("/home/example".to_string()),
        };
        assert_eq!(
            mesh_file_paths_in("", Some("/rivet-shared"), &env, &found).unwrap(),
            vec![
                "/rivet-shared/mesh.json".to_string(),
                "/home/example/.rivetos/mesh.json".to_string(),
            ]
        );
    }

    #[test]
    fn unset_home_uses_the_injected_passwd_entry() {
        let mut env = MapEnv::new();
        env.set("RIVETOS_SHARED_DIR", "/data/shared");
        let lookup = StaticPasswd {
            result: Ok("/home/injected".to_string()),
        };
        assert_eq!(
            mesh_file_paths_in("", None, &env, &lookup).unwrap(),
            vec![
                "/data/shared/mesh.json".to_string(),
                path_join("/home/injected", &[".rivetos", "mesh.json"]),
            ]
        );
    }

    #[test]
    fn live_passwd_lookup_reports_the_system_error_when_the_account_is_absent() {
        let mut env = MapEnv::new();
        env.set("RIVETOS_SHARED_DIR", "/data/shared");
        let lookup = protocol::host::CurrentPasswd;
        match protocol::host::os_homedir(&env, &lookup) {
            Ok(home) => {
                assert!(home.starts_with('/'));
                assert_eq!(
                    mesh_file_paths_in("", None, &env, &lookup).unwrap(),
                    vec![
                        "/data/shared/mesh.json".to_string(),
                        path_join(&home, &[".rivetos", "mesh.json"]),
                    ]
                );
            }
            Err(err) => {
                assert_eq!(err.code, "ERR_SYSTEM_ERROR");
                assert_eq!(err.syscall, "uv_os_homedir");
                let again = mesh_file_paths_in("", None, &env, &lookup).unwrap_err();
                assert_eq!(again, err);
            }
        }
    }

    #[test]
    fn supplied_home_is_the_instance_candidate() {
        let mut env = MapEnv::new();
        env.set("HOME", "/home/example");
        env.set("RIVETOS_SHARED_DIR", "/data/shared");
        let missing = StaticPasswd { result: Err(2) };
        assert_eq!(
            mesh_file_paths_in("", None, &env, &missing).unwrap(),
            vec![
                "/data/shared/mesh.json".to_string(),
                "/home/example/.rivetos/mesh.json".to_string(),
            ]
        );
        env.set("HOME", "");
        assert_eq!(
            mesh_file_paths_in("", Some("/gateway/shared"), &env, &missing).unwrap(),
            vec![
                "/gateway/shared/mesh.json".to_string(),
                ".rivetos/mesh.json".to_string(),
            ]
        );
        assert_eq!(
            mesh_file_paths_in("/x/mesh.json", None, &env, &missing).unwrap(),
            vec!["/x/mesh.json".to_string()]
        );
    }
}
