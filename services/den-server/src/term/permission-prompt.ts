/**
 * Parse a harness permission dialog out of a herdr screen capture.
 * Fixture-driven: Claude Code 2.1.263 "Do you want to proceed?", grok 1.0.13
 * ┃-guttered radio list, kimi-code 0.36.0 approval panel (partially verified).
 */

import { stripAnsi } from '@rivetos/types'

export interface ParsedPermissionPrompt {
  toolName: string
  text: string
  options: { key: string; label: string }[]
}

const OPTION_LINE = /^\s*(?:❯\s*)?(\d)\.\s+(.+?)\s*$/
const SEPARATOR = /^[\s─━─-]+$/
const GROK_ITEM = /(\d)\s*\([●○]\)\s*([^/┃]+?)(?=\s*\/\s*\d|\s*$)/g

function linesOf(screen: string): string[] {
  return stripAnsi(screen).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
}

function parseClaude(lines: string[], proceedIdx: number): ParsedPermissionPrompt | undefined {
  const options: { key: string; label: string }[] = []
  for (let i = proceedIdx + 1; i < lines.length; i++) {
    const m = OPTION_LINE.exec(lines[i])
    if (m) {
      options.push({ key: m[1], label: m[2].trim() })
      continue
    }
    if (options.length > 0) break
  }
  if (options.length === 0) return undefined

  const before: string[] = []
  for (let i = proceedIdx - 1; i >= 0; i--) {
    const l = lines[i]
    if (/^\s*$/.test(l) || SEPARATOR.test(l)) {
      if (before.length > 0) break
      continue
    }
    // Spinner / waiting chrome above the panel.
    if (/^\s*[●○]\s/.test(l) || /^\s*⎿/.test(l) || /Waiting…/.test(l)) {
      if (before.length > 0) break
      continue
    }
    before.unshift(l)
  }
  const toolName = before[0]?.trim() || 'tool'
  const text = before
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
  return { toolName, text, options }
}

function parseGrok(lines: string[]): ParsedPermissionPrompt | undefined {
  const options: { key: string; label: string }[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    if (!line.includes('┃') && !/\([●○]\)/.test(line)) continue
    GROK_ITEM.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = GROK_ITEM.exec(line))) {
      const key = m[1]
      if (seen.has(key)) continue
      seen.add(key)
      options.push({ key, label: m[2].trim() })
    }
  }
  if (options.length === 0) return undefined
  if (!options.some((o) => o.key === '1' || o.key === '2' || o.key === '3')) return undefined
  return {
    toolName: 'tool',
    text: options.map((o) => o.label).join('\n'),
    options,
  }
}

function parseKimi(lines: string[]): ParsedPermissionPrompt | undefined {
  // herdr rule is current_approval_panel; the screen footer is
  // "↑/↓ select · 1/2/3/4 choose · ↵ confirm". Full 1/2 rows were not in the
  // capture log — this parser is unverified above option 3.
  const footer = lines.some((l) => /choose/.test(l) && /confirm/.test(l))
  if (!footer) return undefined
  const options: { key: string; label: string }[] = []
  for (const line of lines) {
    const m = OPTION_LINE.exec(line)
    if (m) options.push({ key: m[1], label: m[2].trim() })
  }
  if (options.length === 0) return undefined
  return {
    toolName: 'tool',
    text: options.map((o) => o.label).join('\n'),
    options,
  }
}

export function parsePermissionPrompt(screen: string): ParsedPermissionPrompt | undefined {
  if (!screen) return undefined
  const lines = linesOf(screen)
  const proceedIdx = lines.findIndex((l) => /^\s*Do you want to proceed\?\s*$/.test(l))
  if (proceedIdx >= 0) return parseClaude(lines, proceedIdx)
  const grok = parseGrok(lines)
  if (grok) return grok
  return parseKimi(lines)
}
