package io.rivethub.app.plane

import kotlin.math.truncate

/**
 * Local terminal scrollback viewport. [firstLine] is the buffer index of the
 * top visible row. [followTail] pins the view to the newest lines until the
 * user drags into history.
 *
 * [dragBy] takes pointer Y delta in pixels (current minus previous; finger
 * moving down is positive). Natural touch scrolling: a finger moving DOWN
 * pulls older lines into view ([firstLine] decreases, like Termux / any
 * list); a finger moving UP returns toward the newest output. Reaching the
 * tail ([firstLine] >= maxFirst) restores follow.
 */
class TermScroll(
    lineCount: Int = 0,
    rows: Int = 24,
) {
    var firstLine: Int = 0
        private set
    var followTail: Boolean = true
        private set

    var lineCount: Int = lineCount.coerceAtLeast(0)
        private set
    var rows: Int = rows.coerceAtLeast(1)
        private set

    private var remainder: Float = 0f

    private val maxFirst: Int
        get() = (lineCount - rows).coerceAtLeast(0)

    fun dragBy(px: Float, cellH: Float) {
        if (cellH <= 0f || px == 0f) return
        remainder += -px / cellH // finger down (+px) → older lines (lower index)
        val step = truncate(remainder).toInt()
        // A sub-cell drag moves nothing on screen, so it must not change follow state
        // either (touch slop makes a few px the normal first movement of every drag).
        if (step == 0) return
        remainder -= step
        val cur = if (followTail) maxFirst else firstLine.coerceIn(0, maxFirst)
        val unclamped = cur + step
        val next = unclamped.coerceIn(0, maxFirst)
        if (next != unclamped) remainder = 0f
        firstLine = next
        followTail = next >= maxFirst
    }

    fun onLinesAppended(n: Int, dropped: Int) {
        val add = n.coerceAtLeast(0)
        val drop = dropped.coerceAtLeast(0)
        lineCount = (lineCount + add - drop).coerceAtLeast(0)
        if (!followTail) {
            firstLine = (firstLine - drop).coerceAtLeast(0)
        }
        applyClamp()
    }

    fun onResize(lineCount: Int, rows: Int) {
        this.lineCount = lineCount.coerceAtLeast(0)
        this.rows = rows.coerceAtLeast(1)
        applyClamp()
    }

    fun visibleFirst(lineCount: Int, rows: Int): Int {
        val max = (lineCount - rows).coerceAtLeast(0)
        return if (followTail) max else firstLine.coerceIn(0, max)
    }

    private fun applyClamp() {
        val max = maxFirst
        if (followTail) {
            firstLine = max
        } else {
            firstLine = firstLine.coerceIn(0, max)
            if (firstLine >= max) followTail = true
        }
    }
}
