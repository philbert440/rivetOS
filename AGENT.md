# AGENT.md — RivetOS Project Context

Live continuity file. Any agent (Opus/Grok/Sonnet/Local) picking this up cold should read this first.

## Current Phase: 0.5 — Mesh mTLS Migration

**Branch:** `feat/mesh-mtls` (commit `aca4f00`)
**Status:** Code complete, lint/tests/build green, ready to push & merge.

### Done
- ✅ Shared CA bring-up
  - `scripts/rivet-ca.sh` — root CA on CT110 (`/var/lib/rivet-ca/root/`, 0600), intermediate + chain on NFS (`/rivet-shared/rivet-ca/`)
  - Root key never leaves CT110. Issuance always runs on CT110.
- ✅ Sudoers fix — `rivet ALL=(ALL) NOPASSWD: ALL` on all CTs via `/rivet-shared/RivetOS/scripts/grant-rivet-sudo.sh`
- ✅ Cert issuance — `scripts/bootstrap-certs.sh` issued:
  - **Node certs:** ct110, ct111, ct112, ct113, ct114 (SANs: `<node>.mesh` + mesh IP)
  - **Agent certs:** opus@ct111, grok@ct112, gemini@ct113, local@ct114 (issued but NOT used on the wire in this phase)
  - All under `/rivet-shared/rivet-ca/issued/`, owned `rivet:rivet`
- ✅ mTLS wiring in RivetOS (commit `aca4f00` on `feat/mesh-mtls`)
  - `MeshConfig.tls: boolean` — single switch, paths derived from `nodeName`
  - Server (`agent-channel.ts`): swaps `http` → `https.createServer({ key, cert, ca, requestCert: true, rejectUnauthorized: true })`
  - Client (`mesh-delegation.ts`, `mesh.ts` seed sync): `undici` Agent with mTLS, `https://` URLs
  - `/api/mesh/ping` reports `{ ok, tls, cn }` for `update --mesh` health checks
  - `mesh.secret` deprecated for agent-channel auth (kept in type for one release of compat in update flow)
- ✅ Lint clean (25 projects), tests 320/320 in `@rivetos/core`, all 26 buildable projects pass

### Design decisions baked in (DO NOT REVISIT without Phil)
1. **Node cert only on the wire.** Agent certs sit in CA, unused for now. Trust unit = node.
2. **CA = allow-list.** No static `allowed_client_cns`. Signed by our intermediate ⇒ trusted.
3. **TLS mandatory** when mesh enabled. No bearer fallback, no plaintext, no dual-mode.
4. **`mesh.tls: true`** — single boolean. Cert/key/CA paths derived from `nodeName`.
5. **Connect by `<node>.mesh`** (not IP) — DNS via dnsmasq. IPs remain as SAN backups.
6. **One PR / one cutover.** `update --mesh` deploys all nodes in lockstep.

### Next Up — DO IN THIS ORDER
1. **Push branch** — `cd /rivet-shared/RivetOS && git push -u origin feat/mesh-mtls`
2. **Open PR** — `gh pr create --title "feat: Phase 0.5 — Mesh mTLS" --body "..."`
3. **Merge** (Phil approves)
4. **Validation hop** before deploy:
   ```bash
   openssl s_client -connect ct111.mesh:3100 \
     -CAfile /rivet-shared/rivet-ca/intermediate/ca-chain.pem \
     -cert  /rivet-shared/rivet-ca/issued/ct111.crt \
     -key   /rivet-shared/rivet-ca/issued/ct111.key </dev/null
   ```
   Expect `Verify return code: 0`. (Note: this test happens AFTER deploy since the listener has to be running mTLS for it to validate.)
5. **Deploy** — `cd /opt/rivetos && node packages/cli/dist/index.js update --mesh`
6. **Sanity check** — `curl https://ct111.mesh:3100/api/mesh/ping --cacert ... --cert ... --key ...` from each node
7. **Confirm** delegate_task round-trip works opus↔grok↔gemini↔local
8. **Next delegation goes to `local`** (Qwen on GERTY/CT114) — Phil wants to stretch its legs on real work. Pick something appropriately scoped.

### Per-node config delta needed before deploy
Each node's RivetOS config (`~/.rivetos/config.yaml` or wherever per node) needs:
```yaml
mesh:
  enabled: true
  nodeName: ct111      # already set
  tls: true            # NEW — flip on
  # secret: <removed>  # safe to delete; ignored by agent-channel now
```
**Important:** all nodes must flip together. `update --mesh` does rolling restart; brief window of mismatch is tolerable but minimize it. If a node has `tls: true` but cert files missing on NFS, mesh refuses to start (fail-closed).

### Gotchas
- `/opt/rivetos` is **runtime** — never edit code there. Dev work goes in `/rivet-shared/RivetOS`.
- `update --mesh` is the ONLY correct way to deploy. Don't hand-roll `git pull && npm install && nx build && systemctl restart`.
- CA root key is **CT110-only**. Any cert issuance runs on CT110.
- Sonnet sub-agents wedged twice during this phase (0 iterations, no progress). If delegating again, watch closely; fall back to direct edits.
- Grok hallucinated commit success in `coding_pipeline` once — verify with `git log` before trusting "done".
- `gh` CLI on CT111 was root-only at `/root/.config/gh/`. Copied to `/home/rivet/.config/gh/` and `chown rivet:rivet`. Auth scope is plenty for push + PR.

### Where to look in the code
- `packages/types/src/mesh.ts` — `MeshConfig.tls`
- `packages/core/src/runtime/agent-channel.ts` — server, peer identity, ping payload
- `packages/core/src/domain/mesh-delegation.ts` — outbound delegate calls
- `packages/core/src/domain/mesh.ts` — seed sync (line ~260)
- `packages/boot/src/registrars/agents.ts` — wire-up
- `packages/boot/src/config/*` — yaml schema for `mesh.tls`

---

## Future Phases (not started)
- **Phase 1:** Per-agent client certs on the wire (CN binding, `fromAgent` ↔ CN strict check)
- **Phase 2:** CRL distribution, cert rotation automation
- **Phase 3:** Drop `mesh.secret` field entirely from types
