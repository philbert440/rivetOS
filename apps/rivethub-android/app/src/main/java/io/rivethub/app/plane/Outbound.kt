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

/**
 * One-conversation outbound pump. Queues a turn that the driver rejects
 * with turn_in_flight (HTTP 409) and retries it after turn-complete.
 * Refuses a send while any attachment chip is still uploading.
 *
 * Single-flight: a Mutex plus a SENDING-status guard so two concurrent
 * pump() calls cannot put two turns in flight. Stale-turn release is
 * [isStalled] — M3b's 3-minute tick calls [onTurnComplete] when true.
 *
 * Deliberately smaller than the web inject-latch / exponential-backoff
 * pump: the control-plane 409 is "not yet", and turn-complete is the
 * retry signal. Persistence of the queue across process death is M3b.
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
    var awaitingTurnComplete: Boolean = false
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

    suspend fun pump() = lock.withLock { pumpLocked() }

    suspend fun onTurnComplete() = lock.withLock {
        awaitingTurnComplete = false
        pumpLocked()
    }

    private suspend fun pumpLocked() {
        if (attachmentsUploading()) return
        if (awaitingTurnComplete) return
        if (q.any { it.status == OutboundItem.Status.SENDING }) return
        val next = q.firstOrNull { it.status == OutboundItem.Status.QUEUED } ?: return
        replace(next, next.copy(status = OutboundItem.Status.SENDING))
        try {
            send(next.text)
            q.removeAll { it.id == next.id }
            awaitingTurnComplete = true
            awaitSince = nowMs()
        } catch (e: Throwable) {
            if (isTurnInFlight(e)) {
                replace(next, next.copy(status = OutboundItem.Status.QUEUED))
                awaitingTurnComplete = true
                awaitSince = nowMs()
                return
            }
            replace(next, next.copy(status = OutboundItem.Status.FAILED))
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
