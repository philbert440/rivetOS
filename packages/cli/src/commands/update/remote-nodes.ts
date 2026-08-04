/**
 * Remote-node update mechanics for `rivetos update --mesh`.
 *
 * Each function operates on a single peer over SSH and returns a
 * NodeUpdateResult for the summary table. Two update paths:
 *   - gitUpdateNodeAsync  — git pull + npm install + build + restart (source nodes)
 *   - npmUpdateNodeAsync   — npm install -g @rivetos/cli@<channel> + restart
 * plus waitForHealth() which gates the summary on the peer coming back up.
 */

import { execSync } from 'node:child_process'
import { buildMeshDispatcher } from '../../lib/mtls.js'
import { sshExec, sshExecQuiet, resolveSshUser, isSafeArg } from '../../lib/ssh.js'
import { retireDenUnitRemote, verifyGatewayRemote } from './den-deploy.js'
import type { UpdateOptions, NodeUpdateResult } from './types.js'

/**
 * Timeout for a `systemctl restart`. Generous because some units (notably
 * datahub's rivet-compactor) take well over 30s to come back up — and
 * `systemctl restart` blocks until the unit is active, so a too-short timeout
 * kills our SSH client mid-restart and reports a false failure even though the
 * restart completes server-side.
 */
const RESTART_TIMEOUT_MS = 90_000

/** Default source-tree install path on mesh peers (git update path). */
export const REMOTE_INSTALL_ROOT = '/opt/rivetos'

/**
 * Relative path labels checked for writability on a remote source install.
 * Same hot spots as local ownership preflight: root, .git, node_modules.
 */
export const REMOTE_OWNERSHIP_PATHS = ['.', '.git', 'node_modules'] as const

export type RemoteOwnershipProbe =
  | { ok: true }
  | { ok: false; reason: 'missing'; root: string }
  | { ok: false; reason: 'unwritable'; root: string; blockers: { path: string; owner: string }[] }

/**
 * Probe whether `sshUser` can write the remote source install before git/npm.
 *
 * Historical footgun (residual from local ownership preflight / #423): mesh
 * updates SSHed in, burned minutes on git pull or mid-npm, then died with
 * EACCES when `/opt/rivetos` (or node_modules) was owned by root/philip while
 * the update user is `rivet`. Fail fast with a copy-paste chown.
 *
 * Uses only fixed path strings (no remote shell variables) so `sshExecQuiet`'s
 * double-quoted wrapper cannot expand `$…` on the local shell.
 */
export function probeRemoteInstallWritable(
  host: string,
  sshUser: string,
  root: string = REMOTE_INSTALL_ROOT,
): RemoteOwnershipProbe {
  // Refuse shell metacharacters in root (defense in depth for future callers).
  if (root.includes('"') || root.includes("'") || root.includes(' ') || root.includes(';')) {
    return { ok: false, reason: 'missing', root }
  }

  const exists = sshExecQuiet(host, `test -d ${root} && echo yes || echo no`, sshUser)
  if (exists !== 'yes') {
    return { ok: false, reason: 'missing', root }
  }

  const blockers: { path: string; owner: string }[] = []
  for (const rel of REMOTE_OWNERSHIP_PATHS) {
    const full = rel === '.' ? root : `${root}/${rel}`
    // SKIP = path does not exist yet (ok — npm will create node_modules).
    // OK = exists and writable. BLOCKED = exists but not writable.
    const writability = sshExecQuiet(
      host,
      `if test -e ${full}; then if test -w ${full}; then echo OK; else echo BLOCKED; fi; else echo SKIP; fi`,
      sshUser,
    )
    if (writability === 'BLOCKED') {
      const owner = sshExecQuiet(host, `stat -c %U:%G ${full} 2>/dev/null || echo unknown`, sshUser)
      blockers.push({ path: rel === '.' ? root : full, owner: owner || 'unknown' })
    }
  }

  if (blockers.length > 0) {
    return { ok: false, reason: 'unwritable', root, blockers }
  }
  return { ok: true }
}

/**
 * Log a clear ownership failure and return a failed NodeUpdateResult fragment
 * for the mesh summary table (`failedStep: 'ownership'`).
 */
