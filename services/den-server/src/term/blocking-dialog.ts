/**
 * Parse a live numbered menu dialog out of a herdr screen capture.
 * Fixture-driven from Claude Code 2.1.280 ("Teach auto mode about your
 * environment?") plus the 2.1.263 permission / AskUserQuestion screens.
 *
 * Shape-based: numbered options with exactly one ❯, a confirm/cancel footer,
 * and nothing after the footer except separators, an empty input box, or a
 * status/hint line. Unknown screens return undefined (fail open).
 */

import { screenLines } from './permission-prompt.js'

export interface BlockingDialog {
  /** First non-blank line after the nearest separator above the options (the dialog's
   *  question). May be ''. */
  title: string
  options: { key: string; label: string }[]
}

const OPTION_LINE = /^\s*(?:❯\s*)?(\d+)\.\s+(.+?)\s*$/
const SEPARATOR = /^[\s─━-]+$/
const FOOTER = /Enter to (confirm|select|continue)|Esc to (cancel|go back|exit)/
const EMPTY_INPUT = /^\s*❯\s*$/
const HINT = /⏵⏵|\? for shortcuts|shift\+tab to cycle|for agents/

function isWrap(line: string): boolean {
  if (/^\s*$/.test(line) || SEPARATOR.test(line) || OPTION_LINE.test(line)) return false
  return /^\s+\S/.test(line)
}

function afterFooterLive(lines: string[], footerIdx: number): boolean {
  for (let i = footerIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*$/.test(line)) continue
    if (SEPARATOR.test(line) || EMPTY_INPUT.test(line) || HINT.test(line)) continue
    return false
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
  if (!afterFooterLive(lines, footerIdx)) return undefined

  let lastOptionIdx = -1
  const earliest = Math.max(0, footerIdx - 3)
  for (let i = footerIdx - 1; i >= earliest; i--) {
    if (OPTION_LINE.test(lines[i])) {
      lastOptionIdx = i
      break
    }
  }
  if (lastOptionIdx < 0) return undefined

  // Walk up the option block. Blank, separator and indented lines between two
  // options are only skipped when they belong to the option above them: an
  // indented line is that option's description only if it sits deeper than
  // the option's number. The dialog's own title/body (and any reply above the
  // dialog) is not, so the walk stops there instead of gluing in numbered
  // lines — or an old `❯` row — from further up the screen.
  const options: { key: string; label: string }[] = []
  let pointers = 0
  let firstOptionIdx = lastOptionIdx
  let gapIndent = Infinity
  for (let i = lastOptionIdx; i >= 0; i--) {
    const line = lines[i]
    const m = OPTION_LINE.exec(line)
    if (m) {
      if (gapIndent <= line.search(/\d/)) break
      if (/^\s*❯/.test(line)) pointers += 1
      options.unshift({ key: m[1], label: m[2].trim() })
      firstOptionIdx = i
      gapIndent = Infinity
      continue
    }
    if (/^\s*$/.test(line) || SEPARATOR.test(line)) continue
    if (isWrap(line)) {
      gapIndent = Math.min(gapIndent, line.search(/\S/))
      continue
    }
    break
  }
  if (options.length < 2 || pointers !== 1) return undefined

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
