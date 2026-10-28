package io.rivethub.app.data

import io.rivethub.app.gateway.GatewayException
import io.rivethub.app.gateway.HubLastSession
import io.rivethub.app.gateway.HubState
import io.rivethub.app.gateway.HubStatePutResult
import io.rivethub.app.gateway.HubStateResponse
import io.rivethub.app.plane.LocalHubPrefs
import io.rivethub.app.plane.fromHubState
import io.rivethub.app.plane.mergeHubState
import io.rivethub.app.plane.sameHubState
import io.rivethub.app.plane.toHubState
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.merge
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable

/** The document as last agreed with [authority] (the entry den's node id). */
@Serializable
data class HubSynced(val authority: String, val version: Long, val state: HubState)

/** What one sync pass touches. The app binds it to Settings + the entry gateway. */
interface HubSyncIo {
    /** Entry den URL; blank before onboarding. */
    suspend fun entryUrl(): String
    suspend fun nodeId(): String?
    suspend fun fetch(): HubStateResponse
    suspend fun put(baseVersion: Long, state: HubState): HubStatePutResult
    suspend fun local(): LocalHubPrefs
    /** Write [next] only if the prefs still equal [expected]; false = the user edited meanwhile. */
    suspend fun apply(expected: LocalHubPrefs, next: LocalHubPrefs): Boolean
    suspend fun loadSynced(): HubSynced?
    suspend fun saveSynced(synced: HubSynced)
}

enum class HubSyncOutcome { SYNCED, UNSUPPORTED, OFFLINE, RETRY }

private const val MAX_ATTEMPTS = 5

/**
 * One pass: fetch, three-way merge against the last synced document, PUT if
 * the result differs (merging again on 409), then write the agreed document
 * back into the phone's prefs. The first pass against an empty document
 * uploads the phone's prefs. Same flow as desktop's lib/hub-state-sync.ts.
 */
suspend fun syncHubStateOnce(io: HubSyncIo, nodeOf: (String) -> String?): HubSyncOutcome {
    if (io.entryUrl().isBlank()) return HubSyncOutcome.OFFLINE
    var remote = try {
        io.fetch()
    } catch (e: GatewayException) {
        return if (e.status == 404 || e.status == 405) HubSyncOutcome.UNSUPPORTED else HubSyncOutcome.OFFLINE
    } catch (_: Exception) {
        return HubSyncOutcome.OFFLINE
    }
    val authority = runCatching { io.nodeId() }.getOrNull()?.takeIf { it.isNotBlank() }
        ?: return HubSyncOutcome.OFFLINE
    val local = io.local()
    val prior = io.loadSynced()
    val base = if (prior?.authority == authority) prior.state else HubState()
    val mine = toHubState(local, base, nodeOf)

    var agreed: HubStateResponse? = null
    repeat(MAX_ATTEMPTS) {
        if (agreed != null) return@repeat
        val merged = mergeHubState(base, mine, remote.state)
        if (sameHubState(merged, remote.state)) {
            agreed = remote
            return@repeat
        }
        when (val res = io.put(remote.version, merged)) {
            is HubStatePutResult.Saved -> agreed = res.doc
            is HubStatePutResult.Conflict -> remote = res.doc
        }
    }
    val doc = agreed ?: return HubSyncOutcome.RETRY
    io.saveSynced(HubSynced(authority, doc.version, doc.state))
    val next = fromHubState(doc.state, local, mine)
    if (next == local) return HubSyncOutcome.SYNCED
    return if (io.apply(local, next)) HubSyncOutcome.SYNCED else HubSyncOutcome.RETRY
}

/**
 * Keeps the phone's names, archive, pins, hidden and modes in step with the
 * entry den's hub state. DataStore stays what the UI reads; this only moves
 * it to and from the server. Passes run on start, on resume, after a session
 * listing refresh, and shortly after any of those prefs change.
 */
@OptIn(FlowPreview::class)
class HubStateRepository(
    private val io: HubSyncIo,
    private val prefs: kotlinx.coroutines.flow.Flow<LocalHubPrefs>,
    private val scope: CoroutineScope,
    private val debounceMs: Long = 800,
) {
    private val sessionNodes = ConcurrentHashMap<String, String>()
    private val kicks = MutableSharedFlow<Unit>(extraBufferCapacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    private val lock = Mutex()
    @Volatile private var unsupportedAt: String? = null
    @Volatile private var started = false
    private val _lastSession = MutableStateFlow<HubLastSession?>(null)

    /**
     * The document's last open session, from the latest completed sync (never
     * a cached copy, so a launch only reacts to what the server says now).
     */
    val lastSession: StateFlow<HubLastSession?> = _lastSession

    fun start() {
        if (started) return
        started = true
        scope.launch {
            merge(prefs.distinctUntilChanged().map { }, kicks)
                .debounce(debounceMs)
                .filter { unsupportedAt != io.entryUrl() }
                .collect { syncNow() }
        }
        kick()
    }

    /** Ask for a pass soon (resume, refresh). */
    fun kick() {
        kicks.tryEmit(Unit)
    }

    /** Which node each listed session lives on (`/healthz.node`), from the latest refresh. */
    fun noteSessionNodes(nodes: Map<String, String>) {
        var added = false
        for ((session, node) in nodes) {
            if (node.isNotBlank() && sessionNodes.put(session, node) != node) added = true
        }
        if (added) kick()
    }

    suspend fun syncNow(): HubSyncOutcome = lock.withLock {
        val url = io.entryUrl()
        val outcome = runCatching { syncHubStateOnce(io) { sessionNodes[it] } }
            .getOrDefault(HubSyncOutcome.OFFLINE)
        if (outcome == HubSyncOutcome.SYNCED) _lastSession.value = io.loadSynced()?.state?.lastSession
        when (outcome) {
            HubSyncOutcome.UNSUPPORTED -> unsupportedAt = url
            HubSyncOutcome.RETRY -> kick()
            else -> if (unsupportedAt == url) unsupportedAt = null
        }
        outcome
    }
}