export function remoteOwnershipFailure(
  tag: string,
  nodeName: string,
  sshUser: string,
  probe: Extract<RemoteOwnershipProbe, { ok: false }>,
  start: number,
): NodeUpdateResult {
  if (probe.reason === 'missing') {
    console.error(
      `    ${tag} ❌ Install tree missing at ${probe.root} — cannot git-update this node as ${sshUser}`,
    )
    console.error(
      `    ${tag}    Clone RivetOS to ${probe.root} (or fix mesh roster) before re-running.`,
    )
    return { success: false, failedStep: 'ownership', elapsedMs: Date.now() - start }
  }

  const detail = probe.blockers.map((b) => `${b.path} (owner ${b.owner})`).join(', ')
  const chownTargets = probe.blockers.map((b) => b.path).join(' ')
  console.error(`    ${tag} ❌ Install tree not writable by ${sshUser}: ${detail}`)
  console.error(`    ${tag}    git/npm will fail with EACCES. Common after sudo installs (root) or`)
  console.error(`    ${tag}    desktop copies owned by philip while mesh update SSHs as rivet.`)
  console.error(
    `    ${tag}    Fix on ${nodeName}: sudo chown -R ${sshUser}:${sshUser} ${chownTargets}`,
  )
  return { success: false, failedStep: 'ownership', elapsedMs: Date.now() - start }
}

/**
 * Discover rivet-* systemd worker services on a remote host, excluding the
 * primary rivetos.service. Returns an array of unit names (e.g.
 * ["rivet-embedder.service", "rivet-compactor.service"]). On failure, returns [].
 */
export function discoverRivetWorkers(host: string, sshUser = 'rivet'): string[] {
  // Only enabled units: a disabled unit is disabled on purpose (one-shot
  // backfills, retired workers) — restarting it re-runs it and then reads
  // as 'failed' when it exits (datahub's rivet-v5-backfill, 2026-07-04).
  const out = sshExecQuiet(
    host,
    "systemctl list-unit-files 'rivet-*.service' --state=enabled --no-legend --no-pager 2>/dev/null | awk '{print \\$1}'",
    sshUser,
  )
  if (!out) return []
  return (
    out
      .split('\n')
      .map((s) => s.trim())
      // isSafeArg guards against a compromised/garbled `systemctl` listing
      // injecting metacharacters into the later `systemctl restart <unit>`.
      .filter((s) => s.length > 0 && s !== 'rivetos.service' && isSafeArg(s))
  )
}

/**
 * Update a remote node via git pull + SSH.
 * Each step logs progress with [nodeName] prefix and has its own timeout.
 * Returns a result object with success/failure details for the summary table.
 */
