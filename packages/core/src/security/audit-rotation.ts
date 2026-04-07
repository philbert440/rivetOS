/**
 * Audit Log Rotation — prevent audit logs from consuming unlimited disk.
 *
 * Features:
 *   - Rotation: Daily files (already the case from safety-hooks.ts)
 *   - Retention: Delete audit files older than configured days (default: 90)
 *   - Compression: gzip files older than 7 days
 *   - Size limit: Warn if total audit dir exceeds threshold
 *
 * Called during startup and periodically (e.g., daily via heartbeat).
 *
 * Usage:
 *   import { rotateAuditLogs } from './security/audit-rotation.js'
 *   await rotateAuditLogs({ auditDir: '/path/to/.data/audit' })
 */

import { readdir, unlink, stat, mkdir } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { resolve, extname } from 'node:path'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { logger } from '../logger.js'

const log = logger('AuditRotation')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditRotationConfig {
  /** Directory containing audit log files */
  auditDir: string
  /** Days to retain audit files (default: 90) */
  retentionDays?: number
  /** Days after which to compress (default: 7) */
  compressAfterDays?: number
  /** Max total audit dir size in MB before warning (default: 500) */
  maxSizeMB?: number
}

export interface RotationResult {
  deleted: string[]
  compressed: string[]
  totalFiles: number
  totalSizeMB: number
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Rotate audit logs: compress old files, delete expired ones, warn on size.
 */
export async function rotateAuditLogs(config: AuditRotationConfig): Promise<RotationResult> {
  const retentionDays = config.retentionDays ?? 90
  const compressAfterDays = config.compressAfterDays ?? 7
  const maxSizeMB = config.maxSizeMB ?? 500
  const auditDir = config.auditDir

  const result: RotationResult = {
    deleted: [],
    compressed: [],
    totalFiles: 0,
    totalSizeMB: 0,
    warnings: [],
  }

  // Ensure directory exists
  await mkdir(auditDir, { recursive: true })

  let files: string[]
  try {
    files = await readdir(auditDir)
  } catch {
    return result
  }

  const now = Date.now()
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000
  const compressMs = compressAfterDays * 24 * 60 * 60 * 1000
  let totalSize = 0

  for (const file of files) {
    const filePath = resolve(auditDir, file)

    try {
      const stats = await stat(filePath)
      if (!stats.isFile()) continue

      totalSize += stats.size
      result.totalFiles++
      const age = now - stats.mtimeMs

      // Delete if older than retention period
      if (age > retentionMs) {
        await unlink(filePath)
        result.deleted.push(file)
        log.debug(`Deleted old audit log: ${file}`)
        continue
      }

      // Compress if older than compress threshold and not already compressed
      if (age > compressMs && extname(file) === '.jsonl') {
        try {
          const gzPath = filePath + '.gz'
          await pipeline(createReadStream(filePath), createGzip(), createWriteStream(gzPath))
          await unlink(filePath)
          result.compressed.push(file)
          log.debug(`Compressed audit log: ${file}`)
        } catch (err) {
          log.warn(`Failed to compress ${file}: ${(err as Error).message}`)
        }
      }
    } catch (err) {
      log.warn(`Error processing audit file ${file}: ${(err as Error).message}`)
    }
  }

  result.totalSizeMB = Math.round((totalSize / 1024 / 1024) * 100) / 100

  if (result.totalSizeMB > maxSizeMB) {
    const warning = `Audit directory is ${result.totalSizeMB}MB (limit: ${maxSizeMB}MB)`
    result.warnings.push(warning)
    log.warn(warning)
  }

  if (result.deleted.length > 0 || result.compressed.length > 0) {
    log.info(
      `Audit rotation: deleted ${result.deleted.length}, compressed ${result.compressed.length}, ` +
        `${result.totalFiles} files, ${result.totalSizeMB}MB total`,
    )
  }

  return result
}
