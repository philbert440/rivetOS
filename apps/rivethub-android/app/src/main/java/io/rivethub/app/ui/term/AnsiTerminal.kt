package io.rivethub.app.ui.term

import io.rivethub.app.data.Osc52
import io.rivethub.app.data.OscFilter
import io.rivethub.app.plane.TermRunCell
import io.rivethub.app.plane.rowRuns
import java.util.ArrayDeque

/** One screen cell. [fg]/[bg] are packed ARGB; default sentinels remap through theme tokens. */
data class TermCell(
    val ch: Char = ' ',
    val fg: Int = AnsiScreen.DEFAULT_FG,
    val bg: Int = AnsiScreen.DEFAULT_BG,
    val bold: Boolean = false,
    val underline: Boolean = false,
    val dim: Boolean = false,
)

/** Run of cells sharing SGR, for Compose [androidx.compose.ui.text.AnnotatedString] painting. */
data class TermSpan(
    val text: String,
    val fg: Int,
    val bg: Int,
    val bold: Boolean,
    val underline: Boolean = false,
    val dim: Boolean = false,
    val startCol: Int = 0,
)

data class TermLine(val spans: List<TermSpan>)

/**
 * Compact VT/ANSI screen: SGR (16 + 256 + truecolor, bold/underline/dim),
 * CR/LF/BS/TAB, ED/EL, CUP/CUU/CUD/CUF/CUB (plus CHA/VPA), DECSTBM, ICH/DCH,
 * IL/DL, ECH, SU/SD, DECAWM pending-wrap, alt screen (`?1049`/`?1047`/`?47`),
 * Unknown sequences are consumed and dropped —
 * including DSR (`CSI 6n`) so we never echo a cursor report. OSC 52 writes
 * are drained via [drainOsc52]; OSC 10/11/12 queries are stripped and never
 * answered.
 */
class AnsiScreen(cols: Int = 80, rows: Int = 24) {
    var cols: Int = cols.coerceIn(MIN_COLS, MAX_COLS)
        private set
    var rows: Int = rows.coerceIn(MIN_ROWS, MAX_ROWS)
        private set

    private val scrollback = ArrayDeque<Array<TermCell>>()
    private var screen: Array<Array<TermCell>> = Array(this.rows) { blankLine(this.cols) }
    private var cx = 0
    private var cy = 0
    private var savedX = 0
    private var savedY = 0
    private var fg = DEFAULT_FG
    private var bg = DEFAULT_BG
    private var bold = false
    private var underline = false
    private var dim = false
    private var cursorVisible = true
    private var appCursor = false
    private var autoWrap = true
    private var wrapPending = false
    private var scrollTop = 0
    private var scrollBottom = this.rows - 1
    private var altActive = false
    private var primaryScreen: Array<Array<TermCell>>? = null
    private var primaryCx = 0
    private var primaryCy = 0
    private var primaryScrollTop = 0
    private var primaryScrollBottom = 0
    private var primaryWrapPending = false
    private val osc52Out = ArrayList<String>()
    private var droppedTotal = 0

    private var state = State.GROUND
    private val csi = StringBuilder()
    private val osc = StringBuilder()
    private var utfNeed = 0
    private var utfAcc = 0
    private var rev = 0

    val generation: Int get() = synchronized(this) { rev }
    val lineCount: Int get() = synchronized(this) { scrollback.size + rows }
    val applicationCursor: Boolean get() = synchronized(this) { appCursor }
    /** Cumulative scrollback head drops (cap rotation). Pane samples the delta. */
    val scrollbackDroppedTotal: Int get() = synchronized(this) { droppedTotal }

