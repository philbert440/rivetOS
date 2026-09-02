# RivetHub setup guide

> Point Hub web (and desktop) at a RivetOS node gateway. Hub is the node's face,
> not a separate agent runtime.
>
> Architecture frame: [ARCHITECTURE.md](ARCHITECTURE.md).

---

## What RivetHub is

| Piece                     | Role                                                                              |
| ------------------------- | --------------------------------------------------------------------------------- |
| `apps/rivethub-web`       | React (Vite) UI — chat, terminal, memory wiki, files, tasks, workflows, settings  |
| `apps/rivethub-electron`  | Electron shell over the same web dist (tray, shortcuts, notifications, mTLS pipe) |
| den-server                | Serves hub dist as static root when configured; hosts gateway + harness APIs      |
| `@rivetos/gateway-client` | Typed HTTP+WS client for harness control plane and gateway surfaces               |

**Primary interactive path:** harness sessions on the node
(`claude-code`, `grok-build`, `kimi-code`, `hermes`) via the gateway contract.

**Removed (Phase 5):** Telegram / Discord / voice-discord channel plugins are gone. Hub is the product path. Leftover `channels.telegram:` in config is a validation warning only (no crash-loop).

---

## Prerequisites

| Requirement               | Notes                                                         |
| ------------------------- | ------------------------------------------------------------- |
| Node.js ≥ 22              | 24 used in CI/containers                                      |
| Built monorepo            | `npm install` at repo root builds packages via postinstall    |
| Running node              | `rivetos` agent (or den-server) with den/gateway up           |
| At least one host harness | Optional for empty drawer; needed to chat with a coding agent |
| PostgreSQL                | Memory / wiki / tasks (via datahub or external)               |

---

## Build Hub

From the repo root:

```bash
npm install

# Production dist
npx nx build @rivetos/rivethub-web
```

Output: `apps/rivethub-web/dist/`.

### Desktop (optional)

```bash
npx nx build @rivetos/rivethub-web
cd apps/rivethub-electron && npm install && npm run dist   # or: npm run dev
```

