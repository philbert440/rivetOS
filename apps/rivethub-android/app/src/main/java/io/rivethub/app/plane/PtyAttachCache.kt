package io.rivethub.app.plane

import java.util.concurrent.atomic.AtomicInteger

/**
 * Spawn-or-get id for one chat session. [cached] and [remember] run under
 * the caller's spawn lock. [restart] makes the next resolve miss so an
 * exited or reaped id is not watched again. Nothing here kills the PTY.
 *
 * [restart] bumps an [AtomicInteger] epoch. The ViewModel calls it on the
 * main thread, outside the spawn lock; a later [cached] observes that bump.
 * [remember] commits the epoch captured by the preceding [cached] call.
 * A restart that lands after that capture still misses on the next resolve.
 */
class PtyAttachCache {
    @Volatile var id: String? = null
        private set

    private val restartEpoch = AtomicInteger(0)
    @Volatile private var resolvedEpoch = 0
    private var capturedEpoch = 0

    fun restart() {
        restartEpoch.incrementAndGet()
    }

    /** Id to reuse, or null when the caller must spawn. */
    fun cached(): String? {
        capturedEpoch = restartEpoch.get()
        if (resolvedEpoch != capturedEpoch) {
            id = null
            return null
        }
        return id
    }

    fun remember(spawnedId: String) {
        id = spawnedId
        resolvedEpoch = capturedEpoch
    }

    /** Inject retry: this id is dead. Not a restart. */
    fun forget() {
        id = null
    }
}

/** Invalidate the cached id, then detach and attach again. Never kills. */
fun restartSessionPty(cache: PtyAttachCache, restartAttach: () -> Unit) {
    cache.restart()
    restartAttach()
}