    fun reset(newCols: Int = cols, newRows: Int = rows) = synchronized(this) {
        cols = newCols.coerceIn(MIN_COLS, MAX_COLS)
        rows = newRows.coerceIn(MIN_ROWS, MAX_ROWS)
        scrollback.clear()
        droppedTotal = 0
        screen = Array(rows) { blankLine(cols) }
        cx = 0; cy = 0; savedX = 0; savedY = 0
        fg = DEFAULT_FG; bg = DEFAULT_BG; bold = false; underline = false; dim = false
        cursorVisible = true
        appCursor = false
        autoWrap = true
        wrapPending = false
        scrollTop = 0
        scrollBottom = rows - 1
        altActive = false
        primaryScreen = null
        state = State.GROUND
        csi.clear(); osc.clear()
        osc52Out.clear()
        utfNeed = 0; utfAcc = 0
        rev++
    }

    fun resize(newCols: Int, newRows: Int) { synchronized(this) {
        val nc = newCols.coerceIn(MIN_COLS, MAX_COLS)
        val nr = newRows.coerceIn(MIN_ROWS, MAX_ROWS)
        if (nc == cols && nr == rows) return
        val old = screen
        val oldRows = rows
        val oldCols = cols
        val oldFullRegion = scrollTop == 0 && scrollBottom == oldRows - 1
        val oldPrimaryFull = primaryScrollTop == 0 && primaryScrollBottom == oldRows - 1
        if (nr < oldRows && !altActive) {
            for (i in 0 until oldRows - nr) pushScrollback(old[i])
        }
        cols = nc; rows = nr
        screen = Array(nr) { r ->
            val srcIndex = r + (oldRows - nr).coerceAtLeast(0)
            val src = if (srcIndex in old.indices) old[srcIndex] else null
            val line = blankLine(nc)
            if (src != null) {
                val n = minOf(nc, oldCols)
                for (c in 0 until n) line[c] = src[c]
            }
            line
        }
        if (oldFullRegion) {
            scrollTop = 0
            scrollBottom = rows - 1
        } else {
            scrollBottom = scrollBottom.coerceIn(0, rows - 1)
            scrollTop = scrollTop.coerceIn(0, scrollBottom)
            if (scrollTop >= scrollBottom) {
                scrollTop = 0
                scrollBottom = rows - 1
            }
        }
        cx = cx.coerceIn(0, cols - 1)
        cy = cy.coerceIn(0, rows - 1)
        wrapPending = false
        primaryScreen?.let { buf ->
            primaryScreen = fitBuffer(buf, nr, nc)
            primaryCx = primaryCx.coerceIn(0, nc - 1)
            primaryCy = primaryCy.coerceIn(0, nr - 1)
            if (oldPrimaryFull) {
                primaryScrollTop = 0
                primaryScrollBottom = nr - 1
            } else {
                primaryScrollBottom = primaryScrollBottom.coerceIn(0, nr - 1)
                primaryScrollTop = primaryScrollTop.coerceIn(0, primaryScrollBottom)
            }
        }
        rev++
    } }

    fun feed(raw: ByteArray) { synchronized(this) {
        if (raw.isEmpty()) return
        val data = OscFilter.stripQueries(raw)
        for (b in data) consume(b.toInt() and 0xFF)
        rev++
    } }

    fun drainOsc52(): List<String> = synchronized(this) {
        if (osc52Out.isEmpty()) emptyList()
        else osc52Out.toList().also { osc52Out.clear() }
    }

    fun lineAt(index: Int): TermLine = synchronized(this) { lineAtLocked(index) }

    /** One lock, [count] rows starting at [first] — paint path must not lock per row. */
    fun snapshot(first: Int, count: Int): List<TermLine> = synchronized(this) {
        List(count) { lineAtLocked(first + it) }
    }

    private fun lineAtLocked(index: Int): TermLine {
        val sb = scrollback.size
        val cells: Array<TermCell> = when {
            index < 0 -> blankLine(cols)
            index < sb -> scrollback.elementAt(index)
            index < sb + rows -> screen[index - sb]
            else -> blankLine(cols)
        }
        val painted = if (index == sb + cy && cursorVisible) withCursor(cells) else cells
        return spansOf(painted)
    }

