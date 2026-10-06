import { describe, expect, it } from 'vitest'
import type { HarnessCapabilities, HarnessId } from '@rivetos/types'
import { nodeCapabilities } from './node-capabilities.js'

function caps(over: Partial<HarnessCapabilities> = {}): HarnessCapabilities {
  return {
    interrupt: true,
    resume: true,
    approvals: false,
    liveStream: true,
    listSessions: true,
    ...over,
  }
}

describe('nodeCapabilities', () => {
  it('reports subsystems and treats a missing drive flag as drivable', () => {
    const body = nodeCapabilities({
      devicesEnabled: false,
      meshReadable: true,
      harnesses: [
        { harnessId: 'cursor' as HarnessId, capabilities: caps() },
        {
          harnessId: 'cowork' as HarnessId,
          capabilities: caps({ drive: false, resume: false, interrupt: false, liveStream: false }),
        },
      ],
    })
    expect(body.subsystems).toEqual({ den: true, devices: false, mesh: true })
    expect(body.harnesses).toEqual([
      { harnessId: 'cursor', list: true, read: true, drive: true, resume: true },
      { harnessId: 'cowork', list: true, read: true, drive: false, resume: false },
    ])
  })
})
