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
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync, spawn } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import { parse as parseYaml } from 'yaml'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..', '..', '..')

/**
 * Resolve this node's name (the CN on its mTLS client cert).
 * Prefers RIVETOS_NODE_NAME, then `node_name` from `~/.rivetos/config.yaml`.
 * Returns null if neither is available.
 */
function resolveLocalNodeName(): string | null {
  if (process.env.RIVETOS_NODE_NAME) return process.env.RIVETOS_NODE_NAME
  try {
    const configPath = resolve(process.env.HOME ?? '.', '.rivetos', 'config.yaml')
    const raw = readFileSync(configPath, 'utf-8')
    const config = parseYaml(raw) as { node_name?: string; mesh?: { node_name?: string } } | null
    if (config?.mesh?.node_name) return config.mesh.node_name
    if (config?.node_name) return config.node_name
  } catch {
    // ignore
  }
  return null
}

interface UpdateOptions {
  version?: string
  restart: boolean
  prebuilt: boolean
  mesh: boolean
  bareMetal: boolean
  sshUser: string
  /** Use npm install -g @rivetos/cli@<channel> instead of git pull */
  npm: boolean
  /** npm dist-tag or version specifier — defaults to "beta" */
  channel: string
}

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
    } else if (arg === '--help' || arg === '-h') {
      showHelp()
      process.exit(0)
    }
  }

  if (process.env.RIVETOS_BARE_METAL === '1') {
    opts.bareMetal = true
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
      try {
        // Try direct systemctl first (running as root), then sudo (running as rivet)
        let restarted = false
        for (const cmd of ['systemctl restart rivetos', 'sudo systemctl restart rivetos']) {
          try {
            execSync(cmd, { stdio: 'inherit', timeout: 30000 })
            restarted = true
            break
          } catch {
            // try next
          }
        }
        if (restarted) {
          console.log('  ✅ Service restarted')
        } else {
          throw new Error('both systemctl and sudo systemctl failed')
        }
      } catch {
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
  const meshFile = await loadMeshFileForUpdate()
  if (!meshFile) {
    console.error('  No mesh.json found. Run `rivetos mesh join` first or enable mesh in config.')
    process.exit(1)
  }

  // Include online agent nodes + all infrastructure nodes (they don't heartbeat,
  // so their status is always 'offline' — but we still want to sync code to them)
  const nodes = Object.values(meshFile.nodes).filter(
    (n) => n.status === 'online' || (n.role && n.role !== 'agent'),
  )

  if (nodes.length === 0) {
    console.error('  No online nodes in the mesh.')
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
          ? npmUpdateNodeAsync(node.host, node.name, localOpts, true)
          : gitUpdateNodeAsync(node.host, node.name, localOpts, false)
      }
      return gitUpdateNodeAsync(node.host, node.name, localOpts, isAgent)
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
        status = '✅'
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

      if (localOpts.restart) {
        console.log('    Restarting service...')
        let restarted = false
        for (const cmd of ['systemctl restart rivetos', 'sudo systemctl restart rivetos']) {
          try {
            execSync(cmd, { encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] })
            restarted = true
            break
          } catch {
            // try next
          }
        }
        if (!restarted) {
          console.log(
            '    ⚠️  Could not restart via systemd. Restart manually: sudo systemctl restart rivetos',
          )
        }
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
          let restarted = false
          for (const cmd of ['systemctl restart rivetos', 'sudo systemctl restart rivetos']) {
            try {
              execSync(cmd, {
                encoding: 'utf-8',
                timeout: 30000,
                stdio: ['pipe', 'pipe', 'pipe'],
              })
              restarted = true
              break
            } catch {
              // try next
            }
          }
          if (!restarted) {
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

/**
 * Run a command on a remote host via SSH using spawn (non-blocking, streamed output).
 * Resolves on exit code 0, rejects on non-zero exit or timeout.
 */
function sshExec(
  host: string,
  command: string,
  label: string,
  timeoutMs: number,
  sshUser = 'rivet',
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=5',
      '-o',
      'StrictHostKeyChecking=no',
      `${sshUser}@${host}`,
      command,
    ]

    const proc = spawn('ssh', args, {
      stdio: 'inherit',
      env: { ...process.env, HOME: process.env.HOME ?? '/root' },
    })

    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`${label} timed out after ${String(Math.round(timeoutMs / 1000))}s`))
    }, timeoutMs)

    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`${label} spawn error: ${err.message}`))
    })

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`${label} exited with code ${String(code)}`))
      }
    })
  })
}

interface NodeUpdateResult {
  success: boolean
  commit?: string
  failedStep?: string
  elapsedMs: number
  workers?: string[]
}

