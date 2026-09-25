package io.rivethub.app.plane

import io.rivethub.app.gateway.WsStatus
import io.rivethub.app.transport.NodeRef
import io.rivethub.app.transport.hostOfUrl

/**
 * Left-drawer node status strip (UX-SPEC §2 item 1): three labelled dots
 * derived purely from state the app already holds. Nothing here fetches, and
 * nothing re-evaluates on a clock — the strip recomposes when the hub or chat
 * state changes, and a tap asks for one `HubViewModel.refresh()`.
 */
enum class Dot { Up, Down, Unknown }

data class NodeDots(val agent: Dot, val mesh: Dot, val hub: Dot)

/** Label keys in on-screen order; the UI maps each to its string resource. */
fun dotLabelKeys(): List<String> = listOf("agent", "mesh", "hub")

/**
 * [entryNodeId] is the node reached through the enrolled entry URL (see
 * [statusEntryNodeId]); [activeNodeId] is the node whose den the user is on
 * (the open chat's node, else the current view node — [statusActiveNodeId]).
 * [chatWs] is the open chat's socket, null when no chat is open. [discovering]
 * is true while a refresh is still in flight (`HubViewModel` `loading`).
 * [entryAnswered] is the last outcome of the entry's own discovery call
 * ([entryAnsweredFor]): true when it returned a roster (even an empty one),
 * false when that call threw, null when there is no outcome yet for this
 * entry URL and identity generation.
 *
 * Contract (integrator revision, ux-u2b fix2; mirrored in AGENT.md and the
 * UX-SPEC §2 item 1 paste in the U2b notes). "Offline" is the node's
 * `online == false`; an error is an entry in `nodeErrors` for that node id.
 * Rows are checked top to bottom and the first match wins.
 *
 * hub — the entry node ([entryNodeId]), else the entry's discovery outcome:
 *
 *     entry has an error                      → Down
 *     entry resolved, online (discovering or not) → Up
 *     entry resolved, offline, not discovering → Down
 *     entry resolved, offline, discovering    → Unknown
 *     entry unresolved, entryAnswered true    → Up
 *     entry unresolved, entryAnswered false   → Down
 *     entry unresolved, entryAnswered null    → Unknown
 *
 * "Resolved" means [entryNodeId] is non-null and that node is in [nodes].
 * The DataHub's own mesh roster does not list the DataHub (fix2 runtime
 * finding), so on a real mesh the entry is usually unresolved and the dot
 * comes from [entryAnswered]: the roster answer IS the entry answering.
 * The hub dot reads neither socket. An online entry stays Up during a
 * refresh, and [entryAnswered] keeps its last value across a refresh, so a
 * refresh never flashes the dot.
 *
 * mesh — the registry socket(s):
 *
 *     registry socket open                    → Up
 *     socket closed, nodes known, not discovering → Down
 *     socket closed, discovering              → Unknown
 *     socket closed, no nodes                 → Unknown
 *
 * While discovering the registry watches have not started yet (they start
 * when the refresh settles), so a closed socket then is not a verdict.
 * Node online/offline, the chat socket and [entryAnswered] do not move mesh.
 *
 * agent — the active node plus the open chat's socket:
 *
 *     active node has an error                → Down
 *     chat socket CLOSED                      → Down
 *     active online, socket null or OPEN      → Up (discovering or not)
 *     active offline, not discovering         → Down
 *     otherwise                               → Unknown
 *
 * "Otherwise" is: socket CONNECTING, the active node absent / not chosen,
 * or an offline active node while discovering. [entryAnswered] does not
 * move agent.
 *
 * Deliberate deviations from the U2b brief's first table, accepted by the
 * integrator: mesh Down waits for discovery to settle, and an offline entry
 * / active node reads Down (it answered the mesh as offline) instead of Up /
 * Unknown.
 */
