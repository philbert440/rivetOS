/** Shared herdr screen captures. Claude Code 2.1.280 auto-mode dialog; 2.1.263 perm/picker. */

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
