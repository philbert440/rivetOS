/**
 * Display helpers for a space's defaults. The directory string is the
 * preset's own `directory` — read-only. Nothing here is a cwd to send.
 */

import type { SpaceDefaults } from '../../stores/spaces.js'

export function directoryBasename(directory: string): string {
  const trimmed = directory.trim().replace(/[\\/]+$/, '')
  if (!trimmed) return ''
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed
}

/** Tooltip / dialog hint. Full directory, not the basename. */
export function startsInDirectory(directory: string | undefined): string | undefined {
  const dir = directory?.trim()
  if (!dir) return undefined
  return `Starts in ${dir}`
}

/** Edit dialog line under the chosen preset. */
export function startsInDirectoryOn(
  directory: string | undefined,
  node: string | undefined,
): string | undefined {
  const dir = directory?.trim()
  if (!dir) return undefined
  const where = node?.trim()
  return where ? `Starts in ${dir} on ${where}` : `Starts in ${dir}`
}

/** A preset that can actually start a thread: it is on the roster and has a node. */
export function startablePreset<T extends { id: string; sourceNodeBaseUrl?: string }>(
  defaults: SpaceDefaults | undefined,
  roster: readonly T[],
): T | undefined {
  const id = defaults?.agentId
  if (!id) return undefined
  return roster.find((row) => row.id === id && (row.sourceNodeBaseUrl?.length ?? 0) > 0)
}

export function defaultAgentChip(
  defaults: SpaceDefaults | undefined,
  roster: readonly { id: string; name: string; directory?: string; sourceNodeBaseUrl?: string }[],
): { name: string; directoryBase: string } | undefined {
  const agent = startablePreset(defaults, roster)
  if (!agent) return undefined
  const directoryBase = agent.directory ? directoryBasename(agent.directory) : ''
  return { name: agent.name, directoryBase }
}
