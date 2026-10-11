use std::io;

use futures_util::sink::unfold;
use futures_util::stream::unfold as stream_unfold;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};

use agent_client_protocol::Lines;

pub fn child_lines(
    stdin: ChildStdin,
    stdout: ChildStdout,
) -> Lines<
    impl futures_util::Sink<String, Error = io::Error> + Send + 'static,
    impl futures_util::Stream<Item = io::Result<String>> + Send + 'static,
> {
    let outgoing = unfold(stdin, |mut stdin, line: String| async move {
        stdin.write_all(line.as_bytes()).await?;
        if !line.ends_with('\n') {
            stdin.write_all(b"\n").await?;
        }
        stdin.flush().await?;
        Ok::<_, io::Error>(stdin)
    });
    let incoming = stream_unfold(BufReader::new(stdout), |mut reader| async move {
        let mut line = String::new();
        match reader.read_line(&mut line).await {
            Ok(0) => None,
            Ok(_) => {
                if line.ends_with('\n') {
                    line.pop();
                }
                if line.ends_with('\r') {
                    line.pop();
                }
                Some((Ok(line), reader))
            }
            Err(error) => Some((Err(error), reader)),
        }
    });
    Lines::new(outgoing, incoming)
}
