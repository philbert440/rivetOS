/**
 * Last-resort fault log — main-process exceptions and renderer/child process
 * deaths land in <userData>/logs/main.log. The shell must stay up wherever
 * possible; a fault with no log is indistinguishable from the app "just
 * closing", which is exactly the bug report this answers. Append can never
 * throw and never recurse: it runs inside process-level fault handlers.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

export const MAX_LOG_BYTES = 1024 * 1024
const LINE_MAX = 4096

export function formatCrashLine(kind: unknown, detail: unknown): string {
  let text: string
  try {
    text = String(detail ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, LINE_MAX)
  } catch {
    // String() throws only for hostile detail (e.g. a Symbol or a toString
    // that throws) — the line must still land.
    text = '<unprintable detail>'
  }
  return `${new Date().toISOString()} [${String(kind)}] ${text}\n`
}

export class CrashLog {
  /** Lazy path: userData is not resolvable at module-eval time. */
  constructor(private readonly file: () => string) {}

  append(kind: unknown, detail: unknown): void {
    let line: string
    try {
      line = formatCrashLine(kind, detail)
    } catch {
      line = 'crash-log format failure\n'
    }
    // Mirror to stderr so unpackaged runs show faults without hunting for
    // the file — its own try: a broken stderr pipe must not kill logging.
    try {
      console.error(`RivetHub ${line.trimEnd()}`)
    } catch {
      /* stderr gone */
    }
    try {
      const file = this.file()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      try {
        // One-deep rotation instead of truncate-in-place: the tail that
        // preceded a fault is usually the part worth reading.
        if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.old`)
      } catch (err) {
        // Absent file: normal first write. Any other stat/rename failure
        // must not let the log grow forever — truncate as the last resort.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          try {
            if (fs.statSync(file).size > MAX_LOG_BYTES) fs.truncateSync(file, 0)
          } catch {
            /* give up on rotation, keep appending */
          }
        }
      }
      fs.appendFileSync(file, line)
    } catch {
      /* logging is best-effort by contract */
    }
  }
}
