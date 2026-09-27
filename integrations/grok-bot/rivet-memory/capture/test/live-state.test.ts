import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  captureStateKey,
  isStuckPolicyState,
  isWatcherStateMap,
  oldStuckPolicyPath,
  shouldIngest,
} from '../live-state.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

describe('watcher / run-once live state', () => {
  it('keys size:mtime by id plus suffix so unsuffixed keys do not skip -v3', () => {
    const id = '6a155e75-0dd5-4c8a-8391-994878ed683a'
    const sig = '100:123'
    const copiedOld = { [id]: sig }
    expect(captureStateKey(id, '-v3')).toBe(`${id}-v3`)
    expect(shouldIngest(copiedOld, id, '-v3', sig)).toBe(true)
    expect(shouldIngest({ [`${id}-v3`]: sig }, id, '-v3', sig)).toBe(false)
    expect(isWatcherStateMap(copiedOld)).toBe(true)
    expect(isStuckPolicyState({ lastStatus: 'success', sessionId: 'grokbot-bob-v3' })).toBe(true)
    expect(isStuckPolicyState(copiedOld)).toBe(false)
  })

  it('looks up run-once stuck-policy under the unsuffixed session, not state.json', () => {
    const oldDir = '/home/user/.rivetos/capture'
    expect(oldStuckPolicyPath(oldDir, 'grokbot-eggbot-v3', '-v3')).toBe(
      `${oldDir}/grokbot-eggbot.json`,
    )
    expect(oldStuckPolicyPath(oldDir, 'grokbot-eggbot-v3', '-v3')).not.toBe(`${oldDir}/state.json`)
    const runOnce = readFileSync(join(HERE, '..', 'run-once.sh'), 'utf8')
    expect(runOnce).toContain('OLD_WATCHER_STATE')
    expect(runOnce).toContain('discover-models.mjs')
    expect(runOnce).toContain('unsuffixed_session')
  })
})
