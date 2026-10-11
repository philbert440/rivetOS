fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let paths = ca::CaPaths::from_env(&protocol::host::ProcessEnv);
    let code = ca::run(
        &args,
        &paths,
        &mut std::io::stdout(),
        &mut std::io::stderr(),
    );
    if code != 0 {
        std::process::exit(code);
    }
}
