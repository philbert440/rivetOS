import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./init.js', () => ({
  default: vi.fn().mockResolvedValue(undefined),
}))

import config from './config.js'
import runInit from './init.js'

describe('config init alias', () => {
  beforeEach(() => {
    vi.mocked(runInit).mockClear()
  })

  it('invokes the wizard entry and forwards remaining args', async () => {
    await config(['init', '--join', 'ct110.mesh'])
    expect(runInit).toHaveBeenCalledWith(['--join', 'ct110.mesh'])
  })

  it('forwards an empty rest list when config init has no flags', async () => {
    await config(['init'])
    expect(runInit).toHaveBeenCalledWith([])
  })
})
