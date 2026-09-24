import { isAbsolute, join, normalize, sep } from 'node:path'
import { HARNESS_IDS, type AgentPreset, type HarnessId } from '@rivetos/types'

const SLUG_MAX = 48

export const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
export const EFFORT_RE = /^[A-Za-z0-9._[\]:-]{0,64}$/

export function isHarnessId(value: string): value is HarnessId {
  return (HARNESS_IDS as readonly string[]).includes(value)
}

export function parseEffort(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const effort = value.trim()
  if (!EFFORT_RE.test(effort)) return undefined
  return effort
}

export function parseHarnessId(value: unknown): HarnessId | undefined | 'bad' {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !isHarnessId(value)) return 'bad'
  return value
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Legacy rows always carry `nodeBaseUrl` and may omit `node`, `directory`,
 * and `sharedLink`. Those optional fields are not required here — the same
 * guard the den uses — so a pre-registry file still loads.
 */
export function isAgentPreset(value: unknown): value is AgentPreset {
  if (!isRecord(value)) return false
  if (
    value.harnessId !== undefined &&
    (typeof value.harnessId !== 'string' || !isHarnessId(value.harnessId))
  )
    return false
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.name === 'string' &&
    typeof value.color === 'string' &&
    typeof value.model === 'string' &&
    typeof value.effort === 'string' &&
    EFFORT_RE.test(value.effort) &&
    typeof value.systemPrompt === 'string' &&
    typeof value.nodeBaseUrl === 'string' &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number'
  )
}

export function parseColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const color = value.trim()
  if (color === '') return ''
  if (!COLOR_RE.test(color)) return undefined
  return color
}

/** Lowercase, non-alnum runs become `-`, trim `-`, cap at 48, `'agent'` when empty. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : 'agent'
}

export function defaultDirectoryFor(root: string, name: string): string {
  return join(root, slugify(name))
}

function withoutTrailingSep(path: string): string {
  if (path.length > 1 && path.endsWith(sep)) return path.replace(/\/+$/, '')
  return path
}

/**
 * Absolute path only. `~` is not expanded (that is the den's job).
 * `..` is rejected only when a segment survives `path.normalize`.
 */
export function validateDirectory(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.includes('\0')) return undefined
  const trimmed = raw.trim()
  if (!trimmed || !isAbsolute(trimmed)) return undefined
  const normalized = withoutTrailingSep(normalize(trimmed))
  if (!normalized || normalized.includes('\0')) return undefined
  if (normalized.split(sep).includes('..')) return undefined
  if (normalized.length > 512) return undefined
  return normalized
}

/**
 * One warning when `directory` is `sharedDir` or a descendant of it. The
 * `rivet-shared` symlink would then point at an ancestor and loop recursive
 * tools. Warn, never reject. No shared dir → no warning.
 */
export function directoryWarnings(directory: string, sharedDir?: string): string[] {
  if (!sharedDir) return []
  const dir = withoutTrailingSep(normalize(directory))
  const root = withoutTrailingSep(normalize(sharedDir))
  if (!dir || !root) return []
  const inside = dir === root || dir.startsWith(`${root}${sep}`)
  if (!inside) return []
  return [
    'directory is inside the shared directory; the rivet-shared link would point at an ancestor and loop recursive tools',
  ]
}
