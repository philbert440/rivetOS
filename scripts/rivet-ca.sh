#!/usr/bin/env bash
# rivet-ca.sh — single-CA trust root for the Rivet collective.
#
# See docs/mcp-auth.md for the design. Layout:
#
#   $ROOT_DIR (default /var/lib/rivet-ca/root, CT110 local disk only)
#     ├── ca.crt                self-signed root (10y)
#     ├── ca.key                root private key — chmod 600, do not copy
#     ├── ca.srl                serial state for root signing
#     └── index.txt             (unused, kept for future openssl ca)
#
#   $SHARED_DIR (default /rivet-shared/rivet-ca, NFS-visible)
#     ├── intermediate/
#     │   ├── int.crt           5y, signed by root
#     │   ├── int.key           600
#     │   ├── int.srl
#     │   ├── chain.pem         root + intermediate
#     │   ├── index.txt         openssl ca DB (issued/revoked log)
#     │   └── openssl.cnf       config used by `openssl ca`
#     ├── crl.pem               regenerated on every revoke
#     └── issued/
#         ├── <node-id>.{crt,key}                 server cert, multi-SAN
#         └── <agent-id>@<node-id>.{crt,key}      client cert
#
# Subcommands:
#   init                              generate root (idempotent: bails if exists)
#   issue-intermediate                generate intermediate signed by root
#   issue-node <node-id> [san ...]    issue server cert with SANs
#   issue-agent <agent-id> <node-id>  issue client cert
#   revoke <cn>                       revoke a leaf, rebuild CRL
#   crl                               regenerate CRL (no revoke)
#   verify <cert-path>                verify a cert against the chain
#   list                              list issued certs
#
# Cert lifetimes:
#   Root: 10y    Intermediate: 5y    Node/Agent leaf: 90d (renew at 60d)

set -euo pipefail

ROOT_DIR="${RIVET_CA_ROOT_DIR:-/var/lib/rivet-ca/root}"
SHARED_DIR="${RIVET_CA_SHARED_DIR:-/rivet-shared/rivet-ca}"
INT_DIR="$SHARED_DIR/intermediate"
ISSUED_DIR="$SHARED_DIR/issued"

ORG="Rivet Collective"
ROOT_CN="Rivet Root CA"
INT_CN="Rivet Intermediate CA"

DAYS_ROOT=3650
DAYS_INT=1825
DAYS_LEAF=90

err()  { echo "rivet-ca: $*" >&2; exit 1; }
log()  { echo "rivet-ca: $*" >&2; }

require_openssl() {
  command -v openssl >/dev/null 2>&1 || err "openssl not found in PATH"
}

ensure_dirs() {
  mkdir -p "$ROOT_DIR" "$INT_DIR" "$ISSUED_DIR"
  chmod 700 "$ROOT_DIR"
}

# Write the openssl.cnf used by `openssl ca` (intermediate signing operations).
write_int_cnf() {
  cat > "$INT_DIR/openssl.cnf" <<EOF
[ ca ]
default_ca = rivet_int

[ rivet_int ]
dir               = $INT_DIR
certs             = \$dir
new_certs_dir     = \$dir
database          = \$dir/index.txt
serial            = \$dir/int.srl
private_key       = \$dir/int.key
certificate       = \$dir/int.crt
default_md        = sha256
default_days      = $DAYS_LEAF
policy            = policy_loose
unique_subject    = no
copy_extensions   = copy
crlnumber         = \$dir/crlnumber
crl               = \$dir/../crl.pem
default_crl_days  = 30

[ policy_loose ]
commonName              = supplied
organizationName        = optional
countryName             = optional
stateOrProvinceName     = optional
localityName            = optional
organizationalUnitName  = optional

[ v3_server ]
basicConstraints     = critical, CA:FALSE
keyUsage             = critical, digitalSignature, keyEncipherment
extendedKeyUsage     = serverAuth, clientAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer

[ v3_client ]
basicConstraints     = critical, CA:FALSE
keyUsage             = critical, digitalSignature
extendedKeyUsage     = clientAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
EOF

  [[ -f "$INT_DIR/index.txt" ]] || : > "$INT_DIR/index.txt"
  [[ -f "$INT_DIR/crlnumber" ]] || echo 1000 > "$INT_DIR/crlnumber"
  [[ -f "$INT_DIR/int.srl"   ]] || echo 1000 > "$INT_DIR/int.srl"
}

