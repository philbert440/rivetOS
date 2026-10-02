import type { CaptureMessage, CaptureRedactionOptions } from './types.js'

/** Secret-shaped object keys — whole value replaced when walking tool_args. */
const SECRET_KEY_RE =
  /^(?:.*(?:password|passwd|secret|token|api[_-]?key|authorization|auth|credential|private[_-]?key).*)$/i

export type BuiltinDetectorId =
  'bearer' | 'assignment' | 'aws_access_key' | 'github_token' | 'slack_token' | 'sk_token' | 'jwt'

interface BuiltinDetector {
  id: BuiltinDetectorId
  /** Global regex; must not retain lastIndex across calls (fresh or sticky-safe). */
  pattern: RegExp
  placeholder: string
}

/**
 * Built-in secret shapes. Order matters: bearer/basic before the assignment
 * rule so "Bearer <token>" is not partially eaten by the key= form.
 */
const BUILTIN_DETECTORS: BuiltinDetector[] = [
  {
    id: 'bearer',
    pattern: /\b(bearer|basic)\s+[\w+./=-]{8,}/gi,
    placeholder: '[REDACTED:bearer]',
  },
  {
    id: 'assignment',
    // Negative lookahead so a prior detector's placeholder is not re-eaten
    // (e.g. "Authorization: [REDACTED:bearer]").
    pattern:
      /\b([\w-]*(?:key|token|secret|passw(?:or)?d|credential|auth)[\w-]*\s*[=:]\s*)(?!\[REDACTED)\S+/gi,
    placeholder: '$1[REDACTED:assignment]',
  },
  {
    id: 'aws_access_key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    placeholder: '[REDACTED:aws_access_key]',
  },
  {
    id: 'github_token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    placeholder: '[REDACTED:github_token]',
  },
  {
    id: 'slack_token',
    pattern: /\bxox[a-z]-[\w-]{10,}\b/g,
    placeholder: '[REDACTED:slack_token]',
  },
  {
    id: 'sk_token',
    pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    placeholder: '[REDACTED:sk_token]',
  },
  {
    id: 'jwt',
    pattern: /\beyJ[\w-]{8,}\.[\w-]+\.[\w-]+\b/g,
    placeholder: '[REDACTED:jwt]',
  },
]

export interface ResolvedCaptureRedaction {
  enabled: true
  builtins: boolean
  /** Compiled operator patterns with stable placeholder indices. */
  patterns: Array<{ source: string; regex: RegExp; index: number }>
}

export interface RedactionApplyResult {
  text: string
  count: number
}

function truthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false
  const v = value.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/**
 * Normalise writer options or a YAML `memory.capture.redaction` slice.
 * Returns null when redaction should not run.
 */
export function resolveCaptureRedaction(
  input: CaptureRedactionOptions | null | undefined,
): ResolvedCaptureRedaction | null {
  if (input == null) return null
  if (input.enabled !== true) return null
  const builtins = input.builtins !== false
  const patterns: ResolvedCaptureRedaction['patterns'] = []
  if (Array.isArray(input.patterns)) {
    for (let index = 0; index < input.patterns.length; index += 1) {
      const source = input.patterns[index]
      if (typeof source !== 'string' || source.length === 0) continue
      try {
        patterns.push({ source, regex: new RegExp(source, 'g'), index })
      } catch {
        /* Invalid patterns are rejected at config validate; skip at runtime. */
      }
    }
  }
  if (!builtins && patterns.length === 0) return null
  return { enabled: true, builtins, patterns }
}

/**
 * Opt-in from process env for hooks that do not load YAML.
 * `RIVETOS_CAPTURE_REDACTION=1|true|yes|on` enables built-ins.
 */
export function captureRedactionFromEnv(
  env: NodeJS.Dict<string> = process.env,
): CaptureRedactionOptions | undefined {
  if (!truthyEnv(env.RIVETOS_CAPTURE_REDACTION)) return undefined
  return { enabled: true, builtins: true }
}

function applyRegex(text: string, regex: RegExp, replacement: string): RedactionApplyResult {
  // Reset lastIndex for global patterns reused across calls.
  regex.lastIndex = 0
  let count = 0
  const next = text.replace(regex, (match, group1: unknown) => {
    count += 1
    if (replacement.includes('$1')) {
      const g1 = typeof group1 === 'string' ? group1 : ''
      return replacement.replace(/\$1/g, g1 || match)
    }
    return replacement
  })
  return { text: next, count }
}

/** Redact a single string; returns the text and how many spans were replaced. */
export function redactText(text: string, resolved: ResolvedCaptureRedaction): RedactionApplyResult {
  let current = text
  let count = 0
  if (resolved.builtins) {
    for (const detector of BUILTIN_DETECTORS) {
      const result = applyRegex(current, detector.pattern, detector.placeholder)
      current = result.text
      count += result.count
    }
  }
  for (const pattern of resolved.patterns) {
    const result = applyRegex(current, pattern.regex, `[REDACTED:pattern:${String(pattern.index)}]`)
    current = result.text
    count += result.count
  }
  return { text: current, count }
}

function redactValue(
  value: unknown,
  resolved: ResolvedCaptureRedaction,
): {
  value: unknown
  count: number
} {
  if (typeof value === 'string') {
    const result = redactText(value, resolved)
    return { value: result.text, count: result.count }
  }
  if (Array.isArray(value)) {
    let count = 0
    const next = value.map((item) => {
      const redacted = redactValue(item, resolved)
      count += redacted.count
      return redacted.value
    })
    return { value: next, count }
  }
  if (value !== null && typeof value === 'object') {
    let count = 0
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(key) && child !== undefined) {
        out[key] = '[REDACTED:secret_key]'
        count += 1
        continue
      }
      const redacted = redactValue(child, resolved)
      out[key] = redacted.value
      count += redacted.count
    }
    return { value: out, count }
  }
  return { value, count: 0 }
}

/** Apply redaction to one capture message. Returns the message and span count. */
export function redactMessage(
  message: CaptureMessage,
  resolved: ResolvedCaptureRedaction,
): { message: CaptureMessage; count: number } {
  let count = 0
  const content = redactText(message.content, resolved)
  count += content.count
  let toolResult = message.tool_result
  if (typeof toolResult === 'string') {
    const result = redactText(toolResult, resolved)
    toolResult = result.text
    count += result.count
  }
  let toolArgs = message.tool_args
  if (toolArgs !== undefined) {
    const result = redactValue(toolArgs, resolved)
    toolArgs = result.value
    count += result.count
  }
  if (count === 0) return { message, count: 0 }
  return {
    message: {
      ...message,
      content: content.text,
      ...(toolResult !== undefined ? { tool_result: toolResult } : {}),
      ...(toolArgs !== undefined ? { tool_args: toolArgs } : {}),
    },
    count,
  }
}

export { SECRET_KEY_RE, BUILTIN_DETECTORS }
