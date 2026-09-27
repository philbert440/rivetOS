// Shared live-capture state helpers. Watcher size:mtime keys are
// `${agentId}${SESSION_SUFFIX}` so a copied unsuffixed state.json cannot
// skip -v3 ingest. run-once stuck-policy files are a different shape.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Matches agents/<uuid>/store.db and the WAL sidecar, same debounce key. */
export const STORE_WATCH_RE = /^([0-9a-f-]{36})[\\/]store\.db(?:-wal)?$/

export function captureStateKey(id, suffix = '') {
  return `${id}${suffix ?? ''}`
}

export function shouldIngest(state, id, suffix, sig) {
  return state[captureStateKey(id, suffix)] !== sig
}

export function storeCursor(state, id, suffix) {
  const raw = state[captureStateKey(id, suffix)]
  if (typeof raw === 'string' && raw.startsWith('seq:')) {
    const n = Number(raw.slice(4))
    return Number.isFinite(n) ? n : -1
  }
  return -1
}

export function writeStoreCursor(state, id, suffix, seq) {
  state[captureStateKey(id, suffix)] = `seq:${seq}`
}

export function shouldIngestStore(state, id, suffix, maxSeq) {
  return maxSeq > storeCursor(state, id, suffix)
}

export function isWatcherStateMap(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false
  const vals = Object.values(obj)
  if (vals.length === 0) return false
  return vals.every(
    (v) => typeof v === 'string' && (/^\d+:\d+$/.test(v) || /^seq:-?\d+$/.test(v)),
  )
}

export function isStuckPolicyState(obj) {
  return Boolean(
    obj &&
    typeof obj === 'object' &&
    !Array.isArray(obj) &&
    ('lastStatus' in obj || 'sessionId' in obj),
  )
}

export function oldStuckPolicyPath(oldDir, sessionId, suffix) {
  const unsuffixed =
    suffix && sessionId.endsWith(suffix) ? sessionId.slice(0, -suffix.length) : sessionId
  return `${oldDir.replace(/\/$/, '')}/${unsuffixed}.json`
}

/** Refresh the roster when the first lookup falls back to rivet-grokbot-run. */
export function resolveIdentityWithRefresh(lookup, id, remake) {
  let who = lookup.identity(id)
  if (who.agent === 'rivet-grokbot-run') {
    lookup = remake()
    who = lookup.identity(id)
  }
  return { lookup, who }
}

const invoked =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (invoked) {
  const cmd = process.argv[2]
  if (cmd === 'old-stuck') {
    const oldDir = process.argv[3] ?? ''
    const sessionId = process.argv[4] ?? ''
    const suffix = process.argv[5] ?? ''
    process.stdout.write(`${oldStuckPolicyPath(oldDir, sessionId, suffix)}\n`)
  } else {
    console.error('usage: live-state.mjs old-stuck OLD_DIR SESSION SUFFIX')
    process.exit(2)
  }
}
