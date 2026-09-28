import { afterEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { OMARCHY_WATCH_DEBOUNCE_MS, omarchyCurrentDirs, watchOmarchyTheme } from './omarchy-watch.js'

const env = { home: '/home/u', platform: 'linux' as const, env: {} }
const current = path.join('/home/u', '.local', 'state', 'omarchy', 'current')

function fakeWatch() {
  const listeners = new Map<string, (event: string, filename: string | null) => void>()
  const closed: string[] = []
  const watch = (dir: string, listener: (event: string, filename: string | null) => void) => {
    listeners.set(dir, listener)
    return { close: () => closed.push(dir) }
  }
  return { watch, listeners, closed }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('omarchyCurrentDirs', () => {
  it('lists only existing current/ dirs', () => {
    expect(omarchyCurrentDirs(env, (p) => p === current)).toEqual([current])
    expect(omarchyCurrentDirs(env, () => false)).toEqual([])
  })
})

describe('watchOmarchyTheme', () => {
  it('debounces a theme switch burst into one call', () => {
    vi.useFakeTimers()
    const w = fakeWatch()
    const onChange = vi.fn()
    watchOmarchyTheme(onChange, { env, watch: w.watch, isDir: (p) => p === current })
    const emit = w.listeners.get(current)!
    emit('rename', 'next-theme')
    emit('rename', 'theme')
    emit('change', 'theme.name')
    expect(onChange).not.toHaveBeenCalled()
    vi.advanceTimersByTime(OMARCHY_WATCH_DEBOUNCE_MS)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('ignores unrelated entries in current/', () => {
    vi.useFakeTimers()
    const w = fakeWatch()
    const onChange = vi.fn()
    watchOmarchyTheme(onChange, { env, watch: w.watch, isDir: (p) => p === current })
    w.listeners.get(current)!('change', 'background')
    vi.advanceTimersByTime(OMARCHY_WATCH_DEBOUNCE_MS * 2)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('closes watchers and drops a pending call on dispose', () => {
    vi.useFakeTimers()
    const w = fakeWatch()
    const onChange = vi.fn()
    const dispose = watchOmarchyTheme(onChange, { env, watch: w.watch, isDir: (p) => p === current })
    w.listeners.get(current)!('change', 'theme.name')
    dispose()
    vi.advanceTimersByTime(OMARCHY_WATCH_DEBOUNCE_MS * 2)
    expect(onChange).not.toHaveBeenCalled()
    expect(w.closed).toEqual([current])
  })

  it('survives a watch that throws', () => {
    const onChange = vi.fn()
    const dispose = watchOmarchyTheme(onChange, {
      env,
      watch: () => {
        throw new Error('ENOSPC')
      },
      isDir: () => true,
    })
    expect(() => dispose()).not.toThrow()
  })
})
