import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ALPHA_ID, BETA_ID } from './ids.js'
import {
  DEFAULT_LAG_ENTRIES,
  DEFAULT_STALL_HOURS,
  evaluatePublishLag,
  formatPublishLagWarn,
  loadPublishLagConfig,
  parsePublishState,
  publishLag,
  publishLagIntervalMs,
  publishLagTempPath,
  readPublishSnapshots,
  runPublishLagPass,
  tryReadPublishSnapshots,
  WARN_CLEAR_RATIO,
  warningLatched,
} from '../publish-lag.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

function writePublish(dir: string, id: string, body: unknown) {
  writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(body)}\n`)
}

describe('publish-lag', () => {
  it('parses a synthetic publish-state and computes lag', () => {
    const parsed = parsePublishState({
      version: 2,
      generation: 1,
      writerSeq: 1411,
      publishedThroughSeq: 927,
      anchorSeq: 1,
      anchorId: 'tbs0',
    })
    expect(parsed).toMatchObject({ writerSeq: 1411, publishedThroughSeq: 927 })
    expect(publishLag(parsed.writerSeq, parsed.publishedThroughSeq)).toBe(484)
    expect(parsePublishState(null)).toBeNull()
    expect(parsePublishState({ writerSeq: 'nope', publishedThroughSeq: 1 })).toBeNull()
    expect(parsePublishState({ writerSeq: 3 })).toBeNull()
  })

  it('reads a publish dir and skips malformed or missing files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-pub-'))
    writePublish(dir, ALPHA_ID, {
      version: 2,
      writerSeq: 80,
      publishedThroughSeq: 20,
    })
    writeFileSync(join(dir, `${BETA_ID}.json`), '{not json')
    writeFileSync(join(dir, 'notes.txt'), 'ignore')
    writePublish(dir, 'empty', { version: 2 })
    const snaps = readPublishSnapshots(dir)
    const ok = snaps.filter((s) => s.parsed)
    const bad = snaps.filter((s) => !s.parsed)
    expect(ok).toHaveLength(1)
    expect(ok[0]?.id).toBe(ALPHA_ID)
    expect(ok[0]?.parsed?.writerSeq).toBe(80)
    expect(bad.map((s) => s.id).sort()).toEqual([BETA_ID, 'empty'])
  })

  it('warns once when lag exceeds the entry threshold', () => {
    const config = { lagEntries: 50, stallMs: 24 * 3_600_000 }
    const snapshots = [
      {
        id: ALPHA_ID,
        parsed: { writerSeq: 100, publishedThroughSeq: 10 },
      },
    ]
    const first = evaluatePublishLag({
      snapshots,
      previous: { agents: {} },
      nowMs: 1_000,
      config,
    })
    expect(first.warnings).toHaveLength(1)
    expect(first.warnings[0]?.reason).toBe('lag')
    expect(first.status.agents[ALPHA_ID]?.warned).toBe(true)
    expect(formatPublishLagWarn(first.warnings[0])).toMatch(/WARN publish lag/)
    expect(formatPublishLagWarn(first.warnings[0])).toContain(ALPHA_ID)

    const second = evaluatePublishLag({
      snapshots,
      previous: first.status,
      nowMs: 2_000,
      config,
    })
    expect(second.warnings).toHaveLength(0)
    expect(second.status.agents[ALPHA_ID]?.warned).toBe(true)
  })

  it('warns once when publishedThroughSeq stalls longer than the time budget', () => {
    const config = { lagEntries: 500, stallMs: 60_000 }
    const snapshots = [
      {
        id: BETA_ID,
        parsed: { writerSeq: 20, publishedThroughSeq: 10 },
      },
    ]
    const t0 = evaluatePublishLag({
      snapshots,
      previous: { agents: {} },
      nowMs: 1_000,
      config,
    })
    expect(t0.warnings).toHaveLength(0)
    expect(t0.status.agents[BETA_ID]?.stalledSince).toBe(1_000)

    const t1 = evaluatePublishLag({
      snapshots,
      previous: t0.status,
      nowMs: 62_000,
      config,
    })
    expect(t1.warnings).toHaveLength(1)
    expect(t1.warnings[0]?.reason).toBe('stall')
    expect(t1.warnings[0]?.stalledSince).toBe(1_000)

    const t2 = evaluatePublishLag({
      snapshots,
      previous: t1.status,
      nowMs: 120_000,
      config,
    })
    expect(t2.warnings).toHaveLength(0)
  })

  it('resets the stall clock when publishedThroughSeq advances', () => {
    const config = { lagEntries: 500, stallMs: 60_000 }
    const first = evaluatePublishLag({
      snapshots: [{ id: ALPHA_ID, parsed: { writerSeq: 40, publishedThroughSeq: 10 } }],
      previous: { agents: {} },
      nowMs: 0,
      config,
    })
    const advanced = evaluatePublishLag({
      snapshots: [{ id: ALPHA_ID, parsed: { writerSeq: 40, publishedThroughSeq: 12 } }],
      previous: first.status,
      nowMs: 50_000,
      config,
    })
    expect(advanced.status.agents[ALPHA_ID]?.stalledSince).toBe(50_000)
    expect(advanced.warnings).toHaveLength(0)
  })

  it('clears the warning when the agent catches up', () => {
    const config = { lagEntries: 5, stallMs: 24 * 3_600_000 }
    const warned = evaluatePublishLag({
      snapshots: [{ id: ALPHA_ID, parsed: { writerSeq: 20, publishedThroughSeq: 1 } }],
      previous: { agents: {} },
      nowMs: 0,
      config,
    })
    expect(warned.warnings).toHaveLength(1)
    const caught = evaluatePublishLag({
      snapshots: [{ id: ALPHA_ID, parsed: { writerSeq: 20, publishedThroughSeq: 20 } }],
      previous: warned.status,
      nowMs: 10,
      config,
    })
    expect(caught.cleared).toEqual([ALPHA_ID])
    expect(caught.status.agents[ALPHA_ID]).toBeUndefined()
  })

  it('loads thresholds from env or a config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-pub-cfg-'))
    const cfg = join(dir, 'capture.json')
    writeFileSync(cfg, JSON.stringify({ publishLagEntries: 7, publishStallHours: 2 }))
    expect(loadPublishLagConfig({ GROKBOT_CAPTURE_CONFIG: cfg })).toEqual({
      lagEntries: 7,
      stallMs: 2 * 3_600_000,
    })
    expect(
      loadPublishLagConfig({
        GROKBOT_CAPTURE_CONFIG: cfg,
        GROKBOT_PUBLISH_LAG_ENTRIES: '9',
        GROKBOT_PUBLISH_STALL_MS: '1234',
      }),
    ).toEqual({ lagEntries: 9, stallMs: 1234 })
    expect(loadPublishLagConfig({})).toEqual({
      lagEntries: DEFAULT_LAG_ENTRIES,
      stallMs: DEFAULT_STALL_HOURS * 3_600_000,
    })
    expect(
      loadPublishLagConfig({
        GROKBOT_PUBLISH_LAG_ENTRIES: '0',
        GROKBOT_PUBLISH_STALL_HOURS: '-2',
        GROKBOT_PUBLISH_STALL_MS: 'NaN',
      }),
    ).toEqual({
      lagEntries: DEFAULT_LAG_ENTRIES,
      stallMs: DEFAULT_STALL_HOURS * 3_600_000,
    })
    expect(
      loadPublishLagConfig({
        GROKBOT_PUBLISH_LAG_ENTRIES: 'nope',
        GROKBOT_PUBLISH_STALL_HOURS: '0',
      }),
    ).toEqual({
      lagEntries: DEFAULT_LAG_ENTRIES,
      stallMs: DEFAULT_STALL_HOURS * 3_600_000,
    })
  })

  it('keeps per-agent state when a snapshot is malformed', () => {
    const config = { lagEntries: 5, stallMs: 24 * 3_600_000 }
    const warned = evaluatePublishLag({
      snapshots: [{ id: ALPHA_ID, parsed: { writerSeq: 20, publishedThroughSeq: 1 } }],
      previous: { agents: {} },
      nowMs: 1_000,
      config,
    })
    expect(warned.status.agents[ALPHA_ID]?.warned).toBe(true)
    const held = evaluatePublishLag({
      snapshots: [{ id: ALPHA_ID, parsed: null }],
      previous: warned.status,
      nowMs: 2_000,
      config,
    })
    expect(held.skipped).toEqual([ALPHA_ID])
    expect(held.cleared).toEqual([])
    expect(held.warnings).toEqual([])
    expect(held.status.agents[ALPHA_ID]).toEqual(warned.status.agents[ALPHA_ID])
  })

  it('stays warned until lag falls below half the enter threshold, then logs cleared', () => {
    const config = { lagEntries: 50, stallMs: 24 * 3_600_000 }
    expect(WARN_CLEAR_RATIO).toBe(0.5)
    expect(
      warningLatched({ alreadyWarned: true, lag: 30, stalledMs: 0, lagEntries: 50, stallMs: config.stallMs }),
    ).toBe(true)
    expect(
      warningLatched({ alreadyWarned: true, lag: 20, stalledMs: 0, lagEntries: 50, stallMs: config.stallMs }),
    ).toBe(false)
    const warned = evaluatePublishLag({
      snapshots: [{ id: ALPHA_ID, parsed: { writerSeq: 80, publishedThroughSeq: 10 } }],
      previous: { agents: {} },
      nowMs: 1_000,
      config,
    })
    expect(warned.warnings).toHaveLength(1)
    const stillHigh = evaluatePublishLag({
      snapshots: [{ id: ALPHA_ID, parsed: { writerSeq: 80, publishedThroughSeq: 50 } }],
      previous: warned.status,
      nowMs: 2_000,
      config,
    })
    expect(stillHigh.warnings).toHaveLength(0)
    expect(stillHigh.cleared).toEqual([])
    expect(stillHigh.status.agents[ALPHA_ID]?.warned).toBe(true)
    const belowHysteresis = evaluatePublishLag({
      snapshots: [{ id: ALPHA_ID, parsed: { writerSeq: 80, publishedThroughSeq: 60 } }],
      previous: stillHigh.status,
      nowMs: 3_000,
      config,
    })
    expect(belowHysteresis.cleared).toEqual([ALPHA_ID])
    expect(belowHysteresis.status.agents[ALPHA_ID]?.warned).toBe(false)

    const dir = mkdtempSync(join(tmpdir(), 'gb-pub-hyst-'))
    const publishDir = join(dir, 'transcript-publish')
    const statusPath = join(dir, 'grokbot-publish-lag-v4.json')
    mkdirSync(publishDir)
    writePublish(publishDir, ALPHA_ID, { writerSeq: 80, publishedThroughSeq: 10 })
    runPublishLagPass({
      publishDir,
      statusPath,
      nowMs: 5_000,
      config,
      log: () => {},
    })
    writePublish(publishDir, ALPHA_ID, { writerSeq: 80, publishedThroughSeq: 60 })
    const logs: string[] = []
    runPublishLagPass({
      publishDir,
      statusPath,
      nowMs: 6_000,
      config,
      log: (...a: unknown[]) => logs.push(a.map(String).join(' ')),
    })
    expect(logs.some((l) => l === `publish lag cleared agent=${ALPHA_ID}`)).toBe(true)
  })

  it('uses file mtime as the stall-start lower bound for a first-seen lagging agent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-pub-mtime-'))
    writePublish(dir, ALPHA_ID, { writerSeq: 40, publishedThroughSeq: 10 })
    const file = join(dir, `${ALPHA_ID}.json`)
    const mtimeSec = 1_700_000_000
    utimesSync(file, mtimeSec, mtimeSec)
    const snaps = readPublishSnapshots(dir)
    expect(snaps[0]?.mtimeMs).toBeGreaterThan(0)
    const nowMs = mtimeSec * 1000 + 3_600_000
    const first = evaluatePublishLag({
      snapshots: snaps,
      previous: { agents: {} },
      nowMs,
      config: { lagEntries: 500, stallMs: 24 * 3_600_000 },
    })
    expect(first.status.agents[ALPHA_ID]?.stalledSince).toBe(snaps[0]?.mtimeMs)
    expect(first.status.agents[ALPHA_ID]?.stalledSince).toBeLessThan(nowMs)
    const alreadyLagging = evaluatePublishLag({
      snapshots: [
        {
          id: BETA_ID,
          parsed: { writerSeq: 20, publishedThroughSeq: 10 },
          mtimeMs: 1_000,
        },
      ],
      previous: { agents: {} },
      nowMs: 5_000,
      config: { lagEntries: 500, stallMs: 3_000 },
    })
    expect(alreadyLagging.status.agents[BETA_ID]?.stalledSince).toBe(1_000)
    expect(alreadyLagging.warnings).toHaveLength(1)
    expect(alreadyLagging.warnings[0]?.reason).toBe('stall')
  })

  it('writes a status file other tools can read and no-ops on a missing dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-pub-pass-'))
    const publishDir = join(dir, 'transcript-publish')
    const statusPath = join(dir, 'grokbot-publish-lag-v4.json')
    mkdirSync(publishDir)
    writePublish(publishDir, ALPHA_ID, { writerSeq: 80, publishedThroughSeq: 1 })
    const logs: string[] = []
    const first = runPublishLagPass({
      publishDir,
      statusPath,
      nowMs: 5_000,
      config: { lagEntries: 10, stallMs: 99_999_999 },
      log: (...a: unknown[]) => logs.push(a.map(String).join(' ')),
    })
    expect(first.warnings).toHaveLength(1)
    expect(logs.some((l) => l.startsWith('WARN publish lag'))).toBe(true)
    const status = JSON.parse(readFileSync(statusPath, 'utf8')) as {
      agents: Record<string, { lag: number; warned: boolean }>
    }
    expect(status.agents[ALPHA_ID]?.lag).toBe(79)
    expect(status.agents[ALPHA_ID]?.warned).toBe(true)

    writePublish(publishDir, ALPHA_ID, { writerSeq: 80, publishedThroughSeq: 80 })
    const logs2: string[] = []
    runPublishLagPass({
      publishDir,
      statusPath,
      nowMs: 6_000,
      config: { lagEntries: 10, stallMs: 99_999_999 },
      log: (...a: unknown[]) => logs2.push(a.map(String).join(' ')),
    })
    expect(logs2.some((l) => l.includes('publish lag cleared'))).toBe(true)
    const cleared = JSON.parse(readFileSync(statusPath, 'utf8')) as {
      agents: Record<string, unknown>
    }
    expect(cleared.agents[ALPHA_ID]).toBeUndefined()

    const missing = runPublishLagPass({
      publishDir: join(dir, 'no-such-publish'),
      statusPath: join(dir, 'empty-status.json'),
      config: { lagEntries: 50, stallMs: 1 },
      log: () => {},
    })
    expect(missing.warnings).toEqual([])
  })

  it('keeps a warned agent when the publish dir is missing or unreadable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-pub-keep-'))
    const statusPath = join(dir, 'grokbot-publish-lag-v4.json')
    const previous = {
      writerSeq: 80,
      publishedThroughSeq: 1,
      lag: 79,
      stalledSince: 1_000,
      warned: true,
      reason: 'lag',
    }
    writeFileSync(
      statusPath,
      `${JSON.stringify({ agents: { [ALPHA_ID]: previous } }, null, 2)}\n`,
    )
    const logs: string[] = []
    const log = (...a: unknown[]) => logs.push(a.map(String).join(' '))
    const missing = runPublishLagPass({
      publishDir: join(dir, 'no-such-publish'),
      statusPath,
      nowMs: 9_000,
      config: { lagEntries: 10, stallMs: 1 },
      log,
    })
    expect(missing.warnings).toEqual([])
    expect(missing.cleared).toEqual([])
    expect(missing.status.agents[ALPHA_ID]).toMatchObject({ warned: true, stalledSince: 1_000 })
    expect(logs.some((line) => line.includes('cleared'))).toBe(false)
    const onDisk = JSON.parse(readFileSync(statusPath, 'utf8')) as {
      agents: Record<string, { warned?: boolean; stalledSince?: number }>
    }
    expect(onDisk.agents[ALPHA_ID]?.warned).toBe(true)
    expect(onDisk.agents[ALPHA_ID]?.stalledSince).toBe(1_000)

    const fileAsDir = join(dir, 'not-a-directory.json')
    writeFileSync(fileAsDir, '{}\n')
    expect(tryReadPublishSnapshots(fileAsDir).readable).toBe(false)
    const thrown = runPublishLagPass({
      publishDir: fileAsDir,
      statusPath,
      nowMs: 10_000,
      config: { lagEntries: 10, stallMs: 1 },
      log,
    })
    expect(thrown.cleared).toEqual([])
    expect(thrown.warnings).toEqual([])
    expect(thrown.status.agents[ALPHA_ID]?.warned).toBe(true)
    expect(thrown.status.agents[ALPHA_ID]?.stalledSince).toBe(1_000)
    const still = JSON.parse(readFileSync(statusPath, 'utf8')) as {
      agents: Record<string, { warned?: boolean }>
    }
    expect(still.agents[ALPHA_ID]?.warned).toBe(true)
    expect(logs.some((line) => line.includes('cleared'))).toBe(false)
  })

  it('falls back to 60s for a bad interval and uses a pid-unique status temp', () => {
    expect(publishLagIntervalMs(undefined)).toBe(60_000)
    expect(publishLagIntervalMs('')).toBe(60_000)
    expect(publishLagIntervalMs('nope')).toBe(60_000)
    expect(publishLagIntervalMs('0')).toBe(60_000)
    expect(publishLagIntervalMs('-5')).toBe(60_000)
    expect(publishLagIntervalMs(Number.NaN)).toBe(60_000)
    expect(publishLagIntervalMs('15000')).toBe(15_000)
    expect(publishLagIntervalMs(15_000)).toBe(15_000)
    const statusPath = join(tmpdir(), 'grokbot-publish-lag-v4.json')
    const a = publishLagTempPath(statusPath)
    const b = publishLagTempPath(statusPath)
    expect(a).not.toBe(b)
    expect(a).not.toBe(`${statusPath}.tmp`)
    expect(a).toContain(String(process.pid))
    expect(a.endsWith('.tmp')).toBe(true)
    expect(b.endsWith('.tmp')).toBe(true)
  })

  it('watcher keeps publish-lag state next to capture-state and checks every pass', () => {
    const watch = readFileSync(join(ROOT, 'watch.mjs'), 'utf8')
    expect(watch).toContain('publish-lag.mjs')
    expect(watch).toContain('grokbot-publish-lag${SESSION_SUFFIX}')
    expect(watch).toContain('transcript-publish')
    expect(watch).toContain('checkPublishLag')
    expect(watch).toContain('GROKBOT_PUBLISH_DIR')
    expect(watch).toContain('publishLagIntervalMs(')
    expect(watch).toContain('setInterval(checkPublishLag, PUBLISH_LAG_INTERVAL_MS)')
    expect(watch).not.toContain('Co-Authored-By')
    const helper = readFileSync(join(ROOT, 'publish-lag.mjs'), 'utf8')
    expect(helper).toContain('GROKBOT_PUBLISH_LAG_ENTRIES')
    expect(helper).toContain('GROKBOT_PUBLISH_STALL_HOURS')
    expect(helper).toContain('GROKBOT_PUBLISH_STALL_MS')
    expect(helper).toContain('GROKBOT_CAPTURE_CONFIG')
  })
})
