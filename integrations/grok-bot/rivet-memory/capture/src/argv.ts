/**
 * Node's parseArgs treats a following token that starts with `-` as another
 * option, so `--session-suffix -v3` and `--after-seq -1` throw
 * "ambiguous option". Callers should use the `=` form; this helper also
 * rewrites the space form for known string flags so a leftover spawn site
 * cannot break live capture.
 */
const DASH_VALUE_FLAGS = new Set([
  '--session-suffix',
  '--after-seq',
  '--session',
  '--session-id',
  '--agent-id',
  '--agent',
  '--persona',
  '--format',
  '--out',
  '--from-transcript',
  '--from-rows',
  '--input',
  '--agents-dir',
  '--fixtures',
  '--overlap-hours',
])

export function coalesceDashArgs(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i] ?? ''
    const next = argv[i + 1] ?? ''
    if (DASH_VALUE_FLAGS.has(cur) && next.startsWith('-') && !next.startsWith('--')) {
      out.push(`${cur}=${next}`)
      i += 1
      continue
    }
    out.push(cur)
  }
  return out
}
