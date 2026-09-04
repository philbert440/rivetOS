// The conversations list is not an app screen on narrow (Phil 2026-09-04):
// the phone's home is the chat surface, the list lives only in the right
// history drawer. These scans pin the render contract in pages/chat.tsx and
// the rail behavior in components/sidebar.tsx — each fails if the narrow
// full-screen list branch comes back.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const chat = readFileSync(new URL('./chat.tsx', import.meta.url), 'utf8')
const sidebar = readFileSync(new URL('../components/sidebar.tsx', import.meta.url), 'utf8')

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

  it('rail Conversations on narrow returns to the chat home — it does not clear the session', () => {
    expect(sidebar).not.toContain('setActive(undefined)')
  })
})
