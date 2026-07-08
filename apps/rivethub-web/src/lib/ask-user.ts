/**
 * Extract suggestion-chip labels from ask-user tool shapes.
 * Supports:
 * - Claude AskUserQuestion: { questions: [{ options: [{ label }] }] }
 * - Grok ask_user_question: flat options/choices (strings or {label})
 * - RivetOS ask_user: { choices: string[] }
 * Missing/malformed args → empty array (never throws).
 */

import { normalizeToolName } from './tool-titles.js'

const ASK_TOOL_NAMES = new Set(['ask_user', 'ask_user_question', 'askuserquestion'])

export function isAskUserTool(name: string): boolean {
  const n = normalizeToolName(name).toLowerCase().replace(/\s+/g, '_')
  return ASK_TOOL_NAMES.has(n) || n === 'askuserquestion'
}

function labelFromOption(opt: unknown): string | undefined {
  if (typeof opt === 'string' && opt.trim()) return opt.trim()
  if (opt && typeof opt === 'object') {
    const o = opt as Record<string, unknown>
    if (typeof o.label === 'string' && o.label.trim()) return o.label.trim()
    if (typeof o.value === 'string' && o.value.trim()) return o.value.trim()
    if (typeof o.text === 'string' && o.text.trim()) return o.text.trim()
  }
  return undefined
}

function labelsFromArray(arr: unknown): string[] {
  if (!Array.isArray(arr)) return []
  const out: string[] = []
  for (const item of arr) {
    const l = labelFromOption(item)
    if (l) out.push(l)
  }
  return out
}

/**
 * Parse tool args / metadata into chip labels. Safe on any unknown input.
 */
export function extractAskUserOptions(args: unknown): string[] {
  if (args == null) return []
  let root: unknown = args
  if (typeof args === 'string') {
    try {
      root = JSON.parse(args) as unknown
    } catch {
      return []
    }
  }
  if (typeof root !== 'object' || root === null) return []
  const obj = root as Record<string, unknown>

  // Nested Claude shape
  if (Array.isArray(obj.questions)) {
    const nested: string[] = []
    for (const q of obj.questions) {
      if (!q || typeof q !== 'object') continue
      const qo = q as Record<string, unknown>
      nested.push(...labelsFromArray(qo.options))
      nested.push(...labelsFromArray(qo.choices))
    }
    if (nested.length) return dedupe(nested)
  }

  // Flat options / choices
  const flat = [...labelsFromArray(obj.options), ...labelsFromArray(obj.choices)]
  if (flat.length) return dedupe(flat)

  // yes_no with no explicit options
  if (obj.type === 'yes_no') return ['Yes', 'No']

  return []
}

function dedupe(labels: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const l of labels) {
    if (seen.has(l)) continue
    seen.add(l)
    out.push(l)
    if (out.length >= 10) break
  }
  return out
}

/**
 * From a live tool stack (newest last), return chips for the last **running**
 * ask-user tool with extractable options. Done/error tools do not show chips
 * (avoids re-send after the question completed).
 */
export function chipsFromLiveTools(
  tools: ReadonlyArray<{ name: string; args?: unknown; status: string }>,
): string[] {
  for (let i = tools.length - 1; i >= 0; i--) {
    const t = tools[i]
    if (t.status !== 'running') continue
    if (!isAskUserTool(t.name)) continue
    const opts = extractAskUserOptions(t.args)
    if (opts.length) return opts
  }
  return []
}
