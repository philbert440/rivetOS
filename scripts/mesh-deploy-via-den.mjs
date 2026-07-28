#!/usr/bin/env node
/**
 * Deploy latest main to den-capable mesh nodes via open terminal inject
 * when SSH mesh keys are unavailable from this host.
 *
 * Usage:
 *   node scripts/mesh-deploy-via-den.mjs [--hosts host1,host2]
 *   node scripts/mesh-deploy-via-den.mjs --status
 *
 * Hosts default from /rivet-shared/mesh.json (or MESH_JSON / --hosts=).
 */
import { readFileSync, existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = Number(process.env.RIVETOS_DEN_PORT || 5174)

function hostsFromMesh() {
  const path = process.env.MESH_JSON || '/rivet-shared/mesh.json'
  if (!existsSync(path)) return []
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    const nodes = data.nodes || {}
    return Object.values(nodes)
      .map((n) => n && n.host)
      .filter((h) => typeof h === 'string' && h.length > 0)
  } catch {
    return []
  }
}

const args = process.argv.slice(2)
const statusOnly = args.includes('--status')
const hostsArg = args.find((a) => a.startsWith('--hosts='))
const HOSTS = hostsArg
  ? hostsArg
      .slice('--hosts='.length)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : hostsFromMesh()

async function jfetch(url, init) {
  const res = await fetch(url, init)
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  if (!res.ok) throw new Error(`${url} → ${res.status} ${text.slice(0, 200)}`)
  return body
}

async function spawnShell(host) {
  return jfetch(`http://${host}:${PORT}/term`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command: 'shell', cols: 120, rows: 40 }),
  })
}

async function inject(host, session, text, submit = true) {
  return jfetch(`http://${host}:${PORT}/term/inject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session, text, submit }),
  })
}

async function killPty(host, id) {
  try {
    await jfetch(`http://${host}:${PORT}/term?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  } catch {
    /* best-effort */
  }
}

const DEPLOY_SCRIPT = String.raw`export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
set -euo pipefail
LOG=/tmp/rivetos-deploy-418.log
exec > >(tee -a "$LOG") 2>&1
echo "=== deploy start $(date -Is) host=$(hostname) ==="
cd /opt/rivetos
git stash push -u -m "pre-mesh-deploy-$(date +%s)" || true
git fetch origin main
git checkout main
git pull --ff-only origin main
# bare-metal local update (no mesh SSH from this node)
if [ -x ./bin/rivetos ]; then
  ./bin/rivetos update --bare-metal
else
  npm ci
  npx nx run-many -t build --projects=@rivetos/types,@rivetos/den-protocol,@rivetos/den-server,@rivetos/boot,@rivetos/rivethub-web,@rivetos/gateway-client,@rivetos/core -c production || npx nx run-many -t build
  sudo -n systemctl restart rivetos || systemctl --user restart rivetos || true
fi
# Phase 0 mic shim (rootless)
if [ -x services/den-server/scripts/micbridge-phase0/setup.sh ]; then
  bash services/den-server/scripts/micbridge-phase0/setup.sh || true
fi
echo "=== deploy done $(date -Is) sha=$(git rev-parse --short HEAD) ==="
echo DONE
`

async function deployHost(host) {
  console.log(`\n── ${host} ──`)
  const health = await jfetch(`http://${host}:${PORT}/healthz`)
  console.log(`  health: ${health.name || host}`)
  const pty = await spawnShell(host)
  console.log(`  spawned shell ${pty.id} session=${pty.denSession}`)
  // Let shell settle
  await sleep(800)
  // Write script to file then run — safer than a huge one-liner inject
  const b64 = Buffer.from(DEPLOY_SCRIPT).toString('base64')
  await inject(
    host,
    pty.denSession,
    `mkdir -p /tmp && echo '${b64}' | base64 -d > /tmp/rivetos-deploy-418.sh && chmod +x /tmp/rivetos-deploy-418.sh && nohup bash /tmp/rivetos-deploy-418.sh > /tmp/rivetos-deploy-418.nohup 2>&1 & echo STARTED_PID:$!`,
    true,
  )
  console.log(`  deploy kicked (log: /tmp/rivetos-deploy-418.log)`)
  return { host, ptyId: pty.id, session: pty.denSession }
}

async function checkStatus(host) {
  const out = { host }
  try {
    out.health = await jfetch(`http://${host}:${PORT}/healthz`)
  } catch (e) {
    out.healthError = String(e.message || e)
    return out
  }
  try {
    out.audio = await jfetch(`http://${host}:${PORT}/api/audio`)
  } catch (e) {
    out.audioError = String(e.message || e)
  }
  return out
}

async function main() {
  if (statusOnly) {
    for (const host of HOSTS) {
      const st = await checkStatus(host)
      console.log(JSON.stringify(st))
    }
    return
  }
  console.log(`Deploying to: ${HOSTS.join(', ')}`)
  const results = []
  for (const host of HOSTS) {
    try {
      results.push(await deployHost(host))
    } catch (e) {
      console.error(`  FAIL ${host}: ${e.message || e}`)
      results.push({ host, error: String(e.message || e) })
    }
  }
  console.log('\nKicked. Poll with: node scripts/mesh-deploy-via-den.mjs --status')
  console.log(JSON.stringify(results, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
