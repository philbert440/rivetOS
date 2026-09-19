import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Runtime } from '@rivetos/core'
import { registerShutdownHandlers } from './lifecycle.js'

type SignalHandler = () => void

describe('registerShutdownHandlers', () => {
  const captured = new Map<string, SignalHandler[]>()
  const originalOn = process.on.bind(process)
  let onSpy: ReturnType<typeof vi.spyOn> | undefined
  let exitSpy: ReturnType<typeof vi.spyOn> | undefined

  afterEach(() => {
    onSpy?.mockRestore()
    exitSpy?.mockRestore()
    onSpy = undefined
    exitSpy = undefined
    captured.clear()
  })

  function stubProcess(): void {
    captured.clear()
    onSpy = vi.spyOn(process, 'on').mockImplementation(((
      event: string | symbol,
      listener: (...args: unknown[]) => void,
    ) => {
      if (event === 'SIGINT' || event === 'SIGTERM') {
        const list = captured.get(event) ?? []
        list.push(listener as SignalHandler)
        captured.set(event, list)
        return process
      }
      return originalOn(event, listener)
    }) as typeof process.on)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit)
  }

  function fire(signal: 'SIGINT' | 'SIGTERM'): void {
    for (const handler of captured.get(signal) ?? []) {
      handler()
    }
  }

  it('two signals in quick succession run stop, afterStop, and exit once', async () => {
    stubProcess()
    const runtime = { stop: vi.fn(async () => undefined) }
    const afterStop = vi.fn(async () => undefined)
    registerShutdownHandlers(runtime as unknown as Runtime, '/no-such-rivetos-pid-dir', afterStop)

    fire('SIGTERM')
    fire('SIGINT')

    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledTimes(1)
    })
    expect(runtime.stop).toHaveBeenCalledTimes(1)
    expect(afterStop).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('continues after stop rejection and does not invoke stop on a second signal', async () => {
    stubProcess()
    let rejectStop!: (reason: Error) => void
    const runtime = {
      stop: vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectStop = reject
          }),
      ),
    }
    const afterStop = vi.fn(async () => undefined)
    registerShutdownHandlers(runtime as unknown as Runtime, '/no-such-rivetos-pid-dir', afterStop)

    fire('SIGTERM')
    expect(runtime.stop).toHaveBeenCalledTimes(1)
    fire('SIGINT')
    expect(runtime.stop).toHaveBeenCalledTimes(1)

    rejectStop(new Error('stop failed'))
    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledTimes(1)
    })
    expect(afterStop).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(0)

    fire('SIGTERM')
    expect(runtime.stop).toHaveBeenCalledTimes(1)
    expect(afterStop).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledTimes(1)
  })
})
