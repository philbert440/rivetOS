use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
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
    assert!(ca::valid_device_id("a..b"));
    assert!(!ca::valid_device_id(".hidden"));
    for id in ["../x", "a/b", "a..b", "a\0b", ".", ".."] {
        let (code, _, stderr) = run(&paths, &["issue-node", id]);
        assert_eq!(code, 1, "{stderr}");
        assert!(
            stderr.contains("node-id must be a single path component"),
            "{stderr}"
        );
        let (code, _, stderr) = run(&paths, &["issue-agent", id, "node-a"]);
        assert_eq!(code, 1, "{stderr}");
        assert!(
            stderr.contains("agent-id must be a single path component"),
            "{stderr}"
        );
    }
    let (code, _, stderr) = run(&paths, &["issue-agent", "opus", "a/b"]);
    assert_eq!(code, 1, "{stderr}");
    assert!(
        stderr.contains("node-id must be a single path component"),
        "{stderr}"
    );
    assert!(!paths.issued_dir().exists());
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
    assert_window(&root.join("ca.crt"), 3650);
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
    assert_critical_and_linked(&root_text, &root_text);
    assert_window(&int_dir.join("int.crt"), 1825);

    let int_crt = int_dir.join("int.crt").display().to_string();
    let int_text = openssl_stdout(&["x509", "-in", &int_crt, "-noout", "-text"]);
    assert!(int_text.contains("Issuer: O = Rivet Collective, CN = Rivet Root CA"));
    assert!(int_text.contains("Subject: O = Rivet Collective, CN = Rivet Intermediate CA"));
    assert!(int_text.contains("(4096 bit)"));
    assert!(int_text.contains("CA:TRUE"));
    assert!(int_text.contains("pathlen:0"));
    assert_critical_and_linked(&int_text, &root_text);
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
    assert_eq!(fs::read(int_dir.join("int.srl.old")).unwrap(), b"1000\n");
    assert_eq!(fs::read(int_dir.join("index.txt.old")).unwrap(), b"");
    assert_window(&node_crt, 90);
    let node_text = openssl_stdout(&[
        "x509",
        "-in",
        &node_crt.display().to_string(),
        "-noout",
        "-text",
    ]);
    assert!(node_text.contains("Subject: CN = node-a.mesh, O = Rivet Collective"));
    assert_critical_and_linked(&node_text, &int_text);
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
    let index_before_client = fs::read_to_string(int_dir.join("index.txt.old")).unwrap();
    assert!(
        index_before_client.contains("\t1000\t"),
        "{index_before_client}"
    );
    assert!(
        !index_before_client.contains("\t1001\t"),
        "{index_before_client}"
    );
    let saved_chain = fs::read(paths.chain_path()).unwrap();
    fs::write(
        paths.chain_path(),
        fs::read(int_dir.join("int.crt")).unwrap(),
    )
    .unwrap();
    compare_verify(&paths, &agent_crt);
    fs::write(paths.chain_path(), &saved_chain).unwrap();

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

    let chain_bytes = fs::read(paths.chain_path()).unwrap();
    let ca_chain = int_dir.join("ca-chain.pem");
    fs::remove_file(&ca_chain).unwrap();
    assert_ok(&run(&paths, &["issue-client", "onlychain"]));
    let only_p12 = shared.join("onlychain.p12");
    ca::mint_device_p12(&paths, "onlychain", "test-pass-phrase", &only_p12).unwrap();
    assert_eq!(mode(&only_p12), 0o600);
    assert!(!paths.issued_dir().join("device-onlychain.key").exists());
    assert_ok(&run(&paths, &["issue-client", "nochain"]));
    fs::remove_file(paths.chain_path()).unwrap();
    let missing_chain = ca::mint_device_p12(
        &paths,
        "nochain",
        "test-pass-phrase",
        &shared.join("nochain.p12"),
    );
    assert!(
        missing_chain
            .unwrap_err()
            .to_string()
            .contains("no CA chain"),
    );
    assert!(paths.issued_dir().join("device-nochain.key").exists());
    fs::write(paths.chain_path(), &chain_bytes).unwrap();
    assert_ok(&run(&paths, &["issue-client", "dirchain"]));
    fs::create_dir(&ca_chain).unwrap();
    let dir_chain = ca::mint_device_p12(
        &paths,
        "dirchain",
        "test-pass-phrase",
        &shared.join("dirchain.p12"),
    );
    assert!(
        dir_chain.is_err(),
        "a directory must not fall back to chain.pem"
    );
    assert!(paths.issued_dir().join("device-dirchain.key").exists());
    fs::remove_dir(&ca_chain).unwrap();
    fs::write(&ca_chain, &chain_bytes).unwrap();

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
    let again = run(&paths, &["revoke", "node-a.mesh"]);
    assert_eq!(again.0, 1, "{}", again.2);
    assert!(again.2.contains("rivet-ca: revoking "), "{}", again.2);
    assert!(again.2.contains("ERROR:Already revoked"), "{}", again.2);
    assert!(!again.2.contains("rivet-ca: ERROR:"), "{}", again.2);

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

    fs::write(int_dir.join("int.srl"), "FFFF\n").unwrap();
    let wide = run(&paths, &["issue-node", "wide"]);
    assert_ok(&wide);
    assert_eq!(
        fs::read_to_string(int_dir.join("int.srl")).unwrap(),
        "010000\n"
    );
    let wide_crt = paths.issued_dir().join("wide.crt");
    assert_eq!(
        openssl_stdout(&[
            "x509",
            "-in",
            &wide_crt.display().to_string(),
            "-noout",
            "-serial"
        ])
        .trim(),
        "serial=FFFF"
    );
    let index = fs::read_to_string(int_dir.join("index.txt")).unwrap();
    assert!(index.contains("\tFFFF\t"), "{index}");
    fs::write(int_dir.join("int.srl"), "010000\n").unwrap();
    let wider = run(&paths, &["issue-node", "wider"]);
    assert_ok(&wider);
    assert_eq!(
        fs::read_to_string(int_dir.join("int.srl")).unwrap(),
        "010001\n"
    );
    let index = fs::read_to_string(int_dir.join("index.txt")).unwrap();
    assert!(index.contains("\t010000\t"), "{index}");
    let revoked_wide = run(&paths, &["revoke", "wider.mesh"]);
    assert_ok(&revoked_wide);

    let srl_path = int_dir.join("int.srl");
    let index_path = int_dir.join("index.txt");
    let srl_before_bad = fs::read_to_string(&srl_path).unwrap();
    let index_before_bad = fs::read_to_string(&index_path).unwrap();
    let bad_san = run(&paths, &["issue-node", "node-a", "IP:999.1.1.1"]);
    assert_eq!(bad_san.0, 1, "{}", bad_san.2);
    assert_eq!(
        bad_san.2,
        format!(
            "rivet-ca: WARN: {} exists — renewing (key reused if present)\nrivet-ca: invalid SAN IP: IP:999.1.1.1\n",
            node_crt.display()
        )
    );
    assert_eq!(fs::read_to_string(&srl_path).unwrap(), srl_before_bad);
    assert_eq!(fs::read_to_string(&index_path).unwrap(), index_before_bad);

    let before_recover = fs::read_to_string(&index_path).unwrap();
    let used_before = index_serial_values(&before_recover);
    assert_eq!(
        used_before.iter().filter(|value| **value == 0x1000).count(),
        1
    );
    fs::write(&srl_path, "1000\n").unwrap();
    let recovered = run(&paths, &["issue-node", "recovered"]);
    assert_ok(&recovered);
    let recovered_crt = paths.issued_dir().join("recovered.crt");
    let recovered_serial = cert_serial(&recovered_crt);
    let max_before = used_before.iter().copied().max().unwrap();
    assert_eq!(recovered_serial, max_before + 1);
    let after_recover = fs::read_to_string(&index_path).unwrap();
    let used_after = index_serial_values(&after_recover);
    assert_eq!(
        used_after.iter().filter(|value| **value == 0x1000).count(),
        1
    );
    assert_eq!(
        used_after
            .iter()
            .filter(|value| **value == recovered_serial)
            .count(),
        1
    );
    let mut unique = used_after.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), used_after.len(), "{after_recover}");

    let dup_snapshot = fs::read_to_string(&index_path).unwrap();
    let srl_snapshot = fs::read_to_string(&srl_path).unwrap();
    let mut duplicated = dup_snapshot.clone();
    duplicated.push_str(dup_snapshot.lines().next().unwrap());
    duplicated.push('\n');
    fs::write(&index_path, &duplicated).unwrap();
    let dup_issue = run(&paths, &["issue-node", "dup-node"]);
    assert_eq!(dup_issue.0, 1, "{}", dup_issue.2);
    assert!(dup_issue.2.contains("duplicate serial"), "{}", dup_issue.2);
    assert!(!paths.issued_dir().join("dup-node.key").exists());
    assert_eq!(fs::read_to_string(&srl_path).unwrap(), srl_snapshot);
    fs::write(&index_path, &dup_snapshot).unwrap();

    let attr_old = int_dir.join("index.txt.attr.old");
    let attr_old_bytes = fs::read(&attr_old).unwrap();
    fs::remove_file(&attr_old).unwrap();
    symlink("missing-attr-old", &attr_old).unwrap();
    let crl_before = fs::read(paths.crl_path()).unwrap();
    let broken = run(&paths, &["revoke", "opus@node-a"]);
    assert_eq!(broken.0, 1, "{}", broken.2);
    assert_eq!(
        broken.2,
        format!(
            "rivet-ca: revoking {}\nrivet-ca: refusing symlink {}\n",
            agent_crt.display(),
            attr_old.display()
        )
    );
    let revoked_index = fs::read_to_string(&index_path).unwrap();
    assert!(
        revoked_index
            .lines()
            .any(|line| line.starts_with("R\t") && line.contains("\t1001\t")),
        "{revoked_index}"
    );
    assert_ne!(fs::read(paths.crl_path()).unwrap(), crl_before);
    compare_verify(&paths, &agent_crt);
    fs::remove_file(&attr_old).unwrap();
    fs::write(&attr_old, &attr_old_bytes).unwrap();
    let rebuilt = run(&paths, &["crl"]);
    assert_ok(&rebuilt);
    let rebuilt_crl = openssl_stdout(&[
        "crl",
        "-in",
        &paths.crl_path().display().to_string(),
        "-noout",
        "-text",
    ]);
    assert!(
        rebuilt_crl.contains("Serial Number: 1001") || rebuilt_crl.contains("Serial Number: 4097"),
        "{rebuilt_crl}"
    );
    assert!(
        fs::read_to_string(&index_path)
            .unwrap()
            .lines()
            .any(|line| line.starts_with("R\t") && line.contains("\t1001\t"))
    );
    compare_verify(&paths, &agent_crt);

    let index_bytes = fs::read(&index_path).unwrap();
    let wider_crt = paths.issued_dir().join("wider.crt");
    fs::remove_file(&index_path).unwrap();
    fs::create_dir(&index_path).unwrap();
    let unreadable = run(&paths, &["revoke", "wider.mesh"]);
    assert_eq!(unreadable.0, 1, "{}", unreadable.2);
    assert_eq!(
        unreadable.2,
        format!(
            "rivet-ca: revoking {}\nrivet-ca: io: Is a directory (os error 21)\n",
            wider_crt.display()
        )
    );
    fs::remove_dir(&index_path).unwrap();
    fs::write(&index_path, &index_bytes).unwrap();
}

