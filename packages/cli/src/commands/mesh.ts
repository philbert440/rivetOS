/**
 * rivetos mesh — multi-agent mesh management commands.
 *
 * Usage:
 *   rivetos mesh list              List all known mesh nodes
 *   rivetos mesh ping              Health-check all mesh peers
 *   rivetos mesh join <host>       Join an existing mesh
 *   rivetos mesh status            Show local node mesh status
 *
 * The mesh tracks all RivetOS instances on the network, enabling
 * cross-instance delegation and coordinated updates.
 */

import { execSync } from 'node:child_process'
import { networkInterfaces } from 'node:os'

const HELP = `
  rivetos mesh — Multi-agent mesh management

  Commands:
    rivetos mesh list              List all known mesh nodes
    rivetos mesh ping              Health-check all mesh peers
    rivetos mesh join <host>       Join an existing mesh via seed node
    rivetos mesh status            Show this node's mesh status

  Options:
    --json                         Output as JSON
    --timeout <ms>                 Ping timeout per node (default: 5000)
`

export default async function mesh(): Promise<void> {
  const args = process.argv.slice(3)
  const subcommand = args[0]
  const flags = parseFlags(args.slice(1))

  switch (subcommand) {
    case 'list':
      await meshList(flags)
      break
    case 'ping':
      await meshPing(flags)
      break
    case 'join':
      await meshJoin(args[1], flags)
      break
    case 'status':
      await meshStatus(flags)
      break
    default:
      console.log(HELP)
  }
}

// ---------------------------------------------------------------------------
// mesh list — show all known nodes
// ---------------------------------------------------------------------------

async function meshList(flags: Flags): Promise<void> {
  const meshFile = await loadMeshFile()
  if (!meshFile) {
    console.log('  No mesh.json found. This node is not part of a mesh.')
    console.log('  Run "rivetos mesh join <host>" to join an existing mesh,')
    console.log('  or enable mesh in rivet.config.yaml.')
    return
  }

  const nodes = Object.values(meshFile.nodes)

  if (flags.json) {
    console.log(JSON.stringify(nodes, null, 2))
    return
  }

  if (nodes.length === 0) {
    console.log('  No nodes registered in the mesh.')
    return
  }

  console.log('')
  console.log('  Mesh Nodes')
  console.log('  ──────────')
  console.log('')

  for (const node of nodes) {
    const statusIcon = statusEmoji(node.status)
    const age = node.lastSeen ? timeSince(node.lastSeen) : 'unknown'
    const agents = node.agents?.join(', ')
    const role = node.role && node.role !== 'agent' ? ` [${node.role}]` : ''
    console.log(`  ${statusIcon} ${node.name}${role}`)
    console.log(`    ID:        ${node.id}`)
    console.log(`    Host:      ${node.host}:${String(node.port)}`)
    console.log(`    Role:      ${node.role ?? 'agent'}`)
    console.log(`    Status:    ${node.status}`)
    if (agents) console.log(`    Agents:    ${agents}`)
    if (node.providers?.length) console.log(`    Providers: ${node.providers.join(', ')}`)
    if (node.models?.length) console.log(`    Models:    ${node.models.join(', ')}`)
    console.log(`    Last seen: ${age}`)
    if (node.version) console.log(`    Version:   ${node.version}`)
    console.log('')
  }

  const agentCount = nodes.filter((n) => !n.role || n.role === 'agent').length
  const otherCount = nodes.length - agentCount
  const summary = otherCount > 0
    ? `${String(nodes.length)} node(s) — ${String(agentCount)} agent, ${String(otherCount)} non-agent`
    : `${String(nodes.length)} node(s)`
  console.log(`  Total: ${summary}`)
  console.log('')
}

// ---------------------------------------------------------------------------
// mesh ping — health-check all peers
// ---------------------------------------------------------------------------

