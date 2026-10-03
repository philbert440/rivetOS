/**
 * TTL-cached bearer token minted from an argv command.
 *
 * - Never logs or embeds the token in thrown errors.
 * - Remint on expiry or after invalidate() (callers use that on HTTP 401).
 * - Argv only — no shell interpolation.
 */

import { defaultRunCommand, type RunCommand } from './run-command.js'

export const DEFAULT_TOKEN_TTL_MS = 300_000
export const DEFAULT_TOKEN_COMMAND_TIMEOUT_MS = 5_000

export interface TokenSourceOptions {
  /** Non-empty argv: [binary, ...args]. */
  argv: string[]
  /** Cache lifetime after a successful mint. */
  ttlMs?: number
  /** Bounded mint timeout. */
  timeoutMs?: number
  /** Injectable runner (tests). */
  runCommand?: RunCommand
  /** Clock (tests). */
  now?: () => number
  /** Optional env for the child. Defaults to process.env. */
  env?: NodeJS.ProcessEnv
}

export interface TokenSource {
  /** Mint or return cached token. */
  getToken(): Promise<string>
  /** Last successful mint, if any and not past TTL. */
  getCachedToken(): string | undefined
  /**
   * Drop the cache so the next getToken() remints. When `rejectedToken` is
   * passed, skip the clear if the cache already holds a different (newer)
   * token — staggered 401s must not wipe a remint that another caller just did.
   */
  invalidate(rejectedToken?: string): void
  /** Authorization header map when a token is available (async mint). */
  authHeaders(extra?: Record<string, string>): Promise<Record<string, string>>
}

interface CacheEntry {
  token: string
  expiresAt: number
}

/**
 * Validate a config value as token_command argv. Returns the argv or a
 * reason string when invalid. Empty/undefined → null (feature unset).
 */
export function parseTokenCommandArgv(raw: unknown): string[] | null | string {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'string') {
    return 'token_command must be an argv array (no shell string)'
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return 'token_command must be a non-empty argv array'
  }
  if (!raw.every((item) => typeof item === 'string' && item.length > 0)) {
    return 'token_command argv entries must be non-empty strings'
  }
  return raw as string[]
}

export function createTokenSource(opts: TokenSourceOptions): TokenSource {
  const argv = opts.argv
  if (argv.length === 0 || !argv[0]) {
    throw new Error('token_command argv is empty')
  }
  const ttlMs = opts.ttlMs ?? DEFAULT_TOKEN_TTL_MS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TOKEN_COMMAND_TIMEOUT_MS
  const runCommand = opts.runCommand ?? defaultRunCommand
  const now = opts.now ?? Date.now
  const env = opts.env

  let cache: CacheEntry | null = null
  let inflight: Promise<string> | null = null

  async function mint(): Promise<string> {
    let stdout: string
    try {
      stdout = await runCommand(argv, { timeoutMs, env })
    } catch (err: unknown) {
      // Re-throw without attaching stdout/stderr from the helper.
      const msg = err instanceof Error ? err.message : 'token_command failed'
      throw new Error(msg, { cause: err })
    }
    const token = stdout.trim()
    if (!token) {
      throw new Error('token_command produced empty stdout')
    }
    // Refuse to keep newlines mid-token (helper printed extra noise).
    if (/[\r\n]/.test(token)) {
      throw new Error('token_command stdout must be a single line')
    }
    cache = { token, expiresAt: now() + ttlMs }
    return token
  }

  async function getToken(): Promise<string> {
    const t = now()
    if (cache && t < cache.expiresAt) return cache.token
    if (inflight) return inflight
    inflight = mint().finally(() => {
      inflight = null
    })
    return inflight
  }

  function getCachedToken(): string | undefined {
    if (!cache) return undefined
    if (now() >= cache.expiresAt) return undefined
    return cache.token
  }

  function invalidate(rejectedToken?: string): void {
    if (
      rejectedToken !== undefined &&
      cache !== null &&
      cache.token !== rejectedToken &&
      now() < cache.expiresAt
    ) {
      return
    }
    cache = null
  }

  async function authHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const token = await getToken()
    return { ...extra, Authorization: `Bearer ${token}` }
  }

  return { getToken, getCachedToken, invalidate, authHeaders }
}

/**
 * Build a fetch wrapper that injects a Bearer token and remints once on 401.
 * When `headerName` is `x-api-key`, that header is set instead of Authorization.
 */
export function createAuthorizedFetch(opts: {
  tokenSource: TokenSource
  /** Default Authorization Bearer. Use `x-api-key` for Anthropic. */
  headerName?: 'Authorization' | 'x-api-key'
  baseFetch?: typeof fetch
}): typeof fetch {
  const headerName = opts.headerName ?? 'Authorization'
  const baseFetch = opts.baseFetch ?? globalThis.fetch.bind(globalThis)
  const { tokenSource } = opts

  return async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const apply = async (token: string): Promise<Response> => {
      const headers = new Headers(init?.headers)
      if (headerName === 'Authorization') {
        headers.set('Authorization', `Bearer ${token}`)
      } else {
        headers.set('x-api-key', token)
      }
      return baseFetch(input, { ...init, headers })
    }

    const token = await tokenSource.getToken()
    let res = await apply(token)
    if (res.status === 401) {
      tokenSource.invalidate(token)
      const next = await tokenSource.getToken()
      res = await apply(next)
    }
    return res
  }
}
