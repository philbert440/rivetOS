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
import { execSync, spawn } from 'node:child_process'
import { networkInterfaces } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..', '..', '..')

interface UpdateOptions {
  version?: string
  restart: boolean
  prebuilt: boolean
  mesh: boolean
  bareMetal: boolean
}

function parseArgs(): UpdateOptions {
  const args = process.argv.slice(3)
  const opts: UpdateOptions = { restart: true, prebuilt: false, mesh: false, bareMetal: false }

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
  rivetos update — Update RivetOS from source

  Usage:
    rivetos update [options]

  Options:
    --version <tag>    Update to a specific version/tag
    --no-restart       Pull and rebuild only, don't restart
    --prebuilt         Pull pre-built images from GHCR instead of building
    --mesh             Rolling update across all agents
    --bare-metal       Force bare-metal mode (skip all Docker logic)

  What it does:
    1. git pull (or checkout specific version)
    2. npm install
    3. Rebuild container images (if containerized)
    4. Restart services
    5. Run post-update hooks (migrations, etc.)
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

  console.log('  Pulling latest...')
  execOrFail('git pull --ff-only', 'git pull')
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

  execOrThrow('git pull --ff-only', 'git pull')
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
      exec('docker compose build', { quiet: false })
      console.log('  ✅ Containers rebuilt')
    } else {
      console.log('\nPulling pre-built images...')
      exec('docker compose pull', { quiet: false })
      console.log('  ✅ Images pulled')
    }
  } else if (deployment === 'bare-metal') {
    // Build TypeScript for bare-metal deployments
    console.log('\nBuilding...')
    execOrFail(
      'npx nx run-many -t build --exclude container-agent,container-datahub,site',
      'nx build',
    )
    console.log('  ✅ Build complete')
  }

  // Step 4: Restart
  if (opts.restart) {
    if (deployment === 'docker') {
      console.log('\nRestarting containers (data volumes preserved)...')
      exec('docker compose up -d', { quiet: false })
      console.log('  ✅ Containers restarted — workspace & database untouched')
    } else if (deployment === 'manual' || deployment === 'bare-metal') {
      // Bare-metal: restart via systemd or signal
      console.log('\nRestarting service...')
      try {
        execSync('systemctl restart rivetos', { stdio: 'inherit', timeout: 30000 })
        console.log('  ✅ Service restarted')
      } catch {
        console.log(
          '  ⚠️  Could not restart via systemd. Restart manually: rivetos stop && rivetos start',
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

  // Step 0: Pull latest code locally first
  const gitDir = exec('git rev-parse --git-dir', { quiet: true })
  if (gitDir) {
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

  // Step 1: Update ALL remote nodes in parallel
  const remoteNodes = nodes.filter((n) => !isLocalAddress(n.host))
  console.log(`  Updating ${String(remoteNodes.length)} remote node(s) in parallel...`)
  console.log('')

  const results = await Promise.all(
    remoteNodes.map((node) => {
      const isAgent = !node.role || node.role === 'agent'
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
      const status = isAgent ? '✅' : '✅ (sync)'
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

  if (gitDir) {
    try {
      const deployment = await detectDeployment(localOpts.bareMetal)

      // Install + build locally (git pull already done in step 0)
      execOrThrow('npm install --no-audit --no-fund', 'npm install')
      exec('npx nx reset', { quiet: true })

      if (deployment === 'docker') {
        if (!localOpts.prebuilt) {
          await verifyDataPersistence()
          exec('docker compose build', { quiet: false })
        }
        if (localOpts.restart) {
          exec('docker compose up -d', { quiet: false })
        }
      } else if (deployment === 'bare-metal') {
        console.log('    Building...')
        execOrThrow(
          'npx nx run-many -t build --exclude container-agent,container-datahub,site',
          'nx build',
        )
        if (localOpts.restart) {
          console.log('    Restarting service...')
          try {
            execSync('systemctl restart rivetos', {
              encoding: 'utf-8',
              timeout: 30000,
              stdio: ['pipe', 'pipe', 'pipe'],
            })
          } catch {
            console.log('    ⚠️  Could not restart via systemd. Restart manually.')
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
function sshExec(host: string, command: string, label: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=5',
      '-o',
      'StrictHostKeyChecking=no',
      `root@${host}`,
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

  // Step 1: SSH connectivity check
  try {
    execSync(
      `ssh -o ConnectTimeout=5 -o BatchMode=yes -o StrictHostKeyChecking=no root@${host} "echo ok"`,
      { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
    )
  } catch {
    console.error(`    ${tag} ❌ SSH connection failed — cannot reach ${host}`)
    return { success: false, failedStep: 'ssh', elapsedMs: Date.now() - start }
  }

  // Step 2: git pull
  try {
    console.log(`    ${tag} Pulling latest code...`)
    const gitCmd = opts.version
      ? `cd /opt/rivetos && git fetch --tags && git checkout ${opts.version}`
      : 'cd /opt/rivetos && git fetch origin && git checkout main && git pull --ff-only'
    await sshExec(host, gitCmd, `${tag} git pull`, 30_000)
  } catch (err: unknown) {
    console.error(`    ${tag} ❌ git pull failed: ${(err as Error).message}`)
    return { success: false, failedStep: 'git', elapsedMs: Date.now() - start }
  }

  // Non-agent nodes only need code sync — no build or restart
  if (!isAgent) {
    const commit = sshExecQuiet(host, 'cd /opt/rivetos && git rev-parse --short HEAD')
    console.log(`    ${tag} ✅ Synced (${commit || 'unknown'})`)
    return { success: true, commit: commit || undefined, elapsedMs: Date.now() - start }
  }

  // Step 3: npm install
  try {
    console.log(`    ${tag} Installing dependencies...`)
    await sshExec(
      host,
      'cd /opt/rivetos && npm install --no-audit --no-fund',
      `${tag} npm install`,
      120_000,
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
      'cd /opt/rivetos && npx nx reset && npx nx run-many -t build --exclude container-agent,container-datahub,site',
      `${tag} build`,
      180_000,
    )
  } catch (err: unknown) {
    console.error(`    ${tag} ❌ Build failed: ${(err as Error).message}`)
    return { success: false, failedStep: 'build', elapsedMs: Date.now() - start }
  }

  // Step 5: restart service
  if (opts.restart) {
    try {
      console.log(`    ${tag} Restarting service...`)
      await sshExec(host, 'systemctl restart rivetos', `${tag} restart`, 30_000)
    } catch (err: unknown) {
      console.error(`    ${tag} ❌ Restart failed: ${(err as Error).message}`)
      return { success: false, failedStep: 'restart', elapsedMs: Date.now() - start }
    }
  }

  // Get final commit SHA
  const commit = sshExecQuiet(host, 'cd /opt/rivetos && git rev-parse --short HEAD')
  console.log(`    ${tag} ✅ Done (${commit || 'unknown'})`)
  return { success: true, commit: commit || undefined, elapsedMs: Date.now() - start }
}

/**
 * Quick SSH command that returns stdout, or empty string on failure.
 * Used for non-critical checks like getting the commit SHA.
 */
function sshExecQuiet(host: string, command: string): string {
  try {
    return execSync(
      `ssh -o ConnectTimeout=5 -o BatchMode=yes -o StrictHostKeyChecking=no root@${host} "${command}"`,
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
    try {
      // Check if the systemd service is active via SSH (bare-metal/Proxmox deployments)
      const result = execSync(
        `ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no root@${host} "systemctl is-active rivetos" 2>/dev/null`,
        { timeout: 5_000 },
      )
      if (result.toString().trim() === 'active') return true
    } catch {
      // Not ready yet — service still starting or SSH not available
    }

    // Fallback: try HTTP health endpoint (Docker/containerized deployments)
    try {
      const res = await fetch(`http://${host}:${String(_port)}/api/mesh/ping`, {
        signal: AbortSignal.timeout(2_000),
      })
      if (res.ok) return true
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
    '/shared/mesh.json',
    join(ROOT, 'mesh.json'),
    join(process.env.HOME ?? '~', '.rivetos', 'mesh.json'),
  ]

  for (const p of paths) {
    try {
      const raw = await readFile(p, 'utf-8')
      return JSON.parse(raw) as MeshFileForUpdate
    } catch {
      // try next
    }
  }

  return null
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

  // Check for systemd service (bare-metal/Proxmox/VM deployment)
  // This takes priority over docker-compose.yaml which exists in the repo
  // for Docker users but is present on bare-metal installs too.
  try {
    await access('/etc/systemd/system/rivetos.service')
    return 'bare-metal'
  } catch {
    // No systemd service
  }

  // Check for docker-compose.yml in project dir
  try {
    await access(resolve(ROOT, 'docker-compose.yaml'))
    return 'docker'
  } catch {
    // No compose file
  }

  return 'bare-metal'
}
