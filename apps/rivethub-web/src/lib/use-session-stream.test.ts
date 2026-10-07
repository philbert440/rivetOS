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
import { bindSessionStream, LINGER_MS, resetSessionStreams } from './use-session-stream.js'
import { useChat } from '../stores/chat.js'
import { useConnection } from '../stores/connection.js'

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
    transportEpoch: 0,
    sessionGateway: () => Promise.resolve(gateway),
    queryClient,
    onStreamError: () => undefined,
    ...over,
  }
}

function harnessArgs(sessionId: string) {
  return args({ sessionId, streamId: sessionId, harnessId: 'claude-code' })
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
  const epoch = useConnection.getState().transportEpoch

  afterEach(() => {
    resetSessionStreams()
    vi.useRealTimers()
    watch.mockClear()
    unwatch.mockClear()
    vi.mocked(attachHarnessSession).mockReset()
    vi.mocked(attachHarnessSession).mockImplementation(() => ({
      close: vi.fn(),
      resync: vi.fn(),
      sync: vi.fn(),
    }))
    useChat.setState({
      watchTranscript: originals.watchTranscript,
      unwatchTranscript: originals.unwatchTranscript,
      bindHarness: originals.bindHarness,
      unbindHarness: originals.unbindHarness,
    })
    if (useConnection.getState().transportEpoch !== epoch) {
      useConnection.setState({ transportEpoch: epoch })
    }
  })

  it('shares one legacy watch and keeps it warm after the last reader leaves', () => {
    useChat.setState({ watchTranscript: watch, unwatchTranscript: unwatch })
    const releaseA = bindSessionStream(args())
    const releaseB = bindSessionStream(args())
    expect(watch).toHaveBeenCalledTimes(1)
    expect(watch).toHaveBeenCalledWith('sess-1')
    releaseA()
    expect(unwatch).not.toHaveBeenCalled()
    releaseB()
    expect(unwatch).not.toHaveBeenCalled()
  })

  it('does not watch a remote thread that has no control-plane stream yet', () => {
    useChat.setState({ watchTranscript: watch, unwatchTranscript: unwatch })
    const release = bindSessionStream(args({ isRemote: true }))
    expect(watch).not.toHaveBeenCalled()
    release()
    expect(unwatch).not.toHaveBeenCalled()
  })

  it('mini then thread then mini attaches once and does not close', async () => {
    const mini = bindSessionStream(harnessArgs('sess-1'))
    const thread = bindSessionStream(harnessArgs('sess-1'))
    await Promise.resolve()
    expect(attachHarnessSession).toHaveBeenCalledTimes(1)
    const held = vi.mocked(attachHarnessSession).mock.results[0]?.value as {
      close: ReturnType<typeof vi.fn>
    }
    mini()
    thread()
    expect(held.close).not.toHaveBeenCalled()
    const again = bindSessionStream(harnessArgs('sess-1'))
    await Promise.resolve()
    expect(attachHarnessSession).toHaveBeenCalledTimes(1)
    expect(held.close).not.toHaveBeenCalled()
    again()
  })

  it('reuses the live attachment when re-acquired inside the linger window', async () => {
    const release = bindSessionStream(harnessArgs('sess-1'))
    await Promise.resolve()
    const held = vi.mocked(attachHarnessSession).mock.results[0]?.value as {
      close: ReturnType<typeof vi.fn>
    }
    release()
    const again = bindSessionStream(harnessArgs('sess-1'))
    await Promise.resolve()
    expect(attachHarnessSession).toHaveBeenCalledTimes(1)
    expect(held.close).not.toHaveBeenCalled()
    again()
  })

  it('closes and unbinds when the linger window ends', async () => {
    vi.useFakeTimers()
    const unbind = vi.fn()
    useChat.setState({ unbindHarness: unbind })
    const release = bindSessionStream(harnessArgs('sess-1'))
    await Promise.resolve()
    const held = vi.mocked(attachHarnessSession).mock.results[0]?.value as {
      close: ReturnType<typeof vi.fn>
    }
    release()
    expect(held.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(LINGER_MS)
    expect(held.close).toHaveBeenCalledTimes(1)
    expect(unbind).toHaveBeenCalledWith('sess-1')
  })

  it('stops the oldest idle lease past the warm cap and leaves held leases', async () => {
    const closes: Array<ReturnType<typeof vi.fn>> = []
    vi.mocked(attachHarnessSession).mockImplementation(() => {
      const close = vi.fn()
      closes.push(close)
      return { close, resync: vi.fn(), sync: vi.fn() }
    })
    const held = bindSessionStream(harnessArgs('held'))
    const idle: Array<() => void> = []
    for (let i = 0; i < 25; i++) idle.push(bindSessionStream(harnessArgs(`idle-${String(i)}`)))
    await Promise.resolve()
    for (const release of idle) release()
    expect(closes[0]).not.toHaveBeenCalled()
    expect(closes[1]).toHaveBeenCalledTimes(1)
    for (const close of closes.slice(2)) expect(close).not.toHaveBeenCalled()
    held()
  })

  it('closes every lease on an epoch bump and the next acquire opens fresh', async () => {
    const closes: Array<ReturnType<typeof vi.fn>> = []
    vi.mocked(attachHarnessSession).mockImplementation(() => {
      const close = vi.fn()
      closes.push(close)
      return { close, resync: vi.fn(), sync: vi.fn() }
    })
    const release = bindSessionStream(
      args({ streamId: 'claude-code:native-1', harnessId: 'claude-code', transportEpoch: epoch }),
    )
    await Promise.resolve()
    expect(closes).toHaveLength(1)
    useConnection.setState({ transportEpoch: epoch + 1 })
    expect(closes[0]).toHaveBeenCalledTimes(1)
    const again = bindSessionStream(
      args({
        streamId: 'claude-code:native-1',
        harnessId: 'claude-code',
        transportEpoch: epoch + 1,
      }),
    )
    await Promise.resolve()
    expect(closes).toHaveLength(2)
    expect(closes[1]).not.toHaveBeenCalled()
    again()
    release()
  })
})
