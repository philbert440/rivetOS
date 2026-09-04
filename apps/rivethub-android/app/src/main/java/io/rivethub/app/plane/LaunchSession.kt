package io.rivethub.app.plane

/**
 * Chat-first launch (Phil 2026-09-03/04): opening the app lands IN a session,
 * never the conversations list — the list is only reached via the history
 * icon. Preference order: the persisted last session (instant resume, see
 * [LastSession] / [narrowLaunchTarget]), then the most recent session on the
 * CURRENT node (an in-progress draft wins, it holds unsent composer intent),
 * then the most recent session on ANY node (so a hub whose current node has
 * no sessions — e.g. datahub — still resumes the genuinely most recent
 * thread), then, when no session exists anywhere, a NEW draft (the caller
 * mints it from the current agent). Agent-PIN rows are pointers, not
 * sessions, so they are never launch targets.
 */
data class LaunchCandidate(
    val key: String,
    /** epoch ms — larger is more recent. */
    val updatedAt: Long,
    /** Only [ChatItemKind.DRAFT] gets the in-progress priority. */
    val kind: ChatItemKind,
    /** The row's home node (trimmed den URL); null = hub-local. */
    val pinNodeBaseUrl: String? = null,
    /** Synthesized agent-pin pointer (not a resumable session) → excluded. */
    val pin: Boolean = false,
)

/**
 * The session to open on launch, or null when there is none to resume (the
 * caller then mints a new draft). Prefers the current node, then any node; a
 * draft beats a finished thread within each scope.
 */
fun pickLaunchSession(items: List<LaunchCandidate>, baseUrl: String): String? {
    val sessions = items.filter { !it.pin }
    fun best(scope: List<LaunchCandidate>): String? {
        val draft = scope.filter { it.kind == ChatItemKind.DRAFT }.maxByOrNull { it.updatedAt }
        if (draft != null) return draft.key
        return scope.maxByOrNull { it.updatedAt }?.key
    }
    val onNode = sessions.filter { it.pinNodeBaseUrl == null || it.pinNodeBaseUrl == baseUrl }
    return best(onNode) ?: best(sessions)
}

/**
 * The last opened session, persisted via Settings (`lastSessionKey` /
 * `lastSessionNode`) for INSTANT RESUME at nav init — the phone's home is
 * the chat surface, so the last thread reopens before the mesh loads (web
 * stores/chat.ts `lastActive`, 2026-09-04).
 */
data class LastSession(val key: String, val nodeDenUrl: String)

/**
 * What `openChat` persists for instant resume, or null when there is nothing
 * durable to point at: a DRAFT is in-memory only, so persisting it would
 * resurrect a dead compose on the next launch — the web store drops the
 * pointer on `removeDraft` for the same reason (stores/chat.ts). The node URL
 * is trimmed so the pointer matches LocatedChatItem.nodeDenUrl form.
 */
fun persistableLastSession(sessionKey: String, nodeDenUrl: String, draft: Boolean): LastSession? =
    if (draft) null else LastSession(sessionKey, nodeDenUrl.trimEnd('/'))

/**
 * What the initial surface resolves to (Phil 2026-09-04: the conversations
 * list is not an app screen — the home IS a session). Mirrors web
 * lib/launch-session.ts `narrowLaunchTarget` case for case:
 *   1. [Resume] — the persisted last session, taken IMMEDIATELY (before the
 *      load there is nothing to validate against; that is the point). Once
 *      loaded, a key with no source row is STALE (the session 404'd) and
 *      falls through to the pick.
 *   2. [Loading] — nothing to resume and the mesh is still in flight: the
 *      surface shows its chat-surface loading state, never the list.
 *   3. [Pick] — [pickLaunchSession] over the loaded rows.
 *   4. [New] — loaded and empty: the new-conversation compose state (the
 *      caller mints a draft from the current agent), never the list.
 *
 * [sourceKeys] are the keys the session sources actually carry (the loaded
 * LocatedChatItem rows) — the staleness oracle for a resumed pointer.
 */
sealed interface NarrowLaunchTarget {
    data object Loading : NarrowLaunchTarget
    data class Resume(val key: String) : NarrowLaunchTarget
    data class Pick(val key: String) : NarrowLaunchTarget
    data object New : NarrowLaunchTarget
}

fun narrowLaunchTarget(
    lastActiveKey: String?,
    loaded: Boolean,
    sourceKeys: Set<String>,
    items: List<LaunchCandidate>,
    baseUrl: String,
): NarrowLaunchTarget {
    if (lastActiveKey != null) {
        if (!loaded || lastActiveKey in sourceKeys) return NarrowLaunchTarget.Resume(lastActiveKey)
        // Stale resume pointer — fall through to the pick.
    }
    if (!loaded) return NarrowLaunchTarget.Loading
    val pick = pickLaunchSession(items, baseUrl)
    return if (pick != null) NarrowLaunchTarget.Pick(pick) else NarrowLaunchTarget.New
}

/**
 * Post-resume staleness check (the loaded half of [narrowLaunchTarget]'s
 * resume rule, for the instant-resume path that opened Screen.Chat straight
 * from the pointer at nav init): a resumed session is stale only when its
 * NODE is online and still does not carry the key — an unreachable node
 * cannot judge, and the session screen keeps its own offline error state.
 */
fun resumedSessionStale(resumedKey: String, nodeOnline: Boolean, sourceKeys: Set<String>): Boolean =
    nodeOnline && resumedKey !in sourceKeys
