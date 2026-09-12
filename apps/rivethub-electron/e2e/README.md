# RivetHub desktop end-to-end tests

Initial ct111 audit: [findings and build details](FINDINGS.md).
Subsequent fixes: [candidate build and verification](FIXES.md).

These tests control the **real installed Electron app** on ct111 through an SSH
tunnel. Requests use the app's native mTLS bridge and its real gateway. Nothing
is mocked. Each run launches a separate temporary profile, copies the existing
desktop identity on the remote host, and removes that profile on completion.
The normal desktop profile is never used for test mutations.

## Run against ct111

```bash
cd apps/rivethub-electron/e2e
npm ci
E2E_EXPECT_SHA=ccebc1c0 E2E_EXPECT_VERSION=0.5.22 npm run test:remote
```

Set `E2E_EXPECT_SHA` to the commit actually built from main. The launcher checks
the UI build stamp before running any tests; a stale installed build fails the
run. It **does not update the app or gateway**. Building/installing them is a
separate operation. Both were updated to `abd8572f` for the initial audit.

Prerequisites: Node 22+, SSH key access, Python 3 on the remote machine, a working
desktop display, installed RivetHub, a running gateway, and an enrolled device
identity. Playwright does not need to download Chromium: it drives Electron's
existing Chromium. Xvfb is needed for the separate `npm run check:sni` tray test,
not for this suite on the existing desktop display.

| Environment variable | Default / purpose                                    |
| -------------------- | ---------------------------------------------------- |
| `E2E_SSH`            | `rivet@ct111` (SSH alias; override for another host) |
| `E2E_BINARY`         | `/home/rivet/.local/bin/RivetHub`                    |
| `E2E_IDENTITY`       | `/home/rivet/.config/RivetHub/mtls`                  |
| `E2E_GATEWAY`        | `https://localhost:5174`, as reached **from ct111**  |
| `E2E_MEMORY_GATEWAY` | Same as gateway; explicit-memory tests only          |
| `E2E_DISPLAY`        | `:0`                                                 |
| `E2E_EXPECT_SHA`     | Required; web build commit                           |
| `E2E_EXPECT_VERSION` | Optional desktop version assertion                   |

Run a subset by passing normal Playwright arguments:

```bash
E2E_EXPECT_SHA=ccebc1c0 npm run test:remote -- --grep 'files:'
E2E_EXPECT_SHA=ccebc1c0 npm run test:remote -- specs/memory.spec.mjs
npm run test:list
npm run report
```

For an already-managed isolated instance, set `E2E_CDP` and use `npm test`.
Its native settings file must contain `"rivethub.e2eProfile": true`; the fixture
refuses an unmarked profile. Do not add that marker to a personal profile.

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
