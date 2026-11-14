# RivetHub desktop end-to-end tests

These tests control the **real installed Electron app** on a remote desktop
through an SSH tunnel. Requests use the app's native mTLS bridge and its real
gateway. Nothing is mocked. Each run launches a separate temporary profile,
copies the existing desktop identity on the remote host, and removes that
profile on completion. The normal desktop profile is never used for test
mutations.

On 2026-09-11 the suite found three application defects: terminal image decoding
blocked by packaged CSP, Memory not discovering a working standalone local
backend, and malformed task IDs surfacing as raw store errors. Those are fixed
here: CSP allows `wasm-unsafe-eval` only, Memory probes the active gateway after
mesh discovery, and task IDs are validated before the store. Two live-provider
checks (assistant reply, task completion) still fail when the desktop agent is
not signed in; they remain ordinary failing tests, not skips.

## Run against a remote desktop

```bash
cd apps/rivethub-electron/e2e
npm ci
E2E_SSH=user@host E2E_EXPECT_SHA=<web-commit> E2E_EXPECT_VERSION=0.5.22 npm run test:remote
```

`E2E_SSH` is required (`user@host` or an SSH config alias). There is no default
host. Set `E2E_EXPECT_SHA` to the commit actually built into the installed UI.
The launcher checks the UI build stamp before running any tests; a stale
installed build fails the run. It **does not update the app or gateway**.
Building/installing them is a separate operation.

Prerequisites: Node 22+, SSH key access, Python 3 on the remote machine, a working
desktop display, installed RivetHub, a running gateway, and an enrolled device
identity. Playwright does not need to download Chromium: it drives Electron's
existing Chromium. Xvfb is needed for the separate `npm run check:sni` tray test,
not for this suite on the existing desktop display.

| Environment variable | Default / purpose                                             |
| -------------------- | ------------------------------------------------------------- |
| `E2E_SSH`            | **Required.** SSH target (`user@host`); no default            |
| `E2E_BINARY`         | Remote RivetHub binary (optional; user-local install default) |
| `E2E_IDENTITY`       | Remote mTLS identity dir (optional; user config default)      |
| `E2E_GATEWAY`        | `https://localhost:5174`, as reached **from the remote host** |
| `E2E_MEMORY_GATEWAY` | Same as gateway; explicit-memory tests only                   |
| `E2E_DISPLAY`        | `:0`                                                          |
| `E2E_EXPECT_SHA`     | Required; web build commit                                    |
| `E2E_EXPECT_VERSION` | Optional desktop version assertion                            |

Run a subset by passing normal Playwright arguments:

```bash
E2E_SSH=user@host E2E_EXPECT_SHA=<web-commit> npm run test:remote -- --grep 'files:'
E2E_SSH=user@host E2E_EXPECT_SHA=<web-commit> npm run test:remote -- specs/memory.spec.mjs
npm run test:list
npm run report
```

For an already-managed isolated instance, set `E2E_CDP` and use `npm test`.
Its native settings file must contain `"rivethub.e2eProfile": true`; the fixture
refuses an unmarked profile. Do not add that marker to a personal profile.

## Run against a Windows desktop

`run-remote-win.mjs` is the same flow for a Windows 11 machine reached over
OpenSSH whose default remote shell is **PowerShell** (Windows PowerShell 5.1 is
what the runner invokes; `pwsh` is not required). Each remote step is one
PowerShell script sent as `powershell -NoProfile -NonInteractive -EncodedCommand`
(base64 of UTF-16LE), so no user-controlled value is ever spliced into a shell
command line; paths and URLs are allow-list validated locally and land inside
single-quoted PowerShell literals.

```bash
cd apps/rivethub-electron/e2e
npm ci
E2E_SSH=win-laptop E2E_GATEWAY=https://10.4.20.116:5174 E2E_EXPECT_SHA=<web-commit> E2E_EXPECT_VERSION=0.6.0 npm run test:remote:win
```

