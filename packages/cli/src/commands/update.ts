/**
 * rivetos update
 *
 * Update RivetOS to latest version from source:
 *
 *   1. Git pull (or fetch + merge for forks)
 *   2. Install dependencies
 *   3. Rebuild container images from source (if containerized deployment)
 *   4. Restart containers
 *   5. Run post-update hooks
 *
 * Options:
 *   --version <tag>    Update to a specific version tag
 *   --no-restart       Pull and rebuild only, don't restart
 *   --prebuilt         Pull pre-built images from registry instead of building
 *   --mesh             Rolling update across all agents in the mesh
 */

import { readFile, access } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import { loadMeshFile } from '../lib/mesh-file.js'
import { restartViaSystemd, assertSafeArg } from '../lib/ssh.js'
import type { UpdateOptions } from './update/types.js'
import { gitUpdateNodeAsync, npmUpdateNodeAsync, waitForHealth } from './update/remote-nodes.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..', '..', '..')

function parseArgs(): UpdateOptions {
  const args = process.argv.slice(3)
  const opts: UpdateOptions = {
    restart: true,
    prebuilt: false,
    mesh: false,
    bareMetal: false,
    sshUser: 'rivet',
    npm: false,
    channel: 'beta',
    includeOffline: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--version' || arg === '-v') {
      opts.version = args[++i]
    } else if (arg === '--no-restart') {
      opts.restart = false
    } else if (arg === '--prebuilt') {
      opts.prebuilt = true
    } else if (arg === '--mesh') {
      opts.mesh = true
    } else if (arg === '--bare-metal') {
      opts.bareMetal = true
    } else if (arg === '--ssh-user' && args[i + 1]) {
      opts.sshUser = args[++i]
    } else if (arg === '--npm') {
      opts.npm = true
    } else if (arg === '--channel' && args[i + 1]) {
      opts.channel = args[++i]
      opts.npm = true
    } else if (arg === '--include-offline') {
      opts.includeOffline = true
    } else if (arg === '--help' || arg === '-h') {
      showHelp()
      process.exit(0)
    }
  }

  if (process.env.RIVETOS_BARE_METAL === '1') {
    opts.bareMetal = true
  }

  // Validate values that get interpolated into git/npm/ssh commands. These flow
  // straight into shell strings (`git checkout <version>`, `npm install -g
  // @rivetos/cli@<channel>`, `<user>@<host>`), so reject anything carrying shell
  // metacharacters before it can break out.
  for (const [label, value] of [
    ['--version', opts.version],
    ['--channel', opts.channel],
    ['--ssh-user', opts.sshUser],
  ] as const) {
    if (value !== undefined) {
      try {
        assertSafeArg(value, label)
      } catch (err: unknown) {
        console.error(`❌ ${(err as Error).message}`)
        process.exit(1)
      }
    }
  }

  return opts
}

function showHelp(): void {
  console.log(`
  rivetos update — Update RivetOS

  Usage:
    rivetos update [options]

  Options:
    --version <tag>    Update to a specific git tag (git mode only)
    --no-restart       Pull/install only, don't restart
    --prebuilt         Pull pre-built images from GHCR instead of building (docker)
    --mesh             Rolling update across all agents
    --bare-metal       Force bare-metal mode (skip all Docker logic)
    --npm              Use npm install -g @rivetos/cli@<channel> instead of git pull
    --channel <tag>    npm dist-tag or version (default: beta) — implies --npm
    --ssh-user <user>  SSH user for remote nodes (default: rivet)
    --include-offline  Obsolete (all nodes are probed over SSH now); accepted as a no-op

  Modes:

    git (default)      git pull + npm ci + nx build + systemctl restart
                       Requires source checkout at /opt/rivetos.

    npm                npm install -g @rivetos/cli@<channel> + systemctl restart
                       No source checkout needed. Picks up published packages
                       from the npm registry. After cutover this will become
                       the default.

  Examples:

    rivetos update --mesh                       # git mode, current default
    rivetos update --mesh --npm                 # npm mode, latest beta
    rivetos update --mesh --channel latest      # npm mode, stable tag
    rivetos update --mesh --channel 0.4.0-beta.2  # pin a specific version

  SSH notes:
    Default SSH user is 'rivet'. Falls back to 'root' automatically if rivet
    auth fails (warns that the node hasn't been migrated yet).
  `)
}

