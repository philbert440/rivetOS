/**
 * Parse a live numbered menu dialog out of a herdr screen capture.
 * Fixture-driven from Claude Code 2.1.280 ("Teach auto mode about your
 * environment?") plus the 2.1.263 permission / AskUserQuestion screens.
 *
 * Claude-only. The pre-send gate that calls this is enabled only on the
 * Claude Code driver. Codex's `Press enter to confirm or esc to cancel` and
 * grok/kimi dialogs are not matched and not gated — this footer looks for
 * capital-E `Enter to confirm|select|continue` / `Esc to cancel|go back|exit`,
 * which those harnesses do not render.
 *
 * Shape-based: numbered options with exactly one ❯, consecutive keys
 * (starting at 1 unless the first visible row has a scrolled-list `↑` marker), a confirm/cancel footer, and
 * nothing after the footer except separators, an empty input box, or the
 * composer status line. Unknown screens return undefined (fail open).
 *
 * The permission prompt and the AskUserQuestion picker replace the composer:
 * there is no empty `❯` line under the footer. The auto-mode dialog does not.
 * `AUTO_MODE_DIALOG_SCREEN` keeps the composer (empty `❯` between two rules,
 * then the `⏵⏵ … ← for agents` status line) directly under the footer — the
 * same tail an assistant reply has when it quotes a menu above the live input
 * box. "No input box below the footer" would reject that live dialog, so a
 * menu above a still-present composer matches only when a box-drawing rule
 * frames it from above (the rule, then blank lines, indented body, or option
 * rows, then the options). The quoted trace has no such rule. A quote that
 * copies the rule is not distinguishable from the live dialog.
 */

import { screenLines } from './permission-prompt.js'

export interface BlockingDialog {
  /** First non-blank line after the nearest separator above the options (the dialog's
   *  question). May be ''. */
  title: string
  options: { key: string; label: string }[]
}

const OPTION_LINE = /^\s*(?:[❯↑↓]\s*)?(\d+)\.\s+(.+?)\s*$/
/** A rule, not a list item. `- item` has other characters; `--` is too short. */
const SEPARATOR = /^\s*[─━▔▁-]{3,}\s*$/
/** Dialog frame in the fixtures. ASCII `---` is a separator, not this rule. */
const DIALOG_RULE = /^\s*[─━▔▁]{3,}\s*$/
const FOOTER = /Enter to (confirm|select|continue)|Esc to (cancel|go back|exit)/
const EMPTY_INPUT = /^\s*❯\s*$/
/** Composer status chrome, not a reply that merely says "for agents". */
const HINT = /^\s*⏵⏵ .+\(shift\+tab to cycle\) · ← for agents\s*$|^\s*\? for shortcuts\s*$/

function isWrap(line: string): boolean {
  if (/^\s*$/.test(line) || SEPARATOR.test(line) || OPTION_LINE.test(line)) return false
  return /^\s+\S/.test(line)
}

/** Next lower option key, walking up the block. `1` has none. */
function predecessorKey(key: string): string | undefined {
  const n = Number(key)
  if (!Number.isInteger(n) || n <= 1) return undefined
  return String(n - 1)
}

/** First post-footer line that is not live composer chrome. */
function rejectingTailLine(lines: string[], footerIdx: number): string | undefined {
  for (let i = footerIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*$/.test(line)) continue
    if (SEPARATOR.test(line) || EMPTY_INPUT.test(line) || HINT.test(line)) continue
    return line
  }
  return undefined
}

/** Empty `❯` under the footer: the composer is still on screen. */
function composerBelowFooter(lines: string[], footerIdx: number): boolean {
  for (let i = footerIdx + 1; i < lines.length; i++) {
    if (EMPTY_INPUT.test(lines[i])) return true
  }
  return false
}

/** Skip option rows so a stale `❯` inside the frame does not hide the rule. */
function dialogRuleAbove(lines: string[], firstOptionIdx: number): boolean {
  for (let i = firstOptionIdx - 1; i >= 0; i--) {
    const line = lines[i]
    if (/^\s*$/.test(line) || isWrap(line) || OPTION_LINE.test(line)) continue
    return DIALOG_RULE.test(line)
  }
  return false
}

/** Consecutive keys start at 1 unless the first visible row marks a scrolled list. */
function sequentialKeys(options: { key: string }[], firstRow: string): boolean {
  const first = Number(options[0].key)
  if (first < 1 || (first !== 1 && !/^\s*↑/.test(firstRow))) return false
  for (let i = 0; i < options.length; i++) {
    if (options[i].key !== String(first + i)) return false
  }
  return true
}