    private fun withCursor(cells: Array<TermCell>): Array<TermCell> {
        val out = cells.copyOf()
        val i = cx.coerceIn(0, out.lastIndex)
        val c = out[i]
        out[i] = TermCell(
            ch = c.ch,
            fg = DEFAULT_BG,
            bg = CURSOR,
            bold = c.bold,
            underline = c.underline,
            dim = c.dim,
        )
        return out
    }

    private fun consume(b: Int) {
        when (state) {
            State.GROUND -> ground(b)
            State.ESC -> esc(b)
            State.CSI -> csiByte(b)
            State.OSC -> oscByte(b)
            State.OSC_ESC -> {
                if (b == '\\'.code) {
                    finishOsc()
                    state = State.GROUND
                } else {
                    state = State.OSC
                }
            }
            State.ST_STRING -> {
                when (b) {
                    0x07 -> state = State.GROUND
                    0x1B -> state = State.ST_ESC
                }
            }
            State.ST_ESC -> state = if (b == '\\'.code) State.GROUND else State.ST_STRING
            State.CHARSET -> state = State.GROUND
        }
    }

    private fun ground(b: Int) {
        when (b) {
            0x00, 0x07 -> {}
            0x08, 0x7F -> {
                wrapPending = false
                if (cx > 0) cx--
            }
            0x09 -> {
                wrapPending = false
                val next = ((cx / 8) + 1) * 8
                cx = minOf(cols - 1, next)
            }
            0x0A, 0x0B, 0x0C -> lineFeed()
            0x0D -> {
                wrapPending = false
                cx = 0
            }
            0x1B -> {
                utfNeed = 0
                state = State.ESC
            }
            else -> if (b >= 0x20) utf8(b)
        }
    }

    private fun esc(b: Int) {
        state = State.GROUND
        when (b.toChar()) {
            '[' -> { csi.clear(); state = State.CSI }
            ']' -> { osc.clear(); state = State.OSC }
            'P', 'X', '^', '_' -> state = State.ST_STRING
            '(', ')', '*', '+' -> state = State.CHARSET
            '7' -> { savedX = cx; savedY = cy }
            '8' -> { cx = savedX.coerceIn(0, cols - 1); cy = savedY.coerceIn(0, rows - 1) }
            'c' -> reset(cols, rows)
            'D' -> lineFeed()
            'E' -> { cx = 0; lineFeed() }
            'M' -> reverseIndex()
            '\\' -> {}
            else -> {}
        }
    }

    private fun csiByte(b: Int) {
        when {
            b == 0x1B -> state = State.ESC
            b in 0x20..0x3F -> {
                if (csi.length < 64) csi.append(b.toChar())
            }
            b in 0x40..0x7E -> {
                dispatchCsi(b.toChar())
                state = State.GROUND
            }
            b < 0x20 -> {}
            else -> state = State.GROUND
        }
    }

    private fun oscByte(b: Int) {
        when (b) {
            0x07 -> {
                finishOsc()
                state = State.GROUND
            }
            0x1B -> state = State.OSC_ESC
            else -> {
                val cap = if (osc.startsWith("52;")) Osc52.MAX_B64 + 8 else 256
                if (osc.length < cap) osc.append(b.toChar())
            }
        }
    }