export async function gitUpdateNodeAsync(
  host: string,
  nodeName: string,
  opts: UpdateOptions,
  isAgent: boolean = true,
  nodeSshUser?: string,
): Promise<NodeUpdateResult> {
  const tag = `[${nodeName}]`
  const start = Date.now()

  // Step 1: SSH connectivity check — the node's own sshUser (mesh.json)
  // first, then the global default, then root
  const candidates = [nodeSshUser, opts.sshUser].filter((u): u is string => !!u)
  const sshUser = resolveSshUser(host, candidates, tag)
  if (!sshUser) {
    console.error(
      `    ${tag} ❌ SSH connection failed — cannot reach ${host} as ${candidates.join('/')} or root`,
    )
    return { success: false, failedStep: 'ssh', elapsedMs: Date.now() - start }
  }

  // Step 1.5: install-tree writability — fail before git/npm burn minutes.
  // Local preflight is open as #423; remotes still only discovered foreign-owned
  // /opt/rivetos mid-npm with EACCES. Same class of footgun over SSH.
  const ownership = probeRemoteInstallWritable(host, sshUser, REMOTE_INSTALL_ROOT)
  if (!ownership.ok) {
    return remoteOwnershipFailure(tag, nodeName, sshUser, ownership, start)
  }

  // Step 2: git pull
  try {
    console.log(`    ${tag} Pulling latest code...`)
    const gitCmd = opts.version
      ? `cd /opt/rivetos && git fetch --tags && git checkout ${opts.version}`
      : 'cd /opt/rivetos && git fetch origin && git checkout main && git reset --hard origin/main'
    await sshExec(host, gitCmd, `${tag} git pull`, 30_000, sshUser)
  } catch (err: unknown) {
    console.error(`    ${tag} ❌ git pull failed: ${(err as Error).message}`)
    return { success: false, failedStep: 'git', elapsedMs: Date.now() - start }
  }

  // Non-agent (infrastructure) nodes: code sync, install deps, and restart any
  // rivet-* worker services discovered on the host (embedder, compactor, etc.).
  // No TypeScript build — workers are plain JS.
  if (!isAgent) {
    // npm install — picks up dep bumps in plugins/memory/postgres/workers/*/package.json
    try {
      console.log(`    ${tag} Installing dependencies...`)
      await sshExec(
        host,
        'cd /opt/rivetos && npm install --no-audit --no-fund',
        `${tag} npm install`,
        120_000,
        sshUser,
      )
    } catch (err: unknown) {
      console.error(`    ${tag} ❌ npm install failed: ${(err as Error).message}`)
      return { success: false, failedStep: 'npm', elapsedMs: Date.now() - start }
    }

    const commit = sshExecQuiet(host, 'cd /opt/rivetos && git rev-parse --short HEAD', sshUser)

    // Heal /etc/hosts mesh block on infra nodes too (non-fatal)
    try {
      const hostsCmd =
        sshUser === 'root'
          ? '/opt/rivetos/infra/scripts/setup-mesh-hosts.sh /rivet-shared/mesh.json --quiet'
          : 'sudo /opt/rivetos/infra/scripts/setup-mesh-hosts.sh /rivet-shared/mesh.json --quiet'
      await sshExec(host, hostsCmd, `${tag} mesh-hosts`, 15_000, sshUser)
    } catch (err: unknown) {
      console.log(`    ${tag} ⚠️  /etc/hosts mesh block update skipped: ${(err as Error).message}`)
    }

    // Discover and restart worker services
    const workers = discoverRivetWorkers(host, sshUser)
    const restartedWorkers: string[] = []
    if (workers.length === 0) {
      console.log(`    ${tag} No rivet-* worker services found`)
    } else if (!opts.restart) {
      console.log(`    ${tag} Found workers (skipping restart): ${workers.join(', ')}`)
    } else {
      // Restart every worker, THEN verify — don't abort the loop on the first
      // unit's restart hiccup. A restart that exceeds the SSH timeout usually
      // means the unit is slow to come up, not that it failed (the server-side
      // `systemctl restart` keeps running after our client is killed), so the
      // post-restart `is-active` probe is the source of truth. The old code
      // returned on the first timeout and left later workers (e.g. datahub's
      // rivet-embedder) on stale code.
      for (const unit of workers) {
        console.log(`    ${tag} Restarting ${unit}...`)
        // Workers run as rivet; use sudo for systemctl if not root
        const restartCmd =
          sshUser === 'root' ? `systemctl restart ${unit}` : `sudo systemctl restart ${unit}`
        try {
          await sshExec(host, restartCmd, `${tag} restart ${unit}`, RESTART_TIMEOUT_MS, sshUser)
        } catch (err: unknown) {
          console.warn(
            `    ${tag} ⚠️  restart of ${unit} did not confirm in time (${(err as Error).message}) — will verify is-active`,
          )
        }
      }

      // Verify final state of every worker (source of truth).
      const failedWorkers: string[] = []
      for (const unit of workers) {
        const stateCmd =
          sshUser === 'root' ? `systemctl is-active ${unit}` : `sudo systemctl is-active ${unit}`
        const state = sshExecQuiet(host, stateCmd, sshUser)
        if (state === 'active') {
          restartedWorkers.push(unit)
        } else {
          console.error(
            `    ${tag} ❌ ${unit} not active after restart (state=${state || 'unknown'})`,
          )
          failedWorkers.push(unit)
        }
      }

      if (failedWorkers.length > 0) {
        return {
          success: false,
          failedStep: `worker:${failedWorkers.join(',')}`,
          commit: commit || undefined,
          elapsedMs: Date.now() - start,
          workers: restartedWorkers,
        }
      }
    }

    const workerSummary =
      restartedWorkers.length > 0 ? ` + ${String(restartedWorkers.length)} worker(s) restarted` : ''
    console.log(`    ${tag} ✅ Synced (${commit || 'unknown'})${workerSummary}`)
    return {
      success: true,
      commit: commit || undefined,
      elapsedMs: Date.now() - start,
      workers: restartedWorkers,
    }
  }

  // Step 3: npm install
  try {
    console.log(`    ${tag} Installing dependencies...`)
    await sshExec(
      host,
      'cd /opt/rivetos && npm install --no-audit --no-fund',
      `${tag} npm install`,
      120_000,
      sshUser,
    )
  } catch (err: unknown) {
    console.error(`    ${tag} ❌ npm install failed: ${(err as Error).message}`)
    return { success: false, failedStep: 'npm', elapsedMs: Date.now() - start }
  }

  // Step 4: nx reset + build
  try {
    console.log(`    ${tag} Building...`)
    await sshExec(
      host,
      'cd /opt/rivetos && npx nx reset && npx nx run-many -t build --exclude container-rivetos,site',
      `${tag} build`,
      180_000,
      sshUser,
    )
  } catch (err: unknown) {
    console.error(`    ${tag} ❌ Build failed: ${(err as Error).message}`)
    return { success: false, failedStep: 'build', elapsedMs: Date.now() - start }
  }

  // Step 4.5: heal /etc/hosts mesh block from /rivet-shared/mesh.json
  // Non-fatal — drift in /etc/hosts shouldn't block a deploy.
  try {
    const hostsCmd =
      sshUser === 'root'
        ? '/opt/rivetos/infra/scripts/setup-mesh-hosts.sh /rivet-shared/mesh.json --quiet'
        : 'sudo /opt/rivetos/infra/scripts/setup-mesh-hosts.sh /rivet-shared/mesh.json --quiet'
    await sshExec(host, hostsCmd, `${tag} mesh-hosts`, 15_000, sshUser)
  } catch (err: unknown) {
    console.log(`    ${tag} ⚠️  /etc/hosts mesh block update skipped: ${(err as Error).message}`)
  }

  // Step 5: restart service. G0: retire any standalone rivet-den unit FIRST —
  // the embedded gateway binds the same port on startup.
  if (opts.restart) {
    await retireDenUnitRemote(host, nodeName, sshUser)
    try {
      console.log(`    ${tag} Restarting service...`)
      // Use sudo when logged in as rivet (non-root)
      const restartCmd =
        sshUser === 'root' ? 'systemctl restart rivetos' : 'sudo systemctl restart rivetos'
      await sshExec(host, restartCmd, `${tag} restart`, RESTART_TIMEOUT_MS, sshUser)
    } catch (err: unknown) {
      console.error(`    ${tag} ❌ Restart failed: ${(err as Error).message}`)
      return { success: false, failedStep: 'restart', elapsedMs: Date.now() - start }
    }
  }

  // Get final commit SHA
  const commit = sshExecQuiet(host, 'cd /opt/rivetos && git rev-parse --short HEAD', sshUser)

  // Step 6: validate the node's config against the code we just deployed.
  // An update that invalidates config (renamed provider, removed key) makes
  // the service crash-loop SILENTLY until someone notices the node "offline"
  // — that exact failure hid ct114 for a week. Non-fatal, but loud.
  let configInvalid = false
  if (isAgent) {
    const validateOut = sshExecQuiet(
      host,
      'cd /opt/rivetos && node packages/cli/dist/index.js config validate 2>&1 | tail -2',
      sshUser,
    )
    if (validateOut && !validateOut.includes('Config is valid')) {
      configInvalid = true
      console.error(`    ${tag} 🚨 CONFIG INVALID after update — service will crash-loop:`)
      console.error(`    ${tag}    ${validateOut.split('\n').join(`\n    ${tag}    `)}`)
      console.error(
        `    ${tag}    fix ~/.rivetos/config.yaml on ${nodeName}, then: sudo systemctl restart rivetos`,
      )
    }
  }

  // Step 7: gateway health — the den routes are served by the embedded
  // gateway now; probe /healthz on den-enabled nodes after the restart.
  // Auxiliary: a failed probe never fails the node update, but it is
  // surfaced in the result and the summary table.
  const den = opts.restart ? await verifyGatewayRemote(host, nodeName, sshUser) : 'skipped'

  // Refresh per-user TUI plugin installs from the updated source (hooks,
  // MCP wiring). Non-fatal: nodes without any TUI installs just no-op.
  try {
    await sshExec(
      host,
      'cd /opt/rivetos && npx tsx packages/cli/src/index.ts plugins sync',
      `${tag} plugins sync`,
      60_000,
      sshUser,
    )
  } catch {
    console.warn(`    ${tag} ⚠️  plugins sync failed (non-fatal)`)
  }

  console.log(
    `    ${tag} ✅ Done (${commit || 'unknown'})${configInvalid ? ' — but config INVALID' : ''}`,
  )
  return {
    success: true,
    commit: commit || undefined,
    elapsedMs: Date.now() - start,
    configInvalid: configInvalid || undefined,
    den,
  }
}