cmd_init() {
  ensure_dirs
  if [[ -f "$ROOT_DIR/ca.key" ]]; then
    err "root already exists at $ROOT_DIR/ca.key — refusing to overwrite"
  fi

  log "generating root key + self-signed cert ($DAYS_ROOT days) at $ROOT_DIR"
  openssl genrsa -out "$ROOT_DIR/ca.key" 4096
  chmod 600 "$ROOT_DIR/ca.key"

  openssl req -new -x509 -sha256 -days "$DAYS_ROOT" \
    -key "$ROOT_DIR/ca.key" \
    -out "$ROOT_DIR/ca.crt" \
    -subj "/O=$ORG/CN=$ROOT_CN" \
    -extensions v3_root \
    -config <(cat <<EOF
[ req ]
distinguished_name = req_dn
prompt = no
[ req_dn ]
O = $ORG
CN = $ROOT_CN
[ v3_root ]
basicConstraints = critical, CA:TRUE
keyUsage         = critical, keyCertSign, cRLSign
subjectKeyIdentifier   = hash
authorityKeyIdentifier = keyid:always,issuer
EOF
)

  echo 1000 > "$ROOT_DIR/ca.srl"
  log "root cert: $ROOT_DIR/ca.crt"
  log "root key:  $ROOT_DIR/ca.key  (KEEP OFFLINE / LOCAL ONLY)"
}

cmd_issue_intermediate() {
  ensure_dirs
  [[ -f "$ROOT_DIR/ca.key" ]] || err "no root — run 'init' first"
  if [[ -f "$INT_DIR/int.key" ]]; then
    err "intermediate already exists at $INT_DIR/int.key"
  fi

  log "generating intermediate key + CSR ($DAYS_INT days)"
  openssl genrsa -out "$INT_DIR/int.key" 4096
  chmod 600 "$INT_DIR/int.key"

  openssl req -new -sha256 \
    -key "$INT_DIR/int.key" \
    -out "$INT_DIR/int.csr" \
    -subj "/O=$ORG/CN=$INT_CN"

  log "signing intermediate with root"
  openssl x509 -req -sha256 -days "$DAYS_INT" \
    -in "$INT_DIR/int.csr" \
    -CA "$ROOT_DIR/ca.crt" \
    -CAkey "$ROOT_DIR/ca.key" \
    -CAserial "$ROOT_DIR/ca.srl" \
    -out "$INT_DIR/int.crt" \
    -extfile <(cat <<EOF
basicConstraints       = critical, CA:TRUE, pathlen:0
keyUsage               = critical, keyCertSign, cRLSign
subjectKeyIdentifier   = hash
authorityKeyIdentifier = keyid:always,issuer
EOF
)

  rm -f "$INT_DIR/int.csr"
  cat "$INT_DIR/int.crt" "$ROOT_DIR/ca.crt" > "$INT_DIR/chain.pem"

  write_int_cnf
  cmd_crl  # initial empty CRL

  log "intermediate cert: $INT_DIR/int.crt"
  log "chain bundle:      $INT_DIR/chain.pem"
}

# Issue a per-node server cert. CN = <node-id>.mesh, SANs = node-id.mesh,
# <node-id>-mcp.mesh, <node-id>-runtime-rpc.mesh, plus any extras.
cmd_issue_node() {
  local node_id="${1:-}"
  shift || true
  [[ -n "$node_id" ]] || err "usage: issue-node <node-id> [extra-san ...]"
  ensure_dirs
  write_int_cnf

  local key="$ISSUED_DIR/$node_id.key"
  local crt="$ISSUED_DIR/$node_id.crt"
  local csr="$ISSUED_DIR/$node_id.csr"

  if [[ -f "$crt" ]]; then
    log "WARN: $crt exists — renewing (key reused if present)"
  fi

  [[ -f "$key" ]] || { openssl genrsa -out "$key" 2048; chmod 600 "$key"; }

  local sans="DNS:${node_id}.mesh,DNS:${node_id}-mcp.mesh,DNS:${node_id}-runtime-rpc.mesh"
  # Extras pass through verbatim — caller must specify "DNS:foo" or "IP:1.2.3.4".
  # Bareword extras are treated as DNS for backward compat.
  for extra in "$@"; do
    if [[ "$extra" == DNS:* || "$extra" == IP:* || "$extra" == URI:* || "$extra" == email:* ]]; then
      sans+=",${extra}"
    else
      sans+=",DNS:${extra}"
    fi
  done

  openssl req -new -sha256 -key "$key" -out "$csr" \
    -subj "/O=$ORG/CN=${node_id}.mesh" \
    -addext "subjectAltName=$sans"

  openssl ca -batch -notext \
    -config "$INT_DIR/openssl.cnf" \
    -extensions v3_server \
    -days "$DAYS_LEAF" \
    -in "$csr" -out "$crt"

  rm -f "$csr"
  log "issued node cert: $crt"
  log "  SANs: $sans"
  log "  expires: $(openssl x509 -in "$crt" -noout -enddate | cut -d= -f2)"
}