async function meshPing(flags: Flags): Promise<void> {
  const meshFile = await loadMeshFile()
  if (!meshFile) {
    console.log('  No mesh.json found. Not part of a mesh.')
    return
  }

  const nodes = Object.values(meshFile.nodes)
  const timeoutMs = flags.timeout ?? 5000
  const results: PingResult[] = []

  console.log('')
  console.log('  Pinging mesh nodes...')
  console.log('')

  for (const node of nodes) {
    const isAgent = !node.role || node.role === 'agent'

    if (!isAgent) {
      // Non-agent nodes: SSH ping instead of HTTP (no RivetOS service running)
      const start = Date.now()
      try {
        execSync(
          `ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no -o PasswordAuthentication=no root@${node.host} "echo ok"`,
          { encoding: 'utf-8', timeout: timeoutMs, stdio: ['pipe', 'pipe', 'pipe'] },
        )
        const latency = Date.now() - start
        results.push({ node, status: 'ok', latencyMs: latency })
        console.log(`  ✅ ${node.name} [${node.role}] (${node.host}) — ${String(latency)}ms (SSH)`)
      } catch {
        const latency = Date.now() - start
        results.push({ node, status: 'error', latencyMs: latency, error: 'SSH unreachable' })
        console.log(`  ❌ ${node.name} [${node.role}] (${node.host}) — SSH unreachable`)
      }
      continue
    }

    const start = Date.now()
    try {
      const res = await fetch(`http://${node.host}:${String(node.port)}/api/mesh/ping`, {
        signal: AbortSignal.timeout(timeoutMs),
      })

      const latency = Date.now() - start

      if (res.ok) {
        results.push({ node, status: 'ok', latencyMs: latency })
        console.log(`  ✅ ${node.name} (${node.host}:${String(node.port)}) — ${String(latency)}ms`)
      } else {
        results.push({ node, status: 'error', error: `HTTP ${String(res.status)}` })
        console.log(
          `  ❌ ${node.name} (${node.host}:${String(node.port)}) — HTTP ${String(res.status)}`,
        )
      }
    } catch (err: unknown) {
      const latency = Date.now() - start
      const msg = err instanceof Error ? err.message : String(err)
      const isTimeout = msg.includes('abort') || msg.includes('timeout')
      results.push({
        node,
        status: isTimeout ? 'timeout' : 'error',
        latencyMs: latency,
        error: msg,
      })
      console.log(
        `  ${isTimeout ? '⏱️' : '❌'}  ${node.name} (${node.host}:${String(node.port)}) — ${isTimeout ? 'timeout' : msg}`,
      )
    }
  }

  console.log('')
  const online = results.filter((r) => r.status === 'ok').length
  console.log(`  ${String(online)}/${String(nodes.length)} nodes reachable`)
  console.log('')

  if (flags.json) {
    console.log(JSON.stringify(results, null, 2))
  }
}

// ---------------------------------------------------------------------------
// mesh join — join an existing mesh via seed node
// ---------------------------------------------------------------------------

