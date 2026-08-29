/**
 * Last-resort fault log — main-process exceptions and renderer/child process
 * deaths land in <userData>/logs/main.log. The shell must stay up wherever
 * possible; a fault with no log is indistinguishable from the app "just
 * closing", which is exactly the bug report this answers. Append must never
 * throw: it runs inside process-level handlers.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

export const MAX_LOG_BYTES = 1024 * 1024
const LINE_MAX = 4096

export function formatCrashLine(kind: string, detail: string): string {
  return `${new Date().toISOString()} [${kind}] ${detail.replace(/\s+/g, ' ').trim().slice(0, LINE_MAX)}\n`
}

export class CrashLog {
  /** Lazy path: userData is not resolvable at module-eval time. */
  constructor(private readonly file: () => string) {}

  append(kind: string, detail: string): void {
    // Mirror to stderr so unpackaged runs show faults without hunting for
    // the file.
    console.error(`RivetHub [${kind}] ${detail}`)
    try {
      const file = this.file()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      try {
        // One-deep rotation instead of truncate-in-place: the tail that
        // preceded a fault is usually the part worth reading.
        if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.old`)
      } catch {
        /* first write */
      }
      fs.appendFileSync(file, formatCrashLine(kind, detail))
    } catch {
      /* logging is best-effort by contract */
    }
  }
}
