/**
 * Chat-first launch on narrow (Phil 2026-09-03): opening the app on the
 * phone lands in the most recent session for the current node instead of the
 * conversations list. An in-progress draft wins — it holds unsent composer
 * intent, which outranks any finished thread. No sessions at all → the list
 * + empty state stays.
 *
 * Rows pinned from ANOTHER node's agent (`pinNodeBaseUrl` set and different
 * from the hub's) are not launch candidates: "most recent session for the
 * current node".
 */

export interface LaunchCandidate {
  key: string
  /** epoch ms — larger is more recent. */
  updatedAt: number
  /** ChatItem kind; only 'draft' gets the in-progress priority. */
  kind: string
  /** Agent-pin rows only: the session's home node. */
  pinNodeBaseUrl?: string
}

export function pickLaunchSession(
  items: readonly LaunchCandidate[],
  baseUrl: string,
): string | undefined {
  const local = items.filter(
    (it) => it.pinNodeBaseUrl === undefined || it.pinNodeBaseUrl === baseUrl,
  )
  const byRecency = (a: LaunchCandidate, b: LaunchCandidate): number => b.updatedAt - a.updatedAt
  const byRecent = [...local].sort(byRecency)
  const draft = byRecent.find((it) => it.kind === 'draft')
  if (draft) return draft.key
  return byRecent[0]?.key
}
