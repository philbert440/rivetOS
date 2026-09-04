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
  /** The row's home node. */
  pinNodeBaseUrl?: string
  /** Synthesized agent-pin pointer (not a resumable session) → excluded. */
  pin?: boolean
}

/**
 * The session to open on launch, or undefined when there is none to resume.
 * Prefers the current node, then any node (so a hub whose current node holds
 * no sessions — e.g. datahub — still resumes the genuinely most recent
 * thread rather than stranding on the list); a draft beats a finished thread
 * within each scope. Agent-pin pointer rows are never launch targets.
 * Mirrored in Android plane/LaunchSession.kt.
 */
export function pickLaunchSession(
  items: readonly LaunchCandidate[],
  baseUrl: string,
): string | undefined {
  const sessions = items.filter((it) => it.pin !== true)
  const byRecency = (a: LaunchCandidate, b: LaunchCandidate): number => b.updatedAt - a.updatedAt
  const best = (scope: LaunchCandidate[]): string | undefined => {
    const byRecent = [...scope].sort(byRecency)
    const draft = byRecent.find((it) => it.kind === 'draft')
    return draft ? draft.key : byRecent[0]?.key
  }
  const onNode = sessions.filter(
    (it) => it.pinNodeBaseUrl === undefined || it.pinNodeBaseUrl === baseUrl,
  )
  return best(onNode) ?? best(sessions)
}
