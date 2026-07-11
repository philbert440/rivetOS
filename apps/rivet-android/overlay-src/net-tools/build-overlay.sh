#!/usr/bin/env bash
# Build app/src/main/assets/rivet-net-tools-overlay.bin — curl, ping, ip (+ shared libs)
# baked into the proot rootfs by RivetRuntime.ensureNetTools().
#
# Noble arm64 debs are extracted with dpkg-deb -x when zstd is available, else the bundled
# Node extractor (noble .deb data members are data.tar.zst).
#
# After running, bump NET_TOOLS_OVERLAY_REV in RivetRuntime.kt so it re-provisions on next launch.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="$REPO/app/src/main/assets/rivet-net-tools-overlay.bin"
# Pinned noble arm64 pool paths (from apt-cache show <pkg> | grep ^Filename:).
declare -a DEB_PATHS=(
  pool/main/c/curl/curl_8.5.0-2ubuntu10.9_arm64.deb
  pool/main/c/curl/libcurl4t64_8.5.0-2ubuntu10.9_arm64.deb
  pool/main/n/nghttp2/libnghttp2-14_1.59.0-1ubuntu0.3_arm64.deb
  pool/main/libp/libpsl/libpsl5t64_0.21.2-1.1build1_arm64.deb
  pool/main/libs/libssh/libssh-4_0.10.6-2ubuntu0.4_arm64.deb
  pool/main/o/openldap/libldap2_2.6.10+dfsg-0ubuntu0.24.04.1_arm64.deb
  pool/main/c/cyrus-sasl2/libsasl2-2_2.1.28+dfsg1-5ubuntu3.1_arm64.deb
  pool/main/c/cyrus-sasl2/libsasl2-modules-db_2.1.28+dfsg1-5ubuntu3.1_arm64.deb
  pool/main/r/rtmpdump/librtmp1_2.4+20151223.gitfa8646d.1-2build7_arm64.deb
  pool/main/k/krb5/libkrb5-3_1.20.1-6ubuntu2.6_arm64.deb
  pool/main/k/krb5/libgssapi-krb5-2_1.20.1-6ubuntu2.6_arm64.deb
  pool/main/k/krb5/libk5crypto3_1.20.1-6ubuntu2.6_arm64.deb
  pool/main/k/krb5/libkrb5support0_1.20.1-6ubuntu2.6_arm64.deb
  pool/main/k/keyutils/libkeyutils1_1.6.3-3build1_arm64.deb
  pool/main/e/e2fsprogs/libcom-err2_1.47.0-2.4~exp1ubuntu4.1_arm64.deb
  pool/main/o/openssl/libssl3t64_3.0.13-0ubuntu3.11_arm64.deb
  pool/main/b/brotli/libbrotli1_1.1.0-2build2_arm64.deb
  pool/main/libz/libzstd/libzstd1_1.5.5+dfsg2-2build1.1_arm64.deb
  pool/main/libc/libcap2/libcap2-bin_2.66-5ubuntu2.4_arm64.deb
  pool/main/libc/libcap2/libcap2_2.66-5ubuntu2.4_arm64.deb
  pool/main/libi/libidn2/libidn2-0_2.3.7-2build1.1_arm64.deb
  pool/main/libu/libunistring/libunistring5_1.1-2build1.1_arm64.deb
  pool/main/i/iputils/iputils-ping_20240117-1ubuntu0.1_arm64.deb
  pool/main/i/iproute2/iproute2_6.1.0-1ubuntu6.3_arm64.deb
  pool/main/libb/libbpf/libbpf1_1.3.0-2build2_arm64.deb
  pool/main/d/db5.3/libdb5.3t64_5.3.28+dfsg2-7_arm64.deb
  pool/main/e/elfutils/libelf1t64_0.190-1.1ubuntu0.1_arm64.deb
  pool/main/libm/libmnl/libmnl0_1.0.5-2build1_arm64.deb
  pool/main/i/iptables/libxtables12_1.8.10-3ubuntu2_arm64.deb
)

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
cd "$work"
mkdir -p debs stage overlay

fetch() {
  local url="$1" out="$2"
  node -e "fetch(process.argv[1]).then(r=>{if(!r.ok)throw new Error(r.status+' '+r.statusText);return r.arrayBuffer()}).then(b=>require('fs').writeFileSync(process.argv[2],Buffer.from(b)))" "$url" "$out"
}

for path in "${DEB_PATHS[@]}"; do
  out="debs/$(basename "$path")"
  url="http://ports.ubuntu.com/ubuntu-ports/$path"
  echo "fetch $(basename "$path")"
  fetch "$url" "$out"
done

extract_one() {
  local deb="$1"
  if command -v zstd >/dev/null 2>&1; then
    dpkg-deb -x "$deb" stage
    return
  fi
  node "$HERE/extract-debs.mjs" stage "$deb"
}

for deb in debs/*.deb; do
  extract_one "$deb"
done

mkdir -p overlay/usr/bin overlay/usr/sbin overlay/usr/local/bin overlay/usr/lib/aarch64-linux-gnu overlay/etc
cp -a stage/usr/bin/curl stage/usr/bin/ping overlay/usr/bin/
# iproute2's arm64 deb lays out ./bin/ip (no usr/ prefix) on noble.
if [[ -f stage/bin/ip ]]; then cp -a stage/bin/ip overlay/usr/bin/ip
elif [[ -f stage/sbin/ip ]]; then cp -a stage/sbin/ip overlay/usr/sbin/ip
else cp -a stage/usr/sbin/ip overlay/usr/sbin/ip
fi
[[ -d stage/etc/iproute2 ]] && cp -a stage/etc/iproute2 overlay/etc/
cp -a stage/usr/lib/aarch64-linux-gnu/*.so* overlay/usr/lib/aarch64-linux-gnu/ 2>/dev/null || true
ln -sf /usr/bin/curl overlay/usr/local/bin/curl
ln -sf /usr/bin/ping overlay/usr/local/bin/ping
if [[ -f overlay/usr/sbin/ip ]]; then ln -sf /usr/sbin/ip overlay/usr/local/bin/ip
else ln -sf /usr/bin/ip overlay/usr/local/bin/ip
fi

tar -czf "$OUT" -C overlay .
echo "built $OUT ($(du -h "$OUT" | cut -f1))"
tar -tzf "$OUT" | sort