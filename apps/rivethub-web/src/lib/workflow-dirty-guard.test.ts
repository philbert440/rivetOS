import { describe, expect, it, vi } from 'vitest'
import { shouldBlockFilesLeave } from './files-dirty-guard.js'

function fakeConfirm(answer: boolean) {
  return vi.fn(async () => answer)
}

// The workflows surfaces share the pure guard with Files; these tests pin the
// call contract the new useWorkflowDirtyGuard wiring relies on: prompt named
// with the Discard danger action, blocker clears dirty on accepted leave, and
// a clean surface never blocks.

describe('workflows dirty-guard contract', () => {
  it('clean surface never blocks and never prompts', async () => {
    const confirm = fakeConfirm(true)
    const clearDirty = vi.fn()
    await expect(shouldBlockFilesLeave({ dirty: false, confirm, clearDirty })).resolves.toBe(false)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('dirty + accepted discard → blocker releases and clears dirty', async () => {
    const confirm = fakeConfirm(true)
    const clearDirty = vi.fn()
    await expect(shouldBlockFilesLeave({ dirty: true, confirm, clearDirty })).resolves.toBe(false)
    expect(confirm).toHaveBeenCalledWith('Discard unsaved changes?', {
      confirmLabel: 'Discard',
      danger: true,
    })
    expect(clearDirty).toHaveBeenCalled()
  })

  it('dirty + cancel → blocker holds, dirty untouched', async () => {
    const confirm = fakeConfirm(false)
    const clearDirty = vi.fn()
    await expect(shouldBlockFilesLeave({ dirty: true, confirm, clearDirty })).resolves.toBe(true)
    expect(clearDirty).not.toHaveBeenCalled()
  })
})