/**
 * Update a remote node via `npm install -g @rivetos/cli@<channel>` + restart.
 * No source checkout, no build chain, no git pull. The node consumes whatever
 * was published to the npm registry.
 *
 * Steps:
 *   1. SSH connectivity check
 *   2. npm install -g @rivetos/cli@<channel> (with sudo fallback for global prefix)
 *   3. Restart systemd unit
 *   4. Capture installed version for the summary
 */
export async function npmUpdateNodeAsync(
  host: string,
  nodeName: string,
  opts: UpdateOptions,
  isAgent: boolean = true,
  nodeSshUser?: string,
): Promise<NodeUpdateResult> {
  const tag = `[${nodeName}]`
  const start = Date.now()

  // Step 1: SSH connectivity check
  const candidates = [nodeSshUser, opts.sshUser].filter((u): u is string => !!u)
  const sshUser = resolveSshUser(host, candidates, tag)
  if (!sshUser) {
    console.error(
      `    ${tag} ❌ SSH connection failed — cannot reach ${host} as ${candidates.join('/')} or root`,
    )
    return { success: false, failedStep: 'ssh', elapsedMs: Date.now() - start }
  }

  // Step 2: npm install -g @rivetos/cli@<channel>
  // Try as the SSH user first; if it fails (likely a global prefix owned by
  // another user), fall back to sudo.
  const channelSpec = `@rivetos/cli@${opts.channel}`
  const installCmd = `npm install -g ${channelSpec} --no-audit --no-fund`
  try {
    console.log(`    ${tag} npm install -g ${channelSpec}...`)
    try {
      await sshExec(host, installCmd, `${tag} npm install -g`, 300_000, sshUser)
    } catch {
      // Fall back to sudo
      const sudoCmd = sshUser === 'root' ? installCmd : `sudo ${installCmd}`
      await sshExec(host, sudoCmd, `${tag} npm install -g (sudo)`, 300_000, sshUser)
    }
  } catch (err: unknown) {
    console.error(`    ${tag} ❌ npm install -g failed: ${(err as Error).message}`)
    return { success: false, failedStep: 'npm', elapsedMs: Date.now() - start }
  }

  // Step 3: rewrite systemd unit ExecStart to call the global `rivetos` bin.
  // Idempotent — only rewrites if the current ExecStart still references
  // tsx + /opt/rivetos. Skipped for non-agent (infra-only) nodes.
  if (isAgent) {
    try {
      const sudoPrefix = sshUser === 'root' ? '' : 'sudo '
      // Find the global rivetos binary location
      const rivetosBin = sshExecQuiet(host, 'which rivetos 2>/dev/null || true', sshUser).trim()
      if (rivetosBin) {
        // Rewrite ExecStart in /etc/systemd/system/rivetos.service if it still
        // points at the old npx tsx path. Use a simple sed in place.
        const rewriteCmd =
          `${sudoPrefix}sh -c "if grep -q '^ExecStart=.*npx tsx' /etc/systemd/system/rivetos.service 2>/dev/null; then ` +
          `sed -i 's|^ExecStart=.*|ExecStart=${rivetosBin} start --config %h/.rivetos/config.yaml|' /etc/systemd/system/rivetos.service && ` +
          `systemctl daemon-reload && echo rewrote; ` +
          `else echo skipped; fi"`
        const result = sshExecQuiet(host, rewriteCmd, sshUser).trim()
        if (result.includes('rewrote')) {
          console.log(`    ${tag} Rewrote systemd ExecStart → ${rivetosBin}`)
        }
      } else {
        console.log(`    ${tag} ⚠️  No rivetos bin found in PATH after install — restart may fail`)
      }
    } catch (err: unknown) {
      console.log(`    ${tag} ⚠️  systemd unit rewrite skipped: ${(err as Error).message}`)
    }
  }

  // Step 4: restart systemd unit (skip on non-agent infrastructure nodes —
  // they don't run rivetos itself, only worker services which keep their
  // own deploy path until we migrate them too).
  if (isAgent && opts.restart) {
    await retireDenUnitRemote(host, nodeName, sshUser)
    try {
      console.log(`    ${tag} Restarting service...`)
      const restartCmd =
        sshUser === 'root' ? 'systemctl restart rivetos' : 'sudo systemctl restart rivetos'
      await sshExec(host, restartCmd, `${tag} restart`, RESTART_TIMEOUT_MS, sshUser)
    } catch (err: unknown) {
      console.error(`    ${tag} ❌ Restart failed: ${(err as Error).message}`)
      return { success: false, failedStep: 'restart', elapsedMs: Date.now() - start }
    }
  }

  // Step 5: gateway health — G0 closes the old npm-mode gap: the gateway is
  // embedded in rivetos, so den-enabled npm nodes get it with the package.
  if (isAgent && opts.restart) {
    await verifyGatewayRemote(host, nodeName, sshUser)
  }

  // Step 6: capture installed version (rivetos version → "RivetOS v0.4.0-beta.2")
  const versionOutput = sshExecQuiet(host, 'rivetos version 2>/dev/null || echo unknown', sshUser)
  const versionMatch = versionOutput.match(/v(\S+)/)
  const installedVersion = versionMatch ? versionMatch[1] : 'unknown'
  console.log(`    ${tag} ✅ Done (${installedVersion})`)
  return { success: true, commit: installedVersion, elapsedMs: Date.now() - start }
}

