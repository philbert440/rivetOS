package dev.rivet.app.data.harness

import dev.rivet.app.data.node.NodeAuthProbe
import dev.rivet.app.ui.pages.terminal.DenHarnessClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext

/**
 * One view of the active node's chat rows, unioning the control plane with the
 * legacy on-disk scan.
 *
 * Held by [dev.rivet.app.service.ChatService] so the drawer and the open chat
 * agree about which rows a driver owns — two surfaces disagreeing would send
 * one row's turns down two different planes.
 *
 * Every control-plane read is best-effort. A node too old to serve
 * `/api/harnesses` answers 404, the descriptor list comes back empty, every row
 * resolves to [ChatRowKind.LEGACY], and the app behaves exactly as it did
 * before this existed. That is the no-regression rule, not a fallback mode.
 */
interface HarnessPlaneSource {
    /** Rows + capability sheets for the active node. */
    suspend fun snapshot(maxAgeMs: Long = 10_000L): HarnessPlaneSnapshot

    /** Session gateway for the active node, or null when it is this device. */
    suspend fun gateway(): HarnessSessionGateway?
}

class HarnessPlaneRepository(
    /** Active den origin, or null/blank when the active node is this device. */
    private val remoteDenUrl: suspend () -> String?,
    /** Per-node bearer, from the credential store; null for a tokenless node. */
    private val tokenFor: suspend (String) -> String? = { null },
    /**
     * Told what the registry read said about the credential. The snapshot is the
     * only control-plane call that runs on a timer against every active node, so
     * it is where a node that started gating — or rotated its bearer — is first
     * visible. Reporting is all it does: the degrade below is unconditional.
     */
    private val onAuth: (NodeAuthProbe) -> Unit = {},
    private val clientFactory: (String, String?) -> HarnessControlPlaneClient =
        { url, token -> HarnessControlPlaneClient(url, token) },
    /** Seam for tests; production is the legacy on-disk scan. */
    private val legacyList: (String, String?) -> List<DenHarnessClient.Session> =
        { url, token -> DenHarnessClient.tryList(url, token) },
) : HarnessPlaneSource, HarnessRegistrySink {
    /**
     * Guards every cache field below — never held across the network read.
     *
     * The registry pump takes this lock for every frame, so a slow refresh
     * holding it would park the fast path behind the very round trip the fast
     * path exists to avoid, with frames piling into the watch's channel
     * meanwhile. Reads therefore run outside it, at the cost of two callers
     * arriving during one read both hitting the node: cheap on a LAN, and the
     * alternative — serializing reads — lets a dead node's 25s timeout stall
     * the node the user just switched to.
     *
     * A plain monitor rather than a coroutine `Mutex`, because not one of these
     * critical sections suspends — and the read accounting has to be released on
     * a path that cannot fail. `Mutex.lock()` is a cancellation point when it
     * has to wait, and the drawer's fetch half lives under `flatMapLatest`, so
     * every node switch and every poll tick cancels a read mid-flight. A
     * release that could itself throw would leak [reads] permanently, and from
     * then on every frame would be buffered for a replay that never comes.
     */
    private val stateLock = Any()

    private val cached = MutableStateFlow<HarnessPlaneSnapshot?>(null)

    /**
     * The cache itself, observable.
     *
     * The drawer renders off this rather than off a [snapshot] return value,
     * which is what lets a registry `session-created` repaint the list without
     * a fetch: [onRegistryEvent] merges the carried summary straight in here.
     * Null means nothing has been read for the active node yet. Render through
     * [rowsFor] rather than reading this directly — an observer that simply
     * filters null away can never learn that the cache was cleared.
     */
    val snapshots: StateFlow<HarnessPlaneSnapshot?> = cached.asStateFlow()

    private var cachedAt = 0L

    /** Bumped by [clear]; a read that began before the bump is discarded. */
    private var generation = 0L

    /** Reads currently in flight — while any is, frames are recorded below. */
    private var reads = 0

    /**
     * Frames that landed while a read was in flight, with the node they came
     * from. Replayed onto that read's answer at publish time, so a fetch that
     * started before a `session-created` cannot un-paint the row the merge
     * already put on screen. Cleared when the last read finishes.
     */
    private val midReadFrames = ArrayList<Pair<String, HarnessEvent>>()

    /**
     * Rows to render for [denUrl].
     *
     * A cleared cache, or one belonging to a different node, emits an EMPTY
     * list — not nothing. An observer that filtered those away would never be
     * told the rows went away, so a switch to an unreachable node would leave
     * the previous machine's sessions on screen, tappable, until some later
     * read happened to succeed.
     */
    fun rowsFor(denUrl: String): Flow<List<HarnessChatRow>> {
        val target = denUrl.trim()
        return snapshots
            .map { snapshot -> if (snapshot?.denUrl == target) snapshot.rows else emptyList() }
            .distinctUntilChanged()
    }

    /**
     * Rows + capability sheets for the active remote node.
     *
     * [maxAgeMs] `0` forces a re-read; the default keeps the drawer's poll and
     * the chat's open from hammering a node with the same three calls.
     */
    override suspend fun snapshot(maxAgeMs: Long): HarnessPlaneSnapshot {
        // Sampled before the den is read, not when the ticket is taken. The
        // question this answers is "has the active node moved since this
        // attempt began" — and reading the setting suspends, so a switch can
        // land between that read and the ticket. Sampling later would let an
        // attempt that already captured the OLD den publish under the NEW
        // generation, stranding the cache on a node the user has left.
        val attempt = synchronized(stateLock) { generation }
        val den = remoteDenUrl()?.trim().orEmpty()
        if (den.isEmpty()) return HarnessPlaneSnapshot.EMPTY

        val started = synchronized(stateLock) {
            val hit = cached.value
            if (hit != null &&
                hit.denUrl == den &&
                maxAgeMs > 0 &&
                System.currentTimeMillis() - cachedAt < maxAgeMs
            ) {
                return hit
            }
            reads += 1
            ReadTicket(attempt, midReadFrames.size)
        }

        try {
            val fresh = read(den)
            return synchronized(stateLock) {
                if (started.generation != generation) {
                    // A node switch while this read was in flight makes its
                    // answer history. Publishing it would strand the cache on
                    // the old node and leave every merge for the new one
                    // refused until the next poll — and handing it back would
                    // have the caller resolve rows for a machine it is not
                    // looking at, so the caller gets nothing instead.
                    HarnessPlaneSnapshot.EMPTY
                } else {
                    val published = replay(fresh, started.from)
                    cached.value = published
                    cachedAt = System.currentTimeMillis()
                    // The PUBLISHED value, not `fresh`: a caller resolving a
                    // gate off the return must see the same rows the drawer
                    // does, mid-read frames included.
                    published
                }
            }
        } finally {
            // Cannot suspend, so it cannot be skipped by cancellation.
            synchronized(stateLock) { finishRead() }
        }
    }

    /**
     * Mark the cache stale so the next [snapshot] re-reads, keeping the rows on
     * screen until it returns — the drawer's pull-to-refresh, a pasted bearer.
     * Blanking the list first would flicker every time the drawer opens.
     */
    fun invalidate() {
        synchronized(stateLock) { cachedAt = 0L }
    }

    /**
     * Drop the rows outright, and disown every read already in flight. Only for
     * a node switch: the previous node's rows are not stale, they are about a
     * different machine.
     */
    fun clear() {
        synchronized(stateLock) {
            cached.value = null
            cachedAt = 0L
            generation += 1
        }
    }

    /** Force a re-read of the active node. */
    override suspend fun refresh() {
        snapshot(maxAgeMs = 0L)
    }

    /**
     * Merge one registry frame into the cache — the `session-created` fast
     * path. Returns true when the cache actually moved.
     *
     * [denUrl] is checked against the cached snapshot's own: a socket that
     * outlived a node switch by a few milliseconds must not write the old
     * node's sessions into the new node's drawer.
     *
     * Nothing cached is a deliberate no-op rather than a seed. Rows merged
     * without the node's capability sheet would render un-bound, and the read
     * that produces that sheet is already the thing about to happen.
     *
     * The read no longer holds [lock] (it would park the pump behind a round
     * trip), so a frame can land while a fetch that predates it is in flight.
     * Rather than let that fetch's publish un-paint the row, frames arriving
     * mid-read are recorded and re-applied on top of the answer — the invariant
     * is preserved, it is just enforced at publish instead of by exclusion.
     *
     * The reconciliation half is untouched: [cachedAt] does not move, so the
     * drawer's poll still re-reads on its own cadence and a merged row the node
     * disagrees with heals on the next read.
     */
    override suspend fun onRegistryEvent(denUrl: String, event: HarnessEvent): Boolean =
        synchronized(stateLock) {
            val den = denUrl.trim()
            // Recorded even when the merge below refuses: a frame for the node
            // a read is currently fetching belongs on that read's answer, and
            // the cache may still be the previous node's (or nothing at all).
            if (reads > 0) midReadFrames.add(den to event)
            val hit = cached.value
            if (hit == null || hit.denUrl != den) return@synchronized false
            val next = hit.withSessions(HarnessPlane.applyRegistryEvent(hit.sessions, event))
            if (next === hit) return@synchronized false
            cached.value = next
            true
        }

    /** One in-flight read's claim on the cache. Taken under [stateLock]. */
    private class ReadTicket(val generation: Long, val from: Int)

    /**
     * Re-apply frames that landed for this node while [fresh] was being read.
     *
     * From [from] onward, deliberately: a frame recorded BEFORE this read's
     * ticket was committed on the node before this read's GET went out, so
     * [fresh] already carries it. Replaying from zero instead would re-apply
     * state a fresher answer had already moved past — an `active` frame
     * resurrected over a fetched `ended`. The index is the ordering argument,
     * written down.
     *
     * Must be held under [stateLock].
     */
    private fun replay(fresh: HarnessPlaneSnapshot, from: Int): HarnessPlaneSnapshot {
        var published = fresh
        for (i in from until midReadFrames.size) {
            val (den, event) = midReadFrames[i]
            if (den != fresh.denUrl) continue
            published = published.withSessions(
                HarnessPlane.applyRegistryEvent(published.sessions, event),
            )
        }
        return published
    }

    /** Must be held under [stateLock]. */
    private fun finishRead() {
        reads -= 1
        if (reads <= 0) {
            reads = 0
            midReadFrames.clear()
        }
    }

    /**
     * Test seam: frames buffered for replay. Nothing is ever buffered while no
     * read is in flight, so a non-zero count with no reader is the signature of
     * leaked read accounting.
     */
    internal fun bufferedFrames(): Int = synchronized(stateLock) { midReadFrames.size }

    /** Registry-stream gateway for one node — the watch targets a node, not "active". */
    suspend fun registryGatewayFor(denUrl: String): HarnessRegistryGateway =
        ClientRegistryGateway(clientFactory(denUrl, tokenFor(denUrl)))

    /** A client for the active node, or null when the active node is local. */
    suspend fun client(): HarnessControlPlaneClient? {
        val den = remoteDenUrl()?.trim().orEmpty()
        if (den.isEmpty()) return null
        return clientFactory(den, tokenFor(den))
    }

    override suspend fun gateway(): HarnessSessionGateway? =
        client()?.let { ClientSessionGateway(it) }

    private suspend fun read(den: String): HarnessPlaneSnapshot = withContext(Dispatchers.IO) {
        val token = tokenFor(den)
        val client = clientFactory(den, token)
        val registry = runCatching { client.harnesses() }
        onAuth(
            NodeAuthProbe(
                denUrl = den,
                hadToken = !token.isNullOrBlank(),
                outcome = HarnessPlane.authOutcome(registry.exceptionOrNull()),
            ),
        )
        // A 401 lands here exactly like a 404 does: empty descriptors, every row
        // resolves to legacy, the app behaves as it did before the control plane
        // existed. Surfacing the reason must never change the degrade.
        val descriptors = registry.getOrDefault(emptyList())
        val planeSessions = coroutineScope {
            HarnessPlane.listable(descriptors)
                .map { id -> async { runCatching { client.sessions(id) }.getOrDefault(emptyList()) } }
                .flatMap { it.await() }
        }
        // One driver failing (a store it cannot read, a node mid-restart) must
        // not blank the drawer — the legacy scan still backs those rows.
        val legacy = legacyList(den, token)
        HarnessPlaneSnapshot(
            denUrl = den,
            descriptors = descriptors,
            rows = HarnessPlane.rows(planeSessions, legacy),
            sessions = planeSessions,
            legacy = legacy,
        )
    }

    private companion object {
        const val DEFAULT_TTL_MS = 10_000L
    }
}

