package io.rivethub.app.plane

import io.rivethub.app.gateway.TurnInFlight
import io.rivethub.app.gateway.isTurnInFlight
import java.util.UUID

data class OutboundItem(
    val id: String,
    val text: String,
    val status: Status,
) {
    enum class Status { QUEUED, SENDING, SENT, FAILED }
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
 * Deliberately smaller than the web inject-latch / exponential-backoff
 * pump: the control-plane 409 is "not yet", and turn-complete is the
 * retry signal. Persistence of the queue across process death is M3b.
 */
class OutboundPump(
    private val send: suspend (text: String) -> Unit,
    private val attachmentsUploading: () -> Boolean = { false },
    private val newId: () -> String = { UUID.randomUUID().toString() },
) {
    private val q = ArrayDeque<OutboundItem>()
    var awaitingTurnComplete: Boolean = false
        private set

    val queued: List<OutboundItem> get() = q.toList()

    fun tryEnqueue(text: String): EnqueueResult {
        if (attachmentsUploading()) return EnqueueResult.Uploading
        val item = OutboundItem(newId(), text, OutboundItem.Status.QUEUED)
        q.addLast(item)
        return EnqueueResult.Accepted(item.id)
    }

    suspend fun pump() {
        if (attachmentsUploading()) return
        if (awaitingTurnComplete) return
        val next = q.firstOrNull { it.status == OutboundItem.Status.QUEUED } ?: return
        replace(next, next.copy(status = OutboundItem.Status.SENDING))
        try {
            send(next.text)
            q.removeAll { it.id == next.id }
            awaitingTurnComplete = true
        } catch (e: Throwable) {
            if (isTurnInFlight(e) || e is TurnInFlight) {
                replace(next, next.copy(status = OutboundItem.Status.QUEUED))
                awaitingTurnComplete = true
                return
            }
            replace(next, next.copy(status = OutboundItem.Status.FAILED))
            throw e
        }
    }

    suspend fun onTurnComplete() {
        awaitingTurnComplete = false
        pump()
    }

    private fun replace(old: OutboundItem, next: OutboundItem) {
        val i = q.indexOfFirst { it.id == old.id }
        if (i >= 0) {
            q.removeAt(i)
            q.add(i, next)
        }
    }
}
