import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { denStateDir } from './den-state-dir.js'

describe('denStateDir', () => {
  it('uses RIVETOS_DEN_STATE_DIR verbatim, including a blank string', () => {
    expect(denStateDir({ RIVETOS_DEN_STATE_DIR: '/tmp/den-state' })).toBe('/tmp/den-state')
    // `??` only, no trim — a blank value must not fall through to ~/.rivetos/den.
    expect(denStateDir({ RIVETOS_DEN_STATE_DIR: '' })).toBe('')
  })

  it('falls back to ~/.rivetos/den when the env var is absent', () => {
    expect(denStateDir({})).toBe(join(homedir(), '.rivetos', 'den'))
  })
})
