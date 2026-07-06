/**
 * TASK_RESULT parsing — shared by every executor (phase 2c).
 *
 * Extracted from the claude-cli executor so the chat-loop path emits the
 * same structured result (verdict/summary/artifacts/criteriaSelfReport);
 * without it, evaluation (2d) would only work for harness-session tasks.
 * Pure shape logic on the task contract — no runtime deps, lives here so
 * both core and provider plugins can import it without boundary edges.
 */

import type { TaskResult, TaskVerdict } from './task.js'

export const TASK_RESULT_FENCE = 'TASK_RESULT'

const TASK_RESULT_RE = /```TASK_RESULT\s*\n([\s\S]*?)```/g

/** Verdicts the MODEL may self-report — the scaffold only offers these.
 *  'killed'/'timeout'/'budget-exceeded' are runner/executor-owned: a model
 *  self-reporting one is coerced to 'failed' (it claimed abnormal-termination
 *  semantics, so failure is the honest reading) with its summary kept. */
const MODEL_VERDICTS: readonly TaskVerdict[] = ['completed', 'failed']
const COERCED_VERDICTS: readonly string[] = ['killed', 'timeout', 'budget-exceeded']

export interface ParsedTaskResult {
  verdict: TaskVerdict
  summary: string
  output?: string
  artifacts: TaskResult['artifacts']
  criteriaSelfReport?: TaskResult['criteriaSelfReport']
}

/** JSON Schema handed to `claude --json-schema` — the CLI forces the model
 *  through a StructuredOutput tool, so the result event carries exactly this
 *  shape (no mid-conversation fence false-positives, review P5a). */
export const TASK_RESULT_JSON_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['completed', 'failed'] },
    summary: { type: 'string', description: 'One-paragraph summary of what you did' },
    output: { type: 'string', description: 'Optional full result payload for the requester' },
    artifacts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['file', 'url', 'commit', 'message'] },
          ref: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['kind', 'ref'],
      },
    },
    criteriaSelfReport: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          met: { type: 'boolean' },
          evidence: { type: 'string' },
        },
        required: ['id', 'met'],
      },
    },
  },
  required: ['verdict', 'summary'],
})

/**
 * Parse a structured-output JSON string (the result event's `result` field
 * when --json-schema is in force). Same validation/coercion as the fenced
 * parser. Returns undefined on any shape problem; never throws.
 */
export function parseTaskResultJson(json: string): ParsedTaskResult | undefined {
  try {
    return validateTaskResultShape(JSON.parse(json) as Record<string, unknown>)
  } catch {
    return undefined
  }
}

/**
 * Parse the LAST fenced TASK_RESULT block out of the model's final text.
 * Fallback path — kept for CLIs without --json-schema, as belt-and-braces
 * when the structured result is missing, and as the PRIMARY path for the
 * chat-loop executor (AgentLoop has no structured-output flag). Never throws.
 */
export function parseTaskResultBlock(text: string): ParsedTaskResult | undefined {
  let match: RegExpExecArray | null
  let last: string | undefined
  TASK_RESULT_RE.lastIndex = 0
  while ((match = TASK_RESULT_RE.exec(text)) !== null) last = match[1]
  if (!last) return undefined
  try {
    return validateTaskResultShape(JSON.parse(last) as Record<string, unknown>)
  } catch {
    return undefined
  }
}

/** Shared shape validation + verdict coercion for both parse paths. */
export function validateTaskResultShape(
  raw: Record<string, unknown>,
): ParsedTaskResult | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  let verdict = raw.verdict
  const summary = raw.summary
  if (typeof verdict === 'string' && COERCED_VERDICTS.includes(verdict)) {
    verdict = 'failed'
  }
  if (typeof summary !== 'string' || !MODEL_VERDICTS.includes(verdict as TaskVerdict)) {
    return undefined
  }
  const artifacts = Array.isArray(raw.artifacts)
    ? (raw.artifacts as TaskResult['artifacts']).filter(
        (a) => typeof a === 'object' && typeof a.ref === 'string' && typeof a.kind === 'string',
      )
    : []
  const criteria = Array.isArray(raw.criteriaSelfReport)
    ? (raw.criteriaSelfReport as NonNullable<TaskResult['criteriaSelfReport']>).filter(
        (c) => typeof c === 'object' && typeof c.id === 'string' && typeof c.met === 'boolean',
      )
    : undefined
  return {
    verdict: verdict as TaskVerdict,
    summary,
    output: typeof raw.output === 'string' ? raw.output : undefined,
    artifacts,
    criteriaSelfReport: criteria,
  }
}

/**
 * The fence-contract scaffold block. claude-cli appends it after its
 * structured-output note; chat-loop appends it verbatim (fence is the ONLY
 * path there). Shared so the two executors never drift on the contract —
 * including the completed-when-pausing rule interactive sessions rely on.
 */
export function taskResultFenceInstructions(): string {
  return [
    '### Structured result (REQUIRED)',
    'You must report a structured result (verdict/summary/artifacts/',
    'criteriaSelfReport) at the end of the task. IMPORTANT: "failed" means',
    'the task itself failed and cannot proceed. If you are pausing to wait',
    'for input or a follow-up, use verdict "completed" with a summary of',
    'progress so far — the session stays resumable.',
    'End your FINAL message with a fenced code block labeled TASK_RESULT',
    'containing this shape:',
    '',
    '```TASK_RESULT',
    '{',
    '  "verdict": "completed" | "failed",',
    '  "summary": "one-paragraph summary of what you did",',
    '  "artifacts": [{ "kind": "file" | "url" | "commit" | "message", "ref": "...", "note": "..." }],',
    '  "criteriaSelfReport": [{ "id": "<criterion id>", "met": true, "evidence": "..." }]',
    '}',
    '```',
  ].join('\n')
}
