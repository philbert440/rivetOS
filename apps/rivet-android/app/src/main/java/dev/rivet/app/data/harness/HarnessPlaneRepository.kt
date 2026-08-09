package dev.rivet.app.data.harness

import dev.rivet.app.ui.pages.terminal.DenHarnessClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
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
    /** Per-node bearer; the roster is tokenless today, so normally null. */
    private val tokenFor: suspend (String) -> String? = { null },
    private val clientFactory: (String, String?) -> HarnessControlPlaneClient =
        { url, token -> HarnessControlPlaneClient(url, token) },
) : HarnessPlaneSource {
    private val lock = Mutex()

    @Volatile
    private var cached: HarnessPlaneSnapshot? = null

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
            val hit = cached
            if (hit != null &&
                hit.denUrl == den &&
                maxAgeMs > 0 &&
                System.currentTimeMillis() - cachedAt < maxAgeMs
            ) {
                return hit
            }
            val fresh = read(den)
            cached = fresh
            cachedAt = System.currentTimeMillis()
            return fresh
        }
    }

    /** Drop the cache so the next [snapshot] re-reads (node switch, resync). */
    fun invalidate() {
        cached = null
        cachedAt = 0L
    }

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
        val descriptors = runCatching { client.harnesses() }.getOrDefault(emptyList())
        val planeSessions = coroutineScope {
            HarnessPlane.listable(descriptors)
                .map { id -> async { runCatching { client.sessions(id) }.getOrDefault(emptyList()) } }
                .flatMap { it.await() }
        }
        // One driver failing (a store it cannot read, a node mid-restart) must
        // not blank the drawer — the legacy scan still backs those rows.
        val legacy = DenHarnessClient.tryList(den, token)
        HarnessPlaneSnapshot(
            denUrl = den,
            descriptors = descriptors,
            rows = HarnessPlane.rows(planeSessions, legacy),
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
) {
    fun row(key: String): HarnessChatRow? = rows.firstOrNull { it.key == key }

    /** Capability gate for one row; [HarnessGate.CLOSED] keeps it on legacy. */
    fun gate(key: String): HarnessGate = HarnessPlane.gate(row(key), descriptors)

    companion object {
        val EMPTY = HarnessPlaneSnapshot("", emptyList(), emptyList())
    }
}
