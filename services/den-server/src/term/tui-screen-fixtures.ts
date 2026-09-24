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

/** Claude Code 2.1.280, fresh session (captured 2026-09-24): the empty input box
 *  shows a dim rotating example (`Try "refactor <filepath>"`). Not typed text. */
export const FRESH_CLAUDE_PROMPT_SCREEN = `\
 ▐▛███▛█   Claude Code v2.1.280
▝▜██████▀  Opus 5.5 · Claude Pro
  ▝▝ ▝▝    /home/alex

▎ Using Opus 5.5 (from .claude/settings.json) · /model





























                                                                                                    ◐ medium · /effort
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯\u00a0Try "refactor <filepath>"
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
`

/** Claude Code 2.1.280 with `/model` typed but not sent (captured live 2026-09-23):
 *  the slash-command list is drawn above the input box. A chat paste here became
 *  `/modeltest 1`. */
export const SLASH_DRAFT_SCREEN = `\
  /model                         Set the AI model for Claude Code (currently
                                 Opus 5.5)
  /claude-api                    Reference for the Claude API / Anthropic SDK
                                 — model ids, pricing, params, streaming, to…
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