    private fun dispatchCsi(final: Char) {
        val raw = csi.toString()
        val priv = raw.isNotEmpty() && raw[0] in "?>=<"
        val body = if (priv) raw.drop(1) else raw
        val ps = parseParams(body)
        if (priv) {
            // DEC private: ?1 DECCKM, ?7 DECAWM, ?25 cursor, ?47/?1047/?1049 alt,
            if (final == 'h' || final == 'l') {
                val on = final == 'h'
                for (p in ps) {
                    when (p) {
                        1 -> appCursor = on
                        7 -> {
                            autoWrap = on
                            if (!on) wrapPending = false
                        }
                        25 -> cursorVisible = on
                        47, 1047, 1049 -> setAltScreen(on)
                    }
                }
            }
            return
        }
        when (final) {
            'A' -> {
                wrapPending = false
                cy = (cy - p(ps, 0, 1)).coerceAtLeast(0)
            }
            'B' -> {
                wrapPending = false
                cy = (cy + p(ps, 0, 1)).coerceAtMost(rows - 1)
            }
            'C' -> {
                wrapPending = false
                cx = (cx + p(ps, 0, 1)).coerceAtMost(cols - 1)
            }
            'D' -> {
                wrapPending = false
                cx = (cx - p(ps, 0, 1)).coerceAtLeast(0)
            }
            'H', 'f' -> {
                wrapPending = false
                val row = p(ps, 0, 1) - 1
                val col = p(ps, 1, 1) - 1
                cy = row.coerceIn(0, rows - 1)
                cx = col.coerceIn(0, cols - 1)
            }
            'G' -> {
                wrapPending = false
                cx = (p(ps, 0, 1) - 1).coerceIn(0, cols - 1)
            }
            'd' -> {
                wrapPending = false
                cy = (p(ps, 0, 1) - 1).coerceIn(0, rows - 1)
            }
            'J' -> eraseDisplay(ps.firstOrNull() ?: 0)
            'K' -> eraseLine(ps.firstOrNull() ?: 0)
            '@' -> insertChars(p(ps, 0, 1))
            'P' -> deleteChars(p(ps, 0, 1))
            'L' -> insertLines(p(ps, 0, 1))
            'M' -> deleteLines(p(ps, 0, 1))
            'X' -> eraseChars(p(ps, 0, 1))
            'S' -> scrollUp(p(ps, 0, 1))
            'T' -> if (ps.size <= 1) scrollDown(p(ps, 0, 1))
            'r' -> setScrollRegion(ps)
            'm' -> sgr(ps)
            's' -> { savedX = cx; savedY = cy }
            'u' -> {
                wrapPending = false
                cx = savedX.coerceIn(0, cols - 1)
                cy = savedY.coerceIn(0, rows - 1)
            }
            else -> {} // unknown CSI, including DSR `n` — never reply
        }
    }

    private fun sgr(ps: IntArray) {
        if (ps.isEmpty()) { resetAttr(); return }
        var i = 0
        while (i < ps.size) {
            when (val n = ps[i]) {
                0 -> resetAttr()
                1 -> bold = true
                2 -> dim = true
                4 -> underline = true
                21, 24 -> underline = false
                22 -> { bold = false; dim = false }
                in 30..37 -> fg = ANSI16[n - 30]
                in 90..97 -> fg = ANSI16[n - 90 + 8]
                in 40..47 -> bg = ANSI16[n - 40]
                in 100..107 -> bg = ANSI16[n - 100 + 8]
                39 -> fg = DEFAULT_FG
                49 -> bg = DEFAULT_BG
                38, 48 -> {
                    val isFg = n == 38
                    val mode = ps.getOrNull(i + 1)
                    when (mode) {
                        5 -> {
                            val idx = ps.getOrNull(i + 2) ?: 0
                            val c = ansi256(idx)
                            if (isFg) fg = c else bg = c
                            i += 2
                        }
                        2 -> {
                            val r = ps.getOrNull(i + 2) ?: 0
                            val g = ps.getOrNull(i + 3) ?: 0
                            val b = ps.getOrNull(i + 4) ?: 0
                            val c = rgb(r, g, b)
                            if (isFg) fg = c else bg = c
                            i += 4
                        }
                        else -> {}
                    }
                }
                else -> {}
            }
            i++
        }
    }

    private fun resetAttr() {
        fg = DEFAULT_FG; bg = DEFAULT_BG; bold = false; underline = false; dim = false
    }

    private fun finishOsc() {
        val body = osc.toString()
        osc.clear()
        if (body.startsWith("52;")) {
            Osc52.decodeWrite(body.substring(3))?.let { osc52Out += it }
        }
    }

