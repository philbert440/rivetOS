/**
 * Parse a live numbered menu dialog out of a herdr screen capture.
 * Fixture-driven from Claude Code 2.1.280 ("Teach auto mode about your
 * environment?") plus the 2.1.263 permission / AskUserQuestion screens.
 *
 * Claude-only. The driver gate is opt-in, and the legacy inject route checks
 * the roster command — anything that is not Claude Code fails open. Codex's
 * `Press enter to confirm or esc to cancel` and grok/kimi dialogs are not
 * matched and not gated — this footer looks for capital-E `Enter to
 * confirm|select|continue` / `Esc to cancel|go back|exit`, which those
 * harnesses do not render.
 *
 * Shape-based: numbered options with exactly one ❯, consecutive keys
 * (starting at 1 unless the first visible row has a scrolled-list `↑` marker), a confirm/cancel footer, and
 * nothing after the footer except separators, an empty input box, or the
 * composer status line. Unknown screens return undefined (fail open).
 *
 * The permission prompt and the AskUserQuestion picker replace the composer:
 * those captures have no empty `❯` between the footer and the bottom of the
 * screen, so the menu matches without a box rule. A menu above a still-present
 * composer (an empty `❯` between the footer and the status chrome) matches
 * only when a box-drawing rule frames the options. The walk climbs blank
 * lines and indented dialog body until that rule, or until a line that cannot
 * be dialog body — an assistant `●` / `⏺` bullet, an unindented non-rule
 * line, or the top of the screen — with a 40-line safety cap. A quoted menu
 * (question, options, and footer) above the live composer has no rule, so it
 * does not match. A quote that also copies the rule is not distinguishable
 * from the live dialog.
 */

import { screenLines } from './permission-prompt.js'
import { parseComposerInput } from './composer-input.js'

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

/** Safety cap on the upward rule walk. The stop is structural; this only
 *  bounds a pathological screen so a rule copied far up scrollback cannot
 *  frame a menu. */
const RULE_WALK_CAP = 40

/** Empty `❯` between the footer and the status chrome. A dialog that replaced
 *  the composer has no such input, so the gate does not also demand a frame. */
function composerBetweenFooterAndChrome(lines: string[], footerIdx: number): boolean {
  for (let i = footerIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (HINT.test(line)) return false
    if (EMPTY_INPUT.test(line)) return true
  }
  return false
}

/** Assistant reply marker. A quoted menu sits under one; a live dialog body does not. */
function isAssistantBullet(line: string): boolean {
  return /^\s*[●⏺○]/.test(line)
}

/** Blank line or indented dialog body (question, explanation, wrap, stale
 *  option row). An assistant bullet or an unindented non-rule line is not. */
function isDialogBodyLine(line: string): boolean {
  if (/^\s*$/.test(line)) return true
  if (isAssistantBullet(line)) return false
  if (SEPARATOR.test(line)) return false
  return /^\s+\S/.test(line)
}

/** Box rule above the options. Climbs blank lines and indented body until the
 *  rule (match) or a line that cannot be dialog body (miss). */
function dialogRuleAbove(lines: string[], firstOptionIdx: number): boolean {
  let steps = 0
  for (let i = firstOptionIdx - 1; i >= 0; i--) {
    steps += 1
    if (steps > RULE_WALK_CAP) return false
    const line = lines[i]
    if (DIALOG_RULE.test(line)) return true
    if (isDialogBodyLine(line)) continue
    return false
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
  // Scan up to the first option-like row. Ten lines covers the /model picker
  // plus one extra chrome row; a menu buried further up in scrollback does not.
  const earliest = Math.max(0, footerIdx - 10)
  for (let i = footerIdx - 1; i >= earliest; i--) {
    if (OPTION_LINE.test(lines[i])) {
      lastOptionIdx = i
      break
    }
  }
  if (lastOptionIdx < 0) {
    console.debug(
      '[den-server] blocking-dialog: footer matched but no option row within 10 lines above it; gate fail-open',
    )
    return undefined
  }

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
  let walkBreak: string | undefined
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
        walkBreak = 'column'
        break
      } else {
        const prev = predecessorKey(top.key)
        if (prev === undefined || m[1] !== prev) {
          walkBreak = 'predecessor'
          break
        }
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
      walkBreak = 'separator'
      break
    }
    if (isWrap(line)) {
      gapIndent = Math.min(gapIndent, line.search(/\S/))
      continue
    }
    walkBreak = 'content'
    break
  }
  if (options.length < 2 || pointers !== 1 || !sequentialKeys(options, lines[firstOptionIdx])) {
    console.debug(
      `[den-server] blocking-dialog: option walk rejected (${walkBreak ?? 'shape'}); gate fail-open`,
    )
    return undefined
  }

  if (composerBetweenFooterAndChrome(lines, footerIdx) && !dialogRuleAbove(lines, firstOptionIdx)) {
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

/** What a pre-send screen read found. At most one is set: an open dialog wins,
 *  since its input box can't hold a draft. */
export interface PreSendBlock {
  dialog?: BlockingDialog
  /** The input box holds unsent text. A paste would be appended to it and
   *  submitted as one message (`/model` + `test 1` → `/modeltest 1`). */
  draft?: boolean
}

/** Parse one pre-send screen read. An empty screen blocks nothing. */
export function parsePreSendBlock(raw: string): PreSendBlock {
  if (!raw) return {}
  const dialog = parseBlockingDialog(raw)
  if (dialog) return { dialog }
  return parseComposerInput(raw) !== undefined ? { draft: true } : {}
}

/** Read and parse the screen, failing open for callers without their own logging
 * (the legacy `POST /term/inject` route): a read error blocks nothing. */
export async function preSendBlockOnScreen(
  read: () => Promise<string> | string,
): Promise<PreSendBlock> {
  try {
    return parsePreSendBlock(await read())
  } catch {
    return {}
  }
}

/** The dialog half of `preSendBlockOnScreen`. */
export async function dialogOnScreen(
  read: () => Promise<string> | string,
): Promise<BlockingDialog | undefined> {
  return (await preSendBlockOnScreen(read)).dialog
}
