package dev.rivetos.bots.ui.term

import dev.rivetos.bots.data.OscFilter
import java.util.ArrayDeque

/** One screen cell. [fg]/[bg] are packed ARGB. */
data class TermCell(
    val ch: Char = ' ',
    val fg: Int = AnsiScreen.DEFAULT_FG,
    val bg: Int = AnsiScreen.DEFAULT_BG,
    val bold: Boolean = false,
)

/** Run of cells sharing SGR, for Compose [androidx.compose.ui.text.AnnotatedString] painting. */
data class TermSpan(val text: String, val fg: Int, val bg: Int, val bold: Boolean)

data class TermLine(val spans: List<TermSpan>)

/**
 * Compact VT/ANSI screen: SGR (16 + 256 + truecolor, bold), CR/LF/BS/TAB,
 * ED/EL, CUP/CUU/CUD/CUF/CUB (plus CHA/VPA). Unknown sequences are consumed
 * and dropped — including DSR (`CSI 6n`) so we never echo a cursor report.
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
    private var cursorVisible = true

    private var state = State.GROUND
    private val csi = StringBuilder()
    private val osc = StringBuilder()
    private var utfNeed = 0
    private var utfAcc = 0
    private var rev = 0

    val generation: Int get() = synchronized(this) { rev }
    val lineCount: Int get() = synchronized(this) { scrollback.size + rows }

    fun reset(newCols: Int = cols, newRows: Int = rows) = synchronized(this) {
        cols = newCols.coerceIn(MIN_COLS, MAX_COLS)
        rows = newRows.coerceIn(MIN_ROWS, MAX_ROWS)
        scrollback.clear()
        screen = Array(rows) { blankLine(cols) }
        cx = 0; cy = 0; savedX = 0; savedY = 0
        fg = DEFAULT_FG; bg = DEFAULT_BG; bold = false
        cursorVisible = true
        state = State.GROUND
        csi.clear(); osc.clear()
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
        if (nr < oldRows) {
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
        cx = cx.coerceIn(0, cols - 1)
        cy = cy.coerceIn(0, rows - 1)
        rev++
    } }

    fun feed(raw: ByteArray) { synchronized(this) {
        if (raw.isEmpty()) return
        val data = OscFilter.stripQueries(raw)
        for (b in data) consume(b.toInt() and 0xFF)
        rev++
    } }

    fun lineAt(index: Int): TermLine = synchronized(this) {
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
            ch = if (c.ch == ' ') '▌' else c.ch,
            fg = DEFAULT_BG,
            bg = CURSOR,
            bold = c.bold,
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
                state = if (b == '\\'.code) State.GROUND else State.OSC
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
            0x08, 0x7F -> if (cx > 0) cx--
            0x09 -> {
                val next = ((cx / 8) + 1) * 8
                cx = minOf(cols - 1, next)
            }
            0x0A, 0x0B, 0x0C -> lineFeed()
            0x0D -> cx = 0
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
            0x07 -> state = State.GROUND
            0x1B -> state = State.OSC_ESC
            else -> if (osc.length < 256) osc.append(b.toChar())
        }
    }

    private fun dispatchCsi(final: Char) {
        val raw = csi.toString()
        val priv = raw.isNotEmpty() && raw[0] in "?>=<"
        val body = if (priv) raw.drop(1) else raw
        val ps = parseParams(body)
        if (priv) {
            // DEC private modes — consume. ?25 h/l is cursor visibility.
            if (final == 'h' || final == 'l') {
                if (ps.firstOrNull() == 25) cursorVisible = final == 'h'
            }
            return
        }
        when (final) {
            'A' -> cy = (cy - p(ps, 0, 1)).coerceAtLeast(0)
            'B' -> cy = (cy + p(ps, 0, 1)).coerceAtMost(rows - 1)
            'C' -> cx = (cx + p(ps, 0, 1)).coerceAtMost(cols - 1)
            'D' -> cx = (cx - p(ps, 0, 1)).coerceAtLeast(0)
            'H', 'f' -> {
                val row = p(ps, 0, 1) - 1
                val col = p(ps, 1, 1) - 1
                cy = row.coerceIn(0, rows - 1)
                cx = col.coerceIn(0, cols - 1)
            }
            'G' -> cx = (p(ps, 0, 1) - 1).coerceIn(0, cols - 1)
            'd' -> cy = (p(ps, 0, 1) - 1).coerceIn(0, rows - 1)
            'J' -> eraseDisplay(ps.firstOrNull() ?: 0)
            'K' -> eraseLine(ps.firstOrNull() ?: 0)
            'm' -> sgr(ps)
            's' -> { savedX = cx; savedY = cy }
            'u' -> { cx = savedX.coerceIn(0, cols - 1); cy = savedY.coerceIn(0, rows - 1) }
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
                2 -> {} // dim — consume; we only paint bold
                22 -> bold = false
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
        fg = DEFAULT_FG; bg = DEFAULT_BG; bold = false
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
            3 -> scrollback.clear()
        }
    }

    private fun eraseLine(mode: Int) {
        val line = screen[cy]
        when (mode) {
            0 -> for (c in cx until cols) line[c] = TermCell(' ', fg, bg, bold)
            1 -> for (c in 0..cx) line[c] = TermCell(' ', fg, bg, bold)
            2 -> screen[cy] = blankLine(cols)
        }
    }

    private fun lineFeed() {
        if (cy < rows - 1) cy++
        else {
            pushScrollback(screen[0])
            for (i in 0 until rows - 1) screen[i] = screen[i + 1]
            screen[rows - 1] = blankLine(cols)
        }
    }

    private fun reverseIndex() {
        if (cy > 0) cy--
        else {
            for (i in rows - 1 downTo 1) screen[i] = screen[i - 1]
            screen[0] = blankLine(cols)
        }
    }

    private fun put(ch: Char) {
        val w = wcwidth(ch.code)
        if (w <= 0) return
        if (cx + w > cols) {
            cx = 0
            lineFeed()
        }
        screen[cy][cx] = TermCell(ch, fg, bg, bold)
        if (w == 2 && cx + 1 < cols) screen[cy][cx + 1] = TermCell(' ', fg, bg, bold)
        cx += w
        if (cx >= cols) {
            cx = 0
            lineFeed()
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
        if (scrollback.size >= SCROLLBACK) scrollback.removeFirst()
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

        private val ANSI16 = intArrayOf(
            0xFF0D1117.toInt(), 0xFFE5484D.toInt(), 0xFF3DD68C.toInt(), 0xFFF2C531.toInt(),
            0xFF2F8CFF.toInt(), 0xFF7C5CFF.toInt(), 0xFF2BB5A0.toInt(), 0xFFE6EDF3.toInt(),
            0xFF6E7681.toInt(), 0xFFFF7B72.toInt(), 0xFF56D364.toInt(), 0xFFE3B341.toInt(),
            0xFF79C0FF.toInt(), 0xFFD2A8FF.toInt(), 0xFF56D4DD.toInt(), 0xFFFFFFFF.toInt(),
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
            val out = ArrayList<TermSpan>()
            val buf = StringBuilder()
            var fg = cells[0].fg
            var bg = cells[0].bg
            var bold = cells[0].bold
            fun flush() {
                if (buf.isEmpty()) return
                out.add(TermSpan(buf.toString(), fg, bg, bold))
                buf.clear()
            }
            for (cell in cells) {
                if (cell.fg != fg || cell.bg != bg || cell.bold != bold) {
                    flush()
                    fg = cell.fg; bg = cell.bg; bold = cell.bold
                }
                buf.append(cell.ch)
            }
            flush()
            if (out.isEmpty()) out.add(TermSpan(" ", DEFAULT_FG, DEFAULT_BG, false))
            return TermLine(out)
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
