import type { CaptureMessage, CaptureRedactionOptions } from './types.js'

/**
 * Exact credential key names for tool_args. Substring forms like "author" /
 * "token_count" must not match — fidelity of ordinary fields wins over greedy
 * secret hunting.
 */
const SECRET_KEY_RE =
  /^(?:api[_-]?key|access[_-]?token|token|secret|password|passwd|credential|authorization|private[_-]?key|auth_token|client_secret)$/i

/** Credential keywords for assignment forms (word-anchored, not substrings). */
const ASSIGNMENT_KEY =
  '(?:api[_-]?key|access[_-]?token|token|secret|password|passwd|credential|authorization|private[_-]?key)'

/**
 * Operator / builtin regexes only see this many UTF-16 units per string.
 * Matches the den content cap: bytes beyond this are truncated before storage,
 * so scanning further only burns CPU.
 */
export const REDACT_SCAN_LIMIT = 16_000

/**
 * Heuristic for nested-quantifier ReDoS shapes such as `(a+)+b`. JS has no
 * regex timeout; validate rejects these and resolve skips them at runtime.
 */
export function isUnsafeRegexSource(source: string): boolean {
  // (…+)+  (…*)*  (…+)*  (…*)+  and the same with ?/{n,} on the outer group.
  return /\((?:[^\\)]|\\.)*[+*](?:[^\\)]|\\.)*\)(?:[+*?]|\{\d+,?\d*\})/.test(source)
}

export type BuiltinDetectorId =
  | 'bearer'
  | 'assignment'
  | 'aws_access_key'
  | 'github_token'
  | 'slack_token'
  | 'sk_token'
  | 'jwt'
  | 'pem_private_key'

interface BuiltinDetector {
  id: BuiltinDetectorId
  /** Global regex; must not retain lastIndex across calls (fresh or sticky-safe). */
  pattern: RegExp
  placeholder: string
}

/**
 * Built-in secret shapes. Order matters: specific token shapes and bearer/PEM
 * run before the assignment rule so a multi-word `password: …` value cannot
 * swallow an AKIA / ghp_ / sk- later on the same line.
 */
const BUILTIN_DETECTORS: BuiltinDetector[] = [
  {
    id: 'bearer',
    // Bare English "basic"/"Bearer credentials…" are not credentials. Bearer
    // requires a digit or symbol in the token; Basic requires base64-ish.
    // Trailing `.` / `,` stay outside the match.
    pattern:
      /\b(?:Bearer\s+(?=[A-Za-z0-9_\-+/=]*[0-9_\-+/=])[A-Za-z0-9_\-+/=]{8,}|Basic\s+[A-Za-z0-9+/]{16,}={0,2})(?![A-Za-z0-9+/=])/gi,
    placeholder: '[REDACTED:bearer]',
  },
  {
    id: 'pem_private_key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    placeholder: '[REDACTED:pem_private_key]',
  },
  {
    id: 'aws_access_key',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    placeholder: '[REDACTED:aws_access_key]',
  },
  {
    id: 'github_token',
    pattern: /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/g,
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
  {
    id: 'assignment',
    // Negative lookahead so a prior detector's placeholder is not re-eaten
    // (e.g. "Authorization: [REDACTED:bearer]"). Value may be multi-word on
    // one line; `[` stops the value so earlier placeholders on the same line
    // are preserved. Trailing , ; stay outside the match.
    pattern: new RegExp(
      `\\b(${ASSIGNMENT_KEY}\\s*[=:]\\s*)(?!\\[REDACTED)[^\\s\\n\\r,;[\\]]+(?:[ \\t]+[^\\s\\n\\r,;[\\]]+)*`,
      'gi',
    ),
    placeholder: '$1[REDACTED:assignment]',
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
 *
 * Note: boot validates the YAML block but does not yet inject it into harness
 * hook processes — callers pass options explicitly or use the env helper.
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
      if (isUnsafeRegexSource(source)) continue
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
  const next = text.replace(regex, (_match, group1: unknown) => {
    count += 1
    if (replacement.includes('$1')) {
      // Never fall back to the full match — that would re-emit the secret.
      const g1 = typeof group1 === 'string' ? group1 : ''
      return replacement.replace(/\$1/g, g1)
    }
    return replacement
  })
  return { text: next, count }
}

function redactTextBody(text: string, resolved: ResolvedCaptureRedaction): RedactionApplyResult {
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

/**
 * Redact a single string; returns the text and how many spans were replaced.
 * Only the first {@link REDACT_SCAN_LIMIT} units are scanned — the same budget
 * the writer keeps after `capMessage` — so operator patterns cannot ReDoS on
 * multi-megabyte tool dumps.
 */
export function redactText(text: string, resolved: ResolvedCaptureRedaction): RedactionApplyResult {
  if (text.length <= REDACT_SCAN_LIMIT) {
    return redactTextBody(text, resolved)
  }
  const head = text.slice(0, REDACT_SCAN_LIMIT)
  const tail = text.slice(REDACT_SCAN_LIMIT)
  const result = redactTextBody(head, resolved)
  return { text: result.text + tail, count: result.count }
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
      // Only string secret values are replaced wholesale. Numbers / nested
      // objects under a secret-shaped key keep structure; nested walk still
      // redacts string leaves. Exact key match (not substring).
      if (SECRET_KEY_RE.test(key) && typeof child === 'string') {
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
