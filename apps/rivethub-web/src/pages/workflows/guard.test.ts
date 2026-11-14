import { beforeEach, describe, expect, it, vi } from 'vitest'
import { workflowsGuard } from './guard.js'

function fakeConfirm(answer: boolean) {
  return vi.fn(async () => answer)
}

beforeEach(() => {
  workflowsGuard.report(false)
})

describe('workflowsGuard', () => {
  it('reports the editor state and reads it back', () => {
    workflowsGuard.report(true)
    expect(workflowsGuard.isDirty()).toBe(true)
  })

  it('leaving the editor when clean proceeds without a prompt', async () => {
    const confirm = fakeConfirm(false)
    await expect(workflowsGuard.confirmDiscard(confirm)).resolves.toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('leaving the editor on Cancel keeps the edits', async () => {
    workflowsGuard.report(true)
    const confirm = fakeConfirm(false)

    await expect(workflowsGuard.confirmDiscard(confirm)).resolves.toBe(false)
    expect(confirm).toHaveBeenCalledWith('Discard unsaved changes?', expect.anything())
    expect(workflowsGuard.isDirty()).toBe(true)
  })

  it('leaving the editor on Discard clears the edits', async () => {
    workflowsGuard.report(true)

    await expect(workflowsGuard.confirmDiscard(fakeConfirm(true))).resolves.toBe(true)
    expect(workflowsGuard.isDirty()).toBe(false)
  })

  it('leaving the page when clean is allowed without a prompt', async () => {
    const confirm = fakeConfirm(false)
    await expect(workflowsGuard.confirmLeave(confirm)).resolves.toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('leaving the page dirty on Cancel is blocked and keeps the edits', async () => {
    workflowsGuard.report(true)

    await expect(workflowsGuard.confirmLeave(fakeConfirm(false))).resolves.toBe(false)
    expect(workflowsGuard.isDirty()).toBe(true)
  })

  it('leaving the page dirty on Discard is allowed and clears the edits', async () => {
    workflowsGuard.report(true)

    await expect(workflowsGuard.confirmLeave(fakeConfirm(true))).resolves.toBe(true)
    expect(workflowsGuard.isDirty()).toBe(false)
  })
})
