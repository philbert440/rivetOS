import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

function memoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() {
      return m.size
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  }
}

const store = memoryStorage()
vi.stubGlobal('localStorage', store)
afterAll(() => vi.unstubAllGlobals())

const { useSpaces, SPACES_STORAGE_KEY, SPACES_MEMBERSHIP_CAP } = await import('./spaces.js')
const { useArchived } = await import('./archived.js')

describe('spaces store', () => {
  beforeEach(() => {
    store.clear()
    useSpaces.setState({ spaces: [], membership: {} })
    useArchived.setState({ keys: [] })
  })

  it('adds a space with a name and returns its id', () => {
    const id = useSpaces.getState().addSpace('  Work  ')
    expect(id).not.toBe('')
    const spaces = useSpaces.getState().spaces
    expect(spaces).toHaveLength(1)
    expect(spaces[0]).toMatchObject({ id, name: 'Work', order: 0 })
    expect(typeof spaces[0]?.createdAt).toBe('number')
  })

  it('refuses a blank name', () => {
    expect(useSpaces.getState().addSpace('   ')).toBe('')
    expect(useSpaces.getState().spaces).toEqual([])
  })

  it('renames a space and ignores an unknown id or a blank name', () => {
    const id = useSpaces.getState().addSpace('Work')
    useSpaces.getState().renameSpace(id, ' Home ')
    expect(useSpaces.getState().spaces[0]?.name).toBe('Home')
    useSpaces.getState().renameSpace(id, '  ')
    expect(useSpaces.getState().spaces[0]?.name).toBe('Home')
    useSpaces.getState().renameSpace('missing', 'Nope')
    expect(useSpaces.getState().spaces).toHaveLength(1)
  })

  it('reorders a space by writing its order', () => {
    const a = useSpaces.getState().addSpace('A')
    const b = useSpaces.getState().addSpace('B')
    useSpaces.getState().reorderSpace(a, 5)
    useSpaces.getState().reorderSpace('missing', 1)
    const byId = Object.fromEntries(
      useSpaces.getState().spaces.map((space) => [space.id, space.order]),
    )
    expect(byId[a]).toBe(5)
    expect(byId[b]).toBe(1)
  })

  it('places and unplaces, round-tripping back to History', () => {
    const id = useSpaces.getState().addSpace('Work')
    const key = 'http://192.168.1.20:8787::thread-a'
    useSpaces.getState().place(key, id)
    expect(useSpaces.getState().spaceOf(key)).toBe(id)
    useSpaces.getState().unplace(key)
    expect(useSpaces.getState().spaceOf(key)).toBeUndefined()
  })

  it('does not place into a missing space or an empty key', () => {
    const before = useSpaces.getState().membership
    useSpaces.getState().place('http://x::a', 'missing')
    useSpaces.getState().place('', 'missing')
    expect(useSpaces.getState().membership).toBe(before)
  })

  it('unplace of a missing key keeps the same membership', () => {
    const id = useSpaces.getState().addSpace('Work')
    useSpaces.getState().place('http://x::a', id)
    const before = useSpaces.getState().membership
    useSpaces.getState().unplace('http://x::nope')
    expect(useSpaces.getState().membership).toBe(before)
  })

  it('removeSpace sends its threads back to History and leaves other spaces', () => {
    const work = useSpaces.getState().addSpace('Work')
    const home = useSpaces.getState().addSpace('Home')
    useSpaces.getState().place('http://x::a', work)
    useSpaces.getState().place('http://x::b', work)
    useSpaces.getState().place('http://x::c', home)
    useSpaces.getState().removeSpace(work)
    expect(useSpaces.getState().spaces.map((space) => space.id)).toEqual([home])
    expect(useSpaces.getState().spaceOf('http://x::a')).toBeUndefined()
    expect(useSpaces.getState().spaceOf('http://x::b')).toBeUndefined()
    expect(useSpaces.getState().spaceOf('http://x::c')).toBe(home)
  })

  it('removeSpace of an unknown id is a no-op', () => {
    const id = useSpaces.getState().addSpace('Work')
    const before = useSpaces.getState().spaces
    useSpaces.getState().removeSpace('missing')
    expect(useSpaces.getState().spaces).toBe(before)
    expect(useSpaces.getState().spaces[0]?.id).toBe(id)
  })

  it('caps membership at 2000 by evicting the least recently placed', () => {
    const id = useSpaces.getState().addSpace('Work')
    for (let i = 0; i < SPACES_MEMBERSHIP_CAP + 1; i++) {
      useSpaces.getState().place(`http://x::s${String(i)}`, id)
    }
    const keys = Object.keys(useSpaces.getState().membership)
    expect(keys).toHaveLength(SPACES_MEMBERSHIP_CAP)
    expect(keys.includes('http://x::s0')).toBe(false)
    expect(keys.at(-1)).toBe(`http://x::s${String(SPACES_MEMBERSHIP_CAP)}`)
  })

  it('moves membership onto the new key', () => {
    const id = useSpaces.getState().addSpace('Work')
    useSpaces.getState().place('http://192.168.1.20:8787::from', id)
    useSpaces.getState().rekey('http://192.168.1.20:8787::from', 'http://192.168.1.20:8787::to')
    expect(useSpaces.getState().spaceOf('http://192.168.1.20:8787::to')).toBe(id)
    expect(useSpaces.getState().spaceOf('http://192.168.1.20:8787::from')).toBeUndefined()
  })

  it('keeps a destination that is already placed and drops the source', () => {
    const source = useSpaces.getState().addSpace('Source')
    const dest = useSpaces.getState().addSpace('Dest')
    useSpaces.getState().place('http://192.168.1.20:8787::from', source)
    useSpaces.getState().place('http://192.168.1.20:8787::to', dest)
    useSpaces.getState().rekey('http://192.168.1.20:8787::from', 'http://192.168.1.20:8787::to')
    expect(useSpaces.getState().spaceOf('http://192.168.1.20:8787::to')).toBe(dest)
    expect(useSpaces.getState().spaceOf('http://192.168.1.20:8787::from')).toBeUndefined()
    expect(Object.keys(useSpaces.getState().membership)).toEqual(['http://192.168.1.20:8787::to'])
  })

  it('does not rekey when the source was never placed', () => {
    const id = useSpaces.getState().addSpace('Work')
    useSpaces.getState().place('http://192.168.1.20:8787::kept', id)
    const before = useSpaces.getState().membership
    useSpaces.getState().rekey('http://192.168.1.20:8787::missing', 'http://192.168.1.20:8787::to')
    useSpaces.getState().rekey('http://192.168.1.20:8787::kept', 'http://192.168.1.20:8787::kept')
    expect(useSpaces.getState().membership).toBe(before)
  })

  it('archive unplaces a thread and place unarchives it', () => {
    const id = useSpaces.getState().addSpace('Work')
    const key = 'http://192.168.1.20:8787::archived'
    useSpaces.getState().place(key, id)
    useArchived.getState().archive(key)
    expect(useArchived.getState().isArchived(key)).toBe(true)
    expect(useSpaces.getState().spaceOf(key)).toBeUndefined()
    useSpaces.getState().place(key, id)
    expect(useArchived.getState().isArchived(key)).toBe(false)
    expect(useSpaces.getState().spaceOf(key)).toBe(id)
  })

  it('re-placing a thread makes it the newest membership entry', () => {
    const id = useSpaces.getState().addSpace('Work')
    useSpaces.getState().place('http://x::a', id)
    useSpaces.getState().place('http://x::b', id)
    useSpaces.getState().place('http://x::a', id)
    expect(Object.keys(useSpaces.getState().membership)).toEqual(['http://x::b', 'http://x::a'])
  })

  it('rehydrates a blob with unknown fields and drops them', async () => {
    store.setItem(
      SPACES_STORAGE_KEY,
      JSON.stringify({
        state: {
          spaces: [
            {
              id: 's',
              name: 'Work',
              order: 2,
              createdAt: 5,
              extra: 'ignore',
              defaults: {
                cwd: '/tmp',
                extra: true,
                model: 'opus',
                effort: 'nope',
                agentId: 'preset-1',
                harnessId: 'not-a-harness',
                node: 'http://192.168.1.9:8787',
              },
            },
            { id: '', name: 'nope', order: 0, createdAt: 0 },
            { name: 'no id' },
          ],
          membership: { 'http://x::a': 's', 'http://x::gone': 'missing', bad: 1, '': 's' },
          future: true,
        },
        version: 0,
      }),
    )
    await useSpaces.persist.rehydrate()
    expect(useSpaces.getState().spaces).toEqual([
      {
        id: 's',
        name: 'Work',
        order: 2,
        createdAt: 5,
        defaults: { agentId: 'preset-1', model: 'opus', node: 'http://192.168.1.9:8787' },
      },
    ])
    expect(useSpaces.getState().membership).toEqual({ 'http://x::a': 's' })
    expect('future' in useSpaces.getState()).toBe(false)
  })

  it('drops a non-object defaults blob without throwing', async () => {
    store.setItem(
      SPACES_STORAGE_KEY,
      JSON.stringify({
        state: {
          spaces: [
            { id: 's', name: 'Work', order: 0, createdAt: 1, defaults: '/tmp' },
            { id: 't', name: 'Home', order: 1, createdAt: 2, defaults: ['cwd'] },
          ],
          membership: {},
        },
        version: 0,
      }),
    )
    await expect(useSpaces.persist.rehydrate()).resolves.toBeUndefined()
    expect(useSpaces.getState().spaces.map((space) => space.defaults)).toEqual([
      undefined,
      undefined,
    ])
  })

  it('round-trips defaults and clears a field when the patch sets it undefined', () => {
    const id = useSpaces.getState().addSpace('Work')
    useSpaces.getState().setSpaceDefaults(id, {
      agentId: 'preset-1',
      model: 'opus',
      effort: 'high',
      harnessId: 'claude-code',
      node: 'http://192.168.1.30:8787',
    })
    expect(useSpaces.getState().spaces[0]?.defaults).toEqual({
      agentId: 'preset-1',
      model: 'opus',
      effort: 'high',
      harnessId: 'claude-code',
      node: 'http://192.168.1.30:8787',
    })
    useSpaces.getState().setSpaceDefaults(id, { model: undefined, effort: undefined })
    expect(useSpaces.getState().spaces[0]?.defaults).toEqual({
      agentId: 'preset-1',
      harnessId: 'claude-code',
      node: 'http://192.168.1.30:8787',
    })
    useSpaces.getState().setSpaceDefaults(id, {
      agentId: '',
      harnessId: undefined,
      node: undefined,
    })
    expect(useSpaces.getState().spaces[0]?.defaults).toBeUndefined()
    const before = useSpaces.getState().spaces
    useSpaces.getState().setSpaceDefaults('missing', { model: 'opus' })
    expect(useSpaces.getState().spaces).toBe(before)
  })

  it('does not throw when storage is missing or throws', async () => {
    const throwing: Storage = {
      get length() {
        return 0
      },
      clear: () => undefined,
      getItem: () => {
        throw new Error('disabled')
      },
      key: () => null,
      removeItem: () => {
        throw new Error('disabled')
      },
      setItem: () => {
        throw new Error('disabled')
      },
    }
    vi.stubGlobal('localStorage', throwing)
    await expect(useSpaces.persist.rehydrate()).resolves.toBeUndefined()
    expect(() => useSpaces.getState().addSpace('Still works')).not.toThrow()
    expect(useSpaces.getState().spaces.some((space) => space.name === 'Still works')).toBe(true)
    vi.stubGlobal('localStorage', store)
  })
})
