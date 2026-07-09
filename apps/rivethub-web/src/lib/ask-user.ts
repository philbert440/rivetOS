/**
 * Extract ask-user prompts from ask-user tool shapes.
 * Supports:
 * - Claude AskUserQuestion: { questions: [{ question, header, multiSelect,
 *   options: [{ label, description }] }] }
 * - Grok ask_user_question: flat options/choices (strings or {label})
 * - RivetOS ask_user: { choices: string[] }
 * Missing/malformed args → empty array (never throws).
 */

import { normalizeToolName } from './tool-titles.js'

const ASK_TOOL_NAMES = new Set(['ask_user', 'ask_user_question', 'askuserquestion'])

export function isAskUserTool(name: string): boolean {
  const n = normalizeToolName(name).toLowerCase().replace(/\s+/g, '_')
  return ASK_TOOL_NAMES.has(n)
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

// ---------------------------------------------------------------------------
// Structured extraction — the composer's ask card.

export interface AskOption {
  label: string
  description?: string
}

export interface AskQuestion {
  /** The question text itself (may be absent on bare option lists). */
  question?: string
  /** Claude's short chip label ("Auth method") — used as the answer prefix
   *  when multiple questions are answered at once. */
  header?: string
  multiSelect: boolean
  options: AskOption[]
}

function optionFrom(opt: unknown): AskOption | undefined {
  const label = labelFromOption(opt)
  if (!label) return undefined
  if (opt && typeof opt === 'object') {
    const d = (opt as Record<string, unknown>).description
    if (typeof d === 'string' && d.trim()) return { label, description: d.trim() }
  }
  return { label }
}

function optionsFromArray(arr: unknown): AskOption[] {
  if (!Array.isArray(arr)) return []
  const seen = new Set<string>()
  const out: AskOption[] = []
  for (const item of arr) {
    const o = optionFrom(item)
    if (!o || seen.has(o.label)) continue
    seen.add(o.label)
    out.push(o)
    if (out.length >= 10) break
  }
  return out
}

function questionFrom(q: unknown): AskQuestion | undefined {
  if (!q || typeof q !== 'object') return undefined
  const qo = q as Record<string, unknown>
  const options = [...optionsFromArray(qo.options), ...optionsFromArray(qo.choices)]
  if (options.length === 0) return undefined
  const question =
    typeof qo.question === 'string' && qo.question.trim() ? qo.question.trim() : undefined
  const header = typeof qo.header === 'string' && qo.header.trim() ? qo.header.trim() : undefined
  return { question, header, multiSelect: qo.multiSelect === true, options }
}

/**
 * Parse tool args into structured ask questions. Safe on any unknown input;
 * empty array when nothing extractable (caller falls back to nothing).
 */
export function extractAskUserQuestions(args: unknown): AskQuestion[] {
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

  // Nested Claude shape — up to 4 questions per call.
  if (Array.isArray(obj.questions)) {
    const nested = obj.questions.map(questionFrom).filter((q): q is AskQuestion => q !== undefined)
    if (nested.length) return nested.slice(0, 4)
  }

  // Flat single-question shapes (grok / rivetos / yes_no).
  const flat = questionFrom(obj)
  if (flat) return [flat]
  if (obj.type === 'yes_no') {
    const question =
      typeof obj.question === 'string' && obj.question.trim() ? obj.question.trim() : undefined
    return [{ question, multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] }]
  }
  return []
}

/**
 * From a live tool stack (newest last), the last ask-user tool's structured
 * questions — running or done (headless CLIs auto-complete the tool; the
 * answer is the next user turn).
 */
export function questionsFromLiveTools(
  tools: ReadonlyArray<{ name: string; args?: unknown; status: string }>,
): AskQuestion[] {
  for (let i = tools.length - 1; i >= 0; i--) {
    const t = tools[i]
    if (!isAskUserTool(t.name)) continue
    const qs = extractAskUserQuestions(t.args)
    if (qs.length) return qs
  }
  return []
}