fn index_serial_values(text: &str) -> Vec<u128> {
    text.lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let serial = line.split('\t').nth(3).unwrap();
            u128::from_str_radix(serial, 16).unwrap()
        })
        .collect()
}

fn cert_serial(path: &Path) -> u128 {
    let text = openssl_stdout(&[
        "x509",
        "-in",
        &path.display().to_string(),
        "-noout",
        "-serial",
    ]);
    let hex = text.trim().trim_start_matches("serial=");
    u128::from_str_radix(hex, 16).unwrap()
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

#[test]
fn key_mismatch_keeps_state_and_symlink_is_refused() {
    if !have_openssl() {
        return;
    }
    let paths = scratch("mismatch");
    assert_ok(&run(&paths, &["init"]));
    assert_ok(&run(&paths, &["issue-intermediate"]));
    assert_ok(&run(&paths, &["issue-node", "node-a"]));
    let int_key = paths.int_dir().join("int.key");
    let saved = fs::read(&int_key).unwrap();
    let serial_before = fs::read_to_string(paths.int_dir().join("int.srl")).unwrap();
    let index_before = fs::read_to_string(paths.int_dir().join("index.txt")).unwrap();
    let decoy = paths.shared_dir.join("decoy.key");
    openssl(&["genrsa", "-out", &decoy.display().to_string(), "2048"]);
    fs::write(&int_key, fs::read(&decoy).unwrap()).unwrap();
    let renewed = run(&paths, &["issue-node", "node-a"]);
    assert_ne!(renewed.0, 0, "{}", renewed.2);
    assert!(renewed.2.contains("WARN:"), "{}", renewed.2);
    assert!(renewed.2.contains("does not match"), "{}", renewed.2);
    assert_eq!(
        fs::read_to_string(paths.int_dir().join("int.srl")).unwrap(),
        serial_before
    );
    assert_eq!(
        fs::read_to_string(paths.int_dir().join("index.txt")).unwrap(),
        index_before
    );
    fs::remove_file(&int_key).unwrap();
    symlink(&decoy, &int_key).unwrap();
    let linked = run(&paths, &["issue-node", "fresh"]);
    assert_ne!(linked.0, 0, "{}", linked.2);
    assert!(linked.2.contains("refusing symlink"), "{}", linked.2);
    assert!(!paths.issued_dir().join("fresh.key").exists());
    fs::remove_file(&int_key).unwrap();
    fs::write(&int_key, &saved).unwrap();
}

#[test]
fn script_and_native_cross_verify() {
    if !have_openssl() {
        return;
    }
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../scripts/rivet-ca.sh");
    let from_rust = scratch("cross-rust");
    assert_ok(&run(&from_rust, &["init"]));
    assert_ok(&run(&from_rust, &["issue-intermediate"]));
    assert_ok(&run(&from_rust, &["issue-node", "native-node"]));
    let scripted = run_script(
        &script,
        &from_rust,
        &["issue-agent", "scripted", "native-node"],
    );
    assert_eq!(scripted.0, 0, "{}", scripted.2);
    let native_crt = from_rust.issued_dir().join("native-node.crt");
    let script_crt = from_rust.issued_dir().join("scripted@native-node.crt");
    compare_verify(&from_rust, &native_crt);
    compare_verify(&from_rust, &script_crt);
    let script_text = openssl_stdout(&[
        "x509",
        "-in",
        &script_crt.display().to_string(),
        "-noout",
        "-text",
    ]);
    assert!(
        script_text.contains("Subject: CN = scripted@native-node, O = Rivet Collective"),
        "{script_text}"
    );
    let native_text = openssl_stdout(&[
        "x509",
        "-in",
        &native_crt.display().to_string(),
        "-noout",
        "-text",
    ]);
    assert!(
        native_text.contains("Subject: CN = native-node.mesh, O = Rivet Collective"),
        "{native_text}"
    );
    let int_text = openssl_stdout(&[
        "x509",
        "-in",
        &from_rust.int_dir().join("int.crt").display().to_string(),
        "-noout",
        "-text",
    ]);
    assert_leaf_aki_matches_issuer(&script_text, &int_text);
    assert_leaf_aki_matches_issuer(&native_text, &int_text);
    let index = fs::read_to_string(from_rust.int_dir().join("index.txt")).unwrap();
    assert!(
        index.contains("/CN=native-node.mesh/O=Rivet Collective"),
        "{index}"
    );
    assert!(
        index.contains("/CN=scripted@native-node/O=Rivet Collective"),
        "{index}"
    );
    assert_lists_match(&script, &from_rust);

    let from_script = scratch("cross-script");
    let init = run_script(&script, &from_script, &["init"]);
    assert_eq!(init.0, 0, "{}", init.2);
    let intermediate = run_script(&script, &from_script, &["issue-intermediate"]);
    assert_eq!(intermediate.0, 0, "{}", intermediate.2);
    assert_eq!(
        fs::read_to_string(from_script.root_dir.join("ca.srl")).unwrap(),
        "1001\n"
    );
    assert_eq!(
        openssl_stdout(&[
            "x509",
            "-in",
            &from_script.int_dir().join("int.crt").display().to_string(),
            "-noout",
            "-serial",
        ])
        .trim(),
        "serial=1001"
    );
    let script_root = openssl_stdout(&[
        "x509",
        "-in",
        &from_script.root_dir.join("ca.crt").display().to_string(),
        "-noout",
        "-text",
    ]);
    let script_int = openssl_stdout(&[
        "x509",
        "-in",
        &from_script.int_dir().join("int.crt").display().to_string(),
        "-noout",
        "-text",
    ]);
    assert!(!aki_has_dirname(&script_root), "{script_root}");
    assert_leaf_aki_matches_issuer(&script_int, &script_root);
    let phone = run_script(&script, &from_script, &["issue-client", "phone"]);
    assert_eq!(phone.0, 0, "{}", phone.2);
    assert_ok(&run(&from_script, &["issue-node", "from-rust"]));
    let phone_crt = from_script.issued_dir().join("device-phone.crt");
    let rust_crt = from_script.issued_dir().join("from-rust.crt");
    let phone_text = openssl_stdout(&[
        "x509",
        "-in",
        &phone_crt.display().to_string(),
        "-noout",
        "-text",
    ]);
    let rust_text = openssl_stdout(&[
        "x509",
        "-in",
        &rust_crt.display().to_string(),
        "-noout",
        "-text",
    ]);
    assert!(
        phone_text.contains("Subject: CN = device:phone, O = Rivet Collective, OU = client"),
        "{phone_text}"
    );
    assert!(
        rust_text.contains("Subject: CN = from-rust.mesh, O = Rivet Collective"),
        "{rust_text}"
    );
    assert_leaf_aki_matches_issuer(&phone_text, &script_int);
    assert_leaf_aki_matches_issuer(&rust_text, &script_int);
    let script_index = fs::read_to_string(from_script.int_dir().join("index.txt")).unwrap();
    assert!(
        script_index.contains("/CN=device:phone/O=Rivet Collective/OU=client"),
        "{script_index}"
    );
    assert!(
        script_index.contains("/CN=from-rust.mesh/O=Rivet Collective"),
        "{script_index}"
    );
    assert_lists_match(&script, &from_script);
    compare_verify(&from_script, &phone_crt);
    compare_verify(&from_script, &rust_crt);
    let first = run_script(&script, &from_script, &["revoke", "device:phone"]);
    assert_eq!(first.0, 0, "{}", first.2);
    assert!(first.2.contains("rivet-ca: revoking "), "{}", first.2);
    compare_verify(&from_script, &phone_crt);
    let second = run_script(&script, &from_script, &["revoke", "device:phone"]);
    assert_ne!(second.0, 0, "{}", second.2);
    assert!(second.2.contains("rivet-ca: revoking "), "{}", second.2);
    assert!(second.2.contains("ERROR:Already revoked"), "{}", second.2);
}

fn run_script(script: &Path, paths: &CaPaths, args: &[&str]) -> (i32, String, String) {
    let output = Command::new("bash")
        .arg(script)
        .args(args)
        .env("RIVET_CA_ROOT_DIR", &paths.root_dir)
        .env("RIVET_CA_SHARED_DIR", &paths.shared_dir)
        .output()
        .expect("spawn rivet-ca.sh");
    (
        output.status.code().unwrap_or(1),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

fn assert_window(path: &Path, days: i64) {
    let text = openssl_stdout(&[
        "x509",
        "-in",
        &path.display().to_string(),
        "-noout",
        "-dates",
    ]);
    let mut before = None;
    let mut after = None;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("notBefore=") {
            before = Some(openssl_unix(rest));
        }
        if let Some(rest) = line.strip_prefix("notAfter=") {
            after = Some(openssl_unix(rest));
        }
    }
    let before = before.expect("notBefore");
    let after = after.expect("notAfter");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    assert!(
        (now - before).abs() < 180,
        "notBefore {before} now {now} for {}",
        path.display()
    );
    let span = after - before;
    assert!(
        (span - days * 86_400).abs() <= 2,
        "span {span} expected {} days for {}",
        days,
        path.display()
    );
}

fn openssl_unix(text: &str) -> i64 {
    let parts: Vec<&str> = text.split_whitespace().collect();
    let months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let month = months.iter().position(|name| *name == parts[0]).unwrap() + 1;
    let day: u32 = parts[1].parse().unwrap();
    let clock: Vec<u32> = parts[2]
        .split(':')
        .map(|piece| piece.parse().unwrap())
        .collect();
    let year: i32 = parts[3].parse().unwrap();
    let days = days_from_civil(year, month as u32, day);
    days * 86_400 + i64::from(clock[0]) * 3_600 + i64::from(clock[1]) * 60 + i64::from(clock[2])
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = (year - era * 400) as u32;
    let month_prime = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    i64::from(era) * 146_097 + i64::from(day_of_era) - 719_468
}

fn assert_lists_match(script: &Path, paths: &CaPaths) {
    let script_list = run_script(script, paths, &["list"]);
    let rust_list = run(paths, &["list"]);
    assert_eq!(script_list.0, 0, "{}", script_list.2);
    assert_eq!(rust_list.0, 0, "{}", rust_list.2);
    assert_eq!(
        rust_list.1, script_list.1,
        "rust stderr {}\nscript stderr {}",
        rust_list.2, script_list.2
    );
}

fn assert_leaf_aki_matches_issuer(leaf_text: &str, issuer_text: &str) {
    assert!(!aki_has_dirname(leaf_text), "{leaf_text}");
    assert_eq!(
        extension_hex(leaf_text, "Authority Key Identifier"),
        extension_hex(issuer_text, "Subject Key Identifier"),
        "{leaf_text}\n{issuer_text}"
    );
}

fn assert_critical_and_linked(text: &str, issuer_text: &str) {
    assert!(
        text.contains("X509v3 Basic Constraints: critical"),
        "{text}"
    );
    assert!(text.contains("X509v3 Key Usage: critical"), "{text}");
    assert_eq!(
        extension_hex(text, "Authority Key Identifier"),
        extension_hex(issuer_text, "Subject Key Identifier"),
        "{text}\n{issuer_text}"
    );
}

#[test]
fn verify_matches_openssl_on_critical_eku_constraints_and_path_length() {
    if !have_openssl() {
        return;
    }
    let paths = scratch("verify-edges");
    fs::create_dir_all(&paths.root_dir).unwrap();
    fs::create_dir_all(paths.int_dir()).unwrap();
    let work = paths.root_dir.clone();
    let key = |name: &str| {
        let path = work.join(name);
        openssl(&["genrsa", "-out", &path.display().to_string(), "2048"]);
        path
    };
    let root_key = key("root.key");
    let int_key = key("int.key");
    let sub_key = key("sub.key");
    let leaf_key = key("leaf.key");
    let root_cnf = work.join("root.cnf");
    fs::write(
        &root_cnf,
        "[ req ]\ndistinguished_name = req_dn\nprompt = no\nx509_extensions = v3\n[ req_dn ]\nO = Rivet Collective\nCN = Rivet Root CA\n[ v3 ]\nbasicConstraints = critical, CA:TRUE\nkeyUsage = critical, keyCertSign, cRLSign\nsubjectKeyIdentifier = hash\n",
    )
    .unwrap();
    let root_crt = work.join("root.crt");
    openssl(&[
        "req",
        "-new",
        "-x509",
        "-sha256",
        "-days",
        "3650",
        "-key",
        &root_key.display().to_string(),
        "-out",
        &root_crt.display().to_string(),
        "-config",
        &root_cnf.display().to_string(),
    ]);
    let root_srl = work.join("root.srl");
    let int_srl = work.join("int.srl");
    let sub_srl = work.join("sub.srl");
    fs::write(&root_srl, "1000\n").unwrap();
    fs::write(&int_srl, "1000\n").unwrap();
    fs::write(&sub_srl, "1000\n").unwrap();
    let sign =
        |key: &Path, name: &str, cn: &str, ext: &str, ca: &Path, cakey: &Path, srl: &Path| {
            let csr = work.join(format!("{name}.csr"));
            let crt = work.join(format!("{name}.crt"));
            let extfile = work.join(format!("{name}.ext"));
            openssl(&[
                "req",
                "-new",
                "-sha256",
                "-key",
                &key.display().to_string(),
                "-out",
                &csr.display().to_string(),
                "-subj",
                &format!("/O=Rivet Collective/CN={cn}"),
            ]);
            fs::write(&extfile, ext).unwrap();
            openssl(&[
                "x509",
                "-req",
                "-sha256",
                "-days",
                "365",
                "-in",
                &csr.display().to_string(),
                "-CA",
                &ca.display().to_string(),
                "-CAkey",
                &cakey.display().to_string(),
                "-CAserial",
                &srl.display().to_string(),
                "-out",
                &crt.display().to_string(),
                "-extfile",
                &extfile.display().to_string(),
            ]);
            crt
        };
    let crl_for = |crt: &Path, key: &Path, name: &str| {
        let index = work.join(format!("{name}-index.txt"));
        let number = work.join(format!("{name}-crlnumber"));
        let cnf = work.join(format!("{name}.cnf"));
        let out = work.join(format!("{name}.crl"));
        fs::write(&index, "").unwrap();
        fs::write(&number, "1000\n").unwrap();
        fs::write(
            &cnf,
            format!(
                "[ca]\ndefault_ca=CA_default\n[CA_default]\ncertificate={}\nprivate_key={}\ndatabase={}\ncrlnumber={}\ndefault_md=sha256\ndefault_crl_days=30\n",
                crt.display(),
                key.display(),
                index.display(),
                number.display(),
            ),
        )
        .unwrap();
        openssl(&[
            "ca",
            "-batch",
            "-gencrl",
            "-config",
            &cnf.display().to_string(),
            "-out",
            &out.display().to_string(),
        ]);
        out
    };
    let ca_ext = "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n";
    let leaf = |san: &str, eku: &str| {
        format!(
            "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage={eku}\nsubjectAltName={san}\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n"
        )
    };
    let int_plain = sign(
        &int_key,
        "int-plain",
        "Plain Intermediate",
        ca_ext,
        &root_crt,
        &root_key,
        &root_srl,
    );
    let int_nc = sign(
        &int_key,
        "int-nc",
        "Permit Intermediate",
        "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nnameConstraints=critical,permitted;DNS:.allowed.example\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n",
        &root_crt,
        &root_key,
        &root_srl,
    );
    let int_ex = sign(
        &int_key,
        "int-ex",
        "Exclude Intermediate",
        "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nnameConstraints=critical,excluded;DNS:.bad.example\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n",
        &root_crt,
        &root_key,
        &root_srl,
    );
    let int_path = sign(
        &int_key,
        "int-path",
        "Plain Intermediate",
        "basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n",
        &root_crt,
        &root_key,
        &root_srl,
    );
    let int_eku = sign(
        &int_key,
        "int-eku",
        "EKU Intermediate",
        "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nextendedKeyUsage=critical,codeSigning\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n",
        &root_crt,
        &root_key,
        &root_srl,
    );
    let sub = sign(
        &sub_key, "sub", "Sub CA", ca_ext, &int_path, &int_key, &int_srl,
    );
    let outside = sign(
        &leaf_key,
        "outside",
        "outside.example",
        &leaf("DNS:outside.example", "clientAuth"),
        &int_nc,
        &int_key,
        &int_srl,
    );
    let inside = sign(
        &leaf_key,
        "inside",
        "www.allowed.example",
        &leaf("DNS:www.allowed.example", "clientAuth"),
        &int_nc,
        &int_key,
        &int_srl,
    );
    let apex = sign(
        &leaf_key,
        "apex",
        "allowed.example",
        &leaf("DNS:allowed.example", "clientAuth"),
        &int_nc,
        &int_key,
        &int_srl,
    );
    let cn_only = sign(
        &leaf_key,
        "cn-only",
        "outside.example",
        "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n",
        &int_nc,
        &int_key,
        &int_srl,
    );
    let san_wins = sign(
        &leaf_key,
        "san-wins",
        "outside.example",
        &leaf("DNS:www.allowed.example", "clientAuth"),
        &int_nc,
        &int_key,
        &int_srl,
    );
    let excluded = sign(
        &leaf_key,
        "excluded",
        "ok.example",
        &leaf("DNS:x.bad.example", "clientAuth"),
        &int_ex,
        &int_key,
        &int_srl,
    );
    let excluded_ok = sign(
        &leaf_key,
        "excluded-ok",
        "ok.example",
        &leaf("DNS:ok.example", "clientAuth"),
        &int_ex,
        &int_key,
        &int_srl,
    );
    let unknown = sign(
        &leaf_key,
        "unknown",
        "unknown.example",
        &format!(
            "{}1.2.3.4.5=critical,ASN1:UTF8String:nope\n",
            leaf("DNS:unknown.example", "clientAuth")
        ),
        &int_plain,
        &int_key,
        &int_srl,
    );
    let unknown_nc = sign(
        &leaf_key,
        "unknown-nc",
        "unknown.example",
        &format!(
            "{}1.2.3.4.5=ASN1:UTF8String:nope\n",
            leaf("DNS:unknown.example", "clientAuth")
        ),
        &int_plain,
        &int_key,
        &int_srl,
    );
    let critical_ski = sign(
        &leaf_key,
        "critical-ski",
        "ski.example",
        "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\nsubjectAltName=DNS:ski.example\nsubjectKeyIdentifier=critical,hash\nauthorityKeyIdentifier=keyid\n",
        &int_plain,
        &int_key,
        &int_srl,
    );
    let critical_client = sign(
        &leaf_key,
        "critical-client",
        "client.example",
        &leaf("DNS:client.example", "critical,clientAuth"),
        &int_plain,
        &int_key,
        &int_srl,
    );
    let server_only = sign(
        &leaf_key,
        "server-only",
        "server.example",
        &leaf("DNS:server.example", "serverAuth"),
        &int_plain,
        &int_key,
        &int_srl,
    );
    let code_signing = sign(
        &leaf_key,
        "code-signing",
        "eku.example",
        &leaf("DNS:eku.example", "codeSigning"),
        &int_plain,
        &int_key,
        &int_srl,
    );
    let under_eku = sign(
        &leaf_key,
        "under-eku",
        "under.example",
        &leaf("DNS:under.example", "clientAuth"),
        &int_eku,
        &int_key,
        &int_srl,
    );
    let deep = sign(
        &leaf_key,
        "deep",
        "deep.example",
        &leaf("DNS:deep.example", "clientAuth"),
        &sub,
        &sub_key,
        &sub_srl,
    );
    let plain_crl = crl_for(&int_plain, &int_key, "plain");
    let nc_crl = crl_for(&int_nc, &int_key, "nc");
    let ex_crl = crl_for(&int_ex, &int_key, "ex");
    let eku_crl = crl_for(&int_eku, &int_key, "eku");
    let sub_crl = crl_for(&sub, &sub_key, "sub");
    let join = |parts: &[&Path]| {
        let mut bytes = Vec::new();
        for part in parts {
            bytes.extend(fs::read(part).unwrap());
        }
        bytes
    };
    let plain_chain = join(&[&int_plain, &root_crt]);
    let nc_chain = join(&[&int_nc, &root_crt]);
    let ex_chain = join(&[&int_ex, &root_crt]);
    let eku_chain = join(&[&int_eku, &root_crt]);
    let deep_chain = join(&[&sub, &int_path, &root_crt]);
    let check = |chain: &[u8], crl: &Path, cert: &Path| {
        fs::write(paths.chain_path(), chain).unwrap();
        fs::write(paths.crl_path(), fs::read(crl).unwrap()).unwrap();
        compare_verify(&paths, cert);
    };
    let check_client_purpose = |chain: &[u8], crl: &Path, cert: &Path| {
        fs::write(paths.chain_path(), chain).unwrap();
        fs::write(paths.crl_path(), fs::read(crl).unwrap()).unwrap();
        let ours = run(&paths, &["verify", &cert.display().to_string()]);
        let openssl = openssl_raw(&[
            "verify",
            "-purpose",
            "sslclient",
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
        assert!(
            ours.2.contains("error 26 at") && ours.2.contains("unsuitable certificate purpose"),
            "{}",
            ours.2
        );
    };
    check(&nc_chain, &nc_crl, &outside);
    check(&nc_chain, &nc_crl, &inside);
    check(&nc_chain, &nc_crl, &apex);
    check(&nc_chain, &nc_crl, &cn_only);
    check(&nc_chain, &nc_crl, &san_wins);
    check(&ex_chain, &ex_crl, &excluded);
    check(&ex_chain, &ex_crl, &excluded_ok);
    check(&plain_chain, &plain_crl, &unknown);
    check(&plain_chain, &plain_crl, &unknown_nc);
    check(&plain_chain, &plain_crl, &critical_ski);
    check(&plain_chain, &plain_crl, &critical_client);
    check(&plain_chain, &plain_crl, &server_only);
    check(&deep_chain, &sub_crl, &deep);
    check_client_purpose(&plain_chain, &plain_crl, &code_signing);
    check_client_purpose(&eku_chain, &eku_crl, &under_eku);
}

fn extension_hex(text: &str, header: &str) -> String {
    let mut grab = false;
    for line in text.lines() {
        if line.contains(header) {
            grab = true;
            continue;
        }
        if grab {
            let hex: String = line
                .trim()
                .trim_start_matches("keyid:")
                .chars()
                .filter(|ch| ch.is_ascii_hexdigit())
                .collect();
            if hex.len() >= 8 {
                return hex.to_ascii_uppercase();
            }
        }
    }
    panic!("missing {header}\n{text}");
}
