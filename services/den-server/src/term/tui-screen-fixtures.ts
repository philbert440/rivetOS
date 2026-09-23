/** Shared herdr screen captures. Claude Code 2.1.280 auto-mode dialog and /model picker; 2.1.263 perm/picker. */

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

/** Composer a live Claude pane keeps under a dialog (empty ❯, rule, status).
 *  The perm/picker captures omit it; appending it must not hide the dialog. */
export const CLAUDE_COMPOSER_TAIL = `\
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
`

export const CLAUDE_PERM_WITH_COMPOSER_SCREEN = `${CLAUDE_PERM_SCREEN}${CLAUDE_COMPOSER_TAIL}`

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

export const CLAUDE_PICKER_WITH_COMPOSER_SCREEN = `${CLAUDE_PICKER_SCREEN}${CLAUDE_COMPOSER_TAIL}`

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

/** Claude Code 2.1.280 `/model` picker (captured live 2026-09-23): a `↓` scroll
 *  marker on the last visible row, extra rows before the footer, a `▔` top
 *  border, and no input box below — the picker replaces it. */
export const MODEL_PICKER_SCREEN = `\
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
   Select model
   Switch between Claude models. Your pick becomes the default for new
   sessions. For other/previous model names, specify with --model.

     1.  Default (recommended)  Opus 5.5 · Best for everyday, complex tasks
   ❯ 2.  Opus 5.5 ✔             Most capable for ambitious work
     3.  Sonnet 5               Most efficient for everyday tasks
     4.  Fable 5.1              For your toughest challenges
     5.  Haiku 4.5              Fastest for quick answers
     6.  Opus 5                 Best for everyday, complex tasks
     7.  Fable 5                Most capable for your hardest and
                                longest-running tasks
     8.  Opus 4.8               Best for everyday, complex tasks
     9.  Opus 4.7               Best for everyday, complex tasks
   ↓ 10. Opus 4.6               Best for everyday, complex tasks
      … +1 model

   ◐ Medium effort (default) ←/→ to adjust

   Enter to set as default · s to use this session only · Esc to cancel
`
