/**
 * Chat-first launch on narrow (Phil 2026-09-03): opening the app on the
 * phone lands in the most recent session for the current node instead of the
 * conversations list. An in-progress draft wins — it holds unsent composer
 * intent, which outranks any finished thread. No sessions at all →
 * `narrowLaunchTarget` resolves to the new-conversation compose state
 * (2026-09-04: the list is not an app screen anymore).
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

/**
 * What the narrow chat surface should open to (Phil 2026-09-04: the
 * conversations list is not an app screen — the home IS a session).
 *
 * Resolution order:
 *   1. `resume` — the persisted last-opened session (`lastActiveKey`), taken
 *      IMMEDIATELY: before the load lands there is nothing to validate it
 *      against, and the whole point is reopening it before the mesh loads.
 *      Once loaded, a key with no source row is STALE (the session 404'd)
 *      and falls through to the pick.
 *   2. `loading` — nothing to resume and the mesh is still in flight: the
 *      surface shows its loading placeholder, never the list.
 *   3. `pick` — `pickLaunchSession` over the loaded rows.
 *   4. `new` — loaded and empty: the surface is the new-conversation compose
 *      state (the caller mints a draft), never the list.
 *
 * `sourceKeys` are the keys the session SOURCES actually carry (plane scan,
 * legacy scan, drafts, agent pins) — NOT the rendered `items`, which keep a
 * placeholder row for the open conversation and so can never report a
 * resumed key as stale. Mirrored in Android plane/LaunchSession.kt.
 */
export type NarrowLaunchTarget =
  | { kind: 'loading' }
  | { kind: 'resume'; key: string }
  | { kind: 'pick'; key: string }
  | { kind: 'new' }

export function narrowLaunchTarget(opts: {
  /** Persisted last-opened session for the current node, if any. */
  lastActiveKey?: string
  /** True once the session sources have settled their first load. */
  loaded: boolean
  /** Keys the sources actually carry (staleness check — see above). */
  sourceKeys: readonly string[]
  items: readonly LaunchCandidate[]
  baseUrl: string
}): NarrowLaunchTarget {
  const { lastActiveKey, loaded, sourceKeys, items, baseUrl } = opts
  if (lastActiveKey !== undefined) {
    if (!loaded || sourceKeys.includes(lastActiveKey)) {
      return { kind: 'resume', key: lastActiveKey }
    }
    // Stale resume pointer — fall through to the pick.
  }
  if (!loaded) return { kind: 'loading' }
  const pick = pickLaunchSession(items, baseUrl)
  return pick !== undefined ? { kind: 'pick', key: pick } : { kind: 'new' }
}
