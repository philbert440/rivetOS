/**
 * Best-effort static check for run.ts determinism.
 *
 * Product rule: orchestration code must be deterministic between replays —
 * no wall clock, no randomness, no I/O outside step calls.
 *
 * This is a simple source scan, not a full eslint rule. It flags common
 * nondeterminism footguns; it does not prove purity.
 */

export interface DeterminismFinding {
  line: number
  column: number
  rule: string
  message: string
  snippet: string
}

const PATTERNS: Array<{ rule: string; re: RegExp; message: string }> = [
  {
    rule: 'no-date-now',
    re: /\bDate\.now\s*\(/g,
    message: 'Date.now() is nondeterministic — use a step if you need wall clock',
  },
  {
    rule: 'no-new-date',
    re: /\bnew\s+Date\s*\(/g,
    message: 'new Date() is nondeterministic in orchestration code',
  },
  {
    rule: 'no-math-random',
    re: /\bMath\.random\s*\(/g,
    message: 'Math.random() is nondeterministic — use a step if you need entropy',
  },
  {
    rule: 'no-fs-import',
    re: /\bfrom\s+['"]node:fs(?:\/promises)?['"]/g,
    message: 'Direct fs import in run.ts — I/O must go through step.* calls',
  },
  {
    rule: 'no-fs-require',
    re: /\brequire\s*\(\s*['"]fs['"]\s*\)/g,
    message: 'Direct fs require in run.ts — I/O must go through step.* calls',
  },
  {
    rule: 'no-fetch',
    re: /\bfetch\s*\(/g,
    message: 'fetch() in orchestration — network I/O must go through step.run/agent',
  },
]

/**
 * Scan run.ts source text for common nondeterminism patterns.
 * Returns findings (empty = clean). Does not throw.
 */
export function checkRunScriptDeterminism(source: string): DeterminismFinding[] {
  const findings: DeterminismFinding[] = []
  const lines = source.split(/\r?\n/)

  for (const { rule, re, message } of PATTERNS) {
    // Reset lastIndex for global regexes
    re.lastIndex = 0
    let match: RegExpExecArray | null
    const copy = new RegExp(re.source, re.flags)
    while ((match = copy.exec(source)) !== null) {
      const offset = match.index
      const { line, column } = offsetToLineCol(lines, offset)
      findings.push({
        line,
        column,
        rule,
        message,
        snippet: lines[line - 1]?.trim() ?? match[0],
      })
    }
  }

  return findings
}

function offsetToLineCol(lines: string[], offset: number): { line: number; column: number } {
  let remaining = offset
  for (let i = 0; i < lines.length; i++) {
    const len = lines[i].length + 1 // + newline
    if (remaining < len) {
      return { line: i + 1, column: remaining + 1 }
    }
    remaining -= len
  }
  return { line: lines.length, column: 1 }
}