fun nodeDots(
    entryNodeId: String?,
    nodes: List<NodeRef>,
    nodeErrors: Map<String, String>,
    registryOpen: Boolean,
    activeNodeId: String?,
    chatWs: WsStatus?,
    discovering: Boolean,
    entryAnswered: Boolean?,
): NodeDots {
    val entry = entryNodeId?.let { id -> nodes.find { it.id == id } }
    val hub = when {
        entryNodeId != null && nodeErrors[entryNodeId] != null -> Dot.Down
        entry != null -> when {
            entry.online -> Dot.Up
            !discovering -> Dot.Down
            else -> Dot.Unknown
        }
        entryAnswered == true -> Dot.Up
        entryAnswered == false -> Dot.Down
        else -> Dot.Unknown
    }
    val mesh = when {
        registryOpen -> Dot.Up
        nodes.isNotEmpty() && !discovering -> Dot.Down
        else -> Dot.Unknown
    }
    val active = activeNodeId?.let { id -> nodes.find { it.id == id } }
    val agent = when {
        activeNodeId != null && nodeErrors[activeNodeId] != null -> Dot.Down
        chatWs == WsStatus.CLOSED -> Dot.Down
        active != null && active.online && (chatWs == null || chatWs == WsStatus.OPEN) -> Dot.Up
        active != null && !active.online && !discovering -> Dot.Down
        else -> Dot.Unknown
    }
    return NodeDots(agent = agent, mesh = mesh, hub = hub)
}

/**
 * The last outcome of the entry's own discovery call (`NodeTransport.discover()`,
 * which asks the entry gateway for `/api/mesh`), keyed to the entry URL and
 * identity generation it was asked under. `HubViewModel` records it at that
 * one call and nowhere else: a roster returned (even empty) → [answered]
 * true; that call threw → false. Cancellation, and anything that fails
 * after the roster came back (per-node bundles, the catalog), is not an
 * entry outcome.
 */
data class EntryAnswer(val entryUrl: String, val identityGen: Int, val answered: Boolean)

/**
 * The `entryAnswered` input of [nodeDots] for [entryUrl] under [identityGen]:
 * the recorded outcome when it belongs to this entry URL (trailing slash and
 * case ignored) and this identity generation, else null. A blank entry URL
 * has no outcome.
 */
fun entryAnsweredFor(answer: EntryAnswer?, entryUrl: String, identityGen: Int): Boolean? {
    if (answer == null || entryUrl.isBlank()) return null
    if (answer.identityGen != identityGen || !sameUrl(answer.entryUrl, entryUrl)) return null
    return answer.answered
}

/**
 * At the start of a refresh: keep the last outcome when the refresh asks the
 * same entry under the same identity (sticky — the dot must not flash while
 * the refresh is in flight); drop it (→ null) when the entry URL or the
 * identity generation changed.
 */
fun entryAnswerAtRefreshStart(answer: EntryAnswer?, entryUrl: String, identityGen: Int): EntryAnswer? =
    answer?.takeIf { entryAnsweredFor(it, entryUrl, identityGen) != null }

/**
 * Record [answered] for the refresh [refreshGen] that asked [entryUrl] under
 * [identityGen]. A stale result — a superseded refresh generation
 * ([refreshGen] != [liveRefreshGen]) or identity ([identityGen] !=
 * [liveIdentityGen]) — or a blank URL leaves [current] untouched.
 */
fun recordEntryAnswer(
    current: EntryAnswer?,
    entryUrl: String,
    identityGen: Int,
    answered: Boolean,
    refreshGen: Int,
    liveRefreshGen: Int,
    liveIdentityGen: Int,
): EntryAnswer? {
    if (!acceptsEntryAnswer(entryUrl, identityGen, refreshGen, liveRefreshGen, liveIdentityGen)) return current
    return EntryAnswer(entryUrl.trim(), identityGen, answered)
}

private fun acceptsEntryAnswer(
    entryUrl: String,
    identityGen: Int,
    refreshGen: Int,
    liveRefreshGen: Int,
    liveIdentityGen: Int,
): Boolean = refreshGen == liveRefreshGen && identityGen == liveIdentityGen && entryUrl.isNotBlank()

/**
 * The two values `HubViewModel.UiState` must publish together (fix3): the
 * recorded [answer] and the identity generation the hub dot reads it under
 * (`UiState.identityGen`, the third argument of [entryAnsweredFor]). The
 * device identity's generation can move without a prefs write (Settings
 * installs a certificate, then refreshes), so a clock published only on
 * prefs ticks and on a successful roster would lag a failed discovery:
 * false recorded under gen N, read at N−1 → null → hub Unknown.
 */
