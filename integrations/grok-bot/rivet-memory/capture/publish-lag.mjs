// Host transcript-publish lag detector. The publisher writes
// <agentDataDir>/transcript-publish/<agentId>.json; we only read it.
// Missing or malformed files are skipped. State lives next to the
// watcher's capture-state file so other tools can read the status JSON.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_LAG_ENTRIES = 50
export const DEFAULT_STALL_HOURS = 24
export const DEFAULT_LAG_INTERVAL_MS = 60_000
export const HOUR_MS = 3_600_000
/** Once warned, stay warned until lag/stall fall to this fraction of the enter threshold. */
export const WARN_CLEAR_RATIO = 0.5

/**
 * Periodic recheck interval. Non-numeric, non-finite, or non-positive values
 * fall back to 60s so a bad knob cannot disable the late-publish guarantee.
 */
export function publishLagIntervalMs(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_LAG_INTERVAL_MS
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LAG_INTERVAL_MS
}

function asFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

export function loadPublishLagConfig(env = process.env, fileCfg = {}) {
  let fromFile = fileCfg && typeof fileCfg === 'object' ? fileCfg : {}
  const cfgPath = env.GROKBOT_CAPTURE_CONFIG
  if (cfgPath && (!fileCfg || Object.keys(fileCfg).length === 0)) {
    try {
      const parsed = JSON.parse(readFileSync(cfgPath, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fromFile = parsed
    } catch {
      fromFile = {}
    }
  }
  const lagEntries = positiveThreshold(
    asFiniteNumber(env.GROKBOT_PUBLISH_LAG_ENTRIES) ?? asFiniteNumber(fromFile.publishLagEntries),
    DEFAULT_LAG_ENTRIES,
  )
  const stallHours = positiveThreshold(
    asFiniteNumber(env.GROKBOT_PUBLISH_STALL_HOURS) ?? asFiniteNumber(fromFile.publishStallHours),
    DEFAULT_STALL_HOURS,
  )
  const stallMs = positiveThreshold(
    asFiniteNumber(env.GROKBOT_PUBLISH_STALL_MS) ?? asFiniteNumber(fromFile.publishStallMs),
    stallHours * HOUR_MS,
  )
  return { lagEntries, stallMs }
}

function positiveThreshold(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

export function parsePublishState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const writerSeq = asFiniteNumber(raw.writerSeq)
  const publishedThroughSeq = asFiniteNumber(raw.publishedThroughSeq)
  if (writerSeq === undefined || publishedThroughSeq === undefined) return null
  return {
    writerSeq,
    publishedThroughSeq,
    version: raw.version,
    generation: raw.generation,
    anchorSeq: raw.anchorSeq,
    anchorId: typeof raw.anchorId === 'string' ? raw.anchorId : undefined,
  }
}

export function publishLag(writerSeq, publishedThroughSeq) {
  return writerSeq - publishedThroughSeq
}

/**
 * Read every publish-state file. `readable: false` means the directory was
 * missing or readdir failed — that is not the same as an empty directory.
 */
export function tryReadPublishSnapshots(publishDir) {
  if (!publishDir || !existsSync(publishDir)) return { readable: false, snapshots: [] }
  let names
  try {
    names = readdirSync(publishDir)
  } catch {
    return { readable: false, snapshots: [] }
  }
  const snapshots = []
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue
    const id = name.slice(0, -'.json'.length)
    if (!id) continue
    const file = join(publishDir, name)
    let parsed = null
    let mtimeMs
    try {
      parsed = parsePublishState(JSON.parse(readFileSync(file, 'utf8')))
    } catch {
      parsed = null
    }
    try {
      mtimeMs = statSync(file).mtimeMs
    } catch {
      mtimeMs = undefined
    }
    snapshots.push({ id, file, parsed, mtimeMs })
  }
  return { readable: true, snapshots }
}

export function loadPublishLagStatus(statusPath) {
  try {
    const raw = JSON.parse(readFileSync(statusPath, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { agents: {} }
    const agents = raw.agents && typeof raw.agents === 'object' && !Array.isArray(raw.agents)
      ? raw.agents
      : {}
    return { ...raw, agents }
  } catch {
    return { agents: {} }
  }
}

export function formatPublishLagWarn(row) {
  const stalledH = row.stalledMs / HOUR_MS
  const stalled =
    stalledH >= 1 ? `${stalledH.toFixed(1)}h` : `${Math.round(row.stalledMs / 1000)}s`
  const reason = row.reason === 'lag' ? `lag=${row.lag} (threshold=${row.lagEntries})` : `stalled=${stalled}`
  return (
    `WARN publish lag agent=${row.id} writerSeq=${row.writerSeq} ` +
    `publishedThroughSeq=${row.publishedThroughSeq} lag=${row.lag} ${reason}`
  )
}

/**
 * Compare the latest publish snapshots against persisted stall state.
 * Warn once per agent when lag > N or the stall exceeds the time budget.
 * The warning (and the status row) clear when lag <= 0.
 *
 * `dirReadable` is required. Defaulting it to true let a caller that had
 * collapsed an unreadable directory into `[]` clear every warned agent.
 * While the directory cannot be read, warned agents stay warned and
 * `dirUnreadableSince` records when that stretch began.
 */
export function evaluatePublishLag(opts) {
  if (!opts || typeof opts.dirReadable !== 'boolean') {
    throw new Error('evaluatePublishLag requires opts.dirReadable (true or false)')
  }
  const nowMs = opts.nowMs ?? Date.now()
  const config = opts.config ?? loadPublishLagConfig()
  const previous = opts.previous?.agents ?? {}
  const dirReadable = opts.dirReadable
  if (!dirReadable) {
    const rawSince = opts.previous?.dirUnreadableSince
    const began = typeof rawSince !== 'string' || !rawSince
    const dirUnreadableSince = began ? new Date(nowMs).toISOString() : rawSince
    return {
      status: {
        updatedAt: new Date(nowMs).toISOString(),
        lagEntries: config.lagEntries,
        stallMs: config.stallMs,
        dirUnreadableSince,
        agents: { ...previous },
      },
      warnings: [],
      cleared: [],
      skipped: [],
      dirState: began ? 'began' : 'ongoing',
    }
  }
  const wasUnreadable = typeof opts.previous?.dirUnreadableSince === 'string' &&
    opts.previous.dirUnreadableSince.length > 0
  const agents = {}
  const warnings = []
  const cleared = []
  const skipped = []
  const seen = new Set()

  for (const snap of opts.snapshots ?? []) {
    if (!snap?.id) continue
    seen.add(snap.id)
    if (!snap.parsed) {
      skipped.push(snap.id)
      if (previous[snap.id]) agents[snap.id] = previous[snap.id]
      continue
    }
    const lag = publishLag(snap.parsed.writerSeq, snap.parsed.publishedThroughSeq)
    const prev = previous[snap.id]
    if (lag <= 0) {
      if (prev?.warned) cleared.push(snap.id)
      continue
    }
    const samePublished =
      prev && asFiniteNumber(prev.publishedThroughSeq) === snap.parsed.publishedThroughSeq
    const prevStalled = asFiniteNumber(prev?.stalledSince)
    const firstSeen = !prev
    const stalledSince =
      samePublished && prevStalled !== undefined
        ? prevStalled
        : firstSeen && Number.isFinite(snap.mtimeMs)
          ? Math.min(nowMs, snap.mtimeMs)
          : nowMs
    const stalledMs = Math.max(0, nowMs - stalledSince)
    const alreadyWarned = Boolean(prev?.warned)
    const stayWarned = warningLatched({
      alreadyWarned,
      lag,
      stalledMs,
      lagEntries: config.lagEntries,
      stallMs: config.stallMs,
    })
    const overLag = lag > config.lagEntries
    const overStall = stalledMs > config.stallMs
    const reason = overLag ? 'lag' : overStall ? 'stall' : alreadyWarned ? prev?.reason : undefined
    const row = {
      id: snap.id,
      writerSeq: snap.parsed.writerSeq,
      publishedThroughSeq: snap.parsed.publishedThroughSeq,
      lag,
      stalledSince,
      stalledMs,
      warned: stayWarned,
      reason,
      lagEntries: config.lagEntries,
      stallMs: config.stallMs,
    }
    agents[snap.id] = {
      writerSeq: row.writerSeq,
      publishedThroughSeq: row.publishedThroughSeq,
      lag,
      stalledSince,
      warned: row.warned,
      reason: row.reason ?? null,
    }
    if (stayWarned && !alreadyWarned) warnings.push(row)
    if (alreadyWarned && !stayWarned) cleared.push(snap.id)
  }

  for (const [id, prev] of Object.entries(previous)) {
    if (seen.has(id) || skipped.includes(id)) continue
    if (prev?.warned) cleared.push(id)
  }

  return {
    status: {
      updatedAt: new Date(nowMs).toISOString(),
      lagEntries: config.lagEntries,
      stallMs: config.stallMs,
      agents,
    },
    warnings,
    cleared,
    skipped,
    dirState: wasUnreadable ? 'ended' : 'ok',
  }
}

export function warningLatched(opts) {
  const lag = opts.lag
  const stalledMs = opts.stalledMs
  const lagEntries = opts.lagEntries
  const stallMs = opts.stallMs
  if (lag <= 0) return false
  if (lag > lagEntries || stalledMs > stallMs) return true
  if (!opts.alreadyWarned) return false
  return lag > lagEntries * WARN_CLEAR_RATIO || stalledMs > stallMs * WARN_CLEAR_RATIO
}

let publishLagTmpSeq = 0

/** Pid + counter + random, so two watchers never share one temp file. */
export function publishLagTempPath(statusPath) {
  publishLagTmpSeq += 1
  const nonce = `${process.pid}-${publishLagTmpSeq}-${Math.random().toString(36).slice(2, 10)}`
  return `${statusPath}.${nonce}.tmp`
}

export function writePublishLagStatus(statusPath, status) {
  mkdirSync(dirname(statusPath), { recursive: true })
  const tmp = publishLagTempPath(statusPath)
  writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`)
  renameSync(tmp, statusPath)
}

export function runPublishLagPass(opts) {
  const publishDir = opts.publishDir
  const statusPath = opts.statusPath
  const config = opts.config ?? loadPublishLagConfig(opts.env)
  const nowMs = opts.nowMs ?? Date.now()
  const log = opts.log ?? (() => {})
  const previous = statusPath ? loadPublishLagStatus(statusPath) : { agents: {} }
  const read = publishDir ? tryReadPublishSnapshots(publishDir) : { readable: false, snapshots: [] }
  const result = evaluatePublishLag({
    snapshots: read.readable ? read.snapshots : [],
    previous,
    nowMs,
    config,
    dirReadable: read.readable,
  })
  if (statusPath) writePublishLagStatus(statusPath, result.status)
  if (result.dirState === 'began') {
    log(`WARN publish dir unreadable since=${result.status.dirUnreadableSince}`)
  } else if (result.dirState === 'ended') {
    log('publish dir readable again')
  }
  for (const row of result.warnings) log(formatPublishLagWarn(row))
  for (const id of result.cleared) log(`publish lag cleared agent=${id}`)
  return result
}

const invoked =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (invoked) {
  const cmd = process.argv[2]
  if (cmd === 'scan') {
    const publishDir = process.argv[3]
    const statusPath = process.argv[4]
    const result = runPublishLagPass({
      publishDir,
      statusPath,
      log: (...a) => console.log(...a),
    })
    process.stdout.write(`${JSON.stringify({ warnings: result.warnings.length, cleared: result.cleared.length, skipped: result.skipped.length })}\n`)
  } else {
    console.error('usage: publish-lag.mjs scan PUBLISH_DIR STATUS_FILE')
    process.exit(2)
  }
}
