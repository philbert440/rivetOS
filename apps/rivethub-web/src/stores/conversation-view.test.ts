import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeCanvasEnabled, useConversationView } from './conversation-view.js'

const KEY = 'rivethub.conversationView'

describe('canvasEnabled', () => {
  const values = new Map<string, string>()

  afterEach(() => {
    values.clear()
    vi.unstubAllGlobals()
    useConversationView.setState({ canvasEnabled: false, defaultView: 'chat' })
  })

  function storage(): void {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
      removeItem: (key: string) => {
        values.delete(key)
      },
    })
  }

  it('stays off unless the stored value is exactly true', () => {
    expect(useConversationView.getState().canvasEnabled).toBe(false)
    expect(normalizeCanvasEnabled(undefined)).toBe(false)
    expect(normalizeCanvasEnabled('true')).toBe(false)
    expect(normalizeCanvasEnabled(true)).toBe(true)
  })

  it('persists the setter', () => {
    storage()
    useConversationView.getState().setCanvasEnabled(true)
    expect(useConversationView.getState().canvasEnabled).toBe(true)
    expect(values.get(KEY)).toContain('"canvasEnabled":true')
    useConversationView.getState().setCanvasEnabled(false)
    expect(useConversationView.getState().canvasEnabled).toBe(false)
    expect(values.get(KEY)).toContain('"canvasEnabled":false')
  })

  it('restores a stored true and keeps a record without the flag off', async () => {
    storage()
    values.set(KEY, JSON.stringify({ state: { defaultView: 'terminal' }, version: 0 }))
    await useConversationView.persist.rehydrate()
    expect(useConversationView.getState().canvasEnabled).toBe(false)
    expect(useConversationView.getState().defaultView).toBe('terminal')

    values.set(
      KEY,
      JSON.stringify({ state: { defaultView: 'chat', canvasEnabled: true }, version: 0 }),
    )
    await useConversationView.persist.rehydrate()
    expect(useConversationView.getState().canvasEnabled).toBe(true)
  })
})