/**
 * Poll a peer until it reports healthy (systemd active via SSH, or the mTLS
 * /api/mesh/ping endpoint), or the timeout elapses.
 */
export async function waitForHealth(
  host: string,
  _port: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  const interval = 3_000

  while (Date.now() < deadline) {
    // Check if the systemd service is active via SSH (bare-metal/Proxmox deployments)
    // Try rivet@ first, then root@ (handles both migrated and legacy nodes)
    for (const user of ['rivet', 'root']) {
      try {
        const svcCheck =
          user === 'root' ? 'systemctl is-active rivetos' : 'sudo systemctl is-active rivetos'
        const result = execSync(
          `ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no ${user}@${host} "${svcCheck}" 2>/dev/null`,
          { timeout: 5_000 },
        )
        if (result.toString().trim() === 'active') return true
        break
      } catch {
        // Not ready yet — try next user
      }
    }

    // Fallback: try HTTPS health endpoint with mTLS
    try {
      const dispatcher = await buildMeshDispatcher()

      if (dispatcher) {
        const res = await fetch(`https://${host}:${String(_port)}/api/mesh/ping`, {
          signal: AbortSignal.timeout(2_000),
          // @ts-expect-error — undici dispatcher not in Node fetch types
          dispatcher,
        })
        if (res.ok) {
          const body = (await res.json().catch(() => ({}))) as { tls?: boolean }
          if (!body.tls) {
            console.warn(`  ⚠️  Node ${host} ping OK but no tls:true — may be running old build`)
          }
          return true
        }
      }
    } catch {
      // Not ready yet
    }

    await new Promise((r) => setTimeout(r, interval))
  }

  return false
}
