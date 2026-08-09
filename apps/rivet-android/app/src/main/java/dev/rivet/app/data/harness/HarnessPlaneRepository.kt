package dev.rivet.app.data.harness

import dev.rivet.app.data.node.NodeAuthProbe
import dev.rivet.app.ui.pages.terminal.DenHarnessClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
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
    private val lock = Mutex()

    private val cached = MutableStateFlow<HarnessPlaneSnapshot?>(null)

    /**
     * The cache itself, observable.
     *
     * The drawer renders off this rather than off a [snapshot] return value,
     * which is what lets a registry `session-created` repaint the list without
     * a fetch: [onRegistryEvent] merges the carried summary straight in here.
     * Null means nothing has been read for the active node yet.
     */
    val snapshots: StateFlow<HarnessPlaneSnapshot?> = cached.asStateFlow()

    @Volatile
    private var cachedAt = 0L

    /**
     * Rows + capability sheets for the active remote node.
     *
     * [maxAgeMs] `0` forces a re-read; the default keeps the drawer's poll and
     * the chat's open from hammering a node with the same three calls.
     */
    override suspend fun snapshot(maxAgeMs: Long): HarnessPlaneSnapshot {
        val den = remoteDenUrl()?.trim().orEmpty()
        if (den.isEmpty()) return HarnessPlaneSnapshot.EMPTY
        lock.withLock {
            val hit = cached.value
            if (hit != null &&
                hit.denUrl == den &&
                maxAgeMs > 0 &&
                System.currentTimeMillis() - cachedAt < maxAgeMs
            ) {
                return hit
            }
            val fresh = read(den)
            cached.value = fresh
            cachedAt = System.currentTimeMillis()
            return fresh
        }
    }

    /**
     * Mark the cache stale so the next [snapshot] re-reads, keeping the rows on
     * screen until it returns — the drawer's pull-to-refresh, a pasted bearer.
     * Blanking the list first would flicker every time the drawer opens.
     */
    fun invalidate() {
        cachedAt = 0L
    }

    /**
     * Drop the rows outright. Only for a node switch: the previous node's rows
     * are not stale, they are about a different machine, and [snapshot]'s own
     * `denUrl` guard would refuse to serve them anyway.
     */
    fun clear() {
        cached.value = null
        cachedAt = 0L
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
     * Serialized against [snapshot] on the same lock, so a frame that arrives
     * mid-fetch is applied to the answer that fetch returns rather than to the
     * list it replaced. The reconciliation half is untouched: [cachedAt] does
     * not move, so the drawer's poll still re-reads on its own cadence and a
     * merged row the node disagrees with heals on the next read.
     */
    override suspend fun onRegistryEvent(denUrl: String, event: HarnessEvent): Boolean =
        lock.withLock {
            val hit = cached.value
            if (hit == null || hit.denUrl != denUrl.trim()) return@withLock false
            val next = hit.withSessions(HarnessPlane.applyRegistryEvent(hit.sessions, event))
            if (next === hit) return@withLock false
            cached.value = next
            true
        }

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