function exec(cmd: string, options?: { quiet?: boolean }): string {
  try {
    return execSync(cmd, {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 300000,
      env: { ...process.env, HOME: process.env.HOME ?? '/root' },
      stdio: options?.quiet ? ['pipe', 'pipe', 'pipe'] : 'inherit',
    }).trim()
  } catch {
    return ''
  }
}

function execOrFail(cmd: string, label: string): string {
  try {
    return execSync(cmd, {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 300000,
      env: { ...process.env, HOME: process.env.HOME ?? '/root' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch (err: unknown) {
    console.error(`❌ ${label} failed: ${(err as Error).message}`)
    process.exit(1)
    throw err // unreachable
  }
}

/**
 * Like execOrFail but throws instead of calling process.exit().
 * Used inside meshRollingUpdate so a local failure doesn't kill
 * the entire mesh update — we can report it and continue to remotes.
 */
function execOrThrow(cmd: string, label: string): string {
  try {
    return execSync(cmd, {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 300000,
      env: { ...process.env, HOME: process.env.HOME ?? '/root' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch (err: unknown) {
    throw new Error(`${label} failed: ${(err as Error).message}`, { cause: err })
  }
}

/**
 * Ensure we are on main branch and up-to-date with origin.
 * If on a feature branch, switches to main first.
 * If a specific version is requested, checks out that tag instead.
 */
function ensureMainBranch(version?: string): void {
  if (version) {
    console.log('  Fetching tags...')
    execOrFail('git fetch --tags', 'git fetch')
    console.log(`  Checking out ${version}...`)
    execOrFail(`git checkout ${version}`, `checkout ${version}`)
    return
  }

  // Fetch latest from origin
  execOrFail('git fetch origin', 'git fetch origin')

  // Check current branch — if not on main, switch to it
  const currentBranch = exec('git branch --show-current', { quiet: true })
  if (currentBranch && currentBranch !== 'main') {
    console.log(`  Currently on branch '${currentBranch}', switching to main...`)
    execOrFail('git checkout main', 'git checkout main')
  }

  console.log('  Resetting to origin/main...')
  execOrFail('git reset --hard origin/main', 'git reset')
}

/**
 * Same as ensureMainBranch but uses execOrThrow (no process.exit).
 * For use inside meshRollingUpdate.
 */
function ensureMainBranchSafe(version?: string): void {
  if (version) {
    execOrThrow('git fetch --tags', 'git fetch')
    execOrThrow(`git checkout ${version}`, `checkout ${version}`)
    return
  }

  execOrThrow('git fetch origin', 'git fetch origin')

  const currentBranch = exec('git branch --show-current', { quiet: true })
  if (currentBranch && currentBranch !== 'main') {
    console.log(`    Currently on branch '${currentBranch}', switching to main...`)
    execOrThrow('git checkout main', 'git checkout main')
  }

  execOrThrow('git reset --hard origin/main', 'git reset')
}

export default async function update(): Promise<void> {
  const opts = parseArgs()

  // Mesh rolling update — update all peers in sequence
  if (opts.mesh) {
    await meshRollingUpdate(opts)
    return
  }

  // Verify git repo
  const gitDir = exec('git rev-parse --git-dir', { quiet: true })
  if (!gitDir) {
    console.error(`Not a git repository: ${ROOT}`)
    process.exit(1)
  }

  // Current state
  const oldPkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf-8')) as {
    version: string
  }
  const oldCommit = exec('git rev-parse --short HEAD', { quiet: true }) || 'unknown'

  console.log('🔩 RivetOS Update')
  console.log(`   Current: v${oldPkg.version} (${oldCommit})`)
  console.log('')

  // Step 1: Ensure on main branch and pull latest (or checkout specific version)
  ensureMainBranch(opts.version)

  // Step 2: Install dependencies
  console.log('Installing dependencies...')
  execOrFail('npm install --no-audit --no-fund', 'npm install')
  console.log('  ✅ Dependencies installed')

  // Step 2.5: Reset Nx cache to avoid stale artifact warnings
  exec('npx nx reset', { quiet: true })

  // Step 3: Detect deployment mode and handle accordingly
  const deployment = await detectDeployment(opts.bareMetal)

  if (deployment === 'docker') {
    // Safety check: verify user data volumes/mounts exist before rebuild
    await verifyDataPersistence()

    if (!opts.prebuilt) {
      console.log('\nRebuilding containers from source...')
      exec('docker compose -f infra/docker/rivetos/docker-compose.yml build', { quiet: false })
      console.log('  ✅ Containers rebuilt')
    } else {
      console.log('\nPulling pre-built images...')
      exec('docker compose -f infra/docker/rivetos/docker-compose.yml pull', { quiet: false })
      console.log('  ✅ Images pulled')
    }
  } else if (deployment === 'bare-metal') {
    // Build TypeScript for bare-metal deployments
    console.log('\nBuilding...')
    execOrFail('npx nx run-many -t build --exclude container-rivetos,site', 'nx build')
    console.log('  ✅ Build complete')
  }

  // Step 4: Restart
  if (opts.restart) {
    if (deployment === 'docker') {
      console.log('\nRestarting containers (data volumes preserved)...')
      exec('docker compose -f infra/docker/rivetos/docker-compose.yml up -d', { quiet: false })
      console.log('  ✅ Containers restarted — workspace & database untouched')
    } else if (deployment === 'manual' || deployment === 'bare-metal') {
      // Bare-metal: restart via systemd or signal
      console.log('\nRestarting service...')
      if (restartViaSystemd()) {
        console.log('  ✅ Service restarted')
      } else {
        console.log(
          '  ⚠️  Could not restart via systemd. Restart manually: sudo systemctl restart rivetos',
        )
      }
    }
  }

  // Step 5: Post-update — report what changed
  const newPkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf-8')) as {
    version: string
  }
  const newCommit = exec('git rev-parse --short HEAD', { quiet: true }) || 'unknown'

  console.log('')
  if (oldPkg.version !== newPkg.version) {
    console.log(`  Version: v${oldPkg.version} → v${newPkg.version}`)
  }
  if (oldCommit !== newCommit) {
    console.log('  Recent commits:')
    const log = exec('git log --oneline -5', { quiet: true })
    if (log) {
      for (const line of log.split('\n')) {
        console.log(`    ${line}`)
      }
    }
  } else {
    console.log('  Already up to date.')
  }

  console.log(`\n✅ RivetOS v${newPkg.version} (${newCommit})`)
}

/**
 * Verify that user data (workspace, config, database) is stored outside the
 * container via bind mounts or named volumes.  If we detect the workspace is
 * ONLY inside the container (no bind mount), warn before rebuild would wipe it.
 */
async function verifyDataPersistence(): Promise<void> {
  console.log('\n  Checking data persistence...')

  // Check workspace bind mount exists on host
  const workspacePath = resolve(ROOT, 'workspace')
  try {
    await access(workspacePath)
    console.log('  ✅ Workspace directory on host: ./workspace/')
  } catch {
    // No workspace dir on host — check if we should create it
    console.log('  ⚠️  No ./workspace/ directory found on host.')
    console.log('     Creating default workspace to preserve agent data across updates...')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(resolve(workspacePath, 'memory'), { recursive: true })
    mkdirSync(resolve(workspacePath, 'skills'), { recursive: true })
    console.log('  ✅ Created ./workspace/ (bind mount target)')
  }

  // Check Docker named volumes exist (pgdata, shared) — only for Docker deployments
  const deployType = await detectDeployment(
    process.env.RIVETOS_BARE_METAL === '1' || process.argv.includes('--bare-metal'),
  )
  if (deployType === 'docker') {
    const volumes = exec('docker volume ls --format "{{.Name}}"', { quiet: true })
    const volumeList = volumes.split('\n').filter(Boolean)

    if (volumeList.includes('rivetos-pgdata')) {
      console.log('  ✅ Database volume: rivetos-pgdata')
    } else {
      console.log('  ℹ️  Database volume will be created on first start')
    }

    if (volumeList.includes('rivetos-shared')) {
      console.log('  ✅ Shared volume: rivetos-shared')
    } else {
      console.log('  ℹ️  Shared volume will be created on first start')
    }
  }

  // Check for workspace files that would indicate an active install
  try {
    const files = await import('node:fs/promises').then((fs) => fs.readdir(workspacePath))
    const important = files.filter(
      (f) =>
        ['CORE.md', 'USER.md', 'MEMORY.md', 'WORKSPACE.md'].includes(f) ||
        f === 'memory' ||
        f === 'skills',
    )
    if (important.length > 0) {
      console.log(`  ✅ Found ${important.length} workspace items (will be preserved)`)
    }
  } catch {
    // Fresh install, nothing to check
  }
}

/**
 * Rolling mesh update — all remotes in parallel, local last.
 *
 * 1. Read mesh.json to get all nodes
 * 2. Pull latest code locally (git pull)
 * 3. Update all remote nodes in parallel (git pull + build + restart)
 * 4. Print summary table
 * 5. Update local node last (restart kills the process)
 */
async function meshRollingUpdate(opts: UpdateOptions): Promise<void> {
  console.log('🔩 RivetOS Mesh Rolling Update')
  console.log('')

  // Load mesh.json
  const meshFile = await loadMeshFile(ROOT)
  if (!meshFile) {
    console.error('  No mesh.json found. Run `rivetos mesh join` first or enable mesh in config.')
    process.exit(1)
  }

  // Probe EVERY node — roster status is not reachability. A node whose
  // service is crash-looping heartbeats nothing and shows 'offline' in the
  // roster while its host is perfectly reachable, and pushing the update is
  // often exactly what fixes it (ct114, 2026-07-04: config invalidated by a
  // provider rename crash-looped for days as roster-'offline'). The per-node
  // SSH check is the real gate; genuinely dead hosts fail fast there.
  const nodes = Object.values(meshFile.nodes)
  const rosterOffline = nodes.filter(
    (n) => n.status !== 'online' && (!n.role || n.role === 'agent'),
  )
  if (rosterOffline.length > 0) {
    const names = rosterOffline.map((n) => n.name).join(', ')
    console.log(
      `  ℹ️  Roster marks ${String(rosterOffline.length)} node(s) offline (${names}) — probing them anyway; SSH decides.`,
    )
    console.log('')
  }

  if (nodes.length === 0) {
    console.error('  No reachable nodes in the mesh.')
    process.exit(1)
  }

  const agentNodes = nodes.filter((n) => !n.role || n.role === 'agent')
  const nonAgentNodes = nodes.filter((n) => n.role && n.role !== 'agent')

  console.log(`  Found ${String(nodes.length)} online node(s):`)
  for (const node of agentNodes) {
    console.log(`    • ${node.name} (${node.host}:${String(node.port)})`)
  }
  for (const node of nonAgentNodes) {
    console.log(`    • ${node.name} (${node.host}) [${node.role} — sync only]`)
  }
  console.log('')

  const localOpts = { ...opts, mesh: false }
  const gitDir = exec('git rev-parse --git-dir', { quiet: true })

  // Step 0: Pull latest code locally first (git mode only)
  if (!opts.npm && gitDir) {
    try {
      console.log('  Pulling latest code locally...')
      ensureMainBranchSafe(localOpts.version)
      console.log('  ✅ Code updated locally')
      console.log('')
    } catch (err: unknown) {
      console.error(`  ❌ Local git pull failed: ${(err as Error).message}`)
      console.error('  Aborting.')
      process.exit(1)
    }
  }

  if (opts.npm) {
    console.log(`  Mode: npm install -g @rivetos/cli@${opts.channel}`)
    console.log('')
  }

  // Step 1: Update ALL remote nodes in parallel
  const remoteNodes = nodes.filter((n) => !isLocalAddress(n.host))
  console.log(`  Updating ${String(remoteNodes.length)} remote node(s) in parallel...`)
  console.log('')

  const results = await Promise.all(
    remoteNodes.map((node) => {
      const isAgent = !node.role || node.role === 'agent'
      if (opts.npm) {
        // npm mode: agents take the npm path, infrastructure nodes still use
        // git pull for now (their workers — embedder, compactor — aren't yet
        // packaged for npm install). Migrate them in a follow-up.
        return isAgent
          ? npmUpdateNodeAsync(node.host, node.name, localOpts, true, node.sshUser)
          : gitUpdateNodeAsync(node.host, node.name, localOpts, false, node.sshUser)
      }
      return gitUpdateNodeAsync(node.host, node.name, localOpts, isAgent, node.sshUser)
    }),
  )

  // Step 2: Wait for health on agent nodes that succeeded
  const healthPromises: Promise<void>[] = []
  for (let i = 0; i < remoteNodes.length; i++) {
    const node = remoteNodes[i]
    const result = results[i]
    const isAgent = !node.role || node.role === 'agent'
    if (result.success && isAgent) {
      healthPromises.push(
        waitForHealth(node.host, node.port, 60_000).then((healthy) => {
          if (healthy) {
            console.log(`    ✅ ${node.name} is healthy`)
          } else {
            console.log(`    ⚠️  ${node.name} health check timed out`)
          }
        }),
      )
    }
  }
  if (healthPromises.length > 0) {
    console.log('  Waiting for health checks...')
    await Promise.all(healthPromises)
    console.log('')
  }

  // Step 3: Print summary table
  let updated = 0
  let failedCount = 0

  console.log('  ══════════════════════════════════════════════')
  console.log('  Node          Status          Commit    Time')
  console.log('  ──────────────────────────────────────────────')
  for (let i = 0; i < remoteNodes.length; i++) {
    const node = remoteNodes[i]
    const result = results[i]
    const isAgent = !node.role || node.role === 'agent'
    const name = node.name.padEnd(14)
    const elapsed = `${String(Math.round(result.elapsedMs / 1000))}s`

    if (result.success) {
      let status: string
      if (isAgent) {
        status = result.configInvalid ? '✅ ⚠cfg' : '✅'
      } else if (result.workers && result.workers.length > 0) {
        status = `✅ (sync+${String(result.workers.length)}w)`
      } else {
        status = '✅ (sync)'
      }
      console.log(`  ${name}${status.padEnd(16)}${(result.commit ?? '—').padEnd(10)}${elapsed}`)
      updated++
    } else {
      const status = `❌ ${result.failedStep ?? 'unknown'}`
      console.log(`  ${name}${status.padEnd(16)}${'—'.padEnd(10)}${elapsed}`)
      failedCount++
    }
  }
  console.log('  ══════════════════════════════════════════════')
  console.log(`  Remote: ${String(updated)} updated, ${String(failedCount)} failed`)
  const cfgBad = results.filter((r) => r.configInvalid)
  if (cfgBad.length > 0) {
    console.log(
      `  🚨 ${String(cfgBad.length)} node(s) have an INVALID config after this update — they will crash-loop until fixed (see per-node output above).`,
    )
  }
  console.log('')

  // Step 4: Update local node last — restart kills the process
  console.log('  ── Updating local node (this will restart the process) ──')
  console.log('')

  if (opts.npm) {
    // npm install -g locally + restart
    try {
      console.log(`    npm install -g @rivetos/cli@${opts.channel}...`)
      const installCmd = `npm install -g @rivetos/cli@${opts.channel} --no-audit --no-fund`
      try {
        execSync(installCmd, { stdio: 'inherit', timeout: 300_000 })
      } catch {
        execSync(`sudo ${installCmd}`, { stdio: 'inherit', timeout: 300_000 })
      }

      // Rewrite systemd ExecStart (idempotent — only if it still points at npx tsx)
      try {
        const rivetosBin = execSync('which rivetos 2>/dev/null || true', {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim()
        if (rivetosBin) {
          execSync(
            `sudo sh -c "if grep -q '^ExecStart=.*npx tsx' /etc/systemd/system/rivetos.service 2>/dev/null; then ` +
              `sed -i 's|^ExecStart=.*|ExecStart=${rivetosBin} start --config %h/.rivetos/config.yaml|' /etc/systemd/system/rivetos.service && ` +
              `systemctl daemon-reload; fi"`,
            { stdio: 'pipe', timeout: 15_000 },
          )
        }
      } catch {
        // non-fatal
      }

      if (localOpts.restart && !restartViaSystemd()) {
        console.log(
          '    ⚠️  Could not restart via systemd. Restart manually: sudo systemctl restart rivetos',
        )
      }
      console.log('  ✅ Local node updated')
    } catch (err: unknown) {
      console.error(`  ❌ Local node update failed: ${(err as Error).message}`)
    }
    console.log('')
    return
  }

  if (gitDir) {
    try {
      const deployment = await detectDeployment(localOpts.bareMetal)

      // Install + build locally (git pull already done in step 0)
      execOrThrow('npm install --no-audit --no-fund', 'npm install')
      exec('npx nx reset', { quiet: true })

      if (deployment === 'docker') {
        const composeFlags = '-f infra/docker/rivetos/docker-compose.yml'
        if (!localOpts.prebuilt) {
          await verifyDataPersistence()
          exec(`docker compose ${composeFlags} build`, { quiet: false })
        }
        if (localOpts.restart) {
          exec(`docker compose ${composeFlags} up -d`, { quiet: false })
        }
      } else if (deployment === 'bare-metal') {
        console.log('    Building...')
        execOrThrow('npx nx run-many -t build --exclude container-rivetos,site', 'nx build')

        // Heal /etc/hosts mesh block from mesh.json (non-fatal)
        try {
          const hostsScript = resolve(ROOT, 'infra/scripts/setup-mesh-hosts.sh')
          execSync(`sudo ${hostsScript} /rivet-shared/mesh.json --quiet`, {
            stdio: 'pipe',
            timeout: 15_000,
          })
        } catch {
          // Silent — drift in /etc/hosts shouldn't block local update
        }

        if (localOpts.restart) {
          console.log('    Restarting service...')
          if (!restartViaSystemd()) {
            console.log(
              '    ⚠️  Could not restart via systemd. Restart manually: sudo systemctl restart rivetos',
            )
          }
        }
      }

      console.log('  ✅ Local node updated')
    } catch (err: unknown) {
      console.error(`  ❌ Local node update failed: ${(err as Error).message}`)
    }
  } else {
    console.log('  ⚠️  No git repo found locally — skipping local update')
  }
  console.log('')
}

function isLocalAddress(host: string): boolean {
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return true

  // Check against local IPs
  try {
    const interfaces = networkInterfaces()
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] ?? []) {
        if (iface.address === host) return true
      }
    }
  } catch {
    // ignore
  }

  return false
}

async function detectDeployment(forceBareMetal = false): Promise<string> {
  if (forceBareMetal) {
    return 'bare-metal'
  }

  // Check for rivet.config.yaml deployment section
  const configPath = resolve(process.env.HOME ?? '.', '.rivetos', 'config.yaml')
  try {
    const { parse: parseYaml } = await import('yaml')
    const raw = await readFile(configPath, 'utf-8')
    const config = parseYaml(raw) as { deployment?: { target?: string } }
    if (config.deployment?.target) {
      return config.deployment.target
    }
  } catch {
    // No config or parse error
  }

  // Check for systemd service (bare-metal/Proxmox/VM deployment).
  // Takes priority over the in-repo Compose file, which is present on
  // bare-metal installs too.
  try {
    await access('/etc/systemd/system/rivetos.service')
    return 'bare-metal'
  } catch {
    // No systemd service
  }

  // Check for the unified Compose stack in the repo
  try {
    await access(resolve(ROOT, 'infra/docker/rivetos/docker-compose.yml'))
    return 'docker'
  } catch {
    // No compose file
  }

  return 'bare-metal'
}
