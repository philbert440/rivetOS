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
    linger: true,
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
    useChat.setState({
      sessionAliases: {},
      opened: [],
      drafts: [],
      messages: {},
      transcripts: {},
      harnessBound: {},
      live: {},
      outbound: {},
      active: undefined,
    })
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

  function trackWatch(): { watched: Set<string>; unwatch: ReturnType<typeof vi.fn> } {
    const watched = new Set<string>()
    const unwatch = vi.fn()
    useChat.setState({
      watchTranscript: (id: string) => {
        originals.watchTranscript(id)
        watched.add(useChat.getState().resolveSessionKey(id))
      },
      unwatchTranscript: (id: string) => {
        unwatch(id)
        originals.unwatchTranscript(id)
        watched.delete(useChat.getState().resolveSessionKey(id))
      },
    })
    return { watched, unwatch }
  }

  function trackUnbind(): ReturnType<typeof vi.fn> {
    const unbind = vi.fn()
    useChat.setState({
      unbindHarness: (id: string) => {
        unbind(id)
        originals.unbindHarness(id)
      },
    })
    return unbind
  }

  it('keeps a held watch across a draft rekey when the old linger expires', async () => {
    vi.useFakeTimers()
    const { watched, unwatch } = trackWatch()
    const draft = bindSessionStream(args({ sessionId: 'draft-1' }))
    expect(watched.has('draft-1')).toBe(true)
    draft()
    useChat.getState().rekey('draft-1', 'canon-1')
    const held = bindSessionStream(args({ sessionId: 'canon-1' }))
    expect(watched.has('canon-1')).toBe(true)
    await vi.advanceTimersByTimeAsync(LINGER_MS)
    expect(unwatch).not.toHaveBeenCalled()
    expect(watched.has('canon-1')).toBe(true)
    held()
  })

  it('keeps a held attach across a draft rekey when the old linger expires', async () => {
    vi.useFakeTimers()
    const unbind = trackUnbind()
    const streamId = 'claude-code:native-1'
    const draft = bindSessionStream(
      args({ sessionId: 'draft-1', streamId, harnessId: 'claude-code' }),
    )
    await Promise.resolve()
    draft()
    useChat.getState().rekey('draft-1', 'claude-code:native-1')
    const held = bindSessionStream(
      args({ sessionId: 'claude-code:native-1', streamId, harnessId: 'claude-code' }),
    )
    await Promise.resolve()
    expect(attachHarnessSession).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(LINGER_MS)
    expect(unbind).not.toHaveBeenCalled()
    expect(useChat.getState().harnessBound['claude-code:native-1']).toBe(true)
    held()
  })

  it('does not close a moved attach when the destination only watches', async () => {
    const closes: Array<ReturnType<typeof vi.fn>> = []
    vi.mocked(attachHarnessSession).mockImplementation(() => {
      const close = vi.fn()
      closes.push(close)
      return { close, resync: vi.fn(), sync: vi.fn() }
    })
    const unbind = trackUnbind()
    const streamId = 'claude-code:native-1'
    const moved = bindSessionStream(
      args({ sessionId: 'draft-1', streamId, harnessId: 'claude-code' }),
    )
    const destination = bindSessionStream(args({ sessionId: 'canon-1' }))
    await Promise.resolve()
    expect(closes).toHaveLength(1)
    useChat.getState().rekey('draft-1', 'canon-1')
    expect(closes[0]).not.toHaveBeenCalled()
    expect(unbind).not.toHaveBeenCalled()
    expect(useChat.getState().harnessBound['canon-1']).toBe(true)
    moved()
    destination()
  })

  it('unwatches a moved watch when the destination already has an attach', async () => {
    const closes: Array<ReturnType<typeof vi.fn>> = []
    vi.mocked(attachHarnessSession).mockImplementation(() => {
      const close = vi.fn()
      closes.push(close)
      return { close, resync: vi.fn(), sync: vi.fn() }
    })
    const { unwatch } = trackWatch()
    const unbind = trackUnbind()
    const streamId = 'claude-code:native-1'
    const moved = bindSessionStream(args({ sessionId: 'draft-1' }))
    const destination = bindSessionStream(
      args({ sessionId: 'canon-1', streamId, harnessId: 'claude-code' }),
    )
    await Promise.resolve()
    useChat.getState().rekey('draft-1', 'canon-1')
    expect(unwatch).toHaveBeenCalledWith('draft-1')
    expect(unbind).not.toHaveBeenCalled()
    expect(closes[0]).not.toHaveBeenCalled()
    expect(useChat.getState().harnessBound['canon-1']).toBe(true)
    moved()
    destination()
  })

  it('adopts a bare native id with one attach and ignores the superseded promise', async () => {
    let resolveGw: (gw: HarnessAttachGateway) => void = () => undefined
    const pending = new Promise<HarnessAttachGateway>((resolve) => {
      resolveGw = resolve
    })
    const sessionGateway = (): Promise<HarnessAttachGateway> => pending
    const streamId = 'claude-code:native-1'
    const bare = bindSessionStream(
      args({ sessionId: 'native-1', streamId, harnessId: 'claude-code', sessionGateway }),
    )
    bare()
    const held = bindSessionStream(
      args({
        sessionId: streamId,
        streamId,
        harnessId: 'claude-code',
        sessionGateway,
      }),
    )
    useChat.getState().adoptSessionKey(streamId)
    resolveGw(gateway)
    await Promise.resolve()
    await Promise.resolve()
    expect(attachHarnessSession).toHaveBeenCalledTimes(1)
    held()
  })

  it('leaves a held session intact when an aliased idle lease would have been the oldest', async () => {
    const closes: Array<ReturnType<typeof vi.fn>> = []
    vi.mocked(attachHarnessSession).mockImplementation(() => {
      const close = vi.fn()
      closes.push(close)
      return { close, resync: vi.fn(), sync: vi.fn() }
    })
    const unbind = trackUnbind()
    const streamId = 'claude-code:native-1'
    const bare = bindSessionStream(
      args({ sessionId: 'native-1', streamId, harnessId: 'claude-code' }),
    )
    await Promise.resolve()
    bare()
    useChat.getState().adoptSessionKey(streamId)
    const held = bindSessionStream(
      args({ sessionId: streamId, streamId, harnessId: 'claude-code' }),
    )
    await Promise.resolve()
    expect(attachHarnessSession).toHaveBeenCalledTimes(1)
    const idle: Array<() => void> = []
    for (let i = 0; i < 25; i++) {
      const id = `claude-code:idle-${String(i)}`
      idle.push(bindSessionStream(args({ sessionId: id, streamId: id, harnessId: 'claude-code' })))
    }
    await Promise.resolve()
    for (const release of idle) release()
    expect(closes[0]).not.toHaveBeenCalled()
    const unbound = unbind.mock.calls.map((call) => call[0])
    expect(unbound).not.toContain('native-1')
    expect(unbound).not.toContain(streamId)
    expect(useChat.getState().harnessBound[streamId]).toBe(true)
    held()
  })

  it('stops a released lease immediately when linger is off (drawer and narrow)', async () => {
    const { unwatch } = trackWatch()
    const unbind = trackUnbind()
    const releaseA = bindSessionStream(args({ sessionId: 'sess-a', linger: false }))
    bindSessionStream(args({ sessionId: 'sess-b', linger: false }))
    releaseA()
    expect(unwatch).toHaveBeenCalledWith('sess-a')

    const closes: Array<ReturnType<typeof vi.fn>> = []
    vi.mocked(attachHarnessSession).mockImplementation(() => {
      const close = vi.fn()
      closes.push(close)
      return { close, resync: vi.fn(), sync: vi.fn() }
    })
    const harnessA = bindSessionStream(
      args({
        sessionId: 'ha',
        streamId: 'claude-code:ha',
        harnessId: 'claude-code',
        linger: false,
      }),
    )
    await Promise.resolve()
    bindSessionStream(
      args({
        sessionId: 'hb',
        streamId: 'claude-code:hb',
        harnessId: 'claude-code',
        linger: false,
      }),
    )
    harnessA()
    expect(closes[0]).toHaveBeenCalledTimes(1)
    expect(unbind).toHaveBeenCalledWith('ha')
  })

  it('retires the legacy watch when the same session gains a stream', async () => {
    const { unwatch } = trackWatch()
    const unbind = trackUnbind()
    const watchRelease = bindSessionStream(args({ sessionId: 'sess-1' }))
    const attachRelease = bindSessionStream(
      args({ sessionId: 'sess-1', streamId: 'claude-code:sess-1', harnessId: 'claude-code' }),
    )
    expect(unwatch).toHaveBeenCalledWith('sess-1')
    await Promise.resolve()
    expect(attachHarnessSession).toHaveBeenCalledTimes(1)
    watchRelease()
    expect(unbind).not.toHaveBeenCalled()
    const held = vi.mocked(attachHarnessSession).mock.results[0]?.value as {
      close: ReturnType<typeof vi.fn>
    }
    expect(held.close).not.toHaveBeenCalled()
    attachRelease()
  })

  it('closes the rotated socket so one resolved session has one attachment', async () => {
    const closes: Array<ReturnType<typeof vi.fn>> = []
    vi.mocked(attachHarnessSession).mockImplementation(() => {
      const close = vi.fn()
      closes.push(close)
      return { close, resync: vi.fn(), sync: vi.fn() }
    })
    const u1 = 'claude-code:U1'
    const u2 = 'claude-code:U2'
    const first = bindSessionStream(args({ sessionId: u1, streamId: u1, harnessId: 'claude-code' }))
    await Promise.resolve()
    first()
    useChat.getState().adoptSessionKey(u2, u1)
    const second = bindSessionStream(
      args({ sessionId: u2, streamId: u2, harnessId: 'claude-code' }),
    )
    await Promise.resolve()
    expect(attachHarnessSession).toHaveBeenCalledTimes(2)
    expect(closes[0]).toHaveBeenCalledTimes(1)
    expect(closes[1]).not.toHaveBeenCalled()
    second()
  })

  it('keeps the open socket when an attached lease folds into a pending one', async () => {
    let resolveGw: (gw: HarnessAttachGateway) => void = () => undefined
    const pending = new Promise<HarnessAttachGateway>((resolve) => {
      resolveGw = resolve
    })
    const closes: Array<ReturnType<typeof vi.fn>> = []
    vi.mocked(attachHarnessSession).mockImplementation(() => {
      const close = vi.fn()
      closes.push(close)
      return { close, resync: vi.fn(), sync: vi.fn() }
    })
    const onError = vi.fn()
    const streamId = 'claude-code:native-1'
    const bare = bindSessionStream(
      args({ sessionId: 'native-1', streamId, harnessId: 'claude-code' }),
    )
    await Promise.resolve()
    expect(closes).toHaveLength(1)
    bare()
    const held = bindSessionStream(
      args({
        sessionId: streamId,
        streamId,
        harnessId: 'claude-code',
        sessionGateway: () => pending,
        onStreamError: onError,
      }),
    )
    useChat.getState().adoptSessionKey(streamId)
    resolveGw(gateway)
    await Promise.resolve()
    await Promise.resolve()
    expect(attachHarnessSession).toHaveBeenCalledTimes(1)
    expect(closes[0]).not.toHaveBeenCalled()
    const opts = vi.mocked(attachHarnessSession).mock.calls[0]?.[0]
    if (!opts?.onError || !opts.onStatus) throw new Error('missing attach handlers')
    opts.onError(new Error('boom'))
    expect(onError).toHaveBeenCalledWith('boom')
    opts.onStatus('open')
    expect(onError).toHaveBeenLastCalledWith(undefined)
    held()
  })

  it('does not drop a session when an older idle lease expires, and re-acquire restores it', async () => {
    vi.useFakeTimers()
    const { watched, unwatch } = trackWatch()
    const older = bindSessionStream(args({ sessionId: 'sess-1' }))
    older()
    await vi.advanceTimersByTimeAsync(1)
    const younger = bindSessionStream(args({ sessionId: 'sess-1', harnessId: 'claude-code' }))
    younger()
    expect(watched.has('sess-1')).toBe(true)
    await vi.advanceTimersByTimeAsync(LINGER_MS - 1)
    expect(unwatch).not.toHaveBeenCalled()
    expect(watched.has('sess-1')).toBe(true)
    useChat.getState().unwatchTranscript('sess-1')
    expect(watched.has('sess-1')).toBe(false)
    const again = bindSessionStream(args({ sessionId: 'sess-1', harnessId: 'claude-code' }))
    expect(watched.has('sess-1')).toBe(true)
    again()

    const unbind = trackUnbind()
    const streamId = 'claude-code:sess-1'
    const attached = bindSessionStream(
      args({ sessionId: 'sess-1', streamId, harnessId: 'claude-code' }),
    )
    await Promise.resolve()
    attached()
    expect(useChat.getState().harnessBound['sess-1']).toBe(true)
    useChat.getState().unbindHarness('sess-1')
    expect(unbind).toHaveBeenCalledWith('sess-1')
    expect(useChat.getState().harnessBound['sess-1']).toBeUndefined()
    const rebound = bindSessionStream(
      args({ sessionId: 'sess-1', streamId, harnessId: 'claude-code' }),
    )
    expect(useChat.getState().harnessBound['sess-1']).toBe(true)
    expect(useChat.getState().transcripts['sess-1']?.turns).toEqual([])
    rebound()
  })

  it('keeps a held destination when it was created before the rotation', async () => {
    vi.useFakeTimers()
    const closes: Array<ReturnType<typeof vi.fn>> = []
    const sessions: string[] = []
    vi.mocked(attachHarnessSession).mockImplementation((opts) => {
      sessions.push(opts.sessionId)
      const close = vi.fn()
      closes.push(close)
      return { close, resync: vi.fn(), sync: vi.fn() }
    })
    const unbind = trackUnbind()
    const onU2 = vi.fn()
    const u1 = 'claude-code:U1'
    const u2 = 'claude-code:U2'
    const predecessor = bindSessionStream(
      args({ sessionId: u1, streamId: u1, harnessId: 'claude-code' }),
    )
    await Promise.resolve()
    predecessor()
    const held = bindSessionStream(
      args({
        sessionId: u2,
        streamId: u2,
        harnessId: 'claude-code',
        onStreamError: onU2,
      }),
    )
    await Promise.resolve()
    useChat.getState().adoptSessionKey(u2, u1)
    expect(sessions).toEqual([u1, u2])
    expect(closes[0]).toHaveBeenCalledTimes(1)
    expect(closes[1]).not.toHaveBeenCalled()
    expect(useChat.getState().harnessBound[u2]).toBe(true)
    expect(unbind).not.toHaveBeenCalled()
    const live = vi.mocked(attachHarnessSession).mock.calls[1]?.[0]
    if (!live?.onStatus) throw new Error('missing U2 attach handlers')
    live.onStatus('open')
    expect(onU2).toHaveBeenCalledWith(undefined)
    await vi.advanceTimersByTimeAsync(LINGER_MS)
    expect(closes[1]).not.toHaveBeenCalled()
    expect(useChat.getState().harnessBound[u2]).toBe(true)
    expect(unbind).not.toHaveBeenCalled()
    live.onStatus('open')
    expect(onU2).toHaveBeenCalledTimes(2)
    const again = bindSessionStream(args({ sessionId: u2, streamId: u2, harnessId: 'claude-code' }))
    await Promise.resolve()
    expect(attachHarnessSession).toHaveBeenCalledTimes(2)
    again()
    held()
  })

  it('attaches the created successor after a rotation and keeps that reader', async () => {
    vi.useFakeTimers()
    const closes: Array<ReturnType<typeof vi.fn>> = []
    const sessions: string[] = []
    vi.mocked(attachHarnessSession).mockImplementation((opts) => {
      sessions.push(opts.sessionId)
      const close = vi.fn()
      closes.push(close)
      return { close, resync: vi.fn(), sync: vi.fn() }
    })
    const unbind = trackUnbind()
    const onU2 = vi.fn()
    const u1 = 'claude-code:U1'
    const u2 = 'claude-code:U2'
    const predecessor = bindSessionStream(
      args({ sessionId: u1, streamId: u1, harnessId: 'claude-code' }),
    )
    await Promise.resolve()
    predecessor()
    useChat.getState().adoptSessionKey(u2, u1)
    const held = bindSessionStream(
      args({
        sessionId: u2,
        streamId: u2,
        harnessId: 'claude-code',
        onStreamError: onU2,
      }),
    )
    await Promise.resolve()
    expect(sessions).toEqual([u1, u2])
    expect(closes[0]).toHaveBeenCalledTimes(1)
    expect(closes[1]).not.toHaveBeenCalled()
    expect(useChat.getState().harnessBound[u2]).toBe(true)
    expect(unbind).not.toHaveBeenCalled()
    const live = vi.mocked(attachHarnessSession).mock.calls[1]?.[0]
    if (!live?.onStatus) throw new Error('missing U2 attach handlers')
    live.onStatus('open')
    expect(onU2).toHaveBeenCalledWith(undefined)
    await vi.advanceTimersByTimeAsync(LINGER_MS)
    expect(closes[1]).not.toHaveBeenCalled()
    expect(useChat.getState().harnessBound[u2]).toBe(true)
    expect(unbind).not.toHaveBeenCalled()
    live.onStatus('open')
    expect(onU2).toHaveBeenCalledTimes(2)
    held()
  })
})
