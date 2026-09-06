import { describe, expect, it } from 'vitest'
import { ROSTER_TO_HARNESS } from '../model-sheets.js'
import { adapterForCommand } from './index.js'

describe('adapterForCommand', () => {
  it('claude liveTurn is true', () => {
    expect(adapterForCommand('claude')?.capabilities().liveTurn).toBe(true)
  })

  it('every roster command in ROSTER_TO_HARNESS resolves to an adapter', () => {
    for (const command of Object.keys(ROSTER_TO_HARNESS)) {
      const adapter = adapterForCommand(command)
      expect(adapter, command).toBeDefined()
      expect(adapter!.id).toBe(ROSTER_TO_HARNESS[command])
    }
  })

  it('unknown command → undefined', () => {
    expect(adapterForCommand('unknown')).toBeUndefined()
    expect(adapterForCommand('')).toBeUndefined()
    expect(adapterForCommand('claude-code')).toBeUndefined()
  })
})
