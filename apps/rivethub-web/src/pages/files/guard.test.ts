import { beforeEach, describe, expect, it, vi } from 'vitest'
import { filesGuard } from './guard.js'

function fakeConfirm(answer: boolean) {
  return vi.fn(async () => answer)
}

beforeEach(() => {
  filesGuard.setOpenFile(undefined)
})

describe('filesGuard', () => {
  it('reports the editor state and reads it back', () => {
    filesGuard.setOpenFile('notes.md')
    filesGuard.report(true)
    expect(filesGuard.isDirty()).toBe(true)
  })

  it('opening another file starts a clean buffer', () => {
    filesGuard.setOpenFile('notes.md')
    filesGuard.report(true)
    filesGuard.setOpenFile('other.md')
    expect(filesGuard.isDirty()).toBe(false)
  })

  it('reopening the file already open is a noop: no prompt', async () => {
    filesGuard.setOpenFile('notes.md')
    filesGuard.report(true)
    const confirm = fakeConfirm(true)

    await expect(filesGuard.confirmSwitchFile(confirm, 'notes.md')).resolves.toBe('noop')
    expect(confirm).not.toHaveBeenCalled()
    expect(filesGuard.isDirty()).toBe(true)
  })

  it('switching away on Cancel keeps the buffer', async () => {
    filesGuard.setOpenFile('notes.md')
    filesGuard.report(true)
    const confirm = fakeConfirm(false)

    await expect(filesGuard.confirmSwitchFile(confirm, 'other.md')).resolves.toBe('cancel')
    expect(confirm).toHaveBeenCalledWith('Discard unsaved changes to notes.md?', {
      confirmLabel: 'Discard',
      danger: true,
    })
    expect(filesGuard.isDirty()).toBe(true)
  })

  it('switching away on Discard clears the buffer', async () => {
    filesGuard.setOpenFile('dir/notes.md')
    filesGuard.report(true)

    await expect(filesGuard.confirmSwitchFile(fakeConfirm(true), 'other.md')).resolves.toBe('proceed')
    expect(filesGuard.isDirty()).toBe(false)
  })

  it('closing the pane prompts with the file name', async () => {
    filesGuard.setOpenFile('dir/notes.md')
    filesGuard.report(true)
    const confirm = fakeConfirm(true)

    await expect(filesGuard.confirmClosePreview(confirm)).resolves.toBe('proceed')
    expect(confirm).toHaveBeenCalledWith('Discard unsaved changes to notes.md?', expect.anything())
    expect(filesGuard.isDirty()).toBe(false)
  })

  it('switching away while clean proceeds without a prompt', async () => {
    filesGuard.setOpenFile('notes.md')
    const confirm = fakeConfirm(false)

    await expect(filesGuard.confirmSwitchFile(confirm, 'other.md')).resolves.toBe('proceed')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('closing a clean file proceeds without a prompt', async () => {
    filesGuard.setOpenFile('notes.md')
    const confirm = fakeConfirm(false)

    await expect(filesGuard.confirmClosePreview(confirm)).resolves.toBe('proceed')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('closing on Cancel keeps the buffer and cancels', async () => {
    filesGuard.setOpenFile('dir/notes.md')
    filesGuard.report(true)

    await expect(filesGuard.confirmClosePreview(fakeConfirm(false))).resolves.toBe('cancel')
    expect(filesGuard.isDirty()).toBe(true)
  })

  it('leaving clean is allowed without a prompt', async () => {
    filesGuard.setOpenFile('notes.md')
    const confirm = fakeConfirm(false)

    await expect(filesGuard.confirmLeave(confirm)).resolves.toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('leaving dirty on Cancel keeps the buffer and blocks', async () => {
    filesGuard.setOpenFile('notes.md')
    filesGuard.report(true)

    await expect(filesGuard.confirmLeave(fakeConfirm(false))).resolves.toBe(false)
    expect(filesGuard.isDirty()).toBe(true)
  })

  it('leaving dirty on Discard is allowed and clears the buffer', async () => {
    filesGuard.setOpenFile('notes.md')
    filesGuard.report(true)
    const confirm = fakeConfirm(true)

    await expect(filesGuard.confirmLeave(confirm)).resolves.toBe(true)
    expect(confirm).toHaveBeenCalledWith('Discard unsaved changes to notes.md?', expect.anything())
    expect(filesGuard.isDirty()).toBe(false)
  })
})
