import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
  type UseQueryOptions,
} from '@tanstack/react-query'
import type { MeshOverview } from '@rivetos/types'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const captured = vi.hoisted(() => ({
  options: undefined as UseQueryOptions<MeshOverview> | undefined,
}))

// Keep real query state and scheduling; capture the options the component
// actually passes so a QueryObserver can mount without a browser DOM.
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: (options: UseQueryOptions<MeshOverview>) => {
      captured.options = options
      return actual.useQuery(options)
    },
  }
})

vi.mock('../lib/node-name.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/node-name.js')>()
  return { ...actual, useNodeName: () => undefined }
})

// Zustand's server snapshot is its import-time state. Use the current snapshot
// for each server render, retaining the real store and its add/remove actions.
vi.mock('../stores/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stores/connection.js')>()
  return {
    ...actual,
    useConnection: Object.assign(() => actual.useConnection.getState(), actual.useConnection),
  }
})

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

const A = { name: 'alpha', baseUrl: 'https://alpha.example' }
const B = { name: 'beta', baseUrl: 'https://beta.example' }
const empty: MeshOverview = { updatedAt: 1, nodes: [] }
const peer: MeshOverview = {
  updatedAt: 2,
  nodes: [{ id: 'beta', name: B.name, denUrl: B.baseUrl, online: true, sessions: 0 }],
}
let useConnection: (typeof import('../stores/connection.js'))['useConnection']
const controls: Record<string, ComponentType> = {}
let client: QueryClient

beforeAll(async () => {
  vi.stubGlobal('localStorage', memoryStorage())
  vi.stubGlobal('sessionStorage', memoryStorage())
  vi.stubGlobal('window', { location: { origin: A.baseUrl } })
  ;({ useConnection } = await import('../stores/connection.js'))
  controls.switcher = (await import('./node-switcher.js')).NodeSwitcher
  controls.picker = (await import('./pickers/node-picker.js')).NodePicker
})

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  captured.options = undefined
  useConnection.setState({ baseUrl: A.baseUrl, roster: [A] })
})
afterEach(() => {
  client.clear()
  vi.restoreAllMocks()
})
afterAll(() => vi.unstubAllGlobals())

for (const name of ['switcher', 'picker']) {
  describe(name, () => {
    function render(): string {
      return renderToStaticMarkup(
        createElement(QueryClientProvider, { client }, createElement(controls[name])),
      )
    }
    function discover(data: MeshOverview = empty): void {
      client.setQueryData(['mesh', useConnection.getState().baseUrl], data)
    }
    function expectVisible(): void {
      expect(render()).toContain(
        name === 'switcher' ? 'aria-label="Current node:' : 'aria-label="node:',
      )
    }

    it('hides for the sole saved active node after successful discovery', () => {
      discover()
      expect(render()).toBe('')
    })

    it('does not mistake the active node in the mesh response for a peer', () => {
      discover({ ...empty, nodes: [{ ...peer.nodes[0], denUrl: `${A.baseUrl}/` }] })
      expect(render()).toBe('')
    })

    it('shows a saved B while connected to unsaved A', () => {
      useConnection.setState({ roster: [B] })
      discover()
      expectVisible()
    })

    it('appears when discovery finds the first peer', () => {
      discover()
      expect(render()).toBe('')
      discover(peer)
      expectVisible()
    })

    it('appears after saving a second node and hides after removing it', () => {
      discover()
      expect(render()).toBe('')
      useConnection.getState().addNode(B)
      expectVisible()
      useConnection.getState().removeNode(B.baseUrl)
      expect(render()).toBe('')
    })

    it('stays visible when the active node is removed from a two-node roster', () => {
      useConnection.getState().addNode(B)
      discover()
      expectVisible()
      useConnection.getState().removeNode(A.baseUrl)
      expectVisible()
    })

    it('stays hidden while discovery is pending with one saved node', async () => {
      let resolve!: (data: MeshOverview) => void
      const request = vi.spyOn(useConnection.getState().gateway, 'meshOverview').mockReturnValue(
        new Promise<MeshOverview>((done) => {
          resolve = done
        }),
      )
      expect(render()).toBe('')
      const observer = new QueryObserver(client, captured.options!)
      const unsubscribe = observer.subscribe(() => {})
      try {
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
        expect(client.getQueryState(['mesh', A.baseUrl])?.status).toBe('pending')
        expect(render()).toBe('')
        resolve(peer)
        await vi.waitFor(() =>
          expect(client.getQueryState(['mesh', A.baseUrl])?.status).toBe('success'),
        )
        expectVisible()
      } finally {
        unsubscribe()
      }
    })

    it('shows two saved nodes immediately while discovery is pending', () => {
      useConnection.setState({ roster: [A, B] })
      expectVisible()
    })

    it.each([1, 2])('handles discovery failure with %i saved nodes', async (count) => {
      useConnection.setState({ roster: [A, B].slice(0, count) })
      await client
        .fetchQuery({
          queryKey: ['mesh', A.baseUrl],
          queryFn: () => Promise.reject(new Error('unavailable')),
        })
        .catch(() => undefined)
      if (count === 1) expect(render()).toBe('')
      else expectVisible()
    })

    it('hides an empty roster only on the app origin', () => {
      useConnection.setState({ roster: [] })
      discover()
      expect(render()).toBe('')
      useConnection.setState({ baseUrl: B.baseUrl })
      discover()
      expectVisible()
    })

    it('keeps an empty roster visible when a peer is discovered', () => {
      useConnection.setState({ roster: [] })
      discover(peer)
      expectVisible()
    })

    it('keeps an unknown connection visible even with cached discovery', () => {
      useConnection.setState({ baseUrl: '' })
      discover()
      expectVisible()
    })

    it('runs discovery while hidden and resurfaces when that request finds a peer', async () => {
      const request = vi
        .spyOn(useConnection.getState().gateway, 'meshOverview')
        .mockResolvedValue(peer)
      // A stale successful snapshot hides the control; mounting its observer
      // must still fetch, without ever opening the dropdown.
      client.setQueryData(['mesh', A.baseUrl], empty, { updatedAt: Date.now() - 31_000 })
      expect(render()).toBe('')
      expect(captured.options).toBeDefined()
      const observer = new QueryObserver(client, captured.options!)
      const unsubscribe = observer.subscribe(() => {})
      try {
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
        await vi.waitFor(() => expect(client.getQueryData(['mesh', A.baseUrl])).toEqual(peer))
        expectVisible()
      } finally {
        unsubscribe()
      }
    })
  })
}