/**
 * Discover rivet-* systemd worker services on a remote host, excluding the
 * primary rivetos.service. Returns an array of unit names (e.g.
 * ["rivet-embedder.service", "rivet-compactor.service"]). On failure, returns [].
 */
function discoverRivetWorkers(host: string, sshUser = 'rivet'): string[] {
  const out = sshExecQuiet(
    host,
    "systemctl list-unit-files 'rivet-*.service' --no-legend --no-pager 2>/dev/null | awk '{print \\$1}'",
    sshUser,
  )
  if (!out) return []
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== 'rivetos.service')
}

/**
 * Resolve the SSH user for a remote host.
 * Tries the requested user first; if auth fails falls back to 'root' with a warning.
 * Returns the user that actually worked, or null if both fail.
 */
function resolveSshUser(host: string, requestedUser: string, tag: string): string | null {
  // Try requested user
  try {
    execSync(
      `ssh -o ConnectTimeout=5 -o BatchMode=yes -o StrictHostKeyChecking=no ${requestedUser}@${host} "echo ok"`,
      { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    return requestedUser
  } catch {
    // fall through to fallback
  }

  if (requestedUser !== 'root') {
    // Fall back to root with warning (node not yet migrated)
    try {
      execSync(
        `ssh -o ConnectTimeout=5 -o BatchMode=yes -o StrictHostKeyChecking=no root@${host} "echo ok"`,
        { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
      )
      console.error(
        `    ${tag} [warn] node not yet migrated to ${requestedUser} user, falling back to root`,
      )
      return 'root'
    } catch {
      // fall through
    }
  }

  return null
}

/**
 * Update a remote node via git pull + SSH.
 * Each step logs progress with [nodeName] prefix and has its own timeout.
 * Returns a result object with success/failure details for the summary table.
 */
async function gitUpdateNodeAsync(
  host: string,
  nodeName: string,
  opts: UpdateOptions,
  isAgent: boolean = true,
): Promise<NodeUpdateResult> {
  const tag = `[${nodeName}]`
  const start = Date.now()

  // Step 1: SSH connectivity check — auto-detect user with fallback
  const sshUser = resolveSshUser(host, opts.sshUser, tag)
  if (!sshUser) {
    console.error(
      `    ${tag} ❌ SSH connection failed — cannot reach ${host} as ${opts.sshUser} or root`,
    )
    return { success: false, failedStep: 'ssh', elapsedMs: Date.now() - start }
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
      for (const unit of workers) {
        try {
          console.log(`    ${tag} Restarting ${unit}...`)
          // Workers run as rivet; use sudo for systemctl if not root
          const restartCmd =
            sshUser === 'root' ? `systemctl restart ${unit}` : `sudo systemctl restart ${unit}`
          await sshExec(host, restartCmd, `${tag} restart ${unit}`, 30_000, sshUser)
          // Verify it came back active
          const stateCmd =
            sshUser === 'root' ? `systemctl is-active ${unit}` : `sudo systemctl is-active ${unit}`
          const state = sshExecQuiet(host, stateCmd, sshUser)
          if (state === 'active') {
            restartedWorkers.push(unit)
          } else {
            console.error(`    ${tag} ⚠️  ${unit} is not active after restart (state=${state})`)
            return {
              success: false,
              failedStep: `worker:${unit}`,
              commit: commit || undefined,
              elapsedMs: Date.now() - start,
              workers: restartedWorkers,
            }
          }
        } catch (err: unknown) {
          console.error(`    ${tag} ❌ Restart of ${unit} failed: ${(err as Error).message}`)
          return {
            success: false,
            failedStep: `worker:${unit}`,
            commit: commit || undefined,
            elapsedMs: Date.now() - start,
            workers: restartedWorkers,
          }
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

  // Step 5: restart service
  if (opts.restart) {
    try {
      console.log(`    ${tag} Restarting service...`)
      // Use sudo when logged in as rivet (non-root)
      const restartCmd =
        sshUser === 'root' ? 'systemctl restart rivetos' : 'sudo systemctl restart rivetos'
      await sshExec(host, restartCmd, `${tag} restart`, 30_000, sshUser)
    } catch (err: unknown) {
      console.error(`    ${tag} ❌ Restart failed: ${(err as Error).message}`)
      return { success: false, failedStep: 'restart', elapsedMs: Date.now() - start }
    }
  }

  // Get final commit SHA
  const commit = sshExecQuiet(host, 'cd /opt/rivetos && git rev-parse --short HEAD', sshUser)
  console.log(`    ${tag} ✅ Done (${commit || 'unknown'})`)
  return { success: true, commit: commit || undefined, elapsedMs: Date.now() - start }
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
async function npmUpdateNodeAsync(
  host: string,
  nodeName: string,
  opts: UpdateOptions,
  isAgent: boolean = true,
): Promise<NodeUpdateResult> {
  const tag = `[${nodeName}]`
  const start = Date.now()

  // Step 1: SSH connectivity check
  const sshUser = resolveSshUser(host, opts.sshUser, tag)
  if (!sshUser) {
    console.error(
      `    ${tag} ❌ SSH connection failed — cannot reach ${host} as ${opts.sshUser} or root`,
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
    try {
      console.log(`    ${tag} Restarting service...`)
      const restartCmd =
        sshUser === 'root' ? 'systemctl restart rivetos' : 'sudo systemctl restart rivetos'
      await sshExec(host, restartCmd, `${tag} restart`, 30_000, sshUser)
    } catch (err: unknown) {
      console.error(`    ${tag} ❌ Restart failed: ${(err as Error).message}`)
      return { success: false, failedStep: 'restart', elapsedMs: Date.now() - start }
    }
  }

  // Step 5: capture installed version (rivetos version → "RivetOS v0.4.0-beta.2")
  const versionOutput = sshExecQuiet(host, 'rivetos version 2>/dev/null || echo unknown', sshUser)
  const versionMatch = versionOutput.match(/v(\S+)/)
  const installedVersion = versionMatch ? versionMatch[1] : 'unknown'
  console.log(`    ${tag} ✅ Done (${installedVersion})`)
  return { success: true, commit: installedVersion, elapsedMs: Date.now() - start }
}

/**
 * Quick SSH command that returns stdout, or empty string on failure.
 * Used for non-critical checks like getting the commit SHA.
 */
function sshExecQuiet(host: string, command: string, sshUser = 'rivet'): string {
  try {
    return execSync(
      `ssh -o ConnectTimeout=5 -o BatchMode=yes -o StrictHostKeyChecking=no ${sshUser}@${host} "${command}"`,
      { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim()
  } catch {
    return ''
  }
}

async function waitForHealth(host: string, _port: number, timeoutMs: number): Promise<boolean> {
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
      const { Agent: UndiciAgent } = await import('undici')
      const nodeName = resolveLocalNodeName()
      const caPath = '/rivet-shared/rivet-ca/intermediate/ca-chain.pem'
      const certPath =
        process.env.RIVETOS_TLS_CERT ??
        (nodeName ? `/rivet-shared/rivet-ca/issued/${nodeName}.crt` : null)
      const keyPath =
        process.env.RIVETOS_TLS_KEY ??
        (nodeName ? `/rivet-shared/rivet-ca/issued/${nodeName}.key` : null)

      let dispatcher: unknown
      if (certPath && keyPath) {
        try {
          const ca = readFileSync(caPath)
          const cert = readFileSync(certPath)
          const key = readFileSync(keyPath)
          dispatcher = new UndiciAgent({ connect: { ca, cert, key, rejectUnauthorized: true } })
        } catch {
          // TLS certs not available — skip HTTPS check
        }
      }

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

interface MeshFileForUpdate {
  version: number
  nodes: Record<
    string,
    { id: string; name: string; host: string; port: number; status: string; role?: string }
  >
  updatedAt: number
}

async function loadMeshFileForUpdate(): Promise<MeshFileForUpdate | null> {
  const { join } = await import('node:path')
  const paths = [
    '/rivet-shared/mesh.json',
    join(ROOT, 'mesh.json'),
    join(process.env.HOME ?? '~', '.rivetos', 'mesh.json'),
  ]

  for (const p of paths) {
    try {
      const raw = await readFile(p, 'utf-8')
      const parsed = JSON.parse(raw) as MeshFileForUpdate | LegacyMeshFile
      return normalizeMeshFile(parsed)
    } catch {
      // try next
    }
  }

  return null
}

/** Legacy mesh.json format — flat array with `ip` instead of `host` */
interface LegacyMeshFile {
  nodes: Array<{ name: string; ip: string; role?: string }>
  updatedAt?: number
}

/** Normalize legacy array-based mesh.json to the Record-based format */
function normalizeMeshFile(parsed: MeshFileForUpdate | LegacyMeshFile): MeshFileForUpdate {
  // Already in the correct format (nodes is a Record, not an Array)
  if (!Array.isArray(parsed.nodes)) {
    return parsed as MeshFileForUpdate
  }

  // Migrate legacy array format
  const nodes: MeshFileForUpdate['nodes'] = {}
  for (const entry of parsed.nodes) {
    const host =
      'ip' in entry ? (entry as { ip: string }).ip : ((entry as { host?: string }).host ?? '')
    const id = entry.name
    nodes[id] = {
      id,
      name: entry.name,
      host,
      port: 3100,
      status: 'offline',
      role: entry.role === 'primary' ? 'agent' : entry.role,
    }
  }

  return {
    version: 1,
    nodes,
    updatedAt: parsed.updatedAt ?? Date.now(),
  }
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
