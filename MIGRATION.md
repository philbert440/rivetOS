# Migration Guide

---

## Phase 0.5 — Mesh mTLS (Breaking Change)

**All mesh nodes must upgrade together.** Mixed-mode (TLS + plaintext) is not
supported. Coordinate the cutover in a maintenance window.

### What Changed

| Before (Phase ≤ 0.25) | After (Phase 0.5) |
|-----------------------|-------------------|
| Agent channel: HTTP + Bearer token | Agent channel: HTTPS + mutual TLS |
| `mesh.secret` used for auth | `mesh.tls` required; `secret` ignored on agent channel |
| URL scheme: `http://` | URL scheme: `https://` |
| Any IP / hostname works | Use `<nodeName>.mesh` — must match cert SAN |

### Pre-flight Checklist

Before running `update --mesh`:

1. **CA and certs are in place:**
   ```
   /rivet-shared/rivet-ca/intermediate/ca-chain.pem
   /rivet-shared/rivet-ca/issued/ct110.{crt,key}
   /rivet-shared/rivet-ca/issued/ct111.{crt,key}
   ... (repeat for each node)
   ```
   Permissions: `rivet:rivet` (600 for keys, 644 for certs).

2. **`.mesh` DNS resolves on all nodes:**
   ```bash
   # On any CT:
   ping -c1 ct110.mesh   # should resolve to the mesh IP
   ping -c1 ct111.mesh
   ```
   If not, check dnsmasq config (`/etc/dnsmasq.d/mesh.conf`).

3. **Cert CNs match node names:**
   ```bash
   openssl x509 -noout -subject -in /rivet-shared/rivet-ca/issued/ct110.crt
   # expect: subject=CN = ct110
   ```

4. **CA chain validates all certs:**
   ```bash
   openssl verify -CAfile /rivet-shared/rivet-ca/intermediate/ca-chain.pem \
     /rivet-shared/rivet-ca/issued/ct110.crt
   # expect: OK
   ```

5. **Certs include the right SANs:**
   ```bash
   openssl x509 -noout -ext subjectAltName \
     -in /rivet-shared/rivet-ca/issued/ct110.crt
   # expect: DNS:ct110.mesh, IP Address:<mesh_ip>
   ```

### Update Config on All Nodes

Add `tls: true` to each node's `~/.rivetos/config.yaml`:

```yaml
mesh:
  enabled: true
  node_name: ct110          # ← must match cert CN
  tls: true                 # ← this is the new required field
  agent_channel_port: 3000
  storage_dir: /rivet-shared
  discovery:
    mode: seed
    seed_host: ct110.mesh   # ← use .mesh hostname
    seed_port: 3000
  # secret: ...             # ← no longer needed for agent-channel auth
```

### Cutover Procedure

```bash
# 1. Deploy the new code to all nodes simultaneously
update --mesh

# 2. Verify each node's agent channel is listening on TLS
curl -k https://ct110.mesh:3000/api/mesh/ping
# expect: {"status":"ok","tls":true,"cn":"ct110"}

# 3. Confirm mTLS is enforced (no client cert = rejected)
curl https://ct110.mesh:3000/api/mesh/ping   # should fail with SSL error

# 4. Run a cross-node delegation to confirm end-to-end
rivetos mesh doctor
```

### Rollback

If something goes wrong, the simplest rollback is reverting the config on all
nodes simultaneously (remove `tls:` and restore `secret:`) and redeploying with
`update --mesh`. Rolling back only some nodes will break the mesh because
plaintext and TLS are not interoperable.

### Troubleshooting

| Symptom | Likely Cause |
|---------|-------------|
| `TLS handshake failed: peer did not return a certificate` | Client not sending cert — check `mesh.tls` is configured on the client node |
| `Hostname/IP does not match certificate's altnames` | Connecting by IP instead of `.mesh` hostname, or cert missing that SAN |
| `certificate verify failed` | CA chain doesn't include the issuing intermediate, or wrong CA file |
| `mesh TLS configured but CA chain at /... not readable` | File missing or wrong permissions — needs `rivet:rivet` ownership |
| Node starts but no mesh ping | Port 3000 blocked by firewall, or `agent_channel_port` mismatch |

---

## Phase 0.25 — Rivet User Migration

See [`docs/phase-0.25-migration.md`](docs/phase-0.25-migration.md).