    private fun eraseDisplay(mode: Int) {
        when (mode) {
            0 -> {
                eraseLine(0)
                for (r in (cy + 1) until rows) screen[r] = blankLine(cols)
            }
            1 -> {
                eraseLine(1)
                for (r in 0 until cy) screen[r] = blankLine(cols)
            }
            2 -> for (r in 0 until rows) screen[r] = blankLine(cols)
            3 -> {
                droppedTotal = 0
                scrollback.clear()
            }
        }
    }

    private fun eraseLine(mode: Int) {
        val line = screen[cy]
        when (mode) {
            0 -> for (c in cx until cols) line[c] = TermCell(' ', fg, bg, bold, underline, dim)
            1 -> for (c in 0..cx) line[c] = TermCell(' ', fg, bg, bold, underline, dim)
            2 -> screen[cy] = blankLine(cols)
        }
    }

    private fun lineFeed() {
        wrapPending = false
        if (cy == scrollBottom) scrollUp(1)
        else if (cy < rows - 1) cy++
    }

    private fun reverseIndex() {
        wrapPending = false
        if (cy == scrollTop) scrollDown(1)
        else if (cy > 0) cy--
    }

    private fun put(ch: Char) {
        val w = wcwidth(ch.code)
        if (w <= 0) return
        if (wrapPending) {
            wrapPending = false
            if (autoWrap) {
                cx = 0
                lineFeed()
            }
        }
        if (cx + w > cols) {
            if (autoWrap) {
                cx = 0
                lineFeed()
            } else {
                cx = (cols - w).coerceAtLeast(0)
            }
        }
        screen[cy][cx] = TermCell(ch, fg, bg, bold, underline, dim)
        if (w == 2 && cx + 1 < cols) screen[cy][cx + 1] = TermCell(' ', fg, bg, bold, underline, dim)
        cx += w
        if (cx >= cols) {
            cx = cols - 1
            wrapPending = autoWrap
        }
    }

    private fun setScrollRegion(ps: IntArray) {
        val range = TermRegion.decstbm(p(ps, 0, 1), p(ps, 1, rows), rows) ?: return
        scrollTop = range.first
        scrollBottom = range.last
        cx = 0
        cy = 0
        wrapPending = false
    }

    private fun setAltScreen(on: Boolean) {
        if (on) {
            if (altActive) return
            altActive = true
            primaryScreen = screen
            primaryCx = cx
            primaryCy = cy
            primaryScrollTop = scrollTop
            primaryScrollBottom = scrollBottom
            primaryWrapPending = wrapPending
            screen = Array(rows) { blankLine(cols) }
            cx = 0
            cy = 0
            scrollTop = 0
            scrollBottom = rows - 1
            wrapPending = false
        } else {
            if (!altActive) return
            val saved = primaryScreen ?: return
            altActive = false
            primaryScreen = null
            screen = saved
            cx = primaryCx.coerceIn(0, cols - 1)
            cy = primaryCy.coerceIn(0, rows - 1)
            scrollTop = primaryScrollTop.coerceIn(0, rows - 1)
            scrollBottom = primaryScrollBottom.coerceIn(scrollTop, rows - 1)
            wrapPending = primaryWrapPending
        }
    }

    private fun insertChars(n: Int) {
        wrapPending = false
        val k = TermRegion.count(n, cols - cx)
        if (k == 0) return
        val line = screen[cy]
        for (c in (cols - 1) downTo cx + k) line[c] = line[c - k]
        val blank = TermCell(' ', fg, bg, bold, underline, dim)
        for (c in cx until cx + k) line[c] = blank
    }

    private fun deleteChars(n: Int) {
        wrapPending = false
        val k = TermRegion.count(n, cols - cx)
        if (k == 0) return
        val line = screen[cy]
        for (c in cx until cols - k) line[c] = line[c + k]
        val blank = TermCell(' ', fg, bg, bold, underline, dim)
        for (c in (cols - k) until cols) line[c] = blank
    }

