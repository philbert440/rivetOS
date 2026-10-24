package io.rivethub.app.plane

import io.rivethub.app.gateway.HubLastSession
import io.rivethub.app.gateway.HubProject
import io.rivethub.app.gateway.HubState

/**
 * Hub state on the phone: the shared per-user document (projects, names,
 * archive, pins, hidden, chat/terminal modes) against the phone's own
 * DataStore copy. Kotlin twin of `mergeHubState` in @rivetos/types plus the
 * phone's key translation.
 *
 * The phone keys per-session prefs by the bare session key (`harness:native`).
 * The document keys them `<nodeId>::<sessionKey>`. Reading ignores the node
 * (session keys are unique across nodes); writing needs it, from the live
 * session listing or else from the document itself. A key with neither stays
 * phone-only until its session shows up in a listing.
 */

const val HUB_KEY_SEP = "::"

/** Caps from @rivetos/types HUB_STATE_LIMITS. */
object HubLimits {
    const val PROJECTS = 200
    const val MEMBERSHIP = 2000
    const val NAMES = 500
    const val ARCHIVED = 1000
    const val PINNED = 500
    const val HIDDEN = 1000
    const val MODES = 500
}

/** The phone's share of the document, in its own (bare) keys. */
data class LocalHubPrefs(
    val names: Map<String, String> = emptyMap(),
    val archived: Set<String> = emptySet(),
    val pinned: Set<String> = emptySet(),
    val hidden: Set<String> = emptySet(),
    val modes: Map<String, String> = emptyMap(),
    /** Projects as the document has them (node ids, not URLs). */
    val projects: List<HubProject> = emptyList(),
    /** Session key → project id. */
    val membership: Map<String, String> = emptyMap(),
    val defaultProjectId: String = "",
)

fun hubKey(nodeId: String, sessionKey: String): String = "$nodeId$HUB_KEY_SEP$sessionKey"

/** `nodeId` and `sessionKey` of a document key; splits on the first `::`. */
fun splitHubKey(key: String): Pair<String, String>? {
    val at = key.indexOf(HUB_KEY_SEP)
    if (at <= 0) return null
    val session = key.substring(at + HUB_KEY_SEP.length)
    return if (session.isEmpty()) null else key.substring(0, at) to session
}

private fun HubState.perSessionKeys(): Sequence<String> =
    membership.keys.asSequence() + names.keys + modes.keys + archived + pinned + hidden +
        listOfNotNull(lastSession?.key)

/**
 * The phone's prefs as a document. The last session comes from [base]
 * unchanged: the phone does not write it yet, and a PUT must never clear
 * what desktop set.
 */
fun toHubState(local: LocalHubPrefs, base: HubState, nodeOf: (String) -> String?): HubState {
    val known = HashMap<String, String>()
    for (key in base.perSessionKeys()) splitHubKey(key)?.let { (node, session) -> known.putIfAbsent(session, node) }
    fun resolve(session: String): String? = nodeOf(session)?.takeIf { it.isNotBlank() } ?: known[session]

    fun map(entries: Map<String, String>): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        for ((session, value) in entries) resolve(session)?.let { out[hubKey(it, session)] = value }
        return out
    }

    /** Sets keep the document's order for what it already has, then append. */
    fun list(keys: Set<String>, baseList: List<String>): List<String> {
        val ordered = LinkedHashSet<String>()
        for (key in baseList) splitHubKey(key)?.second?.takeIf { it in keys }?.let { ordered += it }
        ordered += keys.sorted()
        return ordered.mapNotNull { session -> resolve(session)?.let { hubKey(it, session) } }.distinct()
    }

    return base.copy(
        projects = local.projects,
        defaultProjectId = local.defaultProjectId.ifBlank { null },
        membership = map(local.membership),
        names = map(local.names),
        modes = map(local.modes.filterValues { it == MODE_CHAT || it == MODE_TERMINAL }),
        archived = list(local.archived, base.archived),
        pinned = list(local.pinned, base.pinned),
        hidden = list(local.hidden, base.hidden),
    )
}

/**
 * The document as phone prefs. Entries [mine] could not upload (no node
 * known) are kept as they are; everything else follows [hub].
 */
