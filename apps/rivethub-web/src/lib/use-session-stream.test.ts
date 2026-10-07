import type { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
    clear: () => values.clear(),
    key: () => null,
    get length() {
      return values.size
    },
  })
  vi.stubGlobal('sessionStorage', {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    get length() {
      return 0
    },
  })
  vi.stubGlobal('window', { location: { origin: 'http://192.168.1.20:8787' } })
})
import { attachHarnessSession, type HarnessAttachGateway } from './harness-attach.js'
import { bindSessionStream, resetSessionStreams } from './use-session-stream.js'
import { useChat } from '../stores/chat.js'

vi.mock('./harness-attach.js', () => ({
  attachHarnessSession: vi.fn(() => ({ close: vi.fn(), resync: vi.fn(), sync: vi.fn() })),
}))

const queryClient = { invalidateQueries: () => Promise.resolve() } as unknown as QueryClient
const gateway = {
  harnessSessionTranscript: () => Promise.resolve({ turns: [] }),
  watchHarnessSession: () => ({ close: () => undefined }),
} as unknown as HarnessAttachGateway

function args(over: Partial<Parameters<typeof bindSessionStream>[0]> = {}) {
  return {
    sessionId: 'sess-1',
    streamId: undefined as string | undefined,
    isRemote: false,
    sessionBase: 'http://192.168.1.20:8787',
    harnessId: undefined as string | undefined,
    sessionGateway: () => Promise.resolve(gateway),
    queryClient,
    onStreamError: () => undefined,
    ...over,
  }
}

describe('bindSessionStream', () => {
  const watch = vi.fn()
  const unwatch = vi.fn()
  const originals = {
    watchTranscript: useChat.getState().watchTranscript,
    unwatchTranscript: useChat.getState().unwatchTranscript,
    bindHarness: useChat.getState().bindHarness,
    unbindHarness: useChat.getState().unbindHarness,
  }

  afterEach(() => {
    resetSessionStreams()
    watch.mockClear()
    unwatch.mockClear()
    vi.mocked(attachHarnessSession).mockClear()
    useChat.setState({
      watchTranscript: originals.watchTranscript,
      unwatchTranscript: originals.unwatchTranscript,
      bindHarness: originals.bindHarness,
      unbindHarness: originals.unbindHarness,
    })
  })

  it('shares one legacy watch until the last reader leaves', () => {
    useChat.setState({ watchTranscript: watch, unwatchTranscript: unwatch })
    const releaseA = bindSessionStream(args())
    const releaseB = bindSessionStream(args())
    expect(watch).toHaveBeenCalledTimes(1)
    expect(watch).toHaveBeenCalledWith('sess-1')
    releaseA()
    expect(unwatch).not.toHaveBeenCalled()
    releaseB()
    expect(unwatch).toHaveBeenCalledTimes(1)
  })

  it('does not watch a remote thread that has no control-plane stream yet', () => {
    useChat.setState({ watchTranscript: watch, unwatchTranscript: unwatch })
    const release = bindSessionStream(args({ isRemote: true }))
    expect(watch).not.toHaveBeenCalled()
    release()
    expect(unwatch).not.toHaveBeenCalled()
  })

  it('shares one harness attachment until the last reader leaves', async () => {
    const releaseA = bindSessionStream(
      args({ streamId: 'claude-code:native-1', harnessId: 'claude-code' }),
    )
    const releaseB = bindSessionStream(
      args({ streamId: 'claude-code:native-1', harnessId: 'claude-code' }),
    )
    await Promise.resolve()
    expect(attachHarnessSession).toHaveBeenCalledTimes(1)
    const held = vi.mocked(attachHarnessSession).mock.results[0]?.value as
      { close: ReturnType<typeof vi.fn> } | undefined
    releaseA()
    expect(held?.close).not.toHaveBeenCalled()
    releaseB()
    expect(held?.close).toHaveBeenCalledTimes(1)
  })
})