data class EntryAnswerState(val answer: EntryAnswer?, val identityGen: Int)

/**
 * Refresh-start update: [entryAnswerAtRefreshStart] for the answer, and the
 * read clock moved to the [identityGen] this refresh runs under.
 */
fun entryAnswerStateAtRefreshStart(current: EntryAnswer?, entryUrl: String, identityGen: Int): EntryAnswerState =
    EntryAnswerState(entryAnswerAtRefreshStart(current, entryUrl, identityGen), identityGen)

/**
 * [recordEntryAnswer] plus the read clock. An accepted write publishes the
 * answer together with the [identityGen] it was keyed to, so the answer is
 * readable at once; a stale or blank write leaves [current] (answer and
 * clock) untouched.
 */
fun publishEntryAnswer(
    current: EntryAnswerState,
    entryUrl: String,
    identityGen: Int,
    answered: Boolean,
    refreshGen: Int,
    liveRefreshGen: Int,
    liveIdentityGen: Int,
): EntryAnswerState {
    if (!acceptsEntryAnswer(entryUrl, identityGen, refreshGen, liveRefreshGen, liveIdentityGen)) return current
    return EntryAnswerState(
        recordEntryAnswer(current.answer, entryUrl, identityGen, answered, refreshGen, liveRefreshGen, liveIdentityGen),
        identityGen,
    )
}

private fun sameUrl(a: String, b: String): Boolean =
    a.trim().trimEnd('/').equals(b.trim().trimEnd('/'), ignoreCase = true)

/** `host:port` of a URL, lower-cased (scheme-default port when absent); null when unparsable. */
private fun hostPortOf(url: String): String? {
    val uri = runCatching { java.net.URI(url.trim()) }.getOrNull() ?: return null
    val host = uri.host?.lowercase()?.ifBlank { null } ?: return null
    val port = when {
        uri.port >= 0 -> uri.port
        uri.scheme.equals("http", ignoreCase = true) -> 80
        else -> 443
    }
    return "$host:$port"
}

/**
 * The discovered node the enrolled entry URL reaches, if any. The mesh does
 * not always advertise a node under the exact enrolled URL (an IP vs a host
 * name, a scheme or path difference), so resolution tries, in order:
 *
 *  1. a node whose `denUrl` equals [entryUrl] (trailing slash and case
 *     ignored);
 *  2. a node whose den has the same host and port;
 *  3. a node whose id is the URL-derived id — the entry URL's host, which
 *     is also the id a node added by URL gets (`DirectTransport.discover`).
 *
 * There is deliberately no "the mesh's datahub node" step (fix2): the
 * DataHub's own roster does not list the DataHub, and a name match can
 * paint some other node's health as the hub. When nothing matches, the hub
 * dot falls to the entry's discovery outcome (`nodeDots` `entryAnswered`).
 */
fun statusEntryNodeId(nodes: List<NodeRef>, entryUrl: String): String? {
    if (entryUrl.isBlank()) return null
    nodes.firstOrNull { sameUrl(it.denUrl, entryUrl) }?.let { return it.id }
    val hostPort = hostPortOf(entryUrl)
    if (hostPort != null) {
        nodes.firstOrNull { hostPortOf(it.denUrl) == hostPort }?.let { return it.id }
    }
    val urlId = hostOfUrl(entryUrl.trim()).lowercase()
    if (urlId.isNotBlank()) {
        nodes.firstOrNull { it.id.lowercase() == urlId }?.let { return it.id }
    }
    return null
}

/**
 * The node the `agent` dot reports on: the open chat's node when a chat is
 * open ([chatNodeDenUrl] non-null), else [viewNodeId] when it is a known
 * node, else the entry node.
 */
fun statusActiveNodeId(
    nodes: List<NodeRef>,
    chatNodeDenUrl: String?,
    viewNodeId: String,
    entryUrl: String,
): String? {
    if (chatNodeDenUrl != null) {
        return nodes.firstOrNull { sameUrl(it.denUrl, chatNodeDenUrl) }?.id
    }
    if (viewNodeId.isNotBlank() && nodes.any { it.id == viewNodeId }) return viewNodeId
    return statusEntryNodeId(nodes, entryUrl)
}
