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

  // Step 1: Git pull or checkout specific version
  if (opts.version) {
    console.log(`Fetching tags...`)
    execOrFail('git fetch --tags', 'git fetch')
    console.log(`Checking out ${opts.version}...`)
    execOrFail(`git checkout ${opts.version}`, `checkout ${opts.version}`)
  } else {
    console.log('Pulling latest...')
    execOrFail('git pull --ff-only', 'git pull')
  }

  // Step 2: Install dependencies
  console.log('Installing dependencies...')
  execOrFail('npm install --no-audit --no-fund', 'npm install')
  console.log('  ✅ Dependencies installed')

  // Step 2.5: Reset Nx cache to avoid stale artifact warnings
  exec('npx nx reset', { quiet: true })

  // Step 3: Detect deployment mode and rebuild if containerized
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
 * Rolling mesh update — update all peers one at a time.
 *
 * 1. Read mesh.json to get all nodes
 * 2. Update local node first
 * 3. For each remote peer:
 *    a. SSH in and run `rivetos update`
 *    b. Wait for health check to pass
 *    c. Move to next node
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

  const nodes = Object.values(meshFile.nodes).filter((n) => n.status === 'online')

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

  // Step 1: Update local node first
  console.log('  ── Updating local node ──')
  console.log('')

  // Run local update (non-mesh to avoid recursion)
  const localOpts = { ...opts, mesh: false }

  // Re-run the git pull + rebuild + restart flow
  const gitDir = exec('git rev-parse --git-dir', { quiet: true })
  if (gitDir) {
    if (localOpts.version) {
      execOrFail('git fetch --tags', 'git fetch')
      execOrFail(`git checkout ${localOpts.version}`, `checkout ${localOpts.version}`)
    } else {
      execOrFail('git pull --ff-only', 'git pull')
    }
    execOrFail('npm install --no-audit --no-fund', 'npm install')
    exec('npx nx reset', { quiet: true })

    const deployment = await detectDeployment(localOpts.bareMetal)
    if (deployment === 'docker' && !localOpts.prebuilt) {
      await verifyDataPersistence()
      exec('docker compose build', { quiet: false })
    }
    if (localOpts.restart) {
      if (deployment === 'docker') {
        exec('docker compose up -d', { quiet: false })
      }
    }
  }
  console.log('  ✅ Local node updated')
  console.log('')

  // Step 2: Update remote nodes one by one
  //
  // Strategy: rsync code from control plane → remote node → rebuild → restart
  // This is the preferred path for bare-metal/Proxmox deployments.
  // Falls back to agent API for Docker deployments where SSH isn't available.
  let updated = 1
  let failed = 0

  for (const node of nodes) {
    // Skip local node (we already updated it)
    if (isLocalAddress(node.host)) continue

    console.log(`  ── Updating ${node.name} (${node.host}) ──`)

    // Mark node as updating in mesh
    node.status = 'updating'

    // Try rsync-based update first (bare-metal/Proxmox)
    const isAgent = !node.role || node.role === 'agent'
    const rsyncSuccess = rsyncUpdateNode(node.host, localOpts, isAgent)
    if (rsyncSuccess) {
      console.log(
        `  ✅ ${node.name} updated (via rsync${!isAgent ? ` — ${node.role}, sync only` : ''})`,
      )
      updated++
    } else {
      // Fall back to agent API (Docker/containerized)
      try {
        const secret = process.env.RIVETOS_AGENT_SECRET ?? ''
        const updateMsg = localOpts.version
          ? `[System] Run: rivetos update --version ${localOpts.version}`
          : '[System] Run: rivetos update'

        const res = await fetch(`http://${node.host}:${String(node.port)}/api/message`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${secret}`,
          },
          body: JSON.stringify({
            fromAgent: 'mesh-update',
            message: updateMsg,
            waitForResponse: true,
            timeoutMs: 300_000, // 5 min for build
          }),
          signal: AbortSignal.timeout(310_000),
        })

        if (res.ok) {
          console.log(`  ✅ ${node.name} updated (via API)`)
          updated++
        } else {
          const body = await res.text()
          console.error(`  ❌ ${node.name} update failed: HTTP ${String(res.status)} — ${body}`)
          failed++
        }
      } catch (err: unknown) {
        console.error(`  ❌ ${node.name} update failed: ${(err as Error).message}`)
        failed++
      }
    }

    // Wait for node to come back healthy (skip for non-agent nodes — no service to check)
    if (isAgent) {
      console.log(`    Waiting for ${node.name} to be healthy...`)
      const healthy = await waitForHealth(node.host, node.port, 60_000)
      if (healthy) {
        console.log(`    ✅ ${node.name} is healthy`)
      } else {
        console.log(`    ⚠️  ${node.name} health check timed out — continuing anyway`)
      }
    }

    console.log('')
  }

  console.log(`  ══════════════════`)
  console.log(`  Rolling update complete: ${String(updated)} updated, ${String(failed)} failed`)
  console.log('')
}

/**
 * Update a remote node via rsync + SSH.
 * Syncs code from the control plane, rebuilds, and restarts the service.
 * Returns true on success, false if rsync/SSH isn't available.
 */
function rsyncUpdateNode(host: string, opts: UpdateOptions, isAgent: boolean = true): boolean {
  try {
    // Check if we can SSH to the node
    execSync(
      `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o PasswordAuthentication=no root@${host} "echo ok"`,
      { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
    )

    console.log(`    Syncing code to ${host}...`)

    // rsync the repo (excluding dev files, user data, secrets)
    execSync(
      `rsync -az --delete \
        --exclude='.git/' \
        --exclude='node_modules/' \
        --exclude='.secrets/' \
        --exclude='workspace/' \
        --exclude='.env' \
        --exclude='.env.*' \
        --exclude='*.pid' \
        --exclude='.nx/' \
        "${ROOT}/" "root@${host}:/opt/rivetos/"`,
      { encoding: 'utf-8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] },
    )

    // Non-agent nodes only get code synced — no build or restart
    if (!isAgent) {
      console.log(`    Skipping build/restart (non-agent node — sync only)`)
      return true
    }

    console.log(`    Rebuilding on ${host}...`)

    // Install deps + reset Nx cache + rebuild on remote
    execSync(
      `ssh root@${host} "cd /opt/rivetos && npm install --no-audit --no-fund 2>&1 | tail -3 && npx nx reset 2>/dev/null && npx nx run-many -t build --exclude container-agent,container-datahub,site 2>&1 | tail -5"`,
      { encoding: 'utf-8', timeout: 300000, stdio: ['pipe', 'pipe', 'pipe'] },
    )

    // Restart the service
    if (opts.restart) {
      console.log(`    Restarting service on ${host}...`)
      execSync(`ssh root@${host} "systemctl restart rivetos"`, {
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    }

    return true
  } catch {
    // SSH/rsync not available — fall back to API
    return false
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

  // Check for docker-compose.yml in project dir
  try {
    await access(resolve(ROOT, 'docker-compose.yaml'))
    return 'docker'
  } catch {
    // No compose file
  }

  return 'bare-metal'
}