async function meshJoin(host: string | undefined, flags: Flags): Promise<void> {
  if (!host) {
    console.error('  Usage: rivetos mesh join <host> [--port <port>] [--secret <secret>]')
    process.exit(1)
  }

  const port = flags.port ?? 3100
  const secret = flags.secret ?? process.env.RIVETOS_AGENT_SECRET ?? ''

  console.log('')
  console.log(`  Joining mesh via seed node ${host}:${String(port)}...`)

  // First, check if seed is reachable
  try {
    const pingRes = await fetch(`http://${host}:${String(port)}/api/mesh/ping`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!pingRes.ok) {
      console.error(`  ❌ Seed node responded with HTTP ${String(pingRes.status)}`)
      process.exit(1)
    }
    console.log('  ✅ Seed node is reachable')
  } catch (err: unknown) {
    console.error(`  ❌ Cannot reach seed node: ${(err as Error).message}`)
    process.exit(1)
  }

  // Build our local node info
  const { hostname } = await import('node:os')
  const { readFile } = await import('node:fs/promises')

  let version = 'unknown'
  try {
    const pkg = JSON.parse(await readFile('package.json', 'utf-8')) as { version?: string }
    version = pkg.version ?? 'unknown'
  } catch {
    // ignore
  }

  const localNode = {
    id: crypto.randomUUID(),
    name: hostname(),
    agents: [], // Will be populated on start
    host: getLocalIp(),
    port: 3100,
    providers: [],
    models: [],
    capabilities: [],
    status: 'online' as const,
    lastSeen: Date.now(),
    registeredAt: Date.now(),
    version,
  }

  // Send join request to seed
  try {
    const res = await fetch(`http://${host}:${String(port)}/api/mesh/join`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(localNode),
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      const body = await res.text()
      console.error(`  ❌ Join failed: HTTP ${String(res.status)} — ${body}`)
      process.exit(1)
    }

    const result = (await res.json()) as { status: string; nodes: unknown[] }
    console.log(`  ✅ Joined mesh — ${String(result.nodes.length)} node(s) in the mesh`)

    // Save the mesh config to rivet.config.yaml
    console.log('')
    console.log('  To persist this, add to your rivet.config.yaml:')
    console.log('')
    console.log('    mesh:')
    console.log('      enabled: true')
    console.log('      discovery:')
    console.log(`        mode: seed`)
    console.log(`        seedHost: "${host}"`)
    console.log(`        seedPort: ${String(port)}`)
    if (secret) {
      console.log(`      secret: "\${RIVETOS_MESH_SECRET}"`)
    }
    console.log('')
  } catch (err: unknown) {
    console.error(`  ❌ Join failed: ${(err as Error).message}`)
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// mesh status — show local node mesh info
// ---------------------------------------------------------------------------

async function meshStatus(flags: Flags): Promise<void> {
  const meshFile = await loadMeshFile()
  if (!meshFile) {
    console.log('  Mesh: not active')
    return
  }

  const nodes = Object.values(meshFile.nodes)
  const online = nodes.filter((n) => n.status === 'online')
  const offline = nodes.filter((n) => n.status === 'offline')
  const stale = nodes.filter((n) => n.status === 'degraded')

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          totalNodes: nodes.length,
          online: online.length,
          offline: offline.length,
          degraded: stale.length,
          updatedAt: new Date(meshFile.updatedAt).toISOString(),
        },
        null,
        2,
      ),
    )
    return
  }

  console.log('')
  console.log('  Mesh Status')
  console.log('  ───────────')
  console.log(
    `  Nodes:    ${String(nodes.length)} total (${String(online.length)} online, ${String(offline.length)} offline, ${String(stale.length)} degraded)`,
  )
  console.log(`  Updated:  ${new Date(meshFile.updatedAt).toLocaleString()}`)
  console.log('')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MeshFile {
  version: number
  nodes: Record<string, MeshNode>
  updatedAt: number
}

interface MeshNode {
  id: string
  name: string
  role?: string // 'agent' (default), 'datahub', etc. Non-agent nodes are sync-only.
  agents?: string[]
  host: string
  port: number
  providers?: string[]
  models?: string[]
  capabilities?: string[]
  status: 'online' | 'offline' | 'degraded' | 'updating'
  lastSeen?: number
  registeredAt?: number
  version?: string
}

interface PingResult {
  node: MeshNode
  status: 'ok' | 'timeout' | 'error'
  latencyMs?: number
  error?: string
}

interface Flags {
  json?: boolean
  timeout?: number
  port?: number
  secret?: string
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') flags.json = true
    if (args[i] === '--timeout' && args[i + 1]) flags.timeout = Number(args[++i])
    if (args[i] === '--port' && args[i + 1]) flags.port = Number(args[++i])
    if (args[i] === '--secret' && args[i + 1]) flags.secret = args[++i]
  }
  return flags
}

async function loadMeshFile(): Promise<MeshFile | null> {
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')

  // Check /shared/mesh.json first (container/NFS), then workspace
  const paths = [
    '/shared/mesh.json',
    join(process.cwd(), 'mesh.json'),
    join(process.env.HOME ?? '~', '.rivetos', 'mesh.json'),
  ]

  for (const p of paths) {
    try {
      const raw = await readFile(p, 'utf-8')
      return JSON.parse(raw) as MeshFile
    } catch {
      // try next
    }
  }

  return null
}

function statusEmoji(status: string): string {
  switch (status) {
    case 'online':
      return '🟢'
    case 'offline':
      return '🔴'
    case 'degraded':
      return '🟡'
    case 'updating':
      return '🔄'
    default:
      return '⚪'
  }
}

function timeSince(epochMs: number): string {
  const seconds = Math.floor((Date.now() - epochMs) / 1000)
  if (seconds < 60) return `${String(seconds)}s ago`
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m ago`
  if (seconds < 86400) return `${String(Math.floor(seconds / 3600))}h ago`
  return `${String(Math.floor(seconds / 86400))}d ago`
}

function getLocalIp(): string {
  const interfaces = networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address
      }
    }
  }
  return '127.0.0.1'
}
