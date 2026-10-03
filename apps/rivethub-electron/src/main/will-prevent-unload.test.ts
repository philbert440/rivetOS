import { describe, expect, it } from 'vitest'
import {
  shouldAllowUnload,
  UNLOAD_DISCARD,
  UNLOAD_DIALOG,
  UNLOAD_STAY,
} from './will-prevent-unload.js'

describe('shouldAllowUnload', () => {
  it('Stay keeps the window (do not preventDefault on will-prevent-unload)', () => {
    expect(shouldAllowUnload(UNLOAD_STAY)).toBe(false)
  })

  it('Discard allows the unload (preventDefault on will-prevent-unload)', () => {
    expect(shouldAllowUnload(UNLOAD_DISCARD)).toBe(true)
  })

  it('dialog buttons match the Stay / Discard indices', () => {
    expect(UNLOAD_DIALOG.buttons[UNLOAD_STAY]).toBe('Stay')
    expect(UNLOAD_DIALOG.buttons[UNLOAD_DISCARD]).toBe('Discard changes')
    expect(UNLOAD_DIALOG.defaultId).toBe(UNLOAD_STAY)
    expect(UNLOAD_DIALOG.cancelId).toBe(UNLOAD_STAY)
  })
})
