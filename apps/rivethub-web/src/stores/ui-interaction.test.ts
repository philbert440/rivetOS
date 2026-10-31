import { describe, expect, it } from 'vitest'
import { useUiInteraction } from './ui-interaction.js'

// Reset between tests: the store is module-level singleton state.
function reset(): void {
  useUiInteraction.getState().clearFilesDirty()
}

describe('ui-interaction store: filesDirty', () => {
  it('starts clean', () => {
    reset()
    const s = useUiInteraction.getState().filesDirty
    expect(s).toEqual({ fileName: '', dirty: false, pending: null })
  })

  it('track + setDirty marks the buffer dirty', () => {
    reset()
    const s = useUiInteraction.getState()
    s.trackFilesDirty('a.md')
    s.setFilesDirty(true)
    const filesDirty = useUiInteraction.getState().filesDirty
    expect(filesDirty).toEqual({ fileName: 'a.md', dirty: true, pending: null })
  })

  it('setDirty(false) cancels a pending decision (clean buffers have nothing to discard)', () => {
    reset()
    const s = useUiInteraction.getState()
    s.trackFilesDirty('a.md')
    s.setFilesDirty(true)
    s.promptFilesDirty('close')
    s.setFilesDirty(false)
    expect(useUiInteraction.getState().filesDirty.pending).toBe(null)
  })

  it('answer(discard=true) clears dirty and the pending decision', () => {
    reset()
    const s = useUiInteraction.getState()
    s.trackFilesDirty('a.md')
    s.setFilesDirty(true)
    s.promptFilesDirty('close')
    s.answerFilesDirty(true)
    const filesDirty = useUiInteraction.getState().filesDirty
    expect(filesDirty.dirty).toBe(false)
    expect(filesDirty.pending).toBe(null)
    expect(filesDirty.fileName).toBe('a.md')
  })

  it('answer(discard=false) keeps dirty, clears pending', () => {
    reset()
    const s = useUiInteraction.getState()
    s.trackFilesDirty('a.md')
    s.setFilesDirty(true)
    s.promptFilesDirty('close')
    s.answerFilesDirty(false)
    const filesDirty = useUiInteraction.getState().filesDirty
    expect(filesDirty.dirty).toBe(true)
    expect(filesDirty.pending).toBe(null)
  })

  it('clear resets the whole sub-key', () => {
    reset()
    const s = useUiInteraction.getState()
    s.trackFilesDirty('a.md')
    s.setFilesDirty(true)
    s.promptFilesDirty('close')
    s.clearFilesDirty()
    expect(useUiInteraction.getState().filesDirty).toEqual({
      fileName: '',
      dirty: false,
      pending: null,
    })
  })
})
