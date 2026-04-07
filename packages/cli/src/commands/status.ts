/**
 * rivetos status
 *
 * Shows runtime health, agents, channels, metrics.
 * Fetches from the health endpoint when available, falls back to PID check.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const PID_FILE = resolve(process.env.HOME ?? '.', '.rivetos', 'rivetos.pid')
const VERSION = '0.1.0'
const HEALTH_PORT = parseInt(process.env.RIVETOS_HEALTH_PORT ?? '3100', 10)

interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy'
  version: string
  uptime: number
  startedAt: string
  agents: string[]
  providers: Record<
    string,
    { available: boolean; circuitBreaker?: { state: string; failures: number } }
  >
  channels: Record<string, { connected: boolean }>
  memory: { connected: boolean }
  metrics: {
    turns: { total: number; byAgent: Record<string, number> }
    tools: { total: number }
    tokens: { totalPrompt: number; totalCompletion: number }
    latency: { avgMs: number; p95Ms: number; maxMs: number }
    errors: { total: number; byCode: Record<string, number> }
  }
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

async function fetchHealth(): Promise<HealthResponse | null> {
  try {
    const resp = await fetch(`http://127.0.0.1:${HEALTH_PORT}/health`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!resp.ok) return null
    return (await resp.json()) as HealthResponse
  } catch {
    return null
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case 'healthy':
      return '✅'
    case 'degraded':
      return '⚠️'
    case 'unhealthy':
      return '❌'
    default:
      return '❓'
  }
}

export default async function status(): Promise<void> {
  const health = await fetchHealth()

  if (health) {
    // Rich status from health endpoint
    console.log(`🔩 RivetOS v${health.version}`)
    console.log(`   Status: ${statusIcon(health.status)} ${health.status}`)
    console.log(`   Uptime: ${formatUptime(health.uptime)}`)
    console.log(`   Started: ${new Date(health.startedAt).toLocaleString()}`)

    // Agents
    console.log('')
    console.log('Agents:')
    for (const agent of health.agents) {
      const turns = health.metrics.turns.byAgent[agent] ?? 0
      console.log(`  ${agent}: ${turns} turns`)
    }

    // Providers
    console.log('')
    console.log('Providers:')
    for (const [id, info] of Object.entries(health.providers)) {
      const icon = info.available ? '✅' : '❌'
      const cbState = info.circuitBreaker?.state
      const cbLabel = cbState && cbState !== 'closed' ? ` (circuit: ${cbState})` : ''
      console.log(`  ${icon} ${id}${cbLabel}`)
    }

    // Channels
    console.log('')
    console.log('Channels:')
    for (const [id, info] of Object.entries(health.channels)) {
      const icon = info.connected ? '✅' : '❌'
      console.log(`  ${icon} ${id}`)
    }

    // Memory
    console.log('')
    console.log(`Memory: ${health.memory.connected ? '✅ connected' : '❌ disconnected'}`)

    // Metrics
    console.log('')
    console.log('Metrics:')
    console.log(`  Turns:  ${health.metrics.turns.total}`)
    console.log(`  Tools:  ${health.metrics.tools.total} calls`)
    console.log(
      `  Tokens: ${formatTokens(health.metrics.tokens.totalPrompt)} prompt / ${formatTokens(health.metrics.tokens.totalCompletion)} completion`,
    )
    if (health.metrics.latency.avgMs > 0) {
      console.log(
        `  Latency: avg ${health.metrics.latency.avgMs}ms / p95 ${health.metrics.latency.p95Ms}ms / max ${health.metrics.latency.maxMs}ms`,
      )
    }
    if (health.metrics.errors.total > 0) {
      console.log(`  Errors: ${health.metrics.errors.total}`)
      for (const [code, count] of Object.entries(health.metrics.errors.byCode)) {
        console.log(`    ${code}: ${count}`)
      }
    }

    return
  }

  // Fallback — no health endpoint, just PID check
  console.log(`🔩 RivetOS v${VERSION}`)
  console.log()

  try {
    const pid = parseInt(await readFile(PID_FILE, 'utf-8'))
    try {
      process.kill(pid, 0)
      console.log(`Status: ✅ Running (PID ${pid})`)
      console.log('')
      console.log('Health endpoint not available — run with RIVETOS_HEALTH_PORT to enable.')
    } catch {
      console.log('Status: ❌ Not running (stale PID file)')
    }
  } catch {
    console.log('Status: 💤 Not running')
  }

  const configCandidates = [
    resolve(process.env.HOME ?? '.', '.rivetos', 'config.yaml'),
    resolve('.', 'config.yaml'),
  ]

  for (const candidate of configCandidates) {
    try {
      await readFile(candidate)
      console.log(`Config: ${candidate}`)
      break
    } catch {
      /* expected */
    }
  }

  console.log(`Workspace: ${resolve(process.env.HOME ?? '.', '.rivetos', 'workspace')}`)
}
