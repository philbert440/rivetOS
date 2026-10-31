import { beforeEach, describe, expect, it, vi } from 'vitest'
import { agentsGuard } from './agents-guard.js'

function fakeConfirm(answer: boolean) {
  return vi.fn(async () => answer)
}

beforeEach(() => {
  agentsGuard.report('', false)
})

describe('agentsGuard', () => {
  it('reports the draft and reads it back', () => {
    agentsGuard.report('scout', true)
    expect(agentsGuard.isDirty()).toBe(true)
  })

  it('discarding a clean form proceeds without a prompt', async () => {
    agentsGuard.report('scout', false)
    const confirm = fakeConfirm(false)

    await expect(agentsGuard.confirmDiscard(confirm)).resolves.toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('names the agent in the prompt', async () => {
    agentsGuard.report('scout', true)
    const confirm = fakeConfirm(true)

    await expect(agentsGuard.confirmDiscard(confirm)).resolves.toBe(true)
    expect(confirm).toHaveBeenCalledWith('Discard unsaved changes to agent "scout"?', {
      confirmLabel: 'Discard',
      danger: true,
    })
  })

  it('names a new agent in the prompt when it has no name yet', async () => {
    agentsGuard.report('', true)
    const confirm = fakeConfirm(true)

    await agentsGuard.confirmDiscard(confirm)
    expect(confirm.mock.calls[0]?.[0]).toBe('Discard unsaved changes to agent "new agent"?')
  })

  it('Cancel keeps the edits', async () => {
    agentsGuard.report('scout', true)

    await expect(agentsGuard.confirmDiscard(fakeConfirm(false))).resolves.toBe(false)
    expect(agentsGuard.isDirty()).toBe(true)
  })

  it('Discard clears the edits', async () => {
    agentsGuard.report('scout', true)

    await expect(agentsGuard.confirmDiscard(fakeConfirm(true))).resolves.toBe(true)
    expect(agentsGuard.isDirty()).toBe(false)
  })
})
