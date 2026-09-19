import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Runtime } from '@rivetos/core'
import { registerShutdownHandlers } from './lifecycle.js'

type SignalHandler = () => void

describe('registerShutdownHandlers', () => {
  const captured = new Map<string, SignalHandler[]>()
  const originalOn = process.on.bind(process)
  let onSpy: ReturnType<typeof vi.spyOn> | undefined
  let exitSpy: ReturnType<typeof vi.spyOn> | undefined
  const tempDirs: string[] = []

  afterEach(async () => {
    onSpy?.mockRestore()
    exitSpy?.mockRestore()
    onSpy = undefined
    exitSpy = undefined
    captured.clear()
    const dirs = tempDirs.splice(0)
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function makePidDir(): Promise<{ pidDir: string; pidPath: string }> {
    const pidDir = await mkdtemp(join(tmpdir(), 'rivetos-lifecycle-'))
    tempDirs.push(pidDir)
    const pidPath = join(pidDir, 'rivetos.pid')
    await writeFile(pidPath, String(process.pid))
    return { pidDir, pidPath }
  }

  function stubProcess(trace: string[], pidPath: string): void {
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
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      if (!existsSync(pidPath)) trace.push('pid-file removal')
      trace.push('exit')
      return undefined
    }) as typeof process.exit)
  }

  function fire(signal: 'SIGINT' | 'SIGTERM'): void {
    for (const handler of captured.get(signal) ?? []) {
      handler()
    }
  }

  function tracedStop(
    trace: string[],
    impl: () => Promise<void>,
  ): ReturnType<typeof vi.fn> {
    return vi.fn(async () => {
      trace.push('stop')
      await impl()
    })
  }

  function tracedAfterStop(
    trace: string[],
    pidPath: string,
    impl: () => Promise<void> = async () => undefined,
  ): ReturnType<typeof vi.fn> {
    return vi.fn(async () => {
      if (existsSync(pidPath)) trace.push('afterStop')
      await impl()
    })
  }

  it('two signals in quick succession run stop, afterStop, pid removal, and exit once', async () => {
    const { pidDir, pidPath } = await makePidDir()
    const trace: string[] = []
    stubProcess(trace, pidPath)
    const runtime = { stop: tracedStop(trace, async () => undefined) }
    const afterStop = tracedAfterStop(trace, pidPath)
    registerShutdownHandlers(runtime as unknown as Runtime, pidDir, afterStop)

    fire('SIGTERM')
    fire('SIGINT')

    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledTimes(1)
    })
    expect(runtime.stop).toHaveBeenCalledTimes(1)
    expect(afterStop).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(0)
    expect(existsSync(pidPath)).toBe(false)
    expect(trace).toEqual(['stop', 'afterStop', 'pid-file removal', 'exit'])
  })

  it('continues after stop rejection and does not invoke stop on a second signal', async () => {
    const { pidDir, pidPath } = await makePidDir()
    const trace: string[] = []
    stubProcess(trace, pidPath)
    let rejectStop!: (reason: Error) => void
    const runtime = {
      stop: tracedStop(
        trace,
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectStop = reject
          }),
      ),
    }
    const afterStop = tracedAfterStop(trace, pidPath)
    registerShutdownHandlers(runtime as unknown as Runtime, pidDir, afterStop)

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
    expect(existsSync(pidPath)).toBe(false)
    expect(trace).toEqual(['stop', 'afterStop', 'pid-file removal', 'exit'])

    fire('SIGTERM')
    expect(runtime.stop).toHaveBeenCalledTimes(1)
    expect(afterStop).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, null] as const)(
    'continues after stop rejecting with %s and does not invoke stop on a second signal',
    async (reason) => {
      const { pidDir, pidPath } = await makePidDir()
      const trace: string[] = []
      stubProcess(trace, pidPath)
      const runtime = {
        stop: tracedStop(trace, () => Promise.reject(reason)),
      }
      const afterStop = tracedAfterStop(trace, pidPath)
      registerShutdownHandlers(runtime as unknown as Runtime, pidDir, afterStop)

      fire('SIGTERM')
      fire('SIGINT')

      await vi.waitFor(() => {
        expect(exitSpy).toHaveBeenCalledTimes(1)
      })
      expect(runtime.stop).toHaveBeenCalledTimes(1)
      expect(afterStop).toHaveBeenCalledTimes(1)
      expect(exitSpy).toHaveBeenCalledWith(0)
      expect(existsSync(pidPath)).toBe(false)
      expect(trace).toEqual(['stop', 'afterStop', 'pid-file removal', 'exit'])

      fire('SIGTERM')
      expect(runtime.stop).toHaveBeenCalledTimes(1)
      expect(afterStop).toHaveBeenCalledTimes(1)
      expect(exitSpy).toHaveBeenCalledTimes(1)
    },
  )

  it('continues after afterStop rejecting with undefined', async () => {
    const { pidDir, pidPath } = await makePidDir()
    const trace: string[] = []
    stubProcess(trace, pidPath)
    const runtime = { stop: tracedStop(trace, async () => undefined) }
    const afterStop = tracedAfterStop(trace, pidPath, () => Promise.reject(undefined))
    registerShutdownHandlers(runtime as unknown as Runtime, pidDir, afterStop)

    fire('SIGTERM')

    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledTimes(1)
    })
    expect(runtime.stop).toHaveBeenCalledTimes(1)
    expect(afterStop).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(0)
    expect(existsSync(pidPath)).toBe(false)
    expect(trace).toEqual(['stop', 'afterStop', 'pid-file removal', 'exit'])
  })
})
