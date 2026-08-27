import { describe, expect, it } from 'vitest'
import { createDialogQueue, dialogCancelValue, type DialogRequest } from './confirm-dialog-queue.js'

function req(
  kind: DialogRequest['kind'],
  message: string,
): DialogRequest & {
  settledWith: (string | boolean | undefined)[]
} {
  const settledWith: (string | boolean | undefined)[] = []
  return {
    kind,
    message,
    settledWith,
    resolve: (v) => settledWith.push(v),
  }
}

describe('createDialogQueue', () => {
  it('shows one dialog at a time and promotes the next on settle', () => {
    const shown: (string | undefined)[] = []
    const q = createDialogQueue((r) => shown.push(r?.message))
    const a = req('confirm', 'a')
    const b = req('confirm', 'b')
    q.show(a)
    q.show(b)
    expect(q.current()?.message).toBe('a')
    q.settle(true)
    expect(a.settledWith).toEqual([true])
    expect(b.settledWith).toEqual([])
    expect(q.current()?.message).toBe('b')
    expect(shown).toEqual(['a', 'b'])
  })

  it('resolves current + queued requests to their cancel values on settleAll (unmount)', () => {
    const shown: (string | undefined)[] = []
    const q = createDialogQueue((r) => shown.push(r?.message))
    const a = req('confirm', 'a')
    const b = req('prompt', 'b')
    const c = req('confirm', 'c')
    q.show(a)
    q.show(b)
    q.show(c)
    q.settleAll()
    // confirm cancels to false, prompt to undefined — call sites treat both
    // as abort, so a navigate-away never hangs an `await confirm(...)`.
    expect(a.settledWith).toEqual([false])
    expect(b.settledWith).toEqual([undefined])
    expect(c.settledWith).toEqual([false])
    expect(q.current()).toBeUndefined()
    expect(shown).toEqual(['a', undefined])
  })

  it('resolves every request exactly once even across settle + settleAll', () => {
    const q = createDialogQueue(() => undefined)
    const a = req('confirm', 'a')
    const b = req('prompt', 'b')
    q.show(a)
    q.show(b)
    q.settle(true)
    q.settleAll()
    expect(a.settledWith).toEqual([true])
    expect(b.settledWith).toEqual([undefined])
    // A second settleAll (StrictMode-style double cleanup) is a no-op.
    q.settleAll()
    expect(a.settledWith).toHaveLength(1)
    expect(b.settledWith).toHaveLength(1)
  })

  it('dialogCancelValue mirrors window.confirm/prompt', () => {
    expect(dialogCancelValue(req('confirm', 'x'))).toBe(false)
    expect(dialogCancelValue(req('prompt', 'x'))).toBeUndefined()
    expect(dialogCancelValue(req('choice', 'x'))).toBeUndefined()
  })

  it('choice cancel on settleAll does not hang the caller', () => {
    const q = createDialogQueue(() => undefined)
    const a = req('choice', 'keep or reset?')
    q.show(a)
    q.settleAll()
    expect(a.settledWith).toEqual([undefined])
  })
})
