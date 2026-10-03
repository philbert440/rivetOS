import { describe, expect, it, vi } from 'vitest'
import {
  confirmDiscard,
  discardMessage,
  DISCARD_CONFIRM_OPTS,
  guardClosePreview,
  guardOpenFile,
  guardPathNav,
  shouldBlockFilesLeave,
  shouldIgnoreRowActivate,
} from './files-dirty-guard.js'

function fakeConfirm(answer: boolean) {
  return vi.fn(async () => answer)
}

describe('confirmDiscard', () => {
  it('clean never prompts and returns true', async () => {
    const confirm = fakeConfirm(true)
    const clearDirty = vi.fn()
    await expect(
      confirmDiscard({ dirty: false, confirm, clearDirty, fileName: 'a.md' }),
    ).resolves.toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(clearDirty).not.toHaveBeenCalled()
  })

  it('dirty + Cancel keeps the buffer (no clearDirty) and returns false', async () => {
    const confirm = fakeConfirm(false)
    const clearDirty = vi.fn()
    await expect(
      confirmDiscard({ dirty: true, confirm, clearDirty, fileName: 'notes.md' }),
    ).resolves.toBe(false)
    expect(confirm).toHaveBeenCalledWith(discardMessage('notes.md'), DISCARD_CONFIRM_OPTS)
    expect(clearDirty).not.toHaveBeenCalled()
  })

  it('dirty + Discard clears dirty then returns true', async () => {
    const confirm = fakeConfirm(true)
    const clearDirty = vi.fn()
    await expect(
      confirmDiscard({ dirty: true, confirm, clearDirty, fileName: 'notes.md' }),
    ).resolves.toBe(true)
    expect(clearDirty).toHaveBeenCalledOnce()
  })

  it('names the file in the prompt when provided', async () => {
    const confirm = fakeConfirm(true)
    await confirmDiscard({ dirty: true, confirm, clearDirty: () => undefined, fileName: 'x.md' })
    expect(confirm.mock.calls[0]?.[0]).toBe('Discard unsaved changes to x.md?')
  })
})

describe('guardPathNav', () => {
  it('same-path is a no-op before any confirm (disarm bug)', () => {
    expect(guardPathNav('/a/b', '/a/b')).toBe('noop')
    expect(guardPathNav('', '')).toBe('noop')
  })

  it('different path proceeds so the caller can navigate', () => {
    expect(guardPathNav('/a', '/a/b')).toBe('proceed')
    expect(guardPathNav('a/b', '')).toBe('proceed')
  })
})

describe('guardOpenFile', () => {
  it('same-file is a no-op with no prompt', async () => {
    const confirm = fakeConfirm(true)
    const clearDirty = vi.fn()
    await expect(
      guardOpenFile({
        dirty: true,
        previewPath: 'dir/x.md',
        child: 'dir/x.md',
        confirm,
        clearDirty,
      }),
    ).resolves.toBe('noop')
    expect(confirm).not.toHaveBeenCalled()
    expect(clearDirty).not.toHaveBeenCalled()
  })

  it('dirty + Cancel does not navigate (cancel)', async () => {
    const confirm = fakeConfirm(false)
    const clearDirty = vi.fn()
    await expect(
      guardOpenFile({
        dirty: true,
        previewPath: 'a.md',
        child: 'b.md',
        confirm,
        clearDirty,
        fileName: 'a.md',
      }),
    ).resolves.toBe('cancel')
    expect(clearDirty).not.toHaveBeenCalled()
  })

  it('dirty + OK clears dirty then proceeds', async () => {
    const confirm = fakeConfirm(true)
    const clearDirty = vi.fn()
    await expect(
      guardOpenFile({
        dirty: true,
        previewPath: 'a.md',
        child: 'b.md',
        confirm,
        clearDirty,
        fileName: 'a.md',
      }),
    ).resolves.toBe('proceed')
    expect(clearDirty).toHaveBeenCalledOnce()
  })

  it('clean opens another file without prompting', async () => {
    const confirm = fakeConfirm(true)
    await expect(
      guardOpenFile({
        dirty: false,
        previewPath: 'a.md',
        child: 'b.md',
        confirm,
        clearDirty: () => undefined,
      }),
    ).resolves.toBe('proceed')
    expect(confirm).not.toHaveBeenCalled()
  })
})

describe('guardClosePreview', () => {
  it('Cancel keeps the pane open', async () => {
    const confirm = fakeConfirm(false)
    const clearDirty = vi.fn()
    await expect(
      guardClosePreview({ dirty: true, confirm, clearDirty, fileName: 'a.md' }),
    ).resolves.toBe('cancel')
    expect(clearDirty).not.toHaveBeenCalled()
  })

  it('OK clears dirty then proceeds', async () => {
    const confirm = fakeConfirm(true)
    const clearDirty = vi.fn()
    await expect(
      guardClosePreview({ dirty: true, confirm, clearDirty, fileName: 'a.md' }),
    ).resolves.toBe('proceed')
    expect(clearDirty).toHaveBeenCalledOnce()
  })
})

describe('shouldBlockFilesLeave', () => {
  it('clean never blocks', async () => {
    const confirm = fakeConfirm(true)
    await expect(
      shouldBlockFilesLeave({ dirty: false, confirm, clearDirty: () => undefined }),
    ).resolves.toBe(false)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('dirty + Cancel blocks', async () => {
    await expect(
      shouldBlockFilesLeave({
        dirty: true,
        confirm: fakeConfirm(false),
        clearDirty: () => undefined,
      }),
    ).resolves.toBe(true)
  })

  it('dirty + Discard clears dirty and does not block', async () => {
    const clearDirty = vi.fn()
    await expect(
      shouldBlockFilesLeave({ dirty: true, confirm: fakeConfirm(true), clearDirty }),
    ).resolves.toBe(false)
    expect(clearDirty).toHaveBeenCalledOnce()
  })
})

describe('shouldIgnoreRowActivate', () => {
  it('ignores the checkbox cell via data-no-open', () => {
    const cell = { closest: (sel: string) => (sel.includes('[data-no-open]') ? {} : null) }
    expect(shouldIgnoreRowActivate({ detail: 1, target: cell as unknown as EventTarget })).toBe(
      true,
    )
  })

  it('ignores detail > 1 (second click of a double-click)', () => {
    expect(shouldIgnoreRowActivate({ detail: 2, target: null })).toBe(true)
  })

  it('ignores a non-empty text selection', () => {
    expect(shouldIgnoreRowActivate({ detail: 1, target: null, selectionText: 'filename.md' })).toBe(
      true,
    )
  })

  it('allows a plain single click with no selection', () => {
    const el = { closest: () => null }
    expect(
      shouldIgnoreRowActivate({
        detail: 1,
        target: el as unknown as EventTarget,
        selectionText: '',
      }),
    ).toBe(false)
  })
})