export function parseBlockingDialog(screen: string): BlockingDialog | undefined {
  if (!screen) return undefined
  const lines = screenLines(screen)
  let footerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FOOTER.test(lines[i])) {
      footerIdx = i
      break
    }
  }
  if (footerIdx < 0) return undefined
  const tailLine = rejectingTailLine(lines, footerIdx)
  if (tailLine !== undefined) {
    // Dismissed dialogs in scrollback are routine. A new live status line can
    // also reach this fail-open path, so retain a debug signal for UI changes.
    console.debug(
      `[den-server] blocking-dialog: footer matched but the post-footer check rejected the tail (${JSON.stringify(
        tailLine.trim().slice(0, 80),
      )}); gate fail-open`,
    )
    return undefined
  }

  let lastOptionIdx = -1
  // Room for rows between the list and the footer (`… +1 model`, an effort row).
  const earliest = Math.max(0, footerIdx - 5)
  for (let i = footerIdx - 1; i >= earliest; i--) {
    if (OPTION_LINE.test(lines[i])) {
      lastOptionIdx = i
      break
    }
  }
  if (lastOptionIdx < 0) return undefined

  // One digit column, consecutive keys, and more deeply indented descriptions.
  // A blank ends the block so stale pointers above a gap are excluded. A rule
  // ends it unless the row above is the predecessor (the AskUserQuestion picker
  // draws a rule between "Type something." and "Chat about this"). Column-0
  // lists belong to a different column and cannot be glued onto the options.
  const options: { key: string; label: string }[] = []
  let pointers = 0
  let firstOptionIdx = lastOptionIdx
  let gapIndent = Infinity
  let blockDigitCol = -1
  for (let i = lastOptionIdx; i >= 0; i--) {
    const line = lines[i]
    if (/^\s*$/.test(line)) break
    const m = OPTION_LINE.exec(line)
    if (m) {
      const digitCol = line.search(/\d/)
      const top = options[0]
      if (!top) {
        blockDigitCol = digitCol
      } else if (digitCol !== blockDigitCol || gapIndent <= digitCol) {
        break
      } else {
        const prev = predecessorKey(top.key)
        if (prev === undefined || m[1] !== prev) break
      }
      if (/^\s*❯/.test(line)) pointers += 1
      options.unshift({ key: m[1], label: m[2].trim() })
      firstOptionIdx = i
      gapIndent = Infinity
      continue
    }
    if (SEPARATOR.test(line)) {
      const above = i > 0 ? lines[i - 1] : ''
      const aboveMatch = OPTION_LINE.exec(above)
      const top = options[0]
      const prev = top ? predecessorKey(top.key) : undefined
      if (
        aboveMatch &&
        prev !== undefined &&
        aboveMatch[1] === prev &&
        above.search(/\d/) === blockDigitCol
      ) {
        continue
      }
      break
    }
    if (isWrap(line)) {
      gapIndent = Math.min(gapIndent, line.search(/\S/))
      continue
    }
    break
  }
  if (options.length < 2 || pointers !== 1 || !sequentialKeys(options, lines[firstOptionIdx])) {
    return undefined
  }

  if (composerBelowFooter(lines, footerIdx) && !dialogRuleAbove(lines, firstOptionIdx)) {
    console.debug(
      '[den-server] blocking-dialog: footer matched above a live input box but no dialog rule frames the menu; gate fail-open',
    )
    return undefined
  }

  let sepIdx = -1
  for (let i = firstOptionIdx - 1; i >= 0; i--) {
    if (SEPARATOR.test(lines[i])) {
      sepIdx = i
      break
    }
  }
  let title = ''
  if (sepIdx >= 0) {
    for (let i = sepIdx + 1; i < firstOptionIdx; i++) {
      const line = lines[i]
      if (/^\s*$/.test(line) || SEPARATOR.test(line)) continue
      title = line.trim()
      break
    }
  }
  return { title, options }
}

/** Read and parse the screen, failing open for callers without their own logging
 * (the legacy `POST /term/inject` route). */
export async function dialogOnScreen(
  read: () => Promise<string> | string,
): Promise<BlockingDialog | undefined> {
  try {
    const raw = await read()
    return raw ? parseBlockingDialog(raw) : undefined
  } catch {
    return undefined
  }
}
