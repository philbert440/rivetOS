# MCP & Mesh Auth — Single-CA Trust Model

**Status:** Design (Phase 0 of MCP overhaul)
**Spec owner:** `/rivet-shared/plans/mcp-architecture-overhaul.md`
**Last updated:** 2026-04-24

---

## TL;DR

One X.509 CA — **`rivet-ca`** — is the trust root for the entire Rivet
collective. Every inter-node hop is mTLS, signed by this one CA:

- **MCP server ↔ clients** (internal agents + eventually Claude Desktop / Cursor)
- **DataHub HTTP API** (replaces the current bearer token)
- **Mesh agent-channel** (replaces the current shared-secret HMAC on `:3000`)
- **Runtime-RPC** (the Phase-2 south-bound channel from MCP → runtime nodes)

The legacy shared secret (`mesh.secret`) survives only as **bootstrap** — a
brand-new node uses it once to prove identity and pull its first cert, then
never again.

## Why one CA

Two trust systems (bearer for mesh, mTLS for MCP) means two rotation stories,
two revocation paths, and a permanent seam where a compromise in either
doesn't fully cover the other. One CA gives us a single answer to *"is this
caller trusted?"* across the entire stack.

## Layout

```
/shared/rivet-ca/                 (NFS-visible from CT110 during provisioning)
├── root/
│   ├── ca.crt                    self-signed root (offline in prod)
│   └── ca.key                    → moved offline after intermediate is issued
├── intermediate/
│   ├── int.crt
│   ├── int.key                   online, used for day-to-day issuance
│   └── chain.pem                 root + intermediate concatenated
├── crl.pem                       revocation list, rebuilt on every revocation
└── issued/
    ├── <node-id>.crt             server cert (SANs cover every listener)
    ├── <node-id>.key
    ├── <agent-id>@<node-id>.crt  client cert, one per agent identity
    └── <agent-id>@<node-id>.key

/etc/rivetos/                     (per-node, installed by provision-ct.sh)
├── node.crt                      leaf server cert for this node
├── node.key                      matching private key (mode 0600)
├── rivet-ca.crt                  full chain for verification
└── agents/<agent-id>.{crt,key}   client cert per agent running on this node
```

**Single server cert per node.** SANs cover every listener a node exposes:
`ct111.mesh`, `ct111-mcp.mesh`, `ct111-runtime-rpc.mesh`, plus any service
aliases. One cert, one rotation, every service on the node is covered.

## Identity

- **Node server cert** — CN = `<node-id>.mesh` (e.g. `ct111.mesh`)
- **Internal agent client cert** — CN = `<agent-id>@<node-id>` (e.g. `opus@ct111`)
- **External user client cert** — CN = `<user>@external` (Phase 4 only)

The MCP server's `rivetos/session.attach` handler validates the presented
cert's CN matches the claimed `agent_id`. The runtime-RPC server does the same.
Certs cannot be used to impersonate another agent.

## Lifecycle

| Step | Who | How |
|---|---|---|
| Root issued | Phil, manually | `scripts/rivet-ca.sh init` (once, ever) |
| Intermediate issued | Phil, manually | `scripts/rivet-ca.sh issue-intermediate` |
| Node enrolls | `provision-ct.sh` on new CT | posts CSR + `mesh.secret` bootstrap auth → CA signs → certs land in `/etc/rivetos/` |
| Agent cert minted | boot-time registrar | if missing, CSR against local intermediate (CT110 only) |
| Renewal | systemd timer, 30 days before expiry | re-uses existing private key, rotates cert |
| Revocation | `rivetos ca revoke <cn>` | CRL rebuilt, pushed to all nodes |

- **Cert lifetime:** 90 days. Renew at 60.
- **Root lifetime:** 10 years. Key offline after bootstrap.
- **Intermediate lifetime:** 5 years. Rotated mid-life.

## Bootstrap Path (the one place `mesh.secret` still lives)

1. New node spins up with `mesh.secret` in its env.
2. First call to `datahub:/enroll` uses `mesh.secret` as the bearer.
3. DataHub signs the CSR with the intermediate, returns cert + CA chain.
4. Node writes `/etc/rivetos/node.{crt,key}` + `rivet-ca.crt`.
5. **Every subsequent call is mTLS.** `mesh.secret` is never sent again.

One release after cutover, `mesh.secret` is renamed `bootstrap.secret` and
gated to `datahub:/enroll` only — no other endpoint will accept it.

## Phase Map

| Phase | Action |
|---|---|
| 0.5 | `scripts/rivet-ca.sh` lands. Root + intermediate generated. Every existing node enrolls. Mesh agent-channel starts accepting mTLS alongside bearer (one-release compat). |
| 1 | MCP server on CT110 listens on mTLS using the same CA. Runtime-RPC (Phase 2 prep) registered. |
| 2 | Runtime-RPC `:5701` on every runtime node. All calls mTLS-authenticated. |
| Next release after 0.5 | Bearer path removed from agent-channel. `mesh.secret` demoted to bootstrap. |

## What this replaces

- `AgentChannelServer.authenticate()` bearer check → mTLS handshake
- DataHub HTTP bearer → mTLS handshake
- "Whatever the MCP plugin was going to do on its own" → same CA as everything else

## What it doesn't replace

- **Session tokens.** Minted by the MCP server after cert auth succeeds, used
  as a per-connection identifier inside the already-authenticated channel.
  Cannot be lifted off the wire because the wire is mTLS.
- **Per-agent allow-lists.** Auth says *who you are*; allow-lists say *what
  you're allowed to call*. Still required.
- **MEMORY.md secrecy convention.** Client-side filtering of sensitive
  memory hits stays on the agent side by design — MCP server doesn't know
  which results are sensitive.

## Open follow-ups

- Should agent client certs rotate independently of node certs, or piggyback?
  *Lean: piggyback — one rotation event per node, all agents on that node
  re-issued at the same time.*
- HSM-backed root key storage once the collective has anything worth
  protecting. Fine without it during the design phase.
