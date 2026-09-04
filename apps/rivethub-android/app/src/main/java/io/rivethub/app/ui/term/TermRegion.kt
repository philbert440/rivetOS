package io.rivethub.app.ui.term

/**
 * Pure index math for VT scroll-region and CSI repeat counts.
 * Kept out of [AnsiScreen] so the clamps are obvious in tests.
 */
internal object TermRegion {
    /**
     * CSI repeat: omitted or 0 means 1; never more than [room].
     */
    fun count(n: Int, room: Int): Int {
        if (room <= 0) return 0
        val c = if (n <= 0) 1 else n
        return minOf(c, room)
    }

    /**
     * DECSTBM 1-indexed top/bottom to a 0-indexed inclusive range.
     * Out-of-range values clamp to the screen; top >= bottom is invalid.
     */
    fun decstbm(top1: Int, bottom1: Int, rows: Int): IntRange? {
        if (rows <= 1) return null
        var top = if (top1 <= 0) 1 else top1
        var bot = if (bottom1 <= 0) rows else bottom1
        if (top < 1) top = 1
        if (bot > rows) bot = rows
        if (top >= bot) return null
        return (top - 1) until bot
    }
}
