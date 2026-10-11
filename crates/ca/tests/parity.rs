use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};

use ca::CaPaths;

fn scratch(name: &str) -> CaPaths {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("rr9c-{nanos}-{name}-root"));
    let shared = std::env::temp_dir().join(format!("rr9c-{nanos}-{name}-shared"));
    CaPaths::new(root, shared)
}

fn run(paths: &CaPaths, args: &[&str]) -> (i32, String, String) {
    let owned: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let code = ca::run(&owned, paths, &mut stdout, &mut stderr);
    (
        code,
        String::from_utf8(stdout).unwrap(),
        String::from_utf8(stderr).unwrap(),
    )
}

fn script_help() -> String {
    let script = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../scripts/rivet-ca.sh"),
    )
    .unwrap();
    let mut lines = Vec::new();
    for line in script.lines().skip(1).take(39) {
        let rest = line.strip_prefix('#').unwrap_or(line);
        let rest = rest.strip_prefix(' ').unwrap_or(rest);
        lines.push(rest);
    }
    let mut text = lines.join("\n");
    text.push('\n');
    text
}

fn have_openssl() -> bool {
    Command::new("openssl")
        .arg("version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn openssl_raw(args: &[&str]) -> Output {
    Command::new("openssl")
        .args(args)
        .output()
        .expect("spawn openssl")
}

fn openssl(args: &[&str]) -> Output {
    let output = openssl_raw(args);
    if !output.status.success() {
        panic!(
            "openssl {args:?}\nstdout {}\nstderr {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    output
}

fn openssl_stdout(args: &[&str]) -> String {
    String::from_utf8(openssl(args).stdout).unwrap()
}

fn mode(path: &Path) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn assert_ok(output: &(i32, String, String)) {
    assert_eq!(output.0, 0, "stderr:\n{}", output.2);
}

#[test]
fn cli_messages_match_the_script() {
    let paths = scratch("cli");
    let (code, stdout, stderr) = run(&paths, &[]);
    assert_eq!(code, 0);
    assert_eq!(stderr, "");
    assert_eq!(stdout, script_help());
    let (code, stdout, _) = run(&paths, &["--help"]);
    assert_eq!(code, 0);
    assert_eq!(stdout, script_help());
    let (code, _, stderr) = run(&paths, &["help"]);
    assert_eq!(code, 1);
    assert_eq!(stderr, "rivet-ca: unknown subcommand: help  (try --help)\n");
    let (code, _, stderr) = run(&paths, &["nope"]);
    assert_eq!(code, 1);
    assert_eq!(stderr, "rivet-ca: unknown subcommand: nope  (try --help)\n");
    let (code, _, stderr) = run(&paths, &["issue-node"]);
    assert_eq!(code, 1);
    assert_eq!(
        stderr,
        "rivet-ca: usage: issue-node <node-id> [extra-san ...]\n"
    );
    let (code, _, stderr) = run(&paths, &["issue-agent", "only"]);
    assert_eq!(code, 1);
    assert_eq!(
        stderr,
        "rivet-ca: usage: issue-agent <agent-id> <node-id>\n"
    );
    let (code, _, stderr) = run(&paths, &["issue-client"]);
    assert_eq!(code, 1);
    assert_eq!(
        stderr,
        "rivet-ca: usage: issue-client <device-id>   (e.g. pixel-owner, desk-chrome)\n"
    );
    let (code, _, stderr) = run(&paths, &["issue-client", "bad id"]);
    assert_eq!(code, 1);
    assert_eq!(
        stderr,
        "rivet-ca: device-id must be alphanumeric / . _ - (got: bad id)\n"
    );
    assert!(!paths.issued_dir().exists());
    let (code, _, stderr) = run(&paths, &["revoke"]);
    assert_eq!(code, 1);
    assert_eq!(
        stderr,
        "rivet-ca: usage: revoke <cn>   (e.g. node-b.mesh, opus@node-b)\n"
    );
    let (code, _, stderr) = run(&paths, &["verify", "/no/such/cert.pem"]);
    assert_eq!(code, 1);
    assert_eq!(stderr, "rivet-ca: usage: verify <cert-path>\n");
    assert!(!ca::valid_device_id(""));
    assert!(ca::valid_device_id("pixel-owner"));
    assert!(ca::valid_device_id("a.b_c-d"));
    assert!(!ca::valid_device_id(".hidden"));
}

#[test]
fn native_ca_matches_openssl() {
    if !have_openssl() {
        return;
    }
    let paths = scratch("native");
    let root = paths.root_dir.clone();
    let shared = paths.shared_dir.clone();
    let init = run(&paths, &["init"]);
    assert_ok(&init);
    assert_eq!(
        init.2,
        format!(
            "rivet-ca: generating root key + self-signed cert (3650 days) at {}\nrivet-ca: root cert: {}/ca.crt\nrivet-ca: root key:  {}/ca.key  (KEEP OFFLINE / LOCAL ONLY)\n",
            root.display(),
            root.display(),
            root.display()
        )
    );
    assert_eq!(mode(&root), 0o700);
    assert_eq!(mode(&root.join("ca.key")), 0o600);
    assert!(
        fs::read_to_string(root.join("ca.key"))
            .unwrap()
            .contains("-----BEGIN PRIVATE KEY-----")
    );
    assert_eq!(fs::read_to_string(root.join("ca.srl")).unwrap(), "1000\n");
    assert!(!root.join("index.txt").exists());
    assert!(!root.join("ca.srl.old").exists());
    let again = run(&paths, &["init"]);
    assert_eq!(again.0, 1);
    assert_eq!(
        again.2,
        format!(
            "rivet-ca: root already exists at {}/ca.key — refusing to overwrite\n",
            root.display()
        )
    );

    let intermediate = run(&paths, &["issue-intermediate"]);
    assert_ok(&intermediate);
    let int_dir = paths.int_dir();
    assert_eq!(mode(&int_dir.join("int.key")), 0o600);
    assert!(!int_dir.join("int.csr").exists());
    assert_eq!(fs::read_to_string(root.join("ca.srl")).unwrap(), "1001\n");
    assert_eq!(
        fs::read_to_string(int_dir.join("int.srl")).unwrap(),
        "1000\n"
    );
    assert_eq!(
        fs::read_to_string(int_dir.join("crlnumber")).unwrap(),
        "1001\n"
    );
    assert_eq!(
        fs::read_to_string(int_dir.join("crlnumber.old")).unwrap(),
        "1000\n"
    );
    assert_eq!(fs::read(int_dir.join("index.txt")).unwrap(), b"");
    assert_eq!(
        fs::read_to_string(int_dir.join("index.txt.attr")).unwrap(),
        "unique_subject = no\n"
    );
    let chain = fs::read(int_dir.join("chain.pem")).unwrap();
    let mut expected_chain = fs::read(int_dir.join("int.crt")).unwrap();
    expected_chain.extend(fs::read(root.join("ca.crt")).unwrap());
    assert_eq!(chain, expected_chain);
    assert_eq!(
        fs::read(int_dir.join("ca-chain.pem")).unwrap(),
        expected_chain
    );
    assert!(intermediate.2.contains(&format!(
        "rivet-ca: CRL written: {}/crl.pem\n",
        shared.display()
    )));
    assert!(
        intermediate
            .2
            .contains("rivet-ca: signing intermediate with root\n")
    );
    assert!(intermediate.2.contains(&format!(
        "rivet-ca: chain bundle:      {}/chain.pem\n",
        int_dir.display()
    )));

    let root_text = openssl_stdout(&[
        "x509",
        "-in",
        &root.join("ca.crt").display().to_string(),
        "-noout",
        "-text",
    ]);
    assert!(root_text.contains("Signature Algorithm: sha256WithRSAEncryption"));
    assert!(root_text.contains("Issuer: O = Rivet Collective, CN = Rivet Root CA"));
    assert!(root_text.contains("Subject: O = Rivet Collective, CN = Rivet Root CA"));
    assert!(root_text.contains("(4096 bit)"));
    assert!(root_text.contains("CA:TRUE"));
    assert!(!root_text.contains("pathlen"));
    assert!(root_text.contains("Certificate Sign"));
    assert!(root_text.contains("CRL Sign"));
    assert!(!root_text.contains("CRL Distribution"));
    assert!(!aki_has_dirname(&root_text));

    let int_crt = int_dir.join("int.crt").display().to_string();
    let int_text = openssl_stdout(&["x509", "-in", &int_crt, "-noout", "-text"]);
    assert!(int_text.contains("Issuer: O = Rivet Collective, CN = Rivet Root CA"));
    assert!(int_text.contains("Subject: O = Rivet Collective, CN = Rivet Intermediate CA"));
    assert!(int_text.contains("(4096 bit)"));
    assert!(int_text.contains("CA:TRUE"));
    assert!(int_text.contains("pathlen:0"));
    assert_eq!(
        openssl_stdout(&["x509", "-in", &int_crt, "-noout", "-serial"]).trim(),
        "serial=1001"
    );
    let crl_text = openssl_stdout(&[
        "crl",
        "-in",
        &paths.crl_path().display().to_string(),
        "-noout",
        "-text",
    ]);
    assert!(
        crl_text.contains("No Revoked Certificates") || !crl_text.contains("Revoked Certificates:")
    );
    assert!(crl_text.contains("CRL Number:"));
    assert!(crl_text.contains("4096") || crl_text.contains("0x1000"));
    assert!(!crl_text.contains("Authority Key Identifier"));

    let node = run(
        &paths,
        &[
            "issue-node",
            "node-a",
            "bare.example",
            "IP:10.1.2.3",
            "URI:https://example.test/a",
            "email:dev@example.test",
        ],
    );
    assert_ok(&node);
    let node_crt = paths.issued_dir().join("node-a.crt");
    let first_node = fs::read(&node_crt).unwrap();
    let node_key = fs::read(paths.issued_dir().join("node-a.key")).unwrap();
    assert!(node.2.contains(&format!(
        "rivet-ca: issued node cert: {}\n",
        node_crt.display()
    )));
    assert!(node.2.contains("rivet-ca:   SANs: DNS:node-a.mesh,DNS:node-a-mcp.mesh,DNS:node-a-runtime-rpc.mesh,DNS:bare.example,IP:10.1.2.3,URI:https://example.test/a,email:dev@example.test\n"));
    assert_eq!(
        fs::read_to_string(int_dir.join("int.srl")).unwrap(),
        "1001\n"
    );
    assert_eq!(fs::read(int_dir.join("1000.pem")).unwrap(), first_node);
    let node_text = openssl_stdout(&[
        "x509",
        "-in",
        &node_crt.display().to_string(),
        "-noout",
        "-text",
    ]);
    assert!(node_text.contains("Subject: CN = node-a.mesh, O = Rivet Collective"));
    assert!(node_text.contains("Issuer: O = Rivet Collective, CN = Rivet Intermediate CA"));
    assert!(node_text.contains("(2048 bit)"));
    assert!(node_text.contains("CA:FALSE"));
    assert!(node_text.contains("Digital Signature"));
    assert!(node_text.contains("Key Encipherment"));
    assert!(node_text.contains("TLS Web Server Authentication"));
    assert!(node_text.contains("TLS Web Client Authentication"));
    assert!(node_text.contains("DNS:node-a.mesh"));
    assert!(node_text.contains("DNS:node-a-mcp.mesh"));
    assert!(node_text.contains("DNS:node-a-runtime-rpc.mesh"));
    assert!(node_text.contains("DNS:bare.example"));
    assert!(node_text.contains("10.1.2.3"));
    assert!(node_text.contains("https://example.test/a"));
    assert!(node_text.contains("dev@example.test"));
    assert!(!node_text.contains("CRL Distribution"));
    assert!(!aki_has_dirname(&node_text));
    assert_eq!(
        openssl_stdout(&[
            "x509",
            "-in",
            &node_crt.display().to_string(),
            "-noout",
            "-serial"
        ])
        .trim(),
        "serial=1000"
    );
    compare_verify(&paths, &node_crt);

    let agent = run(&paths, &["issue-agent", "opus", "node-a"]);
    assert_ok(&agent);
    let agent_crt = paths.issued_dir().join("opus@node-a.crt");
    assert!(agent.2.contains(&format!(
        "rivet-ca: issued agent cert: {}  (CN=opus@node-a)\n",
        agent_crt.display()
    )));
    let agent_text = openssl_stdout(&[
        "x509",
        "-in",
        &agent_crt.display().to_string(),
        "-noout",
        "-text",
    ]);
    assert!(agent_text.contains("Subject: CN = opus@node-a, O = Rivet Collective"));
    assert!(!agent_text.contains("OU ="));
    assert!(!agent_text.contains("Subject Alternative Name"));
    assert!(agent_text.contains("TLS Web Client Authentication"));
    assert!(!agent_text.contains("TLS Web Server Authentication"));
    assert!(agent_text.contains("Digital Signature"));
    assert!(!agent_text.contains("Key Encipherment"));
    assert_eq!(
        openssl_stdout(&[
            "x509",
            "-in",
            &agent_crt.display().to_string(),
            "-noout",
            "-serial"
        ])
        .trim(),
        "serial=1001"
    );
    compare_verify(&paths, &agent_crt);

    let client = run(&paths, &["issue-client", "pixel-owner"]);
    assert_ok(&client);
    let client_crt = paths.issued_dir().join("device-pixel-owner.crt");
    assert!(client.2.contains(&format!(
        "rivet-ca: issued device client cert: {}  (CN=device:pixel-owner OU=client)\n",
        client_crt.display()
    )));
    assert!(
        client
            .2
            .contains("rivet-ca:   install on the device only — do not publish the .key\n")
    );
    let client_text = openssl_stdout(&[
        "x509",
        "-in",
        &client_crt.display().to_string(),
        "-noout",
        "-text",
    ]);
    assert!(
        client_text.contains("Subject: CN = device:pixel-owner, O = Rivet Collective, OU = client")
    );
    assert!(!client_text.contains("Subject Alternative Name"));
    assert_eq!(
        openssl_stdout(&[
            "x509",
            "-in",
            &client_crt.display().to_string(),
            "-noout",
            "-serial"
        ])
        .trim(),
        "serial=1002"
    );
    compare_verify(&paths, &client_crt);
    assert_eq!(
        mode(&paths.issued_dir().join("device-pixel-owner.key")),
        0o600
    );

    let renewed = run(&paths, &["issue-node", "node-a"]);
    assert_ok(&renewed);
    assert!(renewed.2.contains(&format!(
        "rivet-ca: WARN: {} exists — renewing (key reused if present)\n",
        node_crt.display()
    )));
    assert_eq!(
        fs::read(paths.issued_dir().join("node-a.key")).unwrap(),
        node_key
    );
    assert_ne!(fs::read(&node_crt).unwrap(), first_node);
    assert_eq!(fs::read(int_dir.join("1000.pem")).unwrap(), first_node);
    assert_eq!(
        fs::read_to_string(int_dir.join("int.srl")).unwrap(),
        "1004\n"
    );
    assert_eq!(
        openssl_stdout(&[
            "x509",
            "-in",
            &node_crt.display().to_string(),
            "-noout",
            "-serial"
        ])
        .trim(),
        "serial=1003"
    );
    let index = fs::read_to_string(int_dir.join("index.txt")).unwrap();
    assert!(index.contains("\t1000\tunknown\t/CN=node-a.mesh/O=Rivet Collective\n"));
    assert!(index.contains("\t1001\tunknown\t/CN=opus@node-a/O=Rivet Collective\n"));
    assert!(
        index.contains("\t1002\tunknown\t/CN=device:pixel-owner/O=Rivet Collective/OU=client\n")
    );
    assert!(index.contains("\t1003\tunknown\t/CN=node-a.mesh/O=Rivet Collective\n"));
    assert_eq!(
        index.lines().filter(|line| line.starts_with("V\t")).count(),
        4
    );

    let listed = run(&paths, &["list"]);
    assert_ok(&listed);
    assert_eq!(listed.1, expected_list(&paths.issued_dir()));

    let p12 = shared.join("pixel.p12");
    ca::mint_device_p12(&paths, "pixel-owner", "test-pass-phrase", &p12).unwrap();
    assert_eq!(mode(&p12), 0o600);
    assert!(!paths.issued_dir().join("device-pixel-owner.key").exists());
    assert!(client_crt.exists());
    let opened = openssl_raw(&[
        "pkcs12",
        "-in",
        &p12.display().to_string(),
        "-passin",
        "pass:test-pass-phrase",
        "-noout",
    ]);
    assert!(
        opened.status.success(),
        "{}",
        String::from_utf8_lossy(&opened.stderr)
    );

    let revoked = run(&paths, &["revoke", "node-a.mesh"]);
    assert_ok(&revoked);
    assert!(
        revoked
            .2
            .contains(&format!("rivet-ca: revoking {}\n", node_crt.display()))
    );
    assert!(revoked.2.contains(&format!(
        "rivet-ca: CRL written: {}/crl.pem\n",
        shared.display()
    )));
    let index = fs::read_to_string(int_dir.join("index.txt")).unwrap();
    assert!(
        index
            .lines()
            .any(|line| line.starts_with("R\t") && line.contains("\t1003\t"))
    );
    assert!(
        index
            .lines()
            .any(|line| line.starts_with("V\t") && line.contains("\t1000\t"))
    );
    assert_eq!(
        fs::read_to_string(int_dir.join("crlnumber")).unwrap(),
        "1002\n"
    );
    let crl_text = openssl_stdout(&[
        "crl",
        "-in",
        &paths.crl_path().display().to_string(),
        "-noout",
        "-text",
    ]);
    assert!(crl_text.contains("Serial Number: 1003") || crl_text.contains("Serial Number: 4099"));
    assert!(!crl_text.contains("Authority Key Identifier"));
    compare_verify(&paths, &node_crt);
    compare_verify(&paths, &agent_crt);

    let extra_key = shared.join("extra.key");
    let extra_csr = shared.join("extra.csr");
    let extra_crt = shared.join("extra.crt");
    openssl(&["genrsa", "-out", &extra_key.display().to_string(), "2048"]);
    openssl(&[
        "req",
        "-new",
        "-sha256",
        "-key",
        &extra_key.display().to_string(),
        "-out",
        &extra_csr.display().to_string(),
        "-subj",
        "/O=Rivet Collective/CN=openssl-extra.mesh",
    ]);
    openssl(&[
        "ca",
        "-batch",
        "-notext",
        "-config",
        &int_dir.join("openssl.cnf").display().to_string(),
        "-extensions",
        "v3_client",
        "-in",
        &extra_csr.display().to_string(),
        "-out",
        &extra_crt.display().to_string(),
    ]);
    compare_verify(&paths, &extra_crt);
    let revoked_extra = run(&paths, &["revoke", "openssl-extra.mesh"]);
    assert_eq!(
        revoked_extra.0, 1,
        "openssl-issued cert is not in issued/, revoke scans issued/"
    );
}

fn compare_verify(paths: &CaPaths, cert: &Path) {
    let ours = run(paths, &["verify", &cert.display().to_string()]);
    let openssl = openssl_raw(&[
        "verify",
        "-CAfile",
        &paths.chain_path().display().to_string(),
        "-crl_check",
        "-CRLfile",
        &paths.crl_path().display().to_string(),
        &cert.display().to_string(),
    ]);
    let openssl_code = openssl.status.code().unwrap_or(1);
    let openssl_out = String::from_utf8_lossy(&openssl.stdout).into_owned();
    let openssl_err = String::from_utf8_lossy(&openssl.stderr).into_owned();
    assert_eq!(
        ours.0, openssl_code,
        "openssl stdout {openssl_out} stderr {openssl_err}\nours {}",
        ours.2
    );
    assert_eq!(
        ours.1, openssl_out,
        "stderr openssl {openssl_err} ours {}",
        ours.2
    );
    assert_eq!(ours.2, openssl_err);
}

fn expected_list(dir: &Path) -> String {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("crt"))
        .collect();
    files.sort();
    let mut text = format!("{} {} {}\n", pad("CN", 40), pad("EXPIRES", 25), "FILE");
    for path in files {
        let subject = openssl_stdout(&[
            "x509",
            "-in",
            &path.display().to_string(),
            "-noout",
            "-subject",
        ]);
        let subject = subject.trim_end();
        let end = openssl_stdout(&[
            "x509",
            "-in",
            &path.display().to_string(),
            "-noout",
            "-enddate",
        ]);
        let expires = end.trim_end().split_once('=').unwrap().1;
        let name = path.file_name().unwrap().to_str().unwrap();
        text.push_str(&format!(
            "{} {} {}\n",
            pad(subject, 40),
            pad(expires, 25),
            name
        ));
    }
    text
}

fn pad(text: &str, width: usize) -> String {
    if text.len() >= width {
        text.to_string()
    } else {
        let mut out = text.to_string();
        out.extend(std::iter::repeat_n(' ', width - text.len()));
        out
    }
}

fn aki_has_dirname(text: &str) -> bool {
    let mut in_aki = false;
    for line in text.lines() {
        if line.contains("Authority Key Identifier") {
            in_aki = true;
            continue;
        }
        if in_aki {
            if line.contains("DirName") || line.contains("serial:") {
                return true;
            }
            if !line.starts_with(' ') && !line.starts_with('\t') {
                in_aki = false;
            }
        }
    }
    false
}

#[test]
fn openssl_tree_then_native_leaf() {
    if !have_openssl() {
        return;
    }
    let paths = scratch("openssl-tree");
    fs::create_dir_all(&paths.root_dir).unwrap();
    fs::create_dir_all(paths.int_dir()).unwrap();
    fs::create_dir_all(paths.issued_dir()).unwrap();
    let root_cnf = paths.root_dir.join("root.cnf");
    fs::write(
        &root_cnf,
        "[ req ]\ndistinguished_name = req_dn\nprompt = no\nx509_extensions = v3_root\n[ req_dn ]\nO = Rivet Collective\nCN = Rivet Root CA\n[ v3_root ]\nbasicConstraints = critical, CA:TRUE\nkeyUsage = critical, keyCertSign, cRLSign\nsubjectKeyIdentifier = hash\nauthorityKeyIdentifier = keyid:always,issuer\n",
    )
    .unwrap();
    let ext = paths.root_dir.join("int.ext");
    fs::write(
        &ext,
        "basicConstraints = critical, CA:TRUE, pathlen:0\nkeyUsage = critical, keyCertSign, cRLSign\nsubjectKeyIdentifier = hash\nauthorityKeyIdentifier = keyid:always,issuer\n",
    )
    .unwrap();
    let ca_key = paths.root_dir.join("ca.key");
    let ca_crt = paths.root_dir.join("ca.crt");
    let ca_srl = paths.root_dir.join("ca.srl");
    openssl(&["genrsa", "-out", &ca_key.display().to_string(), "4096"]);
    openssl(&[
        "req",
        "-new",
        "-x509",
        "-sha256",
        "-days",
        "3650",
        "-key",
        &ca_key.display().to_string(),
        "-out",
        &ca_crt.display().to_string(),
        "-config",
        &root_cnf.display().to_string(),
    ]);
    fs::write(&ca_srl, "1000\n").unwrap();
    let int_key = paths.int_dir().join("int.key");
    let int_csr = paths.int_dir().join("int.csr");
    let int_crt = paths.int_dir().join("int.crt");
    openssl(&["genrsa", "-out", &int_key.display().to_string(), "4096"]);
    openssl(&[
        "req",
        "-new",
        "-sha256",
        "-key",
        &int_key.display().to_string(),
        "-out",
        &int_csr.display().to_string(),
        "-subj",
        "/O=Rivet Collective/CN=Rivet Intermediate CA",
    ]);
    openssl(&[
        "x509",
        "-req",
        "-sha256",
        "-days",
        "1825",
        "-in",
        &int_csr.display().to_string(),
        "-CA",
        &ca_crt.display().to_string(),
        "-CAkey",
        &ca_key.display().to_string(),
        "-CAserial",
        &ca_srl.display().to_string(),
        "-out",
        &int_crt.display().to_string(),
        "-extfile",
        &ext.display().to_string(),
    ]);
    fs::remove_file(&int_csr).unwrap();
    let mut chain = fs::read(&int_crt).unwrap();
    chain.extend(fs::read(&ca_crt).unwrap());
    fs::write(paths.chain_path(), &chain).unwrap();
    let issued = run(&paths, &["issue-node", "foreign"]);
    assert_ok(&issued);
    let crl = run(&paths, &["crl"]);
    assert_ok(&crl);
    let cert = paths.issued_dir().join("foreign.crt");
    compare_verify(&paths, &cert);
    let text = openssl_stdout(&[
        "x509",
        "-in",
        &cert.display().to_string(),
        "-noout",
        "-text",
    ]);
    assert!(text.contains("Subject: CN = foreign.mesh, O = Rivet Collective"));
    assert!(text.contains("Issuer: O = Rivet Collective, CN = Rivet Intermediate CA"));
    assert_eq!(
        fs::read_to_string(paths.int_dir().join("int.srl")).unwrap(),
        "1001\n"
    );
}
