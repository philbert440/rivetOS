package io.rivethub.app.plane

/**
 * Hub refresh state machine. Re-entry is gated on the in-flight job, never
 * on [loading] — a discarded pass must be able to clear loading and still
 * schedule the coalesced re-run.
 */
data class RefreshLatch(
    val gen: Int = 0,
    val loading: Boolean = false,
    val again: Boolean = false,
    val jobActive: Boolean = false,
)

data class RefreshStart(
    val latch: RefreshLatch,
    val start: Boolean,
)

/** Coalesce into the in-flight job; otherwise begin a new generation. */
fun requestRefresh(latch: RefreshLatch): RefreshStart {
    if (latch.jobActive) return RefreshStart(latch.copy(again = true), start = false)
    return RefreshStart(
        latch.copy(gen = latch.gen + 1, loading = true, again = false, jobActive = true),
        start = true,
    )
}

data class RefreshEnd(
    val latch: RefreshLatch,
    val rerun: Boolean,
)

/**
 * Always clears [RefreshLatch.loading] when [startedGen] still owns the
 * latch. A discarded identity-generation pass is the same exit: loading
 * false, and [RefreshLatch.again] becomes a re-run rather than a no-op.
 */
fun finishRefresh(latch: RefreshLatch, startedGen: Int): RefreshEnd {
    if (startedGen != latch.gen) {
        return RefreshEnd(latch, rerun = false)
    }
    val cleared = latch.copy(loading = false, jobActive = false)
    return if (cleared.again) {
        RefreshEnd(cleared.copy(again = false), rerun = true)
    } else {
        RefreshEnd(cleared, rerun = false)
    }
}

/** shutdown / identity wipe: drop the in-flight generation. */
fun supersedeRefresh(latch: RefreshLatch): RefreshLatch =
    latch.copy(gen = latch.gen + 1, loading = false, again = false, jobActive = false)
