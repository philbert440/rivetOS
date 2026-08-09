package dev.rivet.app.data.harness

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch

/**
 * Keeps the plane cache current from the node's driver-level registry stream
 * instead of a timer — the Kotlin half of what #478 gave the hub.
 *
 * `session-created` already carries a full [HarnessSessionSummary], so a client
 * that only re-reads the session list every 30s is paying a round trip (and up
 * to a 30s wait) for a row the node has already handed it. This forwards those
 * frames into [HarnessRegistrySink.onRegistryEvent], which merges them into the
 * snapshot the drawer is rendering.
 *
 * Two rules it does not get to skip:
 *
 * - **The tail is at-most-once from attach time.** Same contract as a session
 *   socket, same recovery: every `open` — first connect and reconnect alike —
 *   forces a re-read, because whatever the node published while the socket was
 *   down is gone and no replay is coming.
 * - **A node with no registry stream is not an error.** An older den answers
 *   404 on the upgrade, a token-gated one 401; both are terminal, the socket
 *   stops itself, and the drawer's existing poll is the whole fallback. There
 *   is nothing to gate on up front and nothing for the user to switch off.
 */

/** The slice of a node the watch needs. Also the test seam. */
interface HarnessRegistryGateway {
    fun watchHarnesses(listener: HarnessStreamListener): HarnessSubscription
}

/** [HarnessRegistryGateway] over a real client. */
class ClientRegistryGateway(
    private val client: HarnessControlPlaneClient,
) : HarnessRegistryGateway {
    /** No harness filter: the drawer is every driver's sessions, not one's. */
    override fun watchHarnesses(listener: HarnessStreamListener): HarnessSubscription =
        client.watchHarnesses(null, listener)
}

/** What the watch writes into — implemented by [HarnessPlaneRepository]. */
interface HarnessRegistrySink {
    /** Merge one frame into the cache for [denUrl]; true when it moved. */
    suspend fun onRegistryEvent(denUrl: String, event: HarnessEvent): Boolean

    /** Re-read from the node (the tail had a gap, so nothing is assumed). */
    suspend fun refresh()
}

/**
 * One registry tail, following the active node.
 *
 * [retarget] is single-writer by construction — the active-node collector in
 * `ChatService` is the only caller — so the subscription bookkeeping needs no
 * lock of its own. Frames go through an unbounded channel drained by one
 * coroutine, which is what keeps a `session-created` and the `session-updated`
 * that follows it from being applied out of order.
 */
class HarnessRegistryWatch(
    private val scope: CoroutineScope,
    private val sink: HarnessRegistrySink,
    /** Null for a node the app cannot build a client for (local, blank). */
    private val gatewayFor: suspend (String) -> HarnessRegistryGateway?,
    private val log: (String) -> Unit = { Log.i(TAG, it) },
) {
    private var target: String? = null
    private var subscription: HarnessSubscription? = null
    private var frames: Channel<HarnessEvent>? = null
    private var pump: Job? = null

    /** The node being tailed, for tests and diagnostics. */
    val watching: String? get() = target

    /**
     * Point the tail at [denUrl], or stop it entirely with null (the active
     * node is this device, or the app is shutting the plane down).
     */
    suspend fun retarget(denUrl: String?) {
        val next = denUrl?.trim()?.takeIf { it.isNotEmpty() }
        if (next == target && subscription != null) return
        stop()
        target = next
        if (next == null) return
        val gateway = gatewayFor(next) ?: return
        val queue = Channel<HarnessEvent>(Channel.UNLIMITED)
        frames = queue
        pump = scope.launch {
            for (event in queue) sink.onRegistryEvent(next, event)
        }
        subscription = gateway.watchHarnesses(Listener(next, queue))
    }

    /**
     * Re-open the tail against the same node. The bearer is captured when the
     * socket is built, so a credential pasted after a 401 would otherwise leave
     * a permanently dead stream behind (the refusal is terminal by design — it
     * does not retry).
     */
    suspend fun rebind() {
        val current = target ?: return
        stop()
        retarget(current)
    }

    /** Close the socket and drop the pump. Idempotent. */
    fun stop() {
        subscription?.close()
        subscription = null
        frames?.close()
        frames = null
        pump?.cancel()
        pump = null
        target = null
    }

    private inner class Listener(
        private val den: String,
        private val queue: Channel<HarnessEvent>,
    ) : HarnessStreamListener {
        override fun onOpen() {
            // Fresh attach, first or Nth. Anything the node published before
            // this socket existed is not in the tail and never will be.
            if (target != den) return
            scope.launch { sink.refresh() }
        }

        override fun onEvent(event: HarnessEvent) {
            queue.trySend(event)
        }

        override fun onTerminal(message: String) {
            // 401/403 (no bearer for this node) or 404 (a den too old to mount
            // the route). The socket has already stopped; say so once and let
            // the poll carry the drawer, exactly as it did before this existed.
            log("registry stream unavailable on $den: $message")
        }
    }

    private companion object {
        const val TAG = "HarnessRegistry"
    }
}
