/**
 * Task rows that registered a harness session, in the shape the den listing
 * merge consumes. Status is ignored: a killed task's transcript stays listed.
 */

import { HARNESS_IDS, type DelegatedSessionLink, type HarnessId } from '@rivetos/types'

export interface TaskLinkRow {
  id: string
  parentTaskId?: string
  executorTarget?: string
  spec?: Record<string, unknown>
}

function harnessOf(target: string | undefined): HarnessId | undefined {
  if (!target || !(HARNESS_IDS as readonly string[]).includes(target)) return undefined
  return target as HarnessId
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function linksFromTaskRows(rows: readonly TaskLinkRow[]): DelegatedSessionLink[] {
  const links: DelegatedSessionLink[] = []
  for (const row of rows) {
    const spec = row.spec ?? {}
    const spawnedSessionId = text(spec.spawnedSessionId)
    if (!spawnedSessionId) continue
    const parentSessionId = text(spec.parentSessionId)
    const agentName = text(spec.spawnedAgentName)
    const model = text(spec.spawnedModel)
    const owner = text(spec.owner)
    const harnessId = harnessOf(row.executorTarget)
    links.push({
      taskId: row.id,
      spawnedSessionId,
      ...(row.parentTaskId ? { parentTaskId: row.parentTaskId } : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(agentName ? { agentName } : {}),
      ...(model ? { model } : {}),
      ...(owner ? { owner } : {}),
      ...(harnessId ? { harnessId } : {}),
    })
  }
  return links
}
