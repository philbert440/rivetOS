package io.rivethub.app.plane

/** One terminal cell as paint input. [fg]/[bg] are packed ARGB. */
data class TermRunCell(
    val ch: Char,
    val fg: Int,
    val bg: Int,
    val bold: Boolean = false,
    val underline: Boolean = false,
    val dim: Boolean = false,
)

/**
 * Horizontal run of cells sharing SGR. [startCol] is the cell index of the
 * first character (not a pixel), so a painter places the run at
 * `startCol * cellW`.
 */
data class TermRun(
    val startCol: Int,
    val text: String,
    val fg: Int,
    val bg: Int,
    val bold: Boolean,
    val underline: Boolean = false,
    val dim: Boolean = false,
)

/** Split a row of cells into attribute-runs. Adjacent cells merge while SGR matches. */
fun rowRuns(cells: List<TermRunCell>): List<TermRun> {
    if (cells.isEmpty()) return emptyList()
    val out = ArrayList<TermRun>()
    val buf = StringBuilder()
    var start = 0
    var fg = cells[0].fg
    var bg = cells[0].bg
    var bold = cells[0].bold
    var underline = cells[0].underline
    var dim = cells[0].dim
    fun flush() {
        if (buf.isEmpty()) return
        out.add(TermRun(start, buf.toString(), fg, bg, bold, underline, dim))
        buf.clear()
    }
    for (i in cells.indices) {
        val cell = cells[i]
        if (cell.fg != fg || cell.bg != bg || cell.bold != bold ||
            cell.underline != underline || cell.dim != dim
        ) {
            flush()
            start = i
            fg = cell.fg
            bg = cell.bg
            bold = cell.bold
            underline = cell.underline
            dim = cell.dim
        }
        buf.append(cell.ch)
    }
    flush()
    return out
}
