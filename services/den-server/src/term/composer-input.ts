/**
 * Parse Claude Code's composer input box out of a herdr screen capture.
 * Fixture-driven from Claude Code 2.1.280.
 *
 * Plain-text captures drop the dim SGR (`ESC[2m`) that marks ghost text, and
 * the pre-send read cannot ask for it (herdr `agent read` / `pane read`, no
 * escape flag). Placeholders are therefore an allowlist of Claude Code 2.1.x
 * empty-box strings. A user who typed one of those strings verbatim and did
 * not send is treated as an empty box: the turn is pasted onto it. Refusing
 * would block every fresh session — the rotating example is on screen before
 * the first message — and the inject button is refused on a draft too, so
 * there would be no escape hatch.
 */

import { screenLines } from './permission-prompt.js'

const INPUT_LINE = /^\s*❯\s?(.*)$/
const OPTION_LINE = /^\s*(?:❯\s*)?\d+\.\s+/
const SEPARATOR = /^[\s─━-]+$/
const HINT = /⏵⏵|\? for shortcuts|shift\+tab to cycle|for agents/
/**
 * Claude Code 2.1.280 empty-box ghosts, read from that version's bundle.
 * The eight `Try "…"` templates (`<f>` is `[^"]+`: a repo path or the literal
 * `<filepath>`), `Message @<agent>…`, and these queue hints:
 * `Press Enter to edit the selected message, or up again for history`,
 * `Press Enter to edit the selected message, or up again for an older one`,
 * `Press up to select a queued message to edit, or Enter to send them now`,
 * `Press up to edit queued messages, Enter to send them immediately`,
 * `Press up to select a queued message, then Enter to edit it`, and
 * `Press up to edit queued messages`. Anything else on the `❯` line is a
 * draft, including `Try "foo"` and `Try "refactor x" then "y"`.
 */
const EMPTY_BOX_PLACEHOLDERS: readonly RegExp[] = [
  /^Try "fix lint errors"$/,
  /^Try "fix typecheck errors"$/,
  /^Try "how does [^"]+ work\?"$/,
  /^Try "refactor [^"]+"$/,
  /^Try "how do I log an error\?"$/,
  /^Try "edit [^"]+ to\.\.\."$/,
  /^Try "write a test for [^"]+"$/,
  /^Try "create a util logging\.py that\.\.\."$/,
  /^Message @.+\u2026$/,
  /^Press Enter to edit the selected message, or up again for history$/,
  /^Press Enter to edit the selected message, or up again for an older one$/,
  /^Press up to select a queued message to edit, or Enter to send them now$/,
  /^Press up to edit queued messages, Enter to send them immediately$/,
  /^Press up to select a queued message, then Enter to edit it$/,
  /^Press up to edit queued messages$/,
]

function isEmptyBoxPlaceholder(text: string): boolean {
  return EMPTY_BOX_PLACEHOLDERS.some((re) => re.test(text))
}

function belowIsChrome(lines: string[], idx: number): boolean {
  // A continuation row (a draft wrapped at the pane width, or shift+enter)
  // is not chrome, so this fail-opens and the paste goes through. Joining the
  // separator-bounded block needs a live capture; WRAPPED_DRAFT_SCREEN pins
  // the miss.
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*$/.test(line)) continue
    if (SEPARATOR.test(line) || HINT.test(line)) continue
    return false
  }
  return true
}

/** Text in Claude Code's input box, or undefined when the box is empty/not found. */
export function parseComposerInput(screen: string): string | undefined {
  if (!screen) return undefined
  const lines = screenLines(screen)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    const m = INPUT_LINE.exec(line)
    if (!m || OPTION_LINE.test(line)) continue
    if (!belowIsChrome(lines, i)) continue
    if (i === 0 || !SEPARATOR.test(lines[i - 1])) continue
    const text = m[1].trim()
    if (isEmptyBoxPlaceholder(text)) return undefined
    return text || undefined
  }
  return undefined
}
