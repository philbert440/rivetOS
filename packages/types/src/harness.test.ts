/**
 * Compile-level checks for the harness control-plane event union (harness.ts).
 * The value assertions are trivial — the point is that these typed literals
 * typecheck, and that the classification map below is `Record<
 * HarnessEvent['type'], …>`, so adding a member to the contract fails to
 * compile until someone decides which surface consumes it.
 */

import { describe, it, expect } from 'vitest'
import type { HarnessEvent, SessionId } from './index.js'

const SID = 'claude-code:a1b2c3d4-1111-4222-8333-444455556666' as SessionId

/**
 * Which surface owns each event. `turn` folds into the in-flight turn view,
 * `approval` outlives the turn and is held by the approvals surface, and
 * `registry` rides the driver-level stream rather than a session's.
 */
const OWNER: Record<HarnessEvent['type'], 'turn' | 'approval' | 'registry'> = {
  'assistant-delta': 'turn',
  'reasoning-delta': 'turn',
  'tool-use': 'turn',
  'tool-result': 'turn',
  'turn-complete': 'turn',
  error: 'turn',
  'session-updated': 'turn',
  'approval-request': 'approval',
  'approval-resolved': 'approval',
  'session-created': 'registry',
}

describe('harness event contract', () => {
  it('carries reasoning as a text delta shaped like assistant-delta', () => {
    // Contract-minimal on purpose: text only, so a harness that observes real
    // thinking blocks and one that only sees spinner status lines both fit.
    const reasoning: HarnessEvent = {
      type: 'reasoning-delta',
      sessionId: SID,
      text: 'weighing the options',
      turnId: 'turn-1',
    }
    const assistant: HarnessEvent = {
      type: 'assistant-delta',
      sessionId: SID,
      text: 'weighing the options',
      turnId: 'turn-1',
    }
    expect({ ...reasoning, type: 'assistant-delta' }).toEqual(assistant)
    expect(OWNER['reasoning-delta']).toBe('turn')
  })

  it('classifies every member of the union', () => {
    expect(Object.keys(OWNER)).toHaveLength(10)
  })
})
