/**
 * Rail visibility for unfinished sections. Files / Tasks / Workflows hide
 * until their experimental flag is on. Conversations, Memory, and Settings
 * are never gated here.
 */

export type ExperimentalFlags = {
  files: boolean
  tasks: boolean
  workflows: boolean
  /** Memory home: one screen for sessions + search, with Wiki beside it. Not a nav gate. */
  memoryHome: boolean
}

export const EXPERIMENTAL_DEFAULTS: ExperimentalFlags = {
  files: false,
  tasks: false,
  workflows: false,
  memoryHome: false,
}

const GATED: Partial<Record<string, keyof ExperimentalFlags>> = {
  '/files': 'files',
  '/tasks': 'tasks',
  '/workflows': 'workflows',
}

/** Filter a primary or secondary nav list by experimental flags. */
export function visibleNav<T extends { to: string }>(
  items: readonly T[],
  experimental: ExperimentalFlags,
): T[] {
  return items.filter((item) => {
    const flag = GATED[item.to]
    return flag === undefined ? true : experimental[flag]
  })
}
