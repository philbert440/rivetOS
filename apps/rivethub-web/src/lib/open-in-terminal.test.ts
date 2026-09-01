import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TermAttachInfo } from '@rivetos/types'
import { rivetShell, type RivetShell } from './shell-bridge.js'
import {
  canOpenInTerminal,
  fallbackAttachCommand,
  openInExternalTerminal,
} from './open-in-terminal.js'

const ATTACH: TermAttachInfo = {
  socket: 'rivet',
  session: 'den-abc',
  host: '192.0.2.116',
  sshUser: 'rivet',
  local: true,
}

function stubShell(extra: Partial<RivetShell> = {}): RivetShell {
  return {
    kind: 'electron',
    mtlsProxyPort: vi.fn(async () => 12345),
    openExternal: vi.fn(async () => undefined),
    clipboardWriteText: vi.fn(async () => undefined),
    clipboardReadText: vi.fn(async () => ''),
    sendNotification: vi.fn(async () => undefined),
    setUnread: vi.fn(async () => undefined),
    ...extra,
  }
}

function setShell(shell?: RivetShell): void {
  const g = globalThis as { rivetShell?: RivetShell }
  if (shell) g.rivetShell = shell
  else delete g.rivetShell
}

afterEach(() => {
  setShell(undefined)
  vi.restoreAllMocks()
})

describe('Electron vs fallback branch', () => {
  it('launches via rivetShell.openInTerminal when the bridge defines it', async () => {
    const openInTerminal = vi.fn(async () => undefined)
    const shell = stubShell({ openInTerminal })
    setShell(shell)
    expect(canOpenInTerminal(rivetShell())).toBe(true)
    await openInExternalTerminal(ATTACH)
    expect(openInTerminal).toHaveBeenCalledWith(ATTACH)
  })

  it('does not launch when the bridge is absent (web/mobile copy fallback)', () => {
    setShell(undefined)
    expect(canOpenInTerminal(rivetShell())).toBe(false)
    expect(fallbackAttachCommand(ATTACH)).toBe('tmux -L rivet attach-session -t =den-abc')
  })

  it('does not launch when the bridge is present but openInTerminal is missing', () => {
    setShell(stubShell())
    expect(canOpenInTerminal(rivetShell())).toBe(false)
    expect(fallbackAttachCommand({ ...ATTACH, local: false })).toBe(
      'ssh -t rivet@192.0.2.116 tmux -L rivet attach-session -t =den-abc',
    )
  })

  it('surfaces rejection from openInTerminal', async () => {
    const openInTerminal = vi.fn(async () => {
      throw new Error('no terminal emulator found')
    })
    setShell(stubShell({ openInTerminal }))
    await expect(openInExternalTerminal(ATTACH)).rejects.toThrow('no terminal emulator found')
  })
})