/** Immutable view of one node's rows and its driver capability sheets. */
data class HarnessPlaneSnapshot(
    val denUrl: String,
    val descriptors: List<HarnessDescriptor>,
    val rows: List<HarnessChatRow>,
    /** Control-plane half of [rows], kept so a registry merge can re-derive them. */
    val sessions: List<HarnessSessionSummary> = emptyList(),
    /** Legacy-scan half of [rows], same reason. */
    val legacy: List<DenHarnessClient.Session> = emptyList(),
) {
    /**
     * The same snapshot with a different control-plane session list, rows
     * rebuilt.
     *
     * Rebuilt, not patched: the merged row goes through the identical
     * [HarnessPlane.rows] call a fetched one does, so it carries the same
     * title/command/timestamp fallbacks and nothing downstream — plane
     * selection, the gate, the binder — can tell the two apart. Returns `this`
     * when the list did not move.
     */
    fun withSessions(next: List<HarnessSessionSummary>): HarnessPlaneSnapshot =
        if (next === sessions) {
            this
        } else {
            copy(sessions = next, rows = HarnessPlane.rows(next, legacy))
        }

    fun row(key: String): HarnessChatRow? = rows.firstOrNull { it.key == key }

    /** Capability gate for one row; [HarnessGate.CLOSED] keeps it on legacy. */
    fun gate(key: String): HarnessGate = HarnessPlane.gate(row(key), descriptors)

    companion object {
        val EMPTY = HarnessPlaneSnapshot("", emptyList(), emptyList())
    }
}
