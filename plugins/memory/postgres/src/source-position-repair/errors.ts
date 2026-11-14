export const RELOCATE_REJECTION_CODES = [
  'invalid_plan',
  'stale_hash',
  'missing_row',
  'cross_conversation',
  'ambiguous',
  'duplicate_target',
  'duplicate_message',
  'occupied_target',
  'split_entry',
  'timestamp_order',
  'timestamp_unproven',
  'summary_contiguity',
  'unsupported_ordinal',
  'backup_failed',
  'concurrent_insert',
] as const

export type RelocateRejectionCode = (typeof RELOCATE_REJECTION_CODES)[number]

export class RelocateRejection extends Error {
  readonly code: RelocateRejectionCode

  constructor(code: RelocateRejectionCode, message: string) {
    super(message)
    this.name = 'RelocateRejection'
    this.code = code
  }
}

export function isRelocateRejection(error: unknown): error is RelocateRejection {
  return error instanceof RelocateRejection
}
