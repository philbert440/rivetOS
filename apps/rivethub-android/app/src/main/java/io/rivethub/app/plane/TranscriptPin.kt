package io.rivethub.app.plane

/**
 * Stick-to-bottom for the chat transcript — a port of rivethub-web
 * components/transcript.tsx:385-480. Pinned starts true; the scroll listener
 * re-derives it from the distance to the bottom; new content follows ONLY
 * while pinned (scrolling up to reread during a streaming reply must not be
 * yanked back down); the jump pill re-pins.
 */

/**
 * transcript.tsx:385 `NEAR_BOTTOM_PX = 120` → 120dp on the phone: generous
 * enough that a stray fling tick doesn't unpin, small enough that reading one
 * message up stays put.
 */
const val TRANSCRIPT_NEAR_BOTTOM_DP = 120f

class TranscriptPin {
    var pinned: Boolean = true
        private set
    private var sawContent = false

    /** Scroll listener (transcript.tsx:422-428): within the threshold of the bottom stays pinned. */
    fun onScroll(distanceFromBottomDp: Float) {
        pinned = distanceFromBottomDp < TRANSCRIPT_NEAR_BOTTOM_DP
    }

    /**
     * New content — a turn appended or the live text growing (transcript.tsx:436-443).
     * Returns true when the view should scroll to the end: unconditionally on
     * the first non-empty load (a chat opens at the bottom of the thread),
     * afterwards only while pinned.
     */
    fun onContent(itemCount: Int): Boolean {
        if (itemCount <= 0) return false
        if (!sawContent) {
            sawContent = true
            pinned = true
            return true
        }
        return pinned
    }

    /** Jump pill (transcript.tsx:430-434): re-pin; the caller scrolls to the end. */
    fun jump() {
        pinned = true
    }
}