    private fun eraseChars(n: Int) {
        val k = TermRegion.count(n, cols - cx)
        if (k == 0) return
        val line = screen[cy]
        val blank = TermCell(' ', fg, bg, bold, underline, dim)
        for (c in cx until cx + k) line[c] = blank
    }

    private fun insertLines(n: Int) {
        wrapPending = false
        if (cy < scrollTop || cy > scrollBottom) return
        cx = 0 // xterm homes the cursor to the left margin on IL
        val k = TermRegion.count(n, scrollBottom - cy + 1)
        if (k == 0) return
        for (i in scrollBottom downTo cy + k) screen[i] = screen[i - k]
        for (i in cy until cy + k) screen[i] = blankLine(cols)
    }

    private fun deleteLines(n: Int) {
        wrapPending = false
        if (cy < scrollTop || cy > scrollBottom) return
        cx = 0 // xterm homes the cursor to the left margin on DL
        val k = TermRegion.count(n, scrollBottom - cy + 1)
        if (k == 0) return
        for (i in cy..scrollBottom - k) screen[i] = screen[i + k]
        for (i in (scrollBottom - k + 1)..scrollBottom) screen[i] = blankLine(cols)
    }

    private fun scrollUp(n: Int) {
        val k = TermRegion.count(n, scrollBottom - scrollTop + 1)
        if (k == 0) return
        val full = !altActive && scrollTop == 0 && scrollBottom == rows - 1
        if (full) {
            for (i in 0 until k) pushScrollback(screen[scrollTop + i])
        }
        for (i in scrollTop..scrollBottom - k) screen[i] = screen[i + k]
        for (i in (scrollBottom - k + 1)..scrollBottom) screen[i] = blankLine(cols)
    }

    private fun scrollDown(n: Int) {
        val k = TermRegion.count(n, scrollBottom - scrollTop + 1)
        if (k == 0) return
        for (i in scrollBottom downTo scrollTop + k) screen[i] = screen[i - k]
        for (i in scrollTop until scrollTop + k) screen[i] = blankLine(cols)
    }

    private fun fitBuffer(src: Array<Array<TermCell>>, nr: Int, nc: Int): Array<Array<TermCell>> {
        val oldRows = src.size
        val oldCols = src.firstOrNull()?.size ?: nc
        return Array(nr) { r ->
            val line = blankLine(nc)
            if (r < oldRows) {
                val copy = minOf(nc, oldCols)
                for (c in 0 until copy) line[c] = src[r][c]
            }
            line
        }
    }

    private fun utf8(b: Int) {
        if (utfNeed == 0) {
            when {
                b < 0x80 -> put(b.toChar())
                b and 0xE0 == 0xC0 -> { utfNeed = 1; utfAcc = b and 0x1F }
                b and 0xF0 == 0xE0 -> { utfNeed = 2; utfAcc = b and 0x0F }
                b and 0xF8 == 0xF0 -> { utfNeed = 3; utfAcc = b and 0x07 }
                else -> put('\uFFFD')
            }
            return
        }
        if (b and 0xC0 != 0x80) {
            utfNeed = 0
            put('\uFFFD')
            utf8(b)
            return
        }
        utfAcc = (utfAcc shl 6) or (b and 0x3F)
        utfNeed--
        if (utfNeed == 0) {
            val cp = utfAcc
            if (cp <= 0xFFFF) put(cp.toChar())
            else {
                val chars = Character.toChars(cp)
                for (ch in chars) put(ch)
            }
        }
    }

    private fun pushScrollback(line: Array<TermCell>) {
        if (scrollback.size >= SCROLLBACK) {
            scrollback.removeFirst()
            droppedTotal++
        }
        scrollback.addLast(line)
    }