fun fromHubState(hub: HubState, local: LocalHubPrefs, mine: HubState): LocalHubPrefs {
    fun sessions(keys: Collection<String>): Set<String> = keys.mapNotNull { splitHubKey(it)?.second }.toSet()

    fun map(hubMap: Map<String, String>, localMap: Map<String, String>, uploaded: Collection<String>): Map<String, String> {
        val sent = sessions(uploaded)
        val out = LinkedHashMap<String, String>()
        for ((session, value) in localMap) if (session !in sent) out[session] = value
        for ((key, value) in hubMap) splitHubKey(key)?.second?.let { out.putIfAbsent(it, value) }
        return out
    }

    fun set(hubList: List<String>, localSet: Set<String>, uploaded: List<String>): Set<String> {
        val sent = sessions(uploaded)
        return localSet.filterTo(LinkedHashSet()) { it !in sent } + sessions(hubList)
    }

    return LocalHubPrefs(
        names = map(hub.names, local.names, mine.names.keys),
        archived = set(hub.archived, local.archived, mine.archived),
        pinned = set(hub.pinned, local.pinned, mine.pinned),
        hidden = set(hub.hidden, local.hidden, mine.hidden),
        modes = map(hub.modes, local.modes, mine.modes.keys),
        projects = hub.projects,
        membership = map(hub.membership, local.membership, mine.membership.keys),
        defaultProjectId = hub.defaultProjectId.orEmpty(),
    )
}

/**
 * Three-way merge. [base] is the document this device last synced, [local]
 * its current edits, [remote] the server copy. Per entry: what this device
 * changed since [base] wins (removal included); the rest follows [remote].
 * Same rules as `mergeHubState` in @rivetos/types.
 */
fun mergeHubState(base: HubState, local: HubState, remote: HubState): HubState {
    val projects = mergeById(base.projects, local.projects, remote.projects).takeLast(HubLimits.PROJECTS)
    val ids = projects.map { it.id }.toSet()
    val membership = mergeMap(base.membership, local.membership, remote.membership).filterValues { it in ids }
    val defaultProjectId = pick(base.defaultProjectId, local.defaultProjectId, remote.defaultProjectId)
    return HubState(
        projects = projects,
        defaultProjectId = defaultProjectId?.takeIf { it in ids },
        membership = membership.capTo(HubLimits.MEMBERSHIP),
        names = mergeMap(base.names, local.names, remote.names).capTo(HubLimits.NAMES),
        archived = mergeList(base.archived, local.archived, remote.archived).takeLast(HubLimits.ARCHIVED),
        pinned = mergeList(base.pinned, local.pinned, remote.pinned).takeLast(HubLimits.PINNED),
        hidden = mergeList(base.hidden, local.hidden, remote.hidden).takeLast(HubLimits.HIDDEN),
        modes = mergeMap(base.modes, local.modes, remote.modes).capTo(HubLimits.MODES),
        lastSession = mergeLastSession(base.lastSession, local.lastSession, remote.lastSession),
    )
}

/** Equal for sync purposes: order inside maps and lists of keys does not matter. */
fun sameHubState(a: HubState, b: HubState): Boolean =
    a.copy(archived = a.archived.sorted(), pinned = a.pinned.sorted(), hidden = a.hidden.sorted()) ==
        b.copy(archived = b.archived.sorted(), pinned = b.pinned.sorted(), hidden = b.hidden.sorted())

private fun <T> pick(base: T, local: T, remote: T): T = if (local == base) remote else local

private fun mergeMap(base: Map<String, String>, local: Map<String, String>, remote: Map<String, String>): Map<String, String> {
    val out = LinkedHashMap<String, String>()
    for (key in LinkedHashSet(remote.keys + local.keys)) {
        pick(base[key], local[key], remote[key])?.let { out[key] = it }
    }
    return out
}

private fun mergeList(base: List<String>, local: List<String>, remote: List<String>): List<String> {
    val b = base.toSet()
    val l = local.toSet()
    val r = remote.toSet()
    return LinkedHashSet(remote + local).filter { key -> if ((key in l) != (key in b)) key in l else key in r }
}

private fun mergeById(base: List<HubProject>, local: List<HubProject>, remote: List<HubProject>): List<HubProject> {
    val b = base.associateBy { it.id }
    val l = local.associateBy { it.id }
    val r = remote.associateBy { it.id }
    return LinkedHashSet(r.keys + l.keys).mapNotNull { id -> pick(b[id], l[id], r[id]) }
}

private fun mergeLastSession(base: HubLastSession?, local: HubLastSession?, remote: HubLastSession?): HubLastSession? = when {
    local == base -> remote
    remote == base || remote == null -> local
    local == null -> remote
    else -> if (local.at >= remote.at) local else remote
}

private fun Map<String, String>.capTo(max: Int): Map<String, String> =
    if (size <= max) this else entries.toList().takeLast(max).associateTo(LinkedHashMap()) { it.key to it.value }
