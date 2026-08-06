/**
 * Append-only journal.jsonl — single writer (the engine).
 */

import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { JournalEntry } from './types.js'

export const JOURNAL_FILENAME = 'journal.jsonl'

export function journalPath(caseDir: string): string {
  return join(caseDir, JOURNAL_FILENAME)
}

export async function ensureJournal(caseDir: string): Promise<void> {
  await mkdir(caseDir, { recursive: true })
  const path = journalPath(caseDir)
  if (!existsSync(path)) {
    await writeFile(path, '', 'utf-8')
  }
}

export async function appendJournal(caseDir: string, entry: JournalEntry): Promise<void> {
  await ensureJournal(caseDir)
  const line = JSON.stringify(entry) + '\n'
  await appendFile(journalPath(caseDir), line, 'utf-8')
}

export async function readJournal(caseDir: string): Promise<JournalEntry[]> {
  const path = journalPath(caseDir)
  if (!existsSync(path)) return []
  const raw = await readFile(path, 'utf-8')
  if (!raw.trim()) return []
  const entries: JournalEntry[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    entries.push(JSON.parse(trimmed) as JournalEntry)
  }
  return entries
}

/** ISO timestamp helper for journal entries (wall clock is fine; not used for control flow). */
export function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Find a completed step result for (label, seq) in the journal.
 * Prefers step_finished; for human gates, gate_resolved supplies the values.
 *
 * When `kind` is given, a journaled result with a DIFFERENT kind for the same
 * (label, seq) throws — silently replaying a stale result across a step-type
 * edit would corrupt the run.
 */
export function findCachedStepResult(
  entries: JournalEntry[],
  label: string,
  seq: number,
  kind?: string,
): { hit: true; result: unknown; from: 'step_finished' | 'gate_resolved' } | { hit: false } {
  for (const e of entries) {
    if (e.type === 'step_finished' && e.label === label && e.seq === seq) {
      if (kind !== undefined && e.kind !== kind) {
        throw new Error(
          `Journal kind mismatch for step "${label}#${seq}": journaled as "${e.kind}", ` +
            `script now declares "${kind}". The orchestration script changed incompatibly ` +
            `mid-run; start a fresh run.`,
        )
      }
      return { hit: true, result: e.result, from: 'step_finished' }
    }
    if (e.type === 'gate_resolved' && e.label === label && e.seq === seq) {
      if (kind !== undefined && kind !== 'human') {
        throw new Error(
          `Journal kind mismatch for step "${label}#${seq}": journaled as a human gate, ` +
            `script now declares "${kind}". Start a fresh run.`,
        )
      }
      return { hit: true, result: e.values, from: 'gate_resolved' }
    }
  }
  return { hit: false }
}

/** True if a gate_opened exists for (label, seq) without a matching gate_resolved. */
export function isOpenGate(entries: JournalEntry[], label: string, seq: number): boolean {
  let opened = false
  let resolved = false
  for (const e of entries) {
    if (e.type === 'gate_opened' && e.label === label && e.seq === seq) opened = true
    if (e.type === 'gate_resolved' && e.label === label && e.seq === seq) resolved = true
  }
  return opened && !resolved
}

/** Open gate summary for UI / resume (last unresolved gate_opened). */
export interface OpenGate {
  stepId: string
  label: string
  seq: number
  fields: string[]
  prompt?: string
}

/**
 * Find the most recent gate_opened without a matching gate_resolved.
 * Used by resumeRun and the run-detail API.
 */
export function findOpenGate(entries: JournalEntry[]): OpenGate | null {
  const opened: OpenGate[] = []
  const resolved = new Set<string>()
  for (const e of entries) {
    if (e.type === 'gate_opened') {
      opened.push({
        stepId: e.stepId,
        label: e.label,
        seq: e.seq,
        fields: e.fields,
        prompt: e.prompt,
      })
    }
    if (e.type === 'gate_resolved') {
      resolved.add(e.stepId)
    }
  }
  for (let i = opened.length - 1; i >= 0; i--) {
    if (!resolved.has(opened[i].stepId)) return opened[i]
  }
  return null
}

/**
 * Next sequence number for a label: one past the highest seq seen for that label
 * in step_started / gate_opened / step_finished / gate_resolved.
 * Used only when computing expected next call during live execution; during
 * replay the StepRuntime tracks in-memory call counts.
 */
export function maxSeqForLabel(entries: JournalEntry[], label: string): number {
  let max = 0
  for (const e of entries) {
    if (
      (e.type === 'step_started' ||
        e.type === 'step_finished' ||
        e.type === 'step_failed' ||
        e.type === 'gate_opened' ||
        e.type === 'gate_resolved') &&
      e.label === label
    ) {
      if (e.seq > max) max = e.seq
    }
  }
  return max
}
