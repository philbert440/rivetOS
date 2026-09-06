import { describe, expect, it } from 'vitest'
import { parsePermissionPrompt } from './permission-prompt.js'

/** Verbatim Claude Code 2.1.263 Bash permission panel (cwd elided). */
const CLAUDE_BASH = `\
● Bash(mkdir -p zz && rm -r zz && echo done)
  ⎿  Waiting…
─────────────────────────────────────────────
 Bash command
   mkdir -p zz && rm -r zz && echo done
   Create zz directory, remove it, and echo done
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for mkdir -p zz and rm -r zz commands in /tmp
   3. No
 Esc to cancel · Tab to amend
`

const CLAUDE_ANSI = `\x1b[1m Do you want to proceed?\x1b[0m
 ❯ 1. Yes
   2. Yes, and don't ask again for edit
   3. No
`

/** grok 1.0.13 ┃ dialog (proven 09-04). */
const GROK_DIALOG = `\
┃  1 (●) Yes, and don't ask again for this command
┃  2 (○) Yes, proceed
┃  3 (○) No, reject
┃  4 (○) Never allow: run_command
`

/**
 * kimi-code 0.36.0 — reconstructed from herdr-kimi-capture.log which only
 * held the bottom of the panel (3/4 + footer). Options 1/2 unverified.
 */
const KIMI_PANEL = `\
     3. Reject
     4. Reject with feedback

   ↑/↓ select · 1/2/3/4 choose · ↵ confirm
 ───────────────────────────────────────────────────────────────────────────────────────────
`

describe('parsePermissionPrompt', () => {
  it('parses the Claude Bash proceed dialog', () => {
    expect(parsePermissionPrompt(CLAUDE_BASH)).toEqual({
      toolName: 'Bash command',
      text: 'mkdir -p zz && rm -r zz && echo done\nCreate zz directory, remove it, and echo done',
      options: [
        { key: '1', label: 'Yes' },
        {
          key: '2',
          label: "Yes, and don't ask again for mkdir -p zz and rm -r zz commands in /tmp",
        },
        { key: '3', label: 'No' },
      ],
    })
  })

  it('strips ANSI before matching Claude anchors', () => {
    const parsed = parsePermissionPrompt(CLAUDE_ANSI)
    expect(parsed?.options.map((o) => o.key)).toEqual(['1', '2', '3'])
    expect(parsed?.options[0]?.label).toBe('Yes')
  })

  it('parses the grok ┃ radio dialog', () => {
    const parsed = parsePermissionPrompt(GROK_DIALOG)
    expect(parsed?.options).toEqual([
      { key: '1', label: "Yes, and don't ask again for this command" },
      { key: '2', label: 'Yes, proceed' },
      { key: '3', label: 'No, reject' },
      { key: '4', label: 'Never allow: run_command' },
    ])
  })

  it('parses the kimi approval-panel footer (unverified above option 3)', () => {
    const parsed = parsePermissionPrompt(KIMI_PANEL)
    expect(parsed?.options).toEqual([
      { key: '3', label: 'Reject' },
      { key: '4', label: 'Reject with feedback' },
    ])
  })

  it('returns undefined when no dialog anchors are present', () => {
    expect(parsePermissionPrompt('')).toBeUndefined()
    expect(parsePermissionPrompt('kimi-k3 thinking  ~')).toBeUndefined()
    expect(parsePermissionPrompt('❯ 1. Red\n  2. Green')).toBeUndefined()
  })
})