    companion object {
        const val MIN_COLS = 20
        const val MAX_COLS = 500
        const val MIN_ROWS = 5
        const val MAX_ROWS = 200
        const val SCROLLBACK = 5000
        val DEFAULT_FG = 0xFFE6EDF3.toInt()
        val DEFAULT_BG = 0xFF0D1117.toInt()
        val CURSOR = 0xFF34D399.toInt()

        private enum class State { GROUND, ESC, CSI, OSC, OSC_ESC, ST_STRING, ST_ESC, CHARSET }

        /** xterm.js Tango ANSI ramp (`XTERM_DEFAULT_ANSI` in terminal-schemes.ts). */
        val ANSI16 = intArrayOf(
            0xFF2E3436.toInt(), 0xFFCC0000.toInt(), 0xFF4E9A06.toInt(), 0xFFC4A000.toInt(),
            0xFF3465A4.toInt(), 0xFF75507B.toInt(), 0xFF06989A.toInt(), 0xFFD3D7CF.toInt(),
            0xFF555753.toInt(), 0xFFEF2929.toInt(), 0xFF8AE234.toInt(), 0xFFFCE94F.toInt(),
            0xFF729FCF.toInt(), 0xFFAD7FA8.toInt(), 0xFF34E2E2.toInt(), 0xFFEEEEEC.toInt(),
        )

        private fun rgb(r: Int, g: Int, b: Int): Int =
            (0xFF shl 24) or (r.coerceIn(0, 255) shl 16) or (g.coerceIn(0, 255) shl 8) or b.coerceIn(0, 255)

        private fun ansi256(n: Int): Int {
            val i = n.coerceIn(0, 255)
            if (i < 16) return ANSI16[i]
            if (i >= 232) {
                val v = 8 + (i - 232) * 10
                return rgb(v, v, v)
            }
            val c = i - 16
            fun level(x: Int) = if (x == 0) 0 else 55 + x * 40
            return rgb(level(c / 36), level((c % 36) / 6), level(c % 6))
        }

        private fun blankLine(n: Int): Array<TermCell> = Array(n) { TermCell() }

        private fun parseParams(s: String): IntArray {
            if (s.isEmpty()) return intArrayOf()
            return s.split(';').map { it.toIntOrNull() ?: 0 }.toIntArray()
        }

        private fun p(ps: IntArray, i: Int, default: Int): Int {
            val v = ps.getOrNull(i) ?: return default
            return if (v == 0) default else v
        }

        private fun spansOf(cells: Array<TermCell>): TermLine {
            if (cells.isEmpty()) return TermLine(listOf(TermSpan(" ", DEFAULT_FG, DEFAULT_BG, false)))
            val runs = rowRuns(
                cells.map { TermRunCell(it.ch, it.fg, it.bg, it.bold, it.underline, it.dim) },
            )
            if (runs.isEmpty()) return TermLine(listOf(TermSpan(" ", DEFAULT_FG, DEFAULT_BG, false)))
            return TermLine(
                runs.map {
                    TermSpan(it.text, it.fg, it.bg, it.bold, it.underline, it.dim, it.startCol)
                },
            )
        }

        private fun wcwidth(cp: Int): Int {
            if (cp == 0) return 0
            if (cp < 32 || cp in 0x7F..0x9F) return 0
            val type = Character.getType(cp)
            if (type == Character.NON_SPACING_MARK.toInt() || type == Character.ENCLOSING_MARK.toInt() ||
                type == Character.COMBINING_SPACING_MARK.toInt()
            ) return 0
            return if (
                cp in 0x1100..0x115F || cp in 0x2329..0x232A ||
                cp in 0x2E80..0xA4CF || cp in 0xAC00..0xD7A3 ||
                cp in 0xF900..0xFAFF || cp in 0xFE10..0xFE19 ||
                cp in 0xFE30..0xFE6F || cp in 0xFF00..0xFF60 ||
                cp in 0xFFE0..0xFFE6
            ) 2 else 1
        }
    }
}
