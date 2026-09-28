/** Synthetic TUI screens covering each detection behavior. */

export const AUTO_MODE_DIALOG_SCREEN = `\
  │ claude (this session)                          │ about 17%      │ Drops when I'm idle.                          │
  └────────────────────────────────────────────────┴────────────────┴───────────────────────────────────────────────┘

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Teach auto mode about your environment?

  Auto mode works better when it knows your environment. Takes about a minute.

  ❯ 1. Yes
    2. Not now
    3. Don't show again

  Enter to confirm · Esc to cancel
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
`

export const CLAUDE_PERM_SCREEN = `\
 Bash command
    mkdir -p zz && rm -r zz && echo done
  Do you want to proceed?
  ❯ 1. Yes
    2. Yes, and don't ask again for mkdir
    3. No
  Esc to cancel · Tab to amend
`

export const CLAUDE_PICKER_SCREEN = `\
Which color would you like?
❯ 1. Red
     The color red
  2. Green
     The color green
  3. Blue
     The color blue
  4. Type something.
────────────────────────────────────────────
  5. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
`

export const IDLE_HARNESS_SCREEN = `\
  │ claude (this session)                          │ about 17%      │ Drops when I'm idle.                          │
  └────────────────────────────────────────────────┴────────────────┴───────────────────────────────────────────────┘

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
`

export const OLD_DIALOG_SCROLLBACK_SCREEN = `\
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Teach auto mode about your environment?

  Auto mode works better when it knows your environment. Takes about a minute.

  ❯ 1. Yes
    2. Not now
    3. Don't show again

  Enter to confirm · Esc to cancel
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
● Done.

Here is the reply after the dialog was dismissed.

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
`

/** Scrolled /model picker: `↓` on the last visible row, extra rows before
 *  the footer, a `▔` top border, and no input box (the picker replaces it). */
export const MODEL_PICKER_SCREEN = `\
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
   Select model

     1.  Default
   ❯ 2.  Opus 5.5 ✔             Most capable for ambitious work
     3.  Sonnet 5
     4.  Fable 5.1
     5.  Haiku 4.5
     6.  Opus 5
     7.  Fable 5
     8.  Opus 4.8
     9.  Opus 4.7
   ↓ 10. Opus 4.6
      … +1 model

   ◐ Medium effort (default) ←/→ to adjust

   Enter to set as default · s to use this session only · Esc to cancel
`

/** Fresh session: empty input box with a dim rotating example. Not typed text. */
export const FRESH_CLAUDE_PROMPT_SCREEN = `\
  Claude Code
  /home/user

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯\u00a0Try "refactor <filepath>"
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
`

/** `/model` typed but not sent: slash-command list above the input box. */
export const SLASH_DRAFT_SCREEN = `\
  /model                         Set the AI model
───────────────────────────────────────────────────────────────────────────────
❯\u00a0/model
───────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle)
`

/**
 * Synthetic, not a live capture. A draft longer than the pane width wraps
 * onto the next row (shift+enter looks the same in a plain-text capture).
 * `belowIsChrome` fail-opens, so this is not reported as a draft. Pinned
 * until the block between the two separators is parsed.
 */
export const WRAPPED_DRAFT_SCREEN = `\
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ this draft is longer than the pane and wraps
onto the next row
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
`
