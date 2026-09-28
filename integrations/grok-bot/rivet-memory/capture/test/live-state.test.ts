import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BETA_ID, ALPHA_ID } from './ids.js'
import {
  captureStateKey,
  isStuckPolicyState,
  isWatcherStateMap,
  oldStuckPolicyPath,
  resolveIdentityWithRefresh,
  shouldIngest,
  shouldIngestStore,
  storeCursor,
  writeStoreCursor,
} from '../live-state.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

describe('watcher / run-once live state', () => {
  it('keys size:mtime by id plus suffix so unsuffixed keys do not skip -v3', () => {
    const id = ALPHA_ID
    const sig = '100:123'
    const copiedOld = { [id]: sig }
    expect(captureStateKey(id, '-v3')).toBe(`${id}-v3`)
    expect(shouldIngest(copiedOld, id, '-v3', sig)).toBe(true)
    expect(shouldIngest({ [`${id}-v3`]: sig }, id, '-v3', sig)).toBe(false)
    expect(isWatcherStateMap(copiedOld)).toBe(true)
    expect(isStuckPolicyState({ lastStatus: 'success', sessionId: 'grokbot-beta-v3' })).toBe(true)
    expect(isStuckPolicyState(copiedOld)).toBe(false)
  })

  it('looks up run-once stuck-policy under the unsuffixed session, not state.json', () => {
    const oldDir = '/tmp/rivetos/capture'
    const viaJs = oldStuckPolicyPath(oldDir, 'grokbot-delta-v3', '-v3')
    expect(viaJs).toBe(`${oldDir}/grokbot-delta.json`)
    expect(viaJs).not.toBe(`${oldDir}/state.json`)
    const viaCli = execFileSync(
      'node',
      [join(ROOT, 'live-state.mjs'), 'old-stuck', oldDir, 'grokbot-delta-v3', '-v3'],
      { encoding: 'utf8' },
    ).trim()
    expect(viaCli).toBe(viaJs)
  })

  it('persists store.db seq cursors keyed by id plus -v3-store', () => {
    const id = BETA_ID
    const state = {}
    expect(storeCursor(state, id, '-v3-store')).toBe(-1)
    expect(shouldIngestStore(state, id, '-v3-store', 4)).toBe(true)
    writeStoreCursor(state, id, '-v3-store', 4)
    expect(storeCursor(state, id, '-v3-store')).toBe(4)
    expect(shouldIngestStore(state, id, '-v3-store', 4)).toBe(false)
    expect(shouldIngestStore(state, id, '-v3-store', 5)).toBe(true)
    expect(isWatcherStateMap(state)).toBe(true)
  })

  it('run-once.sh calls live-state.mjs for the stuck-policy path', () => {
    const runOnce = readFileSync(join(ROOT, 'run-once.sh'), 'utf8')
    expect(runOnce).toContain('live-state.mjs')
    expect(runOnce).toContain('old-stuck')
    expect(runOnce).not.toMatch(/unsuffixed_session="\$\{session_id%/)
    expect(runOnce).toContain('empty roster')
  })
})

describe('roster refresh', () => {
  it('refreshes the lookup when the first hit is grokbot-run', () => {
    const unknown = {
      identity: () => ({ agent: 'grokbot-run', session: 'grokbot-run-x', persona: 'run' }),
    }
    const known = {
      identity: () => ({ agent: 'grokbot-omega', session: 'grokbot-omega', persona: 'Omega' }),
    }
    let remade = 0
    const { who } = resolveIdentityWithRefresh(unknown, 'new-id', () => {
      remade += 1
      return known
    })
    expect(remade).toBe(1)
    expect(who.agent).toBe('grokbot-omega')
  })

  it('does not remake when the first lookup already has a real agent', () => {
    const known = {
      identity: () => ({ agent: 'grokbot-beta', session: 'grokbot-beta', persona: 'Beta' }),
    }
    let remade = 0
    resolveIdentityWithRefresh(known, 'known-id', () => {
      remade += 1
      return known
    })
    expect(remade).toBe(0)
  })
})
