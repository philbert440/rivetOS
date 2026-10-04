import { readFileSync } from 'node:fs'
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

// The hook's dialog is asked through a queue that only a mounted dialog can
// answer: these pin that the hook hands the element out and the page renders
// it, and that an editor clears the guard when it unmounts.
describe('workflows dirty-guard wiring', () => {
  const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('the hook returns the dialog element and the page renders it', () => {
    expect(read('./workflow-dirty-guard.ts')).toContain('element: discardDialog.element')
    const page = read('../pages/workflows-hub.tsx')
    expect(page).toContain('element: discardDialogElement')
    expect(page).toContain('{discardDialogElement}')
  })

  it('both editors report clean when they unmount', () => {
    for (const path of ['../components/workflow-edit-panel.tsx', '../components/flows-author.tsx']) {
      expect(read(path)).toContain('reportDirty.current?.(false)')
    }
  })

  it('leaves tab close and reload to the router blocker', () => {
    const hook = read('./workflow-dirty-guard.ts')
    expect(hook).toContain('useBlocker({ shouldBlockFn, enableBeforeUnload })')
    expect(hook).not.toContain("addEventListener('beforeunload'")
  })
})
