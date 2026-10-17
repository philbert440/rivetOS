import { beforeEach, describe, expect, it, vi } from 'vitest'
import { printRivethubNotice, resetRivethubNotice, RIVETHUB_NOTICE } from './rivethub-notice.js'

describe('printRivethubNotice', () => {
  beforeEach(() => {
    resetRivethubNotice()
  })

  it('prints one line naming the migration command, once per process', () => {
    const write = vi.fn()
    printRivethubNotice(write)
    printRivethubNotice(write)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith(RIVETHUB_NOTICE)
    expect(RIVETHUB_NOTICE).toContain('rivetos migrate-to-rivethub')
    expect(RIVETHUB_NOTICE).not.toContain('\n')
  })

  it('goes to stderr by default so stdout parsers are unaffected', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    printRivethubNotice()
    expect(err).toHaveBeenCalledTimes(1)
    expect(out).not.toHaveBeenCalled()
    err.mockRestore()
    out.mockRestore()
  })
})