| Environment variable | Default / purpose                                                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `E2E_SSH`            | **Required.** SSH target (`user@host` or config alias); no default                                                                                                                                                                                           |
| `E2E_GATEWAY`        | **Required**, as reached **from the laptop**. No default on purpose: a Windows desktop is usually someone's personal machine and a silent default would point the test profile at their production node                                                      |
| `E2E_BINARY`         | Absolute path to `RivetHub.exe`. Default: derived on the laptop from the per-user Uninstall registry entry (`InstallLocation`, else `DisplayIcon`), then a running `RivetHub` process, then `%LOCALAPPDATA%\Programs\@rivetosrivethub-electron\RivetHub.exe` |
| `E2E_IDENTITY`       | mTLS identity dir. Default `%APPDATA%\RivetHub\mtls` (`ca.pem`, `device.crt`, `device.key`)                                                                                                                                                                  |
| `E2E_MEMORY_GATEWAY` | Same as gateway; explicit-memory tests only                                                                                                                                                                                                                  |
| `E2E_EXPECT_SHA`     | Required; web build commit                                                                                                                                                                                                                                   |
| `E2E_EXPECT_VERSION` | Optional desktop version assertion                                                                                                                                                                                                                           |

`E2E_DISPLAY` does not apply. Playwright arguments pass through exactly as for
the Linux runner (`-- --grep 'files:'`, `-- specs/memory.spec.mjs`).

What the runner does on the laptop: creates `%TEMP%\rivethub-e2e-<uuid>`, copies
the three identity files into `<profile>\mtls`, writes a `settings.json` carrying
`"rivethub.e2eProfile": true` and the gateway as `baseUrl`/`remoteUi`/roster,
then launches `RivetHub.exe` through WMI (`Win32_Process.Create`) with
`--user-data-dir=<profile> --remote-debugging-address=127.0.0.1 --remote-debugging-port=0 --disable-gpu`
and polls `<profile>\DevToolsActivePort` for up to 60 s. WMI rather than
`Start-Process`: a child of the ssh session's shell sits in that session's job
object and is killed the moment the launch command returns. The DevTools port
is tunnelled with `ssh -L` kept alive by a remote `Start-Sleep` (not `-N`:
Windows OpenSSH spawns the default shell for a `-N` session regardless, the
shell exits with no stdin, and the tunnel dies with it), the build stamp is
checked against `E2E_EXPECT_SHA`/`E2E_EXPECT_VERSION` on Settings → Advanced,
and `playwright test` runs with `E2E_CDP` set. Artifacts are the same files as
the Linux runner; `artifacts/desktop.log` carries the profile's `logs\main.log`
(a WMI-launched process has no captured stdio), and
`artifacts/build.json` additionally records `platform` and the launched `pid`.

Cleanup (also on `SIGINT`/`SIGTERM`): the app is asked to quit through its own
IPC first; then every process whose command line contains this run's exact
`--user-data-dir="<profile>"` gets `CloseMainWindow()`, up to 5 s to exit, and
only then `Stop-Process -Force`; finally `Remove-Item -Recurse -Force` on the
profile (retried while Windows releases file locks), guarded to paths under
`%TEMP%\rivethub-e2e-*`. The user's own RivetHub is never matched: Electron's
single-instance lock (`app.requestSingleInstanceLock()` in `src/main/index.ts`)
is scoped to the userData directory, so the test profile starts a fully separate
instance instead of being handed off to the running one, and the cleanup filter
is the unique profile path, not the executable name.

Caveats:

- **Install folder.** electron-builder's per-user NSIS target installs under
  `%LOCALAPPDATA%\Programs\@rivetosrivethub-electron\` — the folder is derived
  from the npm package name `@rivetos/rivethub-electron` with the slash dropped,
  not from `productName`. The Uninstall registry entry for it leaves
  `InstallLocation` empty and only `DisplayIcon` (`<exe>,0`) carries the path,
  which is why the runner parses that field.
- **Session 0, not the user's desktop.** Windows OpenSSH runs the remote shell in
  session 0 (the services session), while an app the user launched lives in the
  console session. The test instance therefore starts in session 0: no window
  appears on the user's screen, and whether the screen is locked or the user is
  logged in at the console does not affect the launch. Electron runs there with
  software rendering (hence `--disable-gpu`; without it the GPU process crashes
  with exit code 34 and Chromium falls back anyway). First run on 2026-10-25
  against an unpacked 0.6.1 build on a Windows 11 laptop: the desktop specs pass
  this way, CDP screenshots come from the compositor and need no visible
  desktop. A visible-desktop launch (scheduled task in the console session) is
  not implemented.
- **Console code page.** The laptop's console encoding is IBM437, so the runner
  keeps remote stdout ASCII-only (PID, port, base64 blobs) and decodes logs
  locally. Nested `powershell` invocations may emit CLIXML progress noise on
  stderr; the runner only parses stdout.
- The identity files are copied, not moved; the user's `%APPDATA%\RivetHub` is
  otherwise never read or written. Tests still create real tasks/chats on the
  configured gateway exactly as described under "Effects and cleanup".

## Evidence and failure semantics

- `artifacts/build.json`: host, binary, shell version, web build stamp and time.
- `artifacts/results.json`: structured Playwright results.
- `playwright-report/index.html`: browsable report with screenshots and requests.
- `test-results/*/trace.zip`: actions, DOM snapshots and network evidence.
- `artifacts/desktop.log`: Electron output from this run.

Exit code is nonzero on assertion or setup failure. Known application bugs stay
as ordinary **failing tests**, not skipped tests or expected failures. A green
unit suite is not substituted for an end-to-end result. These artifacts may
include private conversation text; keep them local unless reviewed for sharing.

## Effects and cleanup

The suite changes only its temporary UI settings. It creates a uniquely named
directory under the node's files root and deletes it; restores the clipboard;
and closes PTYs created by its own test requests. It creates, edits, then deletes
one uniquely named agent preset and a temporary workflow definition under the
standard `workflows/defs` directory. It sends one short, response-only
chat prompt and creates a task and an example workflow run. These use the node's
configured provider and can incur a small model charge. Test task/chat/workflow
history is retained by the application's normal audit/capture system and is
identified by `RivetHub E2E` / `RIVETHUB_E2E`. Unfinished test tasks and workflow
runs are killed by their exact returned IDs. No existing task, workflow, session,
agent preset, or file is deleted.

Do not run the suite concurrently against the same CDP instance. The default
runner creates a distinct profile and debugging port for each run, but report
files in this directory are overwritten, so run one invocation at a time here.

## Coverage and limits

| Area                | Automated coverage                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Build/boot          | Exact web commit and shell version, real Electron bridge                                                            |
| Desktop             | Renderer isolation, clipboard Unicode, new window, zoom, sidebar and narrow navigation                              |
| Connection/settings | Live mTLS probe, URL rejection, saved-node rename, four themes, persistence, experimental toggles                   |
| Terminal settings   | Size clamping/reset, named palette, native Omarchy import and persistence                                           |
| Conversations       | Draft create/rename/filter/discard, newline/send validation, auto-speak toggle, live reply and reload               |
| Agents/harnesses    | Preset create/edit/reload/delete, new-agent dialog, each advertised session-list endpoint                           |
| Terminal            | Real PTY spawn, xterm keyboard input, Chat/Terminal switch, uncaught addon errors                                   |
| Files               | Listing/filter/sort, keyboard cancellation, folder/upload/preview/edit/save/rename/copy/delete/reload and cleanup   |
| Memory              | Default local discovery, explicit local search, browse/filter/refresh, stats/health, wiki search                    |
| Tasks               | Empty-goal validation, malformed-link handling, create/detail/completion                                            |
| Workflows           | Definition graph/input form, source edit/save, run/journal, human gate/resume/completion, persistence, cancellation |
| Updates             | Native feed check and visible result/error                                                                          |

Still requires targeted fixtures or manual verification: every provider's live
streaming and approval variants, multi-node failover, microphone/ASR and actual
speaker output, OS notification click-through, enrollment/revocation on an
enrollment-enabled node, full self-update installation/rollback, drag/drop/move and every
file-preview format, OS tray click/global shortcut behavior, and crash recovery.
The separate native tray registration test is `npm run check:sni` in the parent
desktop package. Passing this suite is not a claim that every possible bug is
absent; failures and these coverage gaps must remain visible.
