package io.rivethub.app.plane

import io.rivethub.app.gateway.isTurnInFlight
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.UUID

data class OutboundItem(
    val id: String,
    val text: String,
    val status: Status,
) {
    enum class Status { QUEUED, SENDING, FAILED }
}

sealed class EnqueueResult {
    data class Accepted(val id: String) : EnqueueResult()
    data object Uploading : EnqueueResult()
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
 */
class OutboundPump(
    private val send: suspend (text: String) -> Unit,
    private val attachmentsUploading: () -> Boolean = { false },
    private val newId: () -> String = { UUID.randomUUID().toString() },
    private val nowMs: () -> Long = { System.currentTimeMillis() },
    private val idleDeadlineMs: Long = IDLE_DEADLINE_MS,
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

    fun tryEnqueue(text: String): EnqueueResult {
        if (attachmentsUploading()) return EnqueueResult.Uploading
        val item = OutboundItem(newId(), text, OutboundItem.Status.QUEUED)
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

    suspend fun pump(forceId: String? = null) = lock.withLock { pumpLocked(forceId) }

    suspend fun onTurnComplete() = lock.withLock {
        awaitingTurnComplete = false
        pendingOnServer = false
        pumpLocked()
    }

    /**
     * Status went idle: whatever turn we were waiting on is over — an accepted
     * one that never got a `turn-complete` (herdr off, text-only store) as much
     * as a 409-pending one. Drain the queue (attempts cap kept).
     */
    suspend fun onIdle() = lock.withLock {
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
        }
    }

    private suspend fun pumpLocked(forceId: String? = null, countAttempt: Boolean = true) {
        if (attachmentsUploading()) return
        if (forceId == null) {
            if (awaitingTurnComplete) return
            if (q.any { it.status == OutboundItem.Status.SENDING }) return
        }
        val next = if (forceId != null) {
            q.firstOrNull { it.id == forceId } ?: return
        } else {
            q.firstOrNull { it.status == OutboundItem.Status.QUEUED } ?: return
        }
        if (forceId == null && (attempts[next.id] ?: 0) >= TURN_RETRY_ATTEMPTS) return
        replace(next, next.copy(status = OutboundItem.Status.SENDING))
        try {
            send(next.text)
            q.removeAll { it.id == next.id }
            attempts.remove(next.id)
            awaitingTurnComplete = true
            pendingOnServer = false
            awaitSince = nowMs()
        } catch (e: Throwable) {
            if (isTurnInFlight(e)) {
                replace(next, next.copy(status = OutboundItem.Status.QUEUED))
                awaitingTurnComplete = true
                pendingOnServer = true
                if (countAttempt) attempts[next.id] = (attempts[next.id] ?: 0) + 1
                awaitSince = nowMs()
                return
            }
            pendingOnServer = false
            attempts.remove(next.id)
            q.removeAll { it.id == next.id }
            throw e
        }
    }

    private fun replace(old: OutboundItem, next: OutboundItem) {
        val i = q.indexOfFirst { it.id == old.id }
        if (i >= 0) {
            q.removeAt(i)
            q.add(i, next)
        }
    }
}
