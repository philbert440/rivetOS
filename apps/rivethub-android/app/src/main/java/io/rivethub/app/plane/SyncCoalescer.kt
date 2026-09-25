package io.rivethub.app.plane

/**
 * Transcript sync requests (Terminal → Chat, or a rev-gap resync).
 *
 * A snapshot never cancels or completes a send. Den re-snapshots every sink,
 * so a from-zero frame is not a response to this phone. Each send opens one
 * window and gets exactly one retry unless a newer send from this phone
 * happened in between — that newer send carries its own retry. A request
 * inside the window is absorbed; the pending retry covers it. At most two
 * writes per user request.
 *
 * There is no snapshot API. Correlating a frame with the send that caused it
 * needs a server-side `syncId` echoed in the snapshot. That is a fleet
 * follow-up, not this client.
 */
class SyncCoalescer {
    /** True from a send until its one retry is taken or [abandon] clears it. */
    private var pending: Boolean = false

    /**
     * Any sync request.
     * @return true when the caller should send `{type:sync}` now and arm the
     * one retry. False when a retry is already pending; that retry covers
     * this request, and it does not supersede the pending send.
     */
    fun onRequest(): Boolean {
        if (pending) return false
        pending = true
        return true
    }

    /**
     * The rearm delay elapsed.
     * @return true when a send is still pending, so the caller should write
     * the one retry. The window closes. False when nothing is pending: the
     * retry was already taken, or [abandon] cleared the window.
     */
    fun onRearm(): Boolean {
        if (!pending) return false
        pending = false
        return true
    }

    /** Session switch. A late rearm must not send. The next request sends. */
    fun abandon() {
        pending = false
    }
}
