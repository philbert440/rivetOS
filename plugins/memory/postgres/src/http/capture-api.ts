import type { ServerResponse } from 'node:http'
import { routedUserResult, type GatewayRoute } from '@rivetos/types'
import type pg from 'pg'
import {
  captureBatch,
  captureBatchSchema,
  type CaptureBatchOptions,
  type CaptureWriteFn,
} from '../tools/write-tools.js'

export interface CaptureApiOptions {
  pool: pg.Pool
  userPools?: ReadonlyMap<string, pg.Pool | null>
  /**
   * Replace the writer (tests, alternative transports). It receives the
   * per-request capture options and must honour them: `allowFilesystem` is
   * false for a routed user, whose `settings.cwd` must never be resolved here.
   */
  writer?: (pool: pg.Pool, options: CaptureBatchOptions) => CaptureWriteFn
  /** Forwarded to `captureBatch` when no `writer` override is given. */
  capture?: CaptureBatchOptions
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

export function createCaptureApiRoute(opts: CaptureApiOptions): GatewayRoute {
  return {
    prefix: '/api/capture',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        // HARD INVARIANT: only mount behind den-server's strip-and-stamp of
        // x-rivetos-user. Absent means owner; malformed, unknown and tombstoned
        // identities must never fall through to the owner pool.
        const routed = routedUserResult(req.headers)
        if (routed.kind === 'invalid') {
          return json(res, 503, { error: 'malformed routing identity' })
        }
        let pool: pg.Pool
        if (routed.kind === 'owner') {
          pool = opts.pool
        } else {
          const userPool = opts.userPools?.get(routed.id)
          if (!userPool) {
            return json(res, 503, { error: `memory is not available for user "${routed.id}"` })
          }
          pool = userPool
        }
        const socket = req.socket
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
          size += bytes.length
          if (size > 1024 * 1024) {
            const closeSocket = () => socket?.destroy()
            res.once('finish', closeSocket)
            res.once('close', closeSocket)
            res.setHeader('connection', 'close')
            return json(res, 413, { error: 'body too large' })
          }
          chunks.push(bytes)
        }
        let body: unknown
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          return json(res, 400, { error: 'invalid JSON' })
        }
        const parsed = captureBatchSchema.safeParse(body)
        if (!parsed.success) return json(res, 400, { error: parsed.error.message })
        // A routed user's batch comes from another tenant (and usually another
        // machine): its settings.cwd must never be resolved against this host.
        const captureOptions: CaptureBatchOptions = {
          ...opts.capture,
          allowFilesystem: routed.kind === 'owner' && opts.capture?.allowFilesystem !== false,
        }
        const writer =
          opts.writer?.(pool, captureOptions) ??
          ((batch) => captureBatch(pool, batch, captureOptions))
        return json(res, 200, await writer(parsed.data))
      } catch (error) {
        return json(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }
}
