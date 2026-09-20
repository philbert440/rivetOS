import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessDescriptor } from '@rivetos/types'
import { chatItems, type ChatItem, type HarnessRegistryStatus } from './harness-chat.js'
import { moveSessionMode, setSessionMode } from './session-mode.js'
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

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
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

  it('holds a deep link/pin at loading until registry success or failure', () => {
    expect(view(pin, 'pending')).toBe('<span>loading</span>')
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
    expect(view(pin, 'pending', 'other-node::new')).toBe('<span>loading</span>')
  })
})
