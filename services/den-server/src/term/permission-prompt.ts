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
const SEPARATOR = /^[\s─━-]+$/
const FOOTER = /Esc to cancel|Tab to amend|↵ confirm|choose/
const GROK_ITEM = /(\d)\s*\([●○]\)\s*([^/┃]+?)(?=\s*\/\s*\d|\s*$)/g

/** ANSI-stripped, newline-normalized screen lines. Shared with ask-picker. */
export function screenLines(screen: string): string[] {
  return stripAnsi(screen).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
}

function parseClaude(lines: string[], proceedIdx: number): ParsedPermissionPrompt | undefined {
  const options: { key: string; label: string }[] = []
  for (let i = proceedIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    const m = OPTION_LINE.exec(line)
    if (m) {
      options.push({ key: m[1], label: m[2].trim() })
      continue
    }
    if (options.length === 0) continue
    if (FOOTER.test(line) || /^\s*$/.test(line) || SEPARATOR.test(line)) break
    // A long label wraps onto indented continuation lines ("… commands in
    // <cwd>") — glue them onto the previous option instead of stopping.
    const last = options[options.length - 1]
    last.label = `${last.label} ${line.trim()}`
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
  const title = before[0]?.trim() || 'tool'
  // Panel title is "Bash command" / "Edit file" — the tool name is the head.
  const toolName = title.replace(/\s+(command|file|files|tool|request|edit|write)$/i, '') || title
  const text = [
    title,
    ...before
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean),
  ].join('\n')
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
  // herdr rule is current_approval_panel; the panel footer is
  // "↑/↓ select · 1/2/3/4 choose · ↵ confirm" and the numbered rows sit
  // DIRECTLY above it. Anchor on that footer line — not on prose that happens
  // to contain "choose" and "confirm" — and only harvest the contiguous block
  // of numbered rows above it. Rows 1/2 were not in the capture: unverified.
  const footerIdx = lines.findIndex((l) => /↑\/↓.*choose.*↵\s*confirm/.test(l))
  if (footerIdx < 0) return undefined
  const options: { key: string; label: string }[] = []
  for (let i = footerIdx - 1; i >= 0; i--) {
    const line = lines[i]
    if (/^\s*$/.test(line) || SEPARATOR.test(line)) {
      if (options.length > 0) break
      continue
    }
    const m = OPTION_LINE.exec(line)
    if (!m) {
      if (options.length > 0) break
      continue
    }
    options.unshift({ key: m[1], label: m[2].trim() })
  }
  if (options.length === 0) return undefined
  return {
    toolName: 'tool',
    text: options.map((o) => o.label).join('\n'),
    options,
  }
}

/** Codex CLI 0.153.4, captured on rivet-gpt 2026-09-07. */
function parseCodex(lines: string[]): ParsedPermissionPrompt | undefined {
  const start = lines.findLastIndex((l) =>
    /^\s*Would you like to run the following command\?\s*$/.test(l),
  )
  if (start < 0) return undefined
  const end = lines.findIndex(
    (l, i) => i > start && /Press enter to confirm or esc to cancel/.test(l),
  )
  if (end < 0) return undefined
  const body: string[] = []
  const rows: string[] = []
  for (const line of lines.slice(start + 1, end)) {
    const match = /^\s*(?:›\s*)?\d\.\s+(.+)$/.exec(line)
    if (match) rows.push(match[1])
    else if (rows.length && line.trim()) rows[rows.length - 1] += ` ${line.trim()}`
    else if (line.trim()) body.push(line.trim())
  }
  const options: { key: string; label: string }[] = []
  for (const label of rows) {
    if (/^Yes, proceed \(y\)$/.test(label)) options.push({ key: 'y', label })
    // Prefix rules persist beyond this session. Do not offer this as allow-session.
    if (/^No,.*\(esc\)$/.test(label)) options.push({ key: '\u001b', label })
  }
  if (options.length !== 2 || !body.some((l) => l.startsWith('$ '))) return undefined
  return { toolName: 'shell', text: body.join('\n'), options }
}

export function parsePermissionPrompt(screen: string): ParsedPermissionPrompt | undefined {
  if (!screen) return undefined
  const lines = screenLines(screen)
  const codex = parseCodex(lines)
  if (codex) return codex
  const proceedIdx = lines.findIndex((l) => /^\s*Do you want to proceed\?\s*$/.test(l))
  if (proceedIdx >= 0) return parseClaude(lines, proceedIdx)
  const grok = parseGrok(lines)
  if (grok) return grok
  return parseKimi(lines)
}
