# Desktop defect fixes — 2026-09-11

Fix commit: `ccebc1c0`, based on main `abd8572f`. This is a local candidate build,
not a published release or a merge to main. Both the desktop and gateway on ct111
were rebuilt from this commit. The desktop still reports package version 0.5.22;
the exact identifying web stamp is `dist ccebc1c0`.

Installed AppImage SHA-256:
`4e69003bfd025d32649124323c4e45855dee2108147995a333a32a530afdfbb5`.

## Changes

- **RH-E2E-001:** The packaged desktop CSP permits WebAssembly compilation for
  the terminal image decoder using `wasm-unsafe-eval`. JavaScript `eval` and
  `Function` remain blocked. A real Electron regression checks both behaviors.
- **RH-E2E-002:** Memory probes the active gateway's memory API after mesh
  discovery when no designated datahub exists. A successful probe enables local
  Memory. Explicit settings and discovered datahub choices retain precedence;
  failed probes do not select a nonexistent local memory service.
- **RH-E2E-003:** All task-ID routes validate UUID syntax before accessing the
  store. Malformed IDs return a controlled HTTP 400; missing UUIDs return 404.
  The task detail UI renders a friendly not-found message and stops retries and
  periodic polling for 400/404 responses.

## Validation

**Installed desktop result: 46 passed, 2 failed, 0 skipped** (48 tests, 5.0 minutes,
no retries). All three defect regressions pass. The remaining failures are the
live assistant reply and task completion checks described below. The original
baseline was 41 passed / 5 failed; two additional security/task-error regressions
were added for this build.

- Full monorepo builds passed locally and on ct111 (48 projects).
- Web typecheck and all 813 web unit tests passed.
- Task API regressions passed: 18 tests, including malformed IDs for read, wait,
  steer and kill, with assertions that the store is never accessed.
- Desktop protocol tests passed: 17 tests.
- Native StatusNotifierItem registration/property test passed on ct111 against
  the exact new desktop bundle and Electron 43.4.0.
- The expanded installed-desktop E2E results are in `artifacts/results.json`
  and `playwright-report/index.html`, with screenshots and traces.

## Remaining provider setup

Claude's native `auth status` command on ct111 reports `loggedIn: false` and
`authMethod: none`. The gateway process also has no Anthropic API-key, auth-token,
or Claude OAuth-token environment variable. The live chat terminal displays
Claude's first-run setup. No credentials were added or provider onboarding
accepted by the tests.

To complete sign-in interactively as the desktop user:

```bash
ssh -t rivet@ct111 /home/rivet/.local/share/mise/installs/claude/latest/claude auth login
```

The live chat and task completion checks remain enabled and must pass after
Claude authentication is completed. Missing authentication is a confirmed
environment blocker; it does not prove there are no further provider execution
defects. The task timeout's complete causal chain has not been established.

For the original failures and the remaining manual coverage limits, see
[FINDINGS.md](FINDINGS.md) and [README.md](README.md).
