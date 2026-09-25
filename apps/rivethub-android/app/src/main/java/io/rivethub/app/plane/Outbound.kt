package io.rivethub.app.plane

import io.rivethub.app.gateway.isTurnInFlight
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.UUID

data class OutboundItem(
    val id: String,
    val text: String,
    val status: Status,
    val attachments: List<StagedTurnAttachment> = emptyList(),
    /** The composer edit this turn was sent from; settled by its [PumpOutcome], not at enqueue. */
    val editing: EditState? = null,
) {
    enum class Status { QUEUED, SENDING, FAILED }
}

sealed class EnqueueResult {
    data class Accepted(val id: String) : EnqueueResult()
    data object Uploading : EnqueueResult()
}

/**
 * What one pump pass did, for the item it looked at. Only [Dispatched] means
 * the den accepted the turn; [Deferred] and a [RejectReason.TURN_IN_FLIGHT]
 * rejection leave the item queued; [RejectReason.FAILED] dropped it.
 */
sealed class PumpOutcome {
    data class Dispatched(val item: OutboundItem) : PumpOutcome()

    /** Not tried (awaiting turn-complete, a send in progress, uploading, retries spent); still queued. */
    data class Deferred(val item: OutboundItem) : PumpOutcome()

    /** [cause] is the send error: the 409 for [RejectReason.TURN_IN_FLIGHT], the rethrown one for FAILED. */
    data class Rejected(
        val item: OutboundItem,
        val reason: RejectReason,
        val cause: Throwable? = null,
    ) : PumpOutcome()

    /** Nothing queued (or the forced id is gone). */
    data object Idle : PumpOutcome()

    val itemId: String?
        get() = when (this) {
            is Dispatched -> item.id
            is Deferred -> item.id
            is Rejected -> item.id
            Idle -> null
        }
}

enum class RejectReason {
    /** HTTP 409 turn_in_flight: kept queued, retried on the next idle / turn-complete edge. */
    TURN_IN_FLIGHT,

    /** Hard failure: the item was dropped and the error rethrown to the caller. */
    FAILED,
}

/** Give up auto-retrying a 409 after this many idle/turn-complete edges. */
const val TURN_RETRY_ATTEMPTS: Int = 6

/**
 * One-conversation outbound pump. Queues a turn that the driver rejects
 * with turn_in_flight (HTTP 409) and retries it on a status-idle /
 * turn-complete edge ([onIdle] / [onTurnComplete]), not a timer.
 * Refuses a send while any attachment chip is still uploading.
 *
 * Single-flight: a Mutex plus a SENDING-status guard so two concurrent
 * pump() calls cannot put two turns in flight. Stale-turn release is
 * [isStalled]. A 409 is [pendingOnServer]; [onIdle] retries once per
 * idle edge up to [TURN_RETRY_ATTEMPTS]. [pump] with [forceId] injects
 * that item even while awaiting.
 *
 * Every pass reports a [PumpOutcome] to [onOutcome] (under the lock, before
 * a hard failure is rethrown) whichever entry point ran it — [pump],
 * [onIdle], [onTurnComplete]; [acknowledgePending] reports the item it
 * drops as [PumpOutcome.Dispatched] (the den did take it).
 */