Desktop starts unconfigured until a node gateway URL is set (the bundled app:// origin is not http(s)).

---

## Serve Hub from the node (recommended)

den-server should serve hub as the static root so `/` is Hub.

Boot defaults are **hub-first**: `static_dir` is RivetHub web dist.

Environment (or den config equivalents):

```bash
# Static UI root — hub dist
export RIVETOS_DEN_STATIC_DIR=apps/rivethub-web/dist

# Bind (loopback by default; off-loopback requires TLS + device client cert)
export RIVETOS_DEN_HOST=0.0.0.0
export RIVETOS_DEN_TLS_CERT=/rivet-shared/rivet-ca/issued/<node>.crt
export RIVETOS_DEN_TLS_KEY=/rivet-shared/rivet-ca/issued/<node>.key
# RIVETOS_DEN_TLS_CA is the CA-chain path (default: Rivet intermediate chain).
# Client certs required off-loopback; set RIVETOS_DEN_TLS_REQUIRE_CLIENT=0 to allow encrypt-only (no device cert).

# Then start via normal agent boot (embedded den) or:
node services/den-server/dist/index.js
```

Open the node URL in a browser (default den port is commonly `5174` when run
standalone; use whatever your config/`den.port` advertises).

Authenticate with an enrolled **device client certificate** (`rivet-ca.sh
issue-client`). Bearer tokens (`den.token`, `RIVETOS_DEN_TOKEN`, `?token=`,
`Authorization: Bearer`) are not accepted. See [GATEWAY-MTLS.md](GATEWAY-MTLS.md).

### Dev mode (Vite)

```bash
# Terminal A: node / den-server (loopback HTTP, or TLS + device cert off-loopback)
# Terminal B:
npx nx dev @rivetos/rivethub-web
```

Point the Hub connection/settings at your gateway origin (scheme + host + port
only, no path/userinfo). `isValidGatewayUrl` rejects poisoned roster URLs.

---

## Point Hub at a mesh peer

Hub supports seamless node switch: repoint the gateway client at another node's
origin; local dist stays put (never navigate to a peer's served UI for code).

- Sidebar **Node** switcher / composer node picker
- Android deep-link pattern: `http://127.0.0.1:5174/?node=<denUrl>` (loopback
  may skip client certs; `?token=` is not application auth)
- Mesh dens: roster entries with `capabilities: ["den"]` and `metadata.denPort`
  or `metadata.denUrl` appear via `GET /mesh.json`

Use hostnames or documentation addresses in examples; do not commit lab private IPs.

---

## Harness chat (product path)

Chat binds **per session**, not per app:

| Concern | Control plane (driver-owned)                | Legacy (unclaimed)             |
| ------- | ------------------------------------------- | ------------------------------ |
| List    | `GET /api/harnesses/:id/sessions`           | terminal harness-sessions scan |
| Stream  | `WS /api/harness-sessions/ws?session=<enc>` | all-sessions WS bridge         |
| History | transcript hard-resync on every open        | server-pushed deltas           |
| Send    | `POST …/turns`                              | `/term/inject` into PTY        |

On a full four-driver node every harness row is claimed; fallback remains for
drivers disabled or older nodes.

### Operator expectations

1. **Hard resync is mandatory.** The live tail is at-most-once from attach time.
   Opening a conversation (or reconnect) replaces transcript from the store.
2. **Stop button** only when the driver's `interrupt` flag is true (den terminals enabled).
3. **No approval cards** for current PTY drivers (`approvals: false`). Approvals live in the TUI.
4. **"+ new"** stays a local draft; first turn pins id through the term/roster path;
   control plane **adopts** the session. Hub does not call `startSession` for all harnesses
   (hermes/kimi refuse start).
5. **Attachments**: staging exists (`POST /api/uploads`) but PTY drivers reject
   attachment turns; picker still uses legacy path where applicable.
6. **Thinking**: `reasoning-delta` folds into the live turn (capped in the hub store).
   kimi has no live thinking/assistant deltas; resync transcript for text.
7. **Canonical SessionId** rides on control-plane calls; drawer row keys may still be bare native id (den join key).

---

## Sidebar map

| Route             | Purpose                                                             |
| ----------------- | ------------------------------------------------------------------- |
| `/` Conversations | Chat \| Terminal per conversation                                   |
| `/terminal`       | Open PTY list; attach                                               |
| `/memory`         | Wikipedia-style wiki over datahub `GET /api/wiki`                   |
| `/files`          | Browse node files root (`den.files_root` / `/rivet-shared` default) |
| `/tasks`          | List / create / steer / kill tasks                                  |
| `/workflows`      | Local workflow IR editor (no runner yet)                            |
| Settings          | Gateway URL, wiki/datahub origin (auth is a device client cert)     |

---

## Tasks from Hub

Create tasks in-UI (goal + agent/harness from catalog + optional criteria).
Catalog entries for `harness-session` include `harnessId` and `implemented`;
grey options that are honest rejections (e.g. grok-build / hermes executors).

Implemented headless executors today: `claude-code`, `kimi-code`. Prefer those
for automated task runs. Interactive coding remains the harness TUI + Hub chat.

---

## Memory wiki

- Native Hub UI (no iframe) over datahub wiki API.
- Set datahub origin in Settings (`rivethub.wikiUrl`); blank → mesh-discover datahub.
- Requires postgres memory stack healthy (`rivetos doctor`, migrate role applied).

---

## Files browser

Server: den-server files routes (`list|download|upload|mkdir|rename|delete`).
Config: `den.files_root` / `RIVETOS_DEN_FILES_ROOT` (empty string disables).
Path + symlink fenced; large upload cap; recursive delete opt-in.

---

## MicBridge (optional)

Host microphone as node input for voice harnesses. Design: [MICBRIDGE.md](MICBRIDGE.md).
den-server opt-in `RIVETOS_DEN_AUDIO=1`. Hub capture client is a later phase.

---

## Verify checklist

```bash
# 1. Packages build
npx nx build @rivetos/rivethub-web

# 2. Node healthy
npx rivetos doctor
npx rivetos status

# 3. Harnesses visible on the node
curl -sS --cert /path/to/device.crt --key /path/to/device.key \
  --cacert /rivet-shared/rivet-ca/intermediate/chain.pem \
  "$GATEWAY/api/harnesses" | jq .

# Expect four ids when all drivers registered:
# claude-code, grok-build, hermes, kimi-code

# 4. Open Hub, set gateway origin, present a device client cert, confirm drawer lists sessions
# 5. Open a claude-code or grok-build session — Stop visible if terminals on
# 6. Send a turn; live tool/thinking frames; hard-resync after refresh
# 7. Dens page shows a live room when hooks fire
```

Unit tests (web):

```bash
npx nx test @rivetos/rivethub-web
```

---

## Gotchas

- **Device-cert-gated nodes:** without an enrolled device client cert, harness and most APIs 401. Loopback HTTP is allowed for local node processes. `/healthz` is always open.
- **Double-fold:** bound sessions must not also fold the all-sessions socket (Hub mutex on `harnessBound`).
- **turn_in_flight:** server rejects overlapping turns; Hub client-queues with bounded backoff.
- **Secrets in tool args:** bridge summarizers redact patterns; do not log raw tool input in issues.
- **CI secrets scan** blocks real lab `10.x` addresses in committed tests; use documentation ranges or hostnames.
- **Android** uses the same gateway contract in Kotlin; uploads UI and registry-stream drawer merge still deferred there.

---

## Related

- [ARCHITECTURE.md](ARCHITECTURE.md): harness-first node OS
- [GATEWAY-MTLS.md](GATEWAY-MTLS.md): device client certificates (bearer tokens removed)
- [DEN.md](DEN.md): den viewer and protocol
- [GETTING-STARTED.md](GETTING-STARTED.md): install RivetOS
- [DEPLOYMENT.md](DEPLOYMENT.md): Docker / Proxmox / mesh
