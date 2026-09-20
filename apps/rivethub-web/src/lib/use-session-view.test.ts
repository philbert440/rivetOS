import { createElement, useState } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessDescriptor } from '@rivetos/types'
import { chatItems, type ChatItem, type HarnessRegistryStatus } from './harness-chat.js'
import { getSessionMode, hasSessionMode, moveSessionMode, setSessionMode } from './session-mode.js'
import { useSessionView } from './use-session-view.js'

const DRIVER: HarnessDescriptor = {
  harnessId: 'claude-code',
  capabilities: {
    liveStream: false,
    listSessions: true,
    interrupt: true,
    resume: true,
    approvals: false,
  },
}

const STORE = 'rivethub.sessionModes'
let values: Map<string, string>
const writes = vi.fn((key: string, value: string) => values.set(key, value))
const stored = () => JSON.parse(values.get(STORE) ?? '{}')

beforeEach(() => {
  values = new Map<string, string>()
  writes.mockClear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: writes,
  })
})
afterEach(() => vi.unstubAllGlobals())

// Like use-narrow.test.ts, render the real hook with React's server renderer:
// no DOM shim or new dependency. Effects don't run in this initial-render test.
function view(
  item: ChatItem | undefined,
  status: HarnessRegistryStatus = 'success',
  key = 'node::new',
) {
  function Probe() {
    const { mode } = useSessionView(key, item, status === 'success' ? [DRIVER] : undefined, status)
    return createElement('span', null, mode ?? 'loading')
  }
  return renderToString(createElement(Probe))
}

const pin: ChatItem = {
  key: 'claude-code:new',
  kind: 'legacy',
  harnessId: 'claude-code',
  title: 'new',
  updatedAt: 0,
}

describe('chat page view hook', () => {
  it('opens a new draft and a new scan-only chat in Chat; a real TUI opens Terminal', () => {
    const rows = chatItems({
      drafts: ['draft'],
      harnessSessions: [],
      legacySessions: [
        { id: 'new', command: 'claude', title: 'new', updatedAt: 1 },
        { id: 'tui', command: 'shell', title: 'shell', updatedAt: 1 },
      ],
    })
    expect(
      view(
        rows.find((row) => row.key === 'draft'),
        'pending',
      ),
    ).toBe('<span>chat</span>')
    expect(view(rows.find((row) => row.key === 'new'))).toBe('<span>chat</span>')
    expect(view(rows.find((row) => row.key === 'tui'))).toBe('<span>terminal</span>')
    setSessionMode('node::draft', 'chat')
    moveSessionMode('node::draft', 'node::claude-code:new')
    expect(view(pin, 'error', 'node::claude-code:new')).toBe('<span>chat</span>')
  })

  it('uses a temporary terminal for a deep link/pin until registry success', () => {
    expect(view(pin, 'pending')).toBe('<span>terminal</span>')
    expect(view(pin)).toBe('<span>chat</span>')
    expect(view(pin, 'error')).toBe('<span>terminal</span>')
  })

  it('restores a manual view on reload/back/forward even while registry is pending or failed', () => {
    setSessionMode('node::new', 'chat')
    expect(view(pin, 'pending')).toBe('<span>chat</span>')
    expect(view(pin, 'error')).toBe('<span>chat</span>')
    setSessionMode('node::new', 'terminal')
    expect(view(pin)).toBe('<span>terminal</span>')
    expect(view(pin, 'pending')).toBe('<span>terminal</span>')
    expect(view(pin, 'pending', 'other-node::new')).toBe('<span>terminal</span>')
  })
})

// React performs these render-phase updates on the same Probe instance. This
// exercises real hook state using the existing server renderer, without a DOM
// or a mocked hook dispatcher. As above, passive effects do not run here.
type Step = {
  status?: HarnessRegistryStatus
  key?: string
  item?: Parameters<typeof useSessionView>[1]
  drivers?: HarnessDescriptor[]
  mode: 'chat' | 'terminal'
  choose?: 'chat' | 'terminal'
  after?: () => void
}
function sequence(steps: Step[]) {
  function Probe() {
    const [index, setIndex] = useState(0)
    const step = steps[index]
    const status = step.status ?? 'success'
    const result = useSessionView(
      step.key ?? 'node::new',
      'item' in step ? step.item : pin,
      status === 'success' ? (step.drivers ?? [DRIVER]) : undefined,
      status,
    )
    expect(result.mode).toBe(step.mode)
    if (step.choose) result.setMode(step.choose)
    step.after?.()
    if (index + 1 < steps.length) setIndex(index + 1)
    return createElement('span', null, result.mode)
  }
  return renderToString(createElement(Probe))
}

