// The conversations list is not an app screen on narrow (Phil 2026-09-04):
// the phone's home is the chat surface, the list lives only in the right
// history drawer. These scans pin the render contract in pages/chat.tsx and
// the rail behavior in components/sidebar.tsx — each fails if the narrow
// full-screen list branch comes back.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const chat = readFileSync(new URL('./chat.tsx', import.meta.url), 'utf8')
const sidebar = readFileSync(new URL('../components/sidebar.tsx', import.meta.url), 'utf8')
const composer = readFileSync(new URL('../components/composer.tsx', import.meta.url), 'utf8')

describe('narrow full-screen list is gone', () => {
  it('showList is wide-only — narrow never renders the list as a screen', () => {
    expect(chat).toContain('const showList = !narrow && !conversationsCollapsed')
    expect(chat).not.toContain('narrow ? !active')
  })

  it('the wide conversations column keeps its pane contract untouched', () => {
    // Desktop is unchanged: the pane still toggles with conversationsCollapsed
    // and the empty state stays desktop-only.
    expect(chat).toContain('const showEmpty = !narrow && !active')
    expect(chat).toContain('!narrow && !conversationsCollapsed')
  })

  it('the column drawer is never the narrow full-width screen anymore', () => {
    expect(chat).not.toContain('fullWidth={narrow}')
  })

  it('narrow with no resolved session renders the chat-surface loading state', () => {
    expect(chat).toContain('<ChatLaunchLoading />')
    expect(chat).toContain('function ChatLaunchLoading')
  })

  it('the list still renders in the narrow right history drawer', () => {
    expect(chat).toContain('id="hub-history"')
    expect(chat).toContain('aria-label="Conversations"')
  })

  it('does not poll — no refetchInterval — and mounts QueuedStrip', () => {
    expect(chat).not.toContain('refetchInterval')
    expect(chat).toContain('<QueuedStrip')
  })

  it('rail Conversations on narrow returns to the chat home — it does not clear the session', () => {
    expect(sidebar).not.toContain('setActive(undefined)')
  })
})

describe('session view integration', () => {
  it('threads registry status to the view hook and renders the selected surface', () => {
    expect(chat).toContain('const { mode, setMode } = useSessionView(')
    expect(chat).toContain('remoteRegistry.status,')
    expect(chat).toContain("{mode === 'chat' ? (")
  })

  it('does not mask native scan rows with command-less canonical placeholders', () => {
    expect(chat).toContain('!findChatItem(listed, active)')
    expect(chat).toContain('harnessId = parseSessionId(active).harnessId')
  })

  it('spreads conversationLaunch into the spawn body and shows the default model label', () => {
    expect(chat).toContain('conversationLaunch(')
    expect(chat).toContain('...settledLaunch.spawn')
    expect(chat).toContain('needsRegistryBeforeSpawn(')
    expect(chat).toContain('shouldPersistLaunchLatch(')
    expect(chat).toContain('launchStateWrite(')
    expect(chat).toContain('agentLocked={spawnInFlight}')
    expect(composer).toContain('defaultModelLabel')
    expect(composer).toContain('props.agentLocked')
    // The lock must hold for a dropdown that was already open when it engaged.
    const picker = readFileSync(
      new URL('../components/pickers/model-picker.tsx', import.meta.url),
      'utf8',
    )
    expect(picker).toContain('if (props.disabled) return')
  })
})
