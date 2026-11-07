import { z } from 'zod'
import { RelocateRejection } from './errors.js'

const uuidSchema = z.uuid()
const nonNegInt = z.number().int().nonnegative()
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)

const locatorSchema = z
  .object({
    position: nonNegInt,
    ordinal: nonNegInt,
    eventId: z.string().min(1),
    captureSource: z.string().min(1).optional(),
    sourceId: z.string().min(1).optional(),
  })
  .strict()

const relocationSchema = z
  .object({
    messageId: uuidSchema,
    from: locatorSchema,
    to: z
      .object({
        position: nonNegInt,
      })
      .strict(),
  })
  .strict()

/**
 * Operator-reviewed mapping. Row UUID is the only occurrence key.
 * Content hash and tool-call id are never used to pick a row.
 */
export const sourcePositionRepairPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    conversationId: uuidSchema,
    sessionKey: z.string().min(1),
    agent: z.string().min(1),
    provenanceRef: z.string().min(1),
    expectedStateHash: sha256Hex,
    relocations: z.array(relocationSchema).min(1),
  })
  .strict()

export type SourceLocator = z.infer<typeof locatorSchema>
export type SourcePositionRelocation = z.infer<typeof relocationSchema>
export type SourcePositionRepairPlan = z.infer<typeof sourcePositionRepairPlanSchema>

export type RelocateMode = { kind: 'dry-run' } | { kind: 'apply'; backupPath: string }

function hasUnprovenDestinationTimestamp(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false
  const relocations = (input as { relocations?: unknown }).relocations
  if (!Array.isArray(relocations)) return false
  for (const relocation of relocations) {
    if (!relocation || typeof relocation !== 'object') continue
    const rec = relocation as Record<string, unknown>
    if ('createdAt' in rec || 'created_at' in rec || 'timestamp' in rec) return true
    const dest = rec.to
    if (dest && typeof dest === 'object') {
      const destRec = dest as Record<string, unknown>
      if ('createdAt' in destRec || 'created_at' in destRec || 'timestamp' in destRec) return true
    }
  }
  return false
}

export function parseSourcePositionRepairPlan(input: unknown): SourcePositionRepairPlan {
  if (hasUnprovenDestinationTimestamp(input)) {
    throw new RelocateRejection(
      'timestamp_unproven',
      'v1 does not accept destination timestamps; dates from the original position are not destination proof',
    )
  }
  const parsed = sourcePositionRepairPlanSchema.safeParse(input)
  if (!parsed.success) {
    throw new RelocateRejection(
      'invalid_plan',
      parsed.error.issues.map((issue) => issue.message).join('; '),
    )
  }
  return parsed.data
}
