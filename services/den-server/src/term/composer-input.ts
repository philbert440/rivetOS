/**
 * Parse Claude Code's composer input box out of a herdr screen capture.
 * Fixture-driven from Claude Code 2.1.280.
 */

import { screenLines } from './permission-prompt.js'

const INPUT_LINE = /^\s*❯\s?(.*)$/
const OPTION_LINE = /^\s*(?:❯\s*)?\d+\.\s+/
const SEPARATOR = /^[\s─━-]+$/
const HINT = /⏵⏵|\? for shortcuts|shift\+tab to cycle|for agents/

function belowIsChrome(lines: string[], idx: number): boolean {
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
    return text || undefined
  }
  return undefined
}
