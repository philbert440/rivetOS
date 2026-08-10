# Gateway auth — Rivet CA device mTLS

Gateway (den-server / RivetHub API) access uses the **same Rivet CA** as the mesh.
Bearer tokens (`den.token`, `RIVETOS_DEN_TOKEN`, `?token=`, `Authorization: Bearer`)
are **removed**.

## Roles

| Leaf | Issue | CN | OU | Use |
|------|-------|----|----|-----|
| Node | `rivet-ca.sh issue-node <id>` | `<id>.mesh` | — | TLS **server** on gateway + mesh |
| Device | `rivet-ca.sh issue-client <device-id>` | `device:<device-id>` | `client` | TLS **client** (Hub desktop, Android, browser) |
| Agent | `rivet-ca.sh issue-agent <a> <node>` | `<a>@<node>` | — | Mesh agent identity (not Hub) |

Private keys under `/rivet-shared/rivet-ca/issued/*.key` are **operator secrets**.
Never commit them. Device keys leave the CA host only via secure handoff to the device.

## Node config

```yaml
den:
  enabled: true
  host: 0.0.0.0
  port: 5174
  # Paths to the node leaf (same cert as mesh issue-node for this node_name)
  tls_cert: /rivet-shared/rivet-ca/issued/ct112.crt
  tls_key: /rivet-shared/rivet-ca/issued/ct112.key
  # defaults to intermediate/chain.pem
  # tls_ca: /rivet-shared/rivet-ca/intermediate/chain.pem
```

Env equivalents: `RIVETOS_DEN_TLS_CERT`, `RIVETOS_DEN_TLS_KEY`, `RIVETOS_DEN_TLS_CA`,
`RIVETOS_DEN_TLS_REQUIRE_CLIENT` (default on).

**Loopback** (`den.host: 127.0.0.1`) may run plain HTTP without client certs for
local node processes (hooks, embed). **Off-loopback without TLS refuses to bind.**

## Enroll a device (admin)

On the CA host (typically datahub / CT110):

```bash
/opt/rivetos/scripts/rivet-ca.sh issue-client pixel-phil
# → issued/device-pixel-phil.{crt,key}
```

Install the cert+key (or a PKCS#12 export) into:

- **Browser / desktop OS** certificate store (client auth)
- **Android** app keystore (follow-up wiring)
- **Never** publish the key in chat, git, or world-readable NFS paths

Revoke:

```bash
/opt/rivetos/scripts/rivet-ca.sh revoke 'device:pixel-phil'
/opt/rivetos/scripts/rivet-ca.sh crl
```

Nodes should reload CA/CRL on a schedule (or restart) so revocations stick.

## Clients

- **RivetHub web**: open `https://<node>:5174`; browser picks the device client cert.
- **gateway-client (Node)**: optional `tls: { cert, key, ca }` PEM strings on `GatewayClientConfig`.
- **Same-origin** Hub served by den still requires mTLS when the page is loaded over HTTPS with `requestCert`.

## WireGuard device enroll

`POST /api/devices/enroll` one-time tokens remain **pairing** for WireGuard mesh
membership. They are not gateway application auth and are not a substitute for
device client certificates.

## Operability (post-#491 rollout pieces)

- **Node leaf SANs**: issue node certs with `IP:127.0.0.1` (plus the LAN IP)
  so loopback https — the deploy health probe, den hooks, spawned harnesses —
  passes hostname verification:
  `rivet-ca.sh issue-node ct112 DNS:ct112 IP:192.0.2.112 IP:127.0.0.1`
  SANs must cover **both** `127.0.0.1` and whatever host the node advertises
  on the mesh (`mesh.advertise_host` — LAN or overlay IP): peers verify the
  advertised name, local probes verify loopback. **Re-issue every node leaf
  to this shape BEFORE the fleet cutover** — leaves minted before this scheme
  fail deploy verification with a hostname error, not a scheme error.
- **Deploy probe**: `rivetos update` probes `https://…/healthz --cacert
  <chain>` automatically when the den resolves TLS material (explicit
  `den.tls_*` or the issue-node auto path).
- **Den hooks** (claude-code / hermes / kimi): default fan-out covers both
  loopback schemes; https posts verify against `RIVET_DEN_CA` (default
  `/rivet-shared/rivet-ca/intermediate/chain.pem`). Explicit `RIVET_DEN_URL`
  values must name the right scheme themselves.
- **Mesh view**: nodes with gateway TLS advertise `metadata.denUrl =
  https://<host>:<port>` in mesh.json; peer /healthz probes verify against
  `den.tls_ca`. `/healthz` needs no client cert anywhere.
