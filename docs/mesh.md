# Mesh Networking

RivetOS supports a multi-node mesh that lets agents delegate tasks to each other
across instances. One node can ask another node's agent to handle a task — even
if that agent runs on different hardware or uses a different LLM provider.

---

## How It Works

Every mesh-enabled node runs an **agent channel** — an HTTPS server that
receives delegated tasks and routes them to the local `DelegationEngine`. When
one node needs an agent it doesn't host locally, it looks up the target node in
the shared `mesh.json` registry and sends the task over mTLS.

```
┌─────────────────────────────────┐     HTTPS/mTLS      ┌─────────────────────────────────┐
│  ct110 — opus                   │  ──────────────────▶ │  ct111 — grok                   │
│                                 │  POST /api/message   │                                 │
│  MeshDelegationEngine           │                      │  AgentChannelServer (port 3000) │
│  mesh.json (NFS r/w)            │◀──────────────────── │  mesh.json (NFS r/w)            │
└─────────────────────────────────┘    delegation result └─────────────────────────────────┘
```

### Shared registry

All nodes read and write a single `mesh.json` file at `/rivet-shared/mesh.json`
(NFS-mounted from the datahub CT). This is the source of truth — no extra
coordination service needed.

### Discovery modes

| Mode | How it works |
|------|-------------|
| `static` | Peer list hard-coded in config. Good for stable infra. |
| `seed` | New node contacts a seed's `/api/mesh` endpoint to bootstrap its view. |
| `mdns` | mDNS discovery (local network). |

---

## mTLS Authentication — Phase 0.5

Starting from Phase 0.5, **all mesh agent-channel traffic is mutual TLS**.
There is no plaintext fallback and no bearer-token authentication on the
agent channel. CA-signed certificate = trusted. Everything else = rejected
at the TLS handshake level.

### How it works

1. Each node has a certificate issued by the mesh CA (`/rivet-shared/rivet-ca/`).
2. The agent channel server requires a client cert and verifies it against the CA chain.
3. The delegation client builds an mTLS connection using the same cert pair.
4. Connections to remote nodes use `<nodeName>.mesh` DNS names so the cert SANs match.

### Certificate layout

```
/rivet-shared/rivet-ca/
  intermediate/
    ca-chain.pem          ← CA chain (validates all node certs)
  issued/
    ct110.crt             ← ct110 node cert (CN=ct110, SAN=ct110.mesh + mesh IP)
    ct110.key             ← ct110 node private key
    ct111.crt / .key      ← same for ct111…ct114
    <agent>@<node>.crt    ← agent certs (reserved, unused on the wire in Phase 0.5)
```

Permissions: `rivet:rivet`, NFS-visible on all nodes.

---

## Configuration

### Minimal mesh config (tls: true → default paths)

```yaml
mesh:
  enabled: true
  node_name: ct110          # must match the cert CN
  tls: true                 # use /rivet-shared/rivet-ca/issued/<node_name>.{crt,key}
  agent_channel_port: 3000
  storage_dir: /rivet-shared
  heartbeat_interval_ms: 30000
  stale_threshold_ms: 90000
  discovery:
    mode: seed
    seed_host: ct110.mesh   # use .mesh hostname — matches cert SAN
    seed_port: 3000
```

### Custom cert paths

```yaml
mesh:
  enabled: true
  node_name: ct110
  tls:
    ca_path: /rivet-shared/rivet-ca/intermediate/ca-chain.pem
    cert_path: /rivet-shared/rivet-ca/issued/ct110.crt
    key_path: /rivet-shared/rivet-ca/issued/ct110.key
```

### Config reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `mesh.enabled` | bool | `false` | Enable mesh networking. |
| `mesh.node_name` | string | hostname | Node identifier — **must match cert CN**. |
| `mesh.tls` | bool \| object | — | mTLS config. **Required** — mesh refuses to start without it. |
| `mesh.tls.ca_path` | string | `/rivet-shared/rivet-ca/intermediate/ca-chain.pem` | CA chain PEM path. |
| `mesh.tls.cert_path` | string | `/rivet-shared/rivet-ca/issued/<node_name>.crt` | Node cert PEM path. |
| `mesh.tls.key_path` | string | `/rivet-shared/rivet-ca/issued/<node_name>.key` | Node private key PEM path. |
| `mesh.agent_channel_port` | number | `3000` | HTTPS port for the agent channel. |
| `mesh.storage_dir` | string | `/rivet-shared` | Directory containing `mesh.json`. |
| `mesh.heartbeat_interval_ms` | number | `30000` | How often to write a heartbeat. |
| `mesh.stale_threshold_ms` | number | `90000` | Age before a node is considered stale. |
| `mesh.discovery.mode` | string | — | `seed` \| `static` \| `mdns`. |
| `mesh.discovery.seed_host` | string | — | Seed node hostname. Use `<nodeName>.mesh`. |
| `mesh.discovery.seed_port` | number | `3100` | Seed node port. |
| `mesh.secret` | string | — | **Deprecated** — no longer used for agent-channel auth. Retained for `update --mesh` orchestration. |

### `.mesh` DNS names

dnsmasq on every CT resolves `<nodeName>.mesh` to the node's mesh IP. **Always
use `.mesh` names** for seed hosts and anywhere you reference a peer by URL.
This ensures the cert SAN matches the connection hostname and TLS succeeds
without `rejectUnauthorized: false`.

---

## Endpoints

All endpoints are served over HTTPS. The TLS handshake requires a valid client
certificate; connections without one are rejected before any HTTP code runs.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/mesh/ping` | Liveness probe. Returns `{ status, node, tls, cn }`. |
| `POST` | `/api/message` | Receive a delegated task. Body: `MessageRequest`. |
| `GET` | `/api/mesh` | Return mesh registry for seed sync. |
| `GET` | `/api/agents` | List local agents. |

---

## Audit / Logging

Every accepted request logs `peer.cn=<nodeName>`. You can grep for it in
`journalctl -u rivetos` or wherever your log sink is:

```
INFO [AgentChannel] Received mesh delegation peer.cn=ct110 from opus → grok: Summarise...
```

TLS handshake failures log at `WARN`:

```
WARN [AgentChannel] TLS handshake failed from 192.168.10.112: peer did not return a certificate
```

---

## Cutover — see `MIGRATION.md`

For the Phase 0.5 cutover procedure (all nodes must upgrade together), see
[`MIGRATION.md`](../MIGRATION.md).
