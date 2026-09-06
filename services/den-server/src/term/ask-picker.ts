/**
 * Parse a Claude Code AskUserQuestion picker out of a herdr screen capture.
 * Fixture-driven from Claude Code 2.1.263 (`claude-tui-keys-2.1.263.md`).
 *
 * Anchors on the numbered `Type something` row plus the `Enter to select`
 * footer — never on prose. Only the current question's options are on screen.
 */

import type { HarnessAskOption, HarnessAskQuestion } from '@rivetos/types'
import { screenLines } from './permission-prompt.js'

export interface ParsedAskPicker {
  questions: HarnessAskQuestion[]
  current: number
}

const SEPARATOR = /^[\s─━-]+$/
const FOOTER = /Enter to select/
const TYPE_SOMETHING = /^\s*(?:❯\s*)?\d+\.\s+(?:\[[ ✔]\]\s+)?Type something\.?\s*$/i
const OPTION_LINE = /^\s*(?:❯\s*)?(\d+)\.\s+(?:\[([ ✔])\]\s+)?(.+?)\s*$/
const TAB_CHIP = /([☐☒])\s+(\S+)/g

function isTabRow(line: string): boolean {
  return /[☐☒]/.test(line)
}

function parseTabRow(line: string): { headers: string[]; current: number } | undefined {
  const headers: string[] = []
  let firstOpen = -1
  TAB_CHIP.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAB_CHIP.exec(line))) {
    const header = m[2]
    if (!header) continue
    const idx = headers.length
    headers.push(header)
    if (m[1] === '☐' && firstOpen < 0) firstOpen = idx
  }
  if (headers.length === 0) return undefined
  const current = firstOpen >= 0 ? firstOpen : 0
  return { headers, current }
}

export function parseAskPicker(screen: string): ParsedAskPicker | undefined {
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

  let typeIdx = -1
  for (let i = footerIdx - 1; i >= 0; i--) {
    if (TYPE_SOMETHING.test(lines[i])) {
      typeIdx = i
      break
    }
  }
  if (typeIdx < 0) return undefined

  const collected: { option: HarnessAskOption; boxed: boolean }[] = []
  let pendingDesc: string[] = []
  let firstOptionIdx = typeIdx
  for (let i = typeIdx - 1; i >= 0; i--) {
    const line = lines[i]
    if (/^\s*$/.test(line) || SEPARATOR.test(line)) {
      if (collected.length > 0) break
      continue
    }
    const m = OPTION_LINE.exec(line)
    if (m && !TYPE_SOMETHING.test(line)) {
      const label = m[3]?.trim() ?? ''
      if (!label) continue
      const description = pendingDesc.length > 0 ? pendingDesc.join(' ') : undefined
      pendingDesc = []
      const option: HarnessAskOption = description ? { label, description } : { label }
      collected.unshift({ option, boxed: m[2] !== undefined })
      firstOptionIdx = i
      continue
    }
    // Descriptions sit under each option and are indented past the `N. ` gutter
    // (`     The color red`). A one-space gutter on the question line is not.
    if (/^\s{3,}\S/.test(line) && !OPTION_LINE.test(line)) {
      pendingDesc.unshift(line.trim())
      continue
    }
    break
  }
  if (collected.length === 0) return undefined

  const multiSelect = collected.some((c) => c.boxed)
  const options = collected.map((c) => c.option)

  let question: string | undefined
  let tab: { headers: string[]; current: number } | undefined
  for (let i = firstOptionIdx - 1; i >= 0; i--) {
    const line = lines[i]
    if (/^\s*$/.test(line) || SEPARATOR.test(line)) {
      if (question || tab) break
      continue
    }
    if (isTabRow(line)) {
      tab = parseTabRow(line) ?? tab
      continue
    }
    if (!question) question = line.trim()
    if (tab) break
  }

  if (!tab) {
    return {
      current: 0,
      questions: [
        {
          ...(question ? { question } : {}),
          multiSelect,
          options,
        },
      ],
    }
  }

  const current = tab.current
  const questions: HarnessAskQuestion[] = tab.headers.map((header, i) => {
    if (i === current) {
      return {
        ...(question ? { question } : {}),
        header,
        multiSelect,
        options,
      }
    }
    return { header, multiSelect: false, options: [] }
  })
  return { questions, current }
}