const shell = { kind: 'legacy' as const, command: 'shell' }

describe('chat page view hook regressions', () => {
  it('registry error -> terminal -> recovery becomes chat on the same mount', () => {
    sequence([{ status: 'error', mode: 'terminal' }, { mode: 'chat' }])
  })

  it('manual terminal during an error survives recovery and is marked as user-chosen', () => {
    sequence([{ status: 'error', mode: 'terminal', choose: 'terminal' }, { mode: 'terminal' }])
    expect(stored()['node::new']).toEqual({ mode: 'terminal', source: 'user' })
  })

  it('automatic pending, error, successful, and missing-row decisions never write storage', () => {
    sequence([
      { status: 'pending', mode: 'terminal' },
      { status: 'error', mode: 'terminal' },
      { mode: 'chat' },
      { key: 'node::shell', item: shell, mode: 'terminal' },
      { key: 'node::missing', item: undefined, status: 'pending', mode: 'terminal' },
    ])
    expect(writes).not.toHaveBeenCalled()
  })

  it('legacy unmarked entries cannot pin chat or terminal defaults', () => {
    values.set(STORE, JSON.stringify({ 'node::new': 'terminal', 'node::shell': 'chat' }))
    sequence([{ mode: 'chat' }, { key: 'node::shell', item: shell, mode: 'terminal' }])
    expect(hasSessionMode('node::new')).toBe(false)
  })

  it('reload restores only user choices, never an automatic error fallback', () => {
    sequence([{ status: 'error', mode: 'terminal' }])
    sequence([{ mode: 'chat' }])
    sequence([
      { key: 'node::manual', status: 'error', mode: 'terminal', choose: 'terminal' },
      { key: 'node::manual', status: 'error', mode: 'terminal' },
    ])
    sequence([{ key: 'node::manual', mode: 'terminal' }])
    expect(Object.keys(stored())).toEqual(['node::manual'])
  })

  it('pending and absent rows show terminal immediately; late registry success is derived', () => {
    sequence([{ status: 'pending', mode: 'terminal' }, { mode: 'chat' }])
    sequence([{ status: 'pending', item: shell, mode: 'terminal' }])
    sequence([{ status: 'pending', item: undefined, mode: 'terminal' }])
  })

  it('manual pending choice survives registry settlement, navigation and draft adoption', () => {
    sequence([
      { status: 'pending', mode: 'terminal', choose: 'terminal' },
      { mode: 'terminal' },
      { key: 'other-node::new', mode: 'chat' },
      {
        mode: 'terminal',
        after: () => {
          values.set(STORE, JSON.stringify({ ...stored(), 'node::canonical': 'chat' }))
          moveSessionMode('node::new', 'node::canonical')
        },
      },
      { key: 'node::canonical', item: { kind: 'harness' }, mode: 'terminal' },
    ])
    expect(hasSessionMode('node::new')).toBe(false)
  })

  it('adoption ignores legacy sources and preserves a destination manual choice', () => {
    values.set(STORE, JSON.stringify({ 'node::new': 'terminal' }))
    moveSessionMode('node::new', 'node::canonical')
    expect(hasSessionMode('node::canonical')).toBe(false)
    setSessionMode('node::new', 'terminal')
    setSessionMode('node::canonical', 'chat')
    moveSessionMode('node::new', 'node::canonical')
    expect(getSessionMode('node::canonical')).toBe('chat')
    expect(hasSessionMode('node::new')).toBe(false)
  })

  it('browsing more than the storage cap cannot evict a manual choice', () => {
    setSessionMode('node::new', 'terminal')
    for (let i = 0; i < 501; i++) {
      sequence([{ key: `node::auto-${i}`, mode: 'chat' }])
    }
    expect(getSessionMode('node::new')).toBe('terminal')
    expect(writes).toHaveBeenCalledTimes(1)
  })

  it('successful empty registry can later gain a driver without pinning the fallback', () => {
    sequence([{ drivers: [], mode: 'terminal' }, { mode: 'chat' }])
  })

  it('manual choices remain usable when localStorage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('disabled')
      },
      setItem() {
        throw new Error('disabled')
      },
    })
    sequence([{ status: 'pending', mode: 'terminal', choose: 'terminal' }, { mode: 'terminal' }])
  })
})