class OutboundPump(
    private val send: suspend (text: String, attachments: List<StagedTurnAttachment>) -> Unit,
    private val attachmentsUploading: () -> Boolean = { false },
    private val newId: () -> String = { UUID.randomUUID().toString() },
    private val nowMs: () -> Long = { System.currentTimeMillis() },
    private val idleDeadlineMs: Long = IDLE_DEADLINE_MS,
    private val onOutcome: (PumpOutcome) -> Unit = {},
) {
    private val lock = Mutex()
    private val q = ArrayDeque<OutboundItem>()
    private val attempts = HashMap<String, Int>()
    var awaitingTurnComplete: Boolean = false
        private set
    /** Den rejected with 409; retried on the next idle / turn-complete edge. */
    var pendingOnServer: Boolean = false
        private set
    private var awaitSince: Long = 0

    val queued: List<OutboundItem> get() = q.toList()

    /**
     * An item is queued (incl. a 409 waiting to retry) or sending. An accepted
     * turn awaiting its turn-complete is the transcript's in-flight, not this —
     * a lost turn-complete must not wedge out-of-band input forever.
     */
    val busy: Boolean get() = q.isNotEmpty()

    /**
     * Run [block] under the pump's send lock, so no turn can start sending
     * while it runs (a [pump] waits for it). Out-of-band PTY input — the
     * "/compact" inject — re-checks [busy] and the session inside [block].
     */
    suspend fun <T> withSendLock(block: suspend () -> T): T = lock.withLock { block() }

    fun tryEnqueue(
        text: String,
        attachments: List<StagedTurnAttachment> = emptyList(),
        editing: EditState? = null,
    ): EnqueueResult {
        if (attachmentsUploading()) return EnqueueResult.Uploading
        val item = OutboundItem(newId(), text, OutboundItem.Status.QUEUED, attachments, editing)
        q.addLast(item)
        return EnqueueResult.Accepted(item.id)
    }

    fun isStalled(now: Long = nowMs()): Boolean =
        awaitingTurnComplete && now - awaitSince > idleDeadlineMs

    /** Remove a QUEUED item (never one mid-send) under the same lock as the pump. */
    suspend fun cancel(id: String): OutboundItem? = lock.withLock {
        val item = q.firstOrNull { it.id == id && it.status == OutboundItem.Status.QUEUED }
            ?: return@withLock null
        q.removeAll { it.id == id }
        attempts.remove(id)
        item
    }

    /** One pass; the outcome is for the item it looked at (maybe an older queued one). Throws on a hard failure. */
    suspend fun pump(forceId: String? = null): PumpOutcome = lock.withLock { pumpLocked(forceId) }

    suspend fun onTurnComplete(): PumpOutcome = lock.withLock {
        awaitingTurnComplete = false
        pendingOnServer = false
        pumpLocked()
    }

    /**
     * Status went idle: whatever turn we were waiting on is over — an accepted
     * one that never got a `turn-complete` (herdr off, text-only store) as much
     * as a 409-pending one. Drain the queue (attempts cap kept).
     */
    suspend fun onIdle(): PumpOutcome = lock.withLock {
        awaitingTurnComplete = false
        pendingOnServer = false
        // A speculative drain: an idle edge can land while an accepted turn is
        // still settling and the den answers 409 — that must not burn one of
        // the TURN_RETRY_ATTEMPTS meant for real retries.
        pumpLocked(countAttempt = false)
    }

    /**
     * Registry found our assistant while a 409 item is still queued — drop it
     * so [onTurnComplete] cannot double-send, then the caller may pump the next.
     */
    suspend fun acknowledgePending() = lock.withLock {
        if (!pendingOnServer) return@withLock
        pendingOnServer = false
        awaitingTurnComplete = false
        q.firstOrNull { it.status == OutboundItem.Status.QUEUED }?.let { item ->
            q.removeAll { it.id == item.id }
            attempts.remove(item.id)
            onOutcome(PumpOutcome.Dispatched(item))
        }
    }

    private suspend fun pumpLocked(forceId: String? = null, countAttempt: Boolean = true): PumpOutcome {
        val head = if (forceId != null) {
            q.firstOrNull { it.id == forceId }
        } else {
            q.firstOrNull { it.status == OutboundItem.Status.QUEUED }
        } ?: return report(PumpOutcome.Idle)
        if (attachmentsUploading()) return report(PumpOutcome.Deferred(head))
        if (forceId == null) {
            if (awaitingTurnComplete) return report(PumpOutcome.Deferred(head))
            if (q.any { it.status == OutboundItem.Status.SENDING }) return report(PumpOutcome.Deferred(head))
            if ((attempts[head.id] ?: 0) >= TURN_RETRY_ATTEMPTS) return report(PumpOutcome.Deferred(head))
        }
        val next = head
        replace(next, next.copy(status = OutboundItem.Status.SENDING))
        try {
            send(next.text, next.attachments)
        } catch (e: Throwable) {
            if (isTurnInFlight(e)) {
                replace(next, next.copy(status = OutboundItem.Status.QUEUED))
                awaitingTurnComplete = true
                pendingOnServer = true
                if (countAttempt) attempts[next.id] = (attempts[next.id] ?: 0) + 1
                awaitSince = nowMs()
                return report(PumpOutcome.Rejected(next, RejectReason.TURN_IN_FLIGHT, e))
            }
            pendingOnServer = false
            attempts.remove(next.id)
            q.removeAll { it.id == next.id }
            report(PumpOutcome.Rejected(next, RejectReason.FAILED, e))
            throw e
        }
        // Outside the try: a listener error must not read as a failed send.
        q.removeAll { it.id == next.id }
        attempts.remove(next.id)
        awaitingTurnComplete = true
        pendingOnServer = false
        awaitSince = nowMs()
        return report(PumpOutcome.Dispatched(next))
    }

    private fun report(outcome: PumpOutcome): PumpOutcome {
        onOutcome(outcome)
        return outcome
    }

    private fun replace(old: OutboundItem, next: OutboundItem) {
        val i = q.indexOfFirst { it.id == old.id }
        if (i >= 0) {
            q.removeAt(i)
            q.add(i, next)
        }
    }
}
