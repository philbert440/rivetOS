# Codex app-server integration

RivetHub can use Codex's documented app-server protocol for new sessions.
The standalone terminal driver remains available for existing sessions and
nodes without the opt-in configuration. Tested against Codex CLI 0.153.4;
app-server and its experimental API may change between Codex releases.

## Enable on a single-owner node

Install and authenticate Codex as the same OS user running den. Copy
`integrations/codex/systemd/rivet-codex-app-server.service` into
`~/.config/systemd/user/`, adjust `ExecStart` if Codex is installed elsewhere,
and start it (enable lingering with `loginctl enable-linger "$USER"` if it must
survive logout):

```sh
systemctl --user daemon-reload
systemctl --user enable --now rivet-codex-app-server.service
```

Set `RIVETOS_CODEX_APP_SERVER_URL=ws://127.0.0.1:5175` in den's environment,
then rebuild and restart den. This endpoint must stay on loopback: app-server
can execute tools with the node owner's permissions. Den's existing gateway
authentication protects remote access; clients must never connect directly
to this port. Enabling this on a node with a users registry fails closed.
Per-user app-server processes and credentials are needed before multi-user
support can be enabled.

The dedicated process lives independently of den and attached terminals.
Closing a terminal detaches the TUI; interrupting through Chat targets the
active turn. A den restart reconnects without resending an ambiguous turn.
Keep the app-server service running while turns are active.

Rivet session IDs remain stable. The private
`<den stateDir>/codex-threads.json` maps them to native Codex thread IDs.
Back up this file alongside Codex history. Do not delete it to troubleshoot
an active session. Existing standalone sessions continue through their
original PTY path. Malformed bindings fail den startup closed; repair from a
backup rather than deleting identity mappings. Capture reads the same file; set
`RIVETOS_DEN_STATE_DIR` in both services when using a custom state directory.

## Operator configuration

The adapter translates the roster's `--ask-for-approval`, `--sandbox`,
`--full-auto`, `--dangerously-bypass-approvals-and-sandbox` and `--model`
flags, including their documented short aliases. Unsupported roster flags
fail explicitly. Configure other Codex settings in the dedicated server's
Codex configuration; den never silently drops unrecognized CLI settings.
No bypass policy is introduced by enabling this transport. Resume requests repeat
the operator defaults; policy preservation across a live server restart still
needs rollout validation. Chat context is included in the first turn input,
matching PTY delivery, because loaded threads may ignore resume instruction
overrides. Model reasoning effort is forwarded on thread creation.

Chat approvals use native command/file approval requests and preserve the
request ID. Only Allow and Deny are exposed: Rivet's tool-wide session grant
has different semantics from Codex's command-scoped grant. A terminal may
also answer the request; the server resolution clears the Chat card. After a
disconnect, old request IDs are invalidated. A recovered active turn with no
restored approval is shown as blocked with a hint to attach a terminal or
interrupt. This also covers den restarts; automatic approval replay is not assumed.
Reconnect attempts back off from 1 second to a 30 second cap, with one
unavailable notification per session per outage.

Terminal creation errors now reach Chat directly for every harness; only a 404
without an explicit harness selection falls back to the default spawn.

## Validation

Unit tests cover stable IDs after driver restart, concurrent sends,
interrupt targeting, uncertain-send recovery, developer instructions,
approval ownership and stale answers. WebSocket tests cover initialization,
server request IDs, disconnects without replay, and endpoint restrictions.
A live smoke test should additionally create a fresh Chat session, send its
first turn, attach a terminal, detach/reconnect, interrupt a running turn,
and answer one approval. Keep existing standalone sessions available when
rolling out this opt-in transport.

Protocol reference: [Codex app-server](https://learn.chatgpt.com/docs/app-server).
Regenerate local reference types with `codex app-server generate-ts --out
/tmp/codex-protocol --experimental` when upgrading the CLI.

## Chat controls

Protocol-owned sessions advertise their transport on the session summary.
The same driver may serve older PTY sessions; those retain their existing
controls. Model choices and each model's effort levels come from `model/list`,
with a one-minute cache. Web and Android send selections through `turn/start`;
changing these controls does not restart the terminal.

Web queues retain structured attachments. PNG, JPEG, WebP and GIF images
staged by `/api/uploads` become native `localImage` inputs, after checking the
selected model's image modality and the staging directory. Arbitrary paths,
symlinks, remote URLs and expired uploads are rejected. Other web files retain
the existing text path references. Android stages local images on the bound
session's node before enqueueing; other Android attachment types remain
unsupported and report an error.

`item/tool/requestUserInput` questions use the existing prompt event and
answer endpoint. Answers map positional UI questions back to native IDs;
duplicate indexes, invalid choices and stale answers are rejected. Reconnects
and external resolutions clear stale cards, and new subscribers receive
pending questions and approvals. Secret-input questions are not supported.

Native approval acceptance was exercised against a live server using a
read-only sandbox and an untrusted approval policy: one approval was received
and accepted, and the expected temporary-file marker was verified with no
stream errors. This is a programmatic adapter acceptance test; actual browser
and Android button acceptance still needs a device run. Android compilation
could not run on the development node because Java and the Android SDK were
not installed.

A separate live image-input check read seven catalog models, submitted a staged
image with an advertised model/effort pair, and received the expected reply and
image-bearing transcript without stream errors.
