/**
 * Per-agent watermark for the hourly ReadTranscript live-capture loop.
 * Path comes from GROKBOT_SPOOL_STATE, else GROKBOT_CAPTURE_DIR/spool-state.json
 * (gitignored). Never prints secrets.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const SPOOL_STATE_BASENAME = 'spool-state.json'

export interface AgentWatermark {
  lastIngestedPosition: number | null
  lastIngestAt: string | null
  lastSeenTotal: number | null
}

export interface SpoolStateFile {
  agents: Record<string, AgentWatermark>
}

export class TotalDecreasedError extends Error {
  readonly agentId: string
  readonly previous: number
  readonly next: number
  constructor(agentId: string, previous: number, next: number) {
    super(`TOTAL_DECREASED was=${String(previous)} now=${String(next)}`)
    this.name = 'TotalDecreasedError'
    this.agentId = agentId
    this.previous = previous
    this.next = next
  }
}

export function emptyWatermark(): AgentWatermark {
  return { lastIngestedPosition: null, lastIngestAt: null, lastSeenTotal: null }
}

export function resolveSpoolStatePath(
  env: NodeJS.ProcessEnv = process.env,
  packageDir = defaultCaptureDir(),
): string {
  const explicit = env.GROKBOT_SPOOL_STATE?.trim()
  if (explicit) return resolve(explicit)
  const cap = env.GROKBOT_CAPTURE_DIR?.trim()
  if (cap) return join(resolve(cap), SPOOL_STATE_BASENAME)
  return join(packageDir, SPOOL_STATE_BASENAME)
}

function defaultCaptureDir(): string {
  return resolve(new URL('..', import.meta.url).pathname)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asIntOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function normalizeState(raw: unknown): SpoolStateFile {
  if (!isRecord(raw)) return { agents: {} }
  const source = isRecord(raw.agents) ? raw.agents : raw
  const agents: Record<string, AgentWatermark> = {}
  for (const [id, value] of Object.entries(source)) {
    if (!isRecord(value)) continue
    agents[id] = {
      lastIngestedPosition: asIntOrNull(value.lastIngestedPosition),
      lastIngestAt: typeof value.lastIngestAt === 'string' ? value.lastIngestAt : null,
      lastSeenTotal: asIntOrNull(value.lastSeenTotal),
    }
  }
  return { agents }
}

export function readSpoolState(path: string): SpoolStateFile {
  try {
    return normalizeState(JSON.parse(readFileSync(path, 'utf8')) as unknown)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { agents: {} }
    throw err
  }
}

export function writeSpoolState(path: string, state: SpoolStateFile): void {
  mkdirSync(dirname(resolve(path)), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

export function getAgentWatermark(state: SpoolStateFile, agentId: string): AgentWatermark {
  return state.agents[agentId] ?? emptyWatermark()
}

export function recordOkIngest(
  state: SpoolStateFile,
  agentId: string,
  opts: { position: number; total: number; at?: string },
): SpoolStateFile {
  if (!Number.isInteger(opts.position) || opts.position < 0) {
    throw new Error('spool-state record: --position must be a non-negative integer')
  }
  if (!Number.isInteger(opts.total) || opts.total < 0) {
    throw new Error('spool-state record: --total must be a non-negative integer')
  }
  const prev = getAgentWatermark(state, agentId)
  if (prev.lastSeenTotal != null && opts.total < prev.lastSeenTotal) {
    throw new TotalDecreasedError(agentId, prev.lastSeenTotal, opts.total)
  }
  const position =
    prev.lastIngestedPosition == null
      ? opts.position
      : Math.max(prev.lastIngestedPosition, opts.position)
  return {
    agents: {
      ...state.agents,
      [agentId]: {
        lastIngestedPosition: position,
        lastIngestAt: opts.at ?? new Date().toISOString(),
        lastSeenTotal: opts.total,
      },
    },
  }
}

export function parseTotalFlag(raw: string): { slug: string; total: number } {
  const m = /^([a-z0-9-]+)=(\d+)$/.exec(raw.trim())
  if (!m) {
    throw new Error('needs: --total must be slug=N (non-negative integer)')
  }
  return { slug: m[1], total: Number(m[2]) }
}

export function formatWatermarkJson(agentId: string, watermark: AgentWatermark): string {
  return JSON.stringify({ agentId, ...watermark })
}
