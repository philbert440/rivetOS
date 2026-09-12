/**
 * CLI argument parser for scripts/rivethub-opencode-theme.ts.
 *
 * Kept in src/ so vitest (the src test glob) can cover the argv path
 * that the ad-hoc filter previously dropped.
 */

export const USAGE =
  'usage: rivethub-opencode-theme <colors.toml | snapshot.json> [--out FILE] [--no-set] [--transparent]'

export type ParsedArgs = {
  ok: true
  input: string
  out: string | undefined
  noSet: boolean
  transparent: boolean
}

export type ParseArgsError = {
  ok: false
  error: 'usage'
}

export type ParseArgsResult = ParsedArgs | ParseArgsError

/**
 * Iterate argv. `--out <path>` consumes the next token only when it does not
 * start with `--` (otherwise usage error). `--no-set` and `--transparent` are
 * flags. Unknown `--*` tokens are usage errors. Everything else is positional;
 * exactly one positional (the input path) is required.
 */
export function parseArgs(argv: readonly string[]): ParseArgsResult {
  let out: string | undefined
  let noSet = false
  let transparent = false
  const positional: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === '--out') {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        return { ok: false, error: 'usage' }
      }
      out = next
      i += 1
      continue
    }
    if (token === '--no-set') {
      noSet = true
      continue
    }
    if (token === '--transparent') {
      transparent = true
      continue
    }
    if (token.startsWith('--')) {
      return { ok: false, error: 'usage' }
    }
    positional.push(token)
  }

  if (positional.length !== 1) {
    return { ok: false, error: 'usage' }
  }

  return {
    ok: true,
    input: positional[0]!,
    out,
    noSet,
    transparent,
  }
}
