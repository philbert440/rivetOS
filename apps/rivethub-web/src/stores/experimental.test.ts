import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  const m = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    get length() {
      return m.size
    },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
  } satisfies Storage)
})

afterAll(() => vi.unstubAllGlobals())

const { setExperimentalFlag, useExperimental } = await import('./experimental.js')
const { EXPERIMENTAL_DEFAULTS } = await import('../lib/visible-nav.js')

describe('setExperimentalFlag', () => {
  it('returns the same object when the flag is unchanged', () => {
    const flags = { ...EXPERIMENTAL_DEFAULTS }
    expect(setExperimentalFlag(flags, 'files', false)).toBe(flags)
  })

  it('sets one flag without touching the others', () => {
    const next = setExperimentalFlag(EXPERIMENTAL_DEFAULTS, 'tasks', true)
    expect(next).toEqual({ files: false, tasks: true, workflows: false, memoryHome: false })
    expect(EXPERIMENTAL_DEFAULTS.tasks).toBe(false)
  })
})

describe('experimental store', () => {
  beforeEach(() => {
    useExperimental.setState({ experimental: { ...EXPERIMENTAL_DEFAULTS } })
    localStorage.removeItem('rivethub.experimental')
  })

  it('defaults every flag to false', () => {
    expect(useExperimental.getState().experimental).toEqual({
      files: false,
      tasks: false,
      workflows: false,
      memoryHome: false,
    })
  })

  it('toggles each flag independently', () => {
    useExperimental.getState().setFiles(true)
    expect(useExperimental.getState().experimental.files).toBe(true)
    expect(useExperimental.getState().experimental.tasks).toBe(false)
    useExperimental.getState().setTasks(true)
    useExperimental.getState().setWorkflows(true)
    useExperimental.getState().setMemoryHome(true)
    expect(useExperimental.getState().experimental).toEqual({
      files: true,
      tasks: true,
      workflows: true,
      memoryHome: true,
    })
    useExperimental.getState().setFiles(false)
    expect(useExperimental.getState().experimental.files).toBe(false)
    expect(useExperimental.getState().experimental.tasks).toBe(true)
  })

  it('persists the slice and rehydrates', async () => {
    useExperimental.getState().setFiles(true)
    useExperimental.getState().setWorkflows(true)
    const raw = localStorage.getItem('rivethub.experimental')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw ?? '') as {
      state: { experimental: Record<string, boolean> }
    }
    expect(parsed.state.experimental).toEqual({
      files: true,
      tasks: false,
      workflows: true,
      memoryHome: false,
    })
    expect(parsed.state).not.toHaveProperty('setFiles')

    useExperimental.setState({ experimental: { ...EXPERIMENTAL_DEFAULTS } })
    expect(useExperimental.getState().experimental.files).toBe(false)
    localStorage.setItem('rivethub.experimental', raw ?? '')
    await useExperimental.persist.rehydrate()
    expect(useExperimental.getState().experimental).toEqual({
      files: true,
      tasks: false,
      workflows: true,
      memoryHome: false,
    })
  })

  it('treats a missing or truthy-but-not-true blob as all off except true booleans', async () => {
    localStorage.setItem(
      'rivethub.experimental',
      JSON.stringify({
        state: { experimental: { files: 'yes', tasks: true, memoryHome: 1 } },
        version: 0,
      }),
    )
    await useExperimental.persist.rehydrate()
    expect(useExperimental.getState().experimental).toEqual({
      files: false,
      tasks: true,
      workflows: false,
      memoryHome: false,
    })
  })
})
