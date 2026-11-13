package io.rivethub.app.gateway

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.Closeable
import java.util.concurrent.CopyOnWriteArraySet
import kotlin.random.Random

/**
 * Reconnect rules shared by [WsSubscription] and [TermWs]: base 500ms,
 * doubling, capped at 15s, jittered — and tied to the app's foreground.
 *
 * Android cuts a backgrounded app's network, so every retry while away
 * fails and the wait climbs to the cap. Retries therefore pause in the
 * background, and coming back resets the wait and reconnects at once: a
 * socket that is not open, or one that claims to be open after
 * [STALE_AFTER_MS] away (it may have died silently and only the next ping
 * would notice).
 */

/** Wait before retry number [attempt] (0-based), without jitter. */
fun reconnectDelayMs(attempt: Int): Long = minOf(500L shl minOf(attempt, 6), 15_000L)

/** Away longer than this and an OPEN socket is reopened on return. */
const val STALE_AFTER_MS: Long = 20_000L

/** Whether a socket in [status] reconnects when the app returns after [awayMs]. */
fun reconnectOnForeground(status: WsStatus, awayMs: Long): Boolean =
    status != WsStatus.OPEN || awayMs >= STALE_AFTER_MS

/** Process-wide foreground signal, set from MainActivity's start/stop (notify/AppVisibility). */
object AppForeground {
    fun interface Listener {
        /** [foreground] false = went to the background; true = back after [awayMs]. */
        fun onChange(foreground: Boolean, awayMs: Long)
    }

    private val listeners = CopyOnWriteArraySet<Listener>()

    /** True until told otherwise, so a socket opened outside an activity still retries. */
    @Volatile var foreground: Boolean = true
        private set
    @Volatile private var backgroundedAt: Long = 0L

    fun set(foreground: Boolean, nowMs: Long = System.currentTimeMillis()) {
        if (foreground == this.foreground) return
        this.foreground = foreground
        val away = if (foreground) (nowMs - backgroundedAt).coerceAtLeast(0L) else 0L
        if (!foreground) backgroundedAt = nowMs
        for (l in listeners) l.onChange(foreground, away)
    }

    fun register(listener: Listener): Closeable {
        listeners += listener
        return Closeable { listeners -= listener }
    }
}

/**
 * One socket's retry timer. [schedule] arms the next try after the current
 * wait; in the background it arms nothing (the return reconnects).
 * [connectNow] is the foreground path: reset the wait, drop any pending
 * try, connect. Only the job handoff is locked; [connect] runs on [scope].
 */
class ReconnectScheduler(
    private val scope: CoroutineScope,
    private val isForeground: () -> Boolean = { AppForeground.foreground },
    private val jitterMs: () -> Long = { Random.nextLong(0, 250) },
    private val connect: () -> Unit,
) {
    @Volatile private var job: Job? = null

    /** Failed tries since the last open; also picks the client path. */
    @Volatile var attempt: Int = 0
        private set

    fun onOpen() { attempt = 0 }

    fun schedule() = synchronized(this) {
        if (job?.isActive == true || !isForeground()) return
        val wait = reconnectDelayMs(attempt) + jitterMs()
        attempt += 1
        job = scope.launch {
            delay(wait)
            job = null // a failure raised from inside connect() must be able to schedule the next try
            connect()
        }
    }

    fun connectNow() {
        synchronized(this) {
            job?.cancel()
            job = null
            attempt = 0
        }
        scope.launch { connect() }
    }

    /** Background: no try fires while away. */
    fun pause() = synchronized(this) {
        job?.cancel()
        job = null
    }

    fun cancel() = pause()
}
