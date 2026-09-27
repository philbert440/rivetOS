import { readFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { deadLetter, spoolBatch, spoolFiles } from './spool.js'
import type { CaptureResult, CaptureWriter, CaptureWriterOptions } from './types.js'

class CaptureClientError extends Error {}

export function createCaptureWriter(opts: CaptureWriterOptions): CaptureWriter {
  const dir = opts.spoolDir ?? join(homedir(), '.rivetos', 'capture-spool')
  const fetch = opts.fetch ?? globalThis.fetch
  const log = (error: unknown): void => {
    try {
      opts.log?.(String(error))
    } catch {
      /* Logging must not interrupt capture. */
    }
  }
  const post = async (body: string): Promise<CaptureResult> => {
    const response = await fetch(`${opts.denUrl.replace(/\/$/, '')}/api/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    if (!response.ok) await response.body?.cancel().catch(log)
    if (response.status >= 400 && response.status < 500) {
      throw new CaptureClientError(`capture HTTP ${response.status}`)
    }
    if (!response.ok) throw new Error(`capture HTTP ${response.status}`)
    return (await response.json()) as CaptureResult
  }
  const replay: CaptureWriter['replay'] = async (options) => {
    let replayed = 0
    let dead = 0
    try {
      const files = await spoolFiles(dir)
      const requested = options?.max ?? 50
      const max = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 50
      for (const file of files.slice(0, max)) {
        try {
          const body = await readFile(join(dir, file), 'utf8')
          await post(body)
          await unlink(join(dir, file))
          replayed++
        } catch (error) {
          log(error)
          if (error instanceof CaptureClientError) {
            await deadLetter(dir, file)
            dead++
          } else if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            break
          }
        }
      }
      return { replayed, remaining: (await spoolFiles(dir)).length, dead }
    } catch (error) {
      log(error)
      return { replayed, remaining: (await spoolFiles(dir).catch(() => [])).length, dead }
    }
  }
  return {
    replay,
    async write(batch) {
      await replay({ max: 50 })
      try {
        return await post(JSON.stringify(batch))
      } catch (error) {
        log(error)
        if (error instanceof CaptureClientError) throw error
        try {
          return {
            spooled: true,
            file: await spoolBatch(dir, batch, (opts.now ?? (() => new Date()))()),
          }
        } catch (spoolError) {
          log(`capture spool failed; batch was not saved: ${String(spoolError)}`)
          // The public contract has no failure result; an empty path means no durable file.
          return { spooled: true, file: '' }
        }
      }
    },
  }
}