cmd_issue_agent() {
  local agent_id="${1:-}"
  local node_id="${2:-}"
  [[ -n "$agent_id" && -n "$node_id" ]] || err "usage: issue-agent <agent-id> <node-id>"
  ensure_dirs
  write_int_cnf

  local cn="${agent_id}@${node_id}"
  local key="$ISSUED_DIR/${cn}.key"
  local crt="$ISSUED_DIR/${cn}.crt"
  local csr="$ISSUED_DIR/${cn}.csr"

  [[ -f "$key" ]] || { openssl genrsa -out "$key" 2048; chmod 600 "$key"; }

  openssl req -new -sha256 -key "$key" -out "$csr" \
    -subj "/O=$ORG/CN=${cn}"

  openssl ca -batch -notext \
    -config "$INT_DIR/openssl.cnf" \
    -extensions v3_client \
    -days "$DAYS_LEAF" \
    -in "$csr" -out "$crt"

  rm -f "$csr"
  log "issued agent cert: $crt  (CN=$cn)"
  log "  expires: $(openssl x509 -in "$crt" -noout -enddate | cut -d= -f2)"
}

cmd_revoke() {
  local cn="${1:-}"
  [[ -n "$cn" ]] || err "usage: revoke <cn>   (e.g. ct111.mesh, opus@ct111)"
  write_int_cnf

  # Find the issued cert by CN scan
  local target=""
  for f in "$ISSUED_DIR"/*.crt; do
    [[ -e "$f" ]] || continue
    if openssl x509 -in "$f" -noout -subject 2>/dev/null | grep -qE "CN ?= ?$cn(,|$| )"; then
      target="$f"; break
    fi
  done
  [[ -n "$target" ]] || err "no issued cert with CN=$cn"

  log "revoking $target"
  openssl ca -config "$INT_DIR/openssl.cnf" -revoke "$target"
  cmd_crl
}

cmd_crl() {
  write_int_cnf
  openssl ca -config "$INT_DIR/openssl.cnf" -gencrl -out "$SHARED_DIR/crl.pem"
  log "CRL written: $SHARED_DIR/crl.pem"
}

cmd_verify() {
  local cert="${1:-}"
  [[ -f "$cert" ]] || err "usage: verify <cert-path>"
  openssl verify -CAfile "$INT_DIR/chain.pem" -crl_check -CRLfile "$SHARED_DIR/crl.pem" "$cert"
}

cmd_list() {
  printf "%-40s %-25s %s\n" "CN" "EXPIRES" "FILE"
  for f in "$ISSUED_DIR"/*.crt; do
    [[ -e "$f" ]] || continue
    local subj exp
    subj=$(openssl x509 -in "$f" -noout -subject | sed 's/.*CN ?= ?//')
    exp=$(openssl x509 -in "$f" -noout -enddate | cut -d= -f2)
    printf "%-40s %-25s %s\n" "$subj" "$exp" "$(basename "$f")"
  done
}

main() {
  require_openssl
  local sub="${1:-}"
  shift || true
  case "$sub" in
    init)                cmd_init "$@" ;;
    issue-intermediate)  cmd_issue_intermediate "$@" ;;
    issue-node)          cmd_issue_node "$@" ;;
    issue-agent)         cmd_issue_agent "$@" ;;
    revoke)              cmd_revoke "$@" ;;
    crl)                 cmd_crl "$@" ;;
    verify)              cmd_verify "$@" ;;
    list)                cmd_list "$@" ;;
    ""|-h|--help)
      sed -n '2,40p' "$0" | sed 's/^# \?//'
      ;;
    *) err "unknown subcommand: $sub  (try --help)" ;;
  esac
}

main "$@"
