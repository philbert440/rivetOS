package dev.rivet.app.data.harness

import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

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
 * There are two writers, not one: the active-node collector calls [retarget]
 * and a pasted bearer calls [rebind], both on the app scope's single
 * dispatcher, and both suspend partway through (building a gateway reads the
 * credential store). Interleaved, they can orphan a live socket or leave the
 * subscription pointing at a channel the other one closed, so every entry point
 * is serialized on [gate] and [rebind] re-reads the target after acquiring it —
 * a credential change that raced a node switch re-opens the node that is
 * actually active, never the one that was active when the paste happened.
 *
 * Frames go through an unbounded channel drained by one coroutine, which is
 * what keeps a `session-created` and the `session-updated` behind it from being
 * applied out of order.
 */
class HarnessRegistryWatch(
    private val scope: CoroutineScope,
    private val sink: HarnessRegistrySink,
    /** Null for a node the app cannot build a client for (local, blank). */
    private val gatewayFor: suspend (String) -> HarnessRegistryGateway?,
    private val log: (String) -> Unit = { Log.i(TAG, it) },
) {
    private val gate = Mutex()

    /**
     * Written under [gate], but read from OkHttp's socket threads in
     * [Listener] — volatile for the happens-before edge, or a retarget racing
     * an open could drop the resync the reconnect owes, or fire one for a node
     * that is no longer active.
     */
    @Volatile
    private var target: String? = null

    /**
     * Whether the tail is believed alive. A terminal handshake stops the socket
     * from the inside, and only this flag records it: the socket thread must
     * not touch the handles [gate] protects, and a watch that kept claiming to
     * be attached would make [retarget] of the same node a silent no-op against
     * a dead stream.
     */
    @Volatile
    private var live = false

    /**
     * Which attach the live socket belongs to. A terminal callback already in
     * flight when a rebind replaces the socket would otherwise mark the FRESH
     * tail dead — `watching` reporting null against a stream that is speaking.
     * Written under [gate], read from socket threads.
     */
    @Volatile
    private var attachSeq = 0L

    private var subscription: HarnessSubscription? = null
    private var frames: Channel<HarnessEvent>? = null
    private var pump: Job? = null

    /** The node being tailed, or null when nothing is live. */
    val watching: String? get() = target?.takeIf { live }

    /**
     * Point the tail at [denUrl], or stop it entirely with null (the active
     * node is this device, or the app is shutting the plane down).
     */
    suspend fun retarget(denUrl: String?) = gate.withLock { attach(denUrl) }

    /**
     * Re-open the tail against whatever node is current. The bearer is captured
     * when the socket is built, so a credential pasted after a 401 would
     * otherwise leave a permanently dead stream behind — the refusal is
     * terminal by design and does not retry.
     *
     * The node is read under [gate], never captured before it: a rebind that
     * queued behind a node switch must re-open the node that switch chose, not
     * resurrect the one it left.
     */
    suspend fun rebind() = gate.withLock {
        val current = target ?: return@withLock
        detach()
        attach(current)
    }

    /** Close the socket and drop the pump. Idempotent. */
    suspend fun stop() = gate.withLock { detach() }

    /** Must be held under [gate]. */
    private suspend fun attach(denUrl: String?) {
        val next = denUrl?.trim()?.takeIf { it.isNotEmpty() }
        if (next == target && live) return
        detach()
        target = next
        if (next == null) return
        val gateway = gatewayFor(next) ?: return
        val seq = attachSeq + 1
        attachSeq = seq
        val queue = Channel<HarnessEvent>(Channel.UNLIMITED)
        frames = queue
        pump = scope.launch {
            for (event in queue) {
                try {
                    sink.onRegistryEvent(next, event)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // One bad frame must not take the fast path down silently
                    // and leave the channel buffering behind a dead pump — the
                    // same rule the socket layer applies to unparseable frames.
                    log("registry frame dropped on $next: ${e.message}")
                }
            }
        }
        subscription = gateway.watchHarnesses(Listener(next, seq, queue))
        live = true
    }

    /** Must be held under [gate]. */
    private fun detach() {
        live = false
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
        private val seq: Long,
        private val queue: Channel<HarnessEvent>,
    ) : HarnessStreamListener {
        /** Still the socket the watch believes in? */
        private val current: Boolean get() = target == den && seq == attachSeq

        override fun onOpen() {
            // Fresh attach, first or Nth. Anything the node published before
            // this socket existed is not in the tail and never will be.
            if (!current) return
            scope.launch { sink.refresh() }
        }

        override fun onEvent(event: HarnessEvent) {
            queue.trySend(event)
        }

        override fun onTerminal(message: String) {
            // 401/403 (no bearer for this node) or 404 (a den too old to mount
            // the route). The socket has already stopped; say so once and let
            // the poll carry the drawer, exactly as it did before this existed.
            //
            // Mark it dead rather than tearing the handles down: this is a
            // socket thread and those belong to `gate`. `rebind` (a pasted
            // bearer) and `stop` + `retarget` are the recovery paths, and
            // clearing the flag is what stops either from no-opping against a
            // stream that will never speak again.
            // Only for the attach this listener belongs to: a callback still
            // in flight when a rebind swapped the socket must not defame the
            // new one.
            if (current) live = false
            log("registry stream unavailable on $den: $message")
        }
    }

    private companion object {
        const val TAG = "HarnessRegistry"
    }
}
