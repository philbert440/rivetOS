/**
 * Claude Desktop Cowork sessions on the host.
 *
 * Sandbox-off tasks leave metadata at `local_<task>.json` under
 * `local-agent-mode-sessions/` (and the older `claude-code-sessions/`).
 * The transcript, when the sandbox wrote one, is the sibling
 * `local_<task>/.claude/projects/<slug>/<cliSessionId>.jsonl` in Claude
 * Code JSONL. Full-VM mode keeps that file inside a disk image; listing
 * still works from metadata, and the transcript read is empty.
 */

import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { HarnessTranscriptTurn } from '@rivetos/types'
import { claudeTurnsFromLines } from './adapters/claude.js'

const META_RE = /^local_.+\.json$/
const TAIL_BYTES = 8_000_000
const WALK_DEPTH = 6

export interface CoworkTaskMeta {
  cliSessionId: string
  title?: string
  cwd?: string
  createdAtMs: number
  updatedAtMs: number
  archived: boolean
  metadataPath: string
  transcriptPath?: string
}

let rootsOverride: string[] | undefined

/** Test-only. Pass undefined to restore the real config roots. */
export function setCoworkRootsForTest(roots?: string[]): void {
  rootsOverride = roots
}

/** Host config dirs Cowork writes into. `CLAUDE_CONFIG_DIR` wins an extra root. */
export function coworkConfigRoots(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  if (rootsOverride) return rootsOverride
  const roots = [
    join(home, 'Library', 'Application Support', 'Claude'),
    join(home, '.config', 'Claude'),
  ]
  const extra = env.CLAUDE_CONFIG_DIR?.trim()
  if (extra) roots.push(extra)
  return [...new Set(roots)]
}

/** Directories the drawer watcher should observe when they exist. */
export function coworkWatchDirs(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  const out: string[] = []
  for (const root of coworkConfigRoots(env, home)) {
    out.push(join(root, 'local-agent-mode-sessions'), join(root, 'claude-code-sessions'))
  }
  return out
}

function epochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const asNum = Number(value)
    if (Number.isFinite(asNum)) return asNum
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

async function walkMeta(dir: string, out: string[], depth = 0): Promise<void> {
  if (depth > WALK_DEPTH) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue
    const full = join(dir, ent.name)
    if (ent.isDirectory()) await walkMeta(full, out, depth + 1)
    else if (ent.isFile() && META_RE.test(ent.name)) out.push(full)
  }
}

async function findTranscript(taskDir: string, id: string): Promise<string | undefined> {
  const projects = join(taskDir, '.claude', 'projects')
  let slugs
  try {
    slugs = await readdir(projects, { withFileTypes: true })
  } catch {
    return undefined
  }
  let best: { path: string; mtime: number } | undefined
  for (const slug of slugs) {
    if (!slug.isDirectory() || slug.name.includes('..')) continue
    const path = join(projects, slug.name, `${id}.jsonl`)
    try {
      const st = await stat(path)
      if (!st.isFile()) continue
      if (!best || st.mtimeMs >= best.mtime) best = { path, mtime: st.mtimeMs }
    } catch {
      /* miss */
    }
  }
  return best?.path
}

async function readMeta(path: string): Promise<CoworkTaskMeta | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object') return undefined
  const row = parsed as Record<string, unknown>
  const id = typeof row.cliSessionId === 'string' ? row.cliSessionId.trim() : ''
  if (!id || id.includes('/') || id.includes('..') || id.includes('\\')) return undefined
  const created = epochMs(row.createdAt) ?? epochMs(row.created_at)
  const updated = epochMs(row.lastActivityAt) ?? epochMs(row.updatedAt) ?? created
  if (created === undefined || updated === undefined) return undefined
  const taskDir = join(dirname(path), basename(path, '.json'))
  return {
    cliSessionId: id,
    title: typeof row.title === 'string' && row.title.trim() ? row.title.trim() : undefined,
    cwd: typeof row.cwd === 'string' && row.cwd.trim() ? row.cwd.trim() : undefined,
    createdAtMs: created,
    updatedAtMs: updated,
    archived: row.archived === true,
    metadataPath: path,
    transcriptPath: await findTranscript(taskDir, id),
  }
}

/** Newest metadata row per `cliSessionId`. */
export async function listCoworkTasks(): Promise<CoworkTaskMeta[]> {
  const files: string[] = []
  for (const dir of coworkWatchDirs()) await walkMeta(dir, files)
  const byId = new Map<string, CoworkTaskMeta>()
  for (const file of files) {
    const meta = await readMeta(file)
    if (!meta) continue
    const prev = byId.get(meta.cliSessionId)
    if (!prev || meta.updatedAtMs >= prev.updatedAtMs) byId.set(meta.cliSessionId, meta)
  }
  return [...byId.values()].sort((a, b) => b.updatedAtMs - a.updatedAtMs)
}

export async function findCoworkTask(id: string): Promise<CoworkTaskMeta | undefined> {
  if (!id || id.includes('/') || id.includes('..')) return undefined
  const all = await listCoworkTasks()
  return all.find((row) => row.cliSessionId === id)
}

async function readJsonlObjects(file: string): Promise<Record<string, unknown>[]> {
  const st = await stat(file)
  let raw: string
  if (st.size > TAIL_BYTES) {
    const fh = await open(file, 'r')
    try {
      const buf = Buffer.alloc(TAIL_BYTES)
      await fh.read(buf, 0, TAIL_BYTES, st.size - TAIL_BYTES)
      raw = buf.toString('utf8')
      const nl = raw.indexOf('\n')
      if (nl >= 0) raw = raw.slice(nl + 1)
    } finally {
      await fh.close()
    }
  } else {
    raw = await readFile(file, 'utf8')
  }
  const out: Record<string, unknown>[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>)
      }
    } catch {
      // A partial last line is not a turn.
    }
  }
  return out
}

export async function readCoworkTurns(id: string): Promise<HarnessTranscriptTurn[]> {
  const task = await findCoworkTask(id)
  if (!task?.transcriptPath) return []
  try {
    return claudeTurnsFromLines(await readJsonlObjects(task.transcriptPath))
  } catch {
    return []
  }
}
