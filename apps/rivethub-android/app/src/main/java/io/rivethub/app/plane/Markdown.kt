package io.rivethub.app.plane

sealed interface MdBlock {
    data class Paragraph(val inlines: List<MdInline>) : MdBlock
    data class Heading(val level: Int, val inlines: List<MdInline>) : MdBlock
    data class Quote(val inlines: List<MdInline>) : MdBlock
    data class BulletList(val items: List<MdListItem>) : MdBlock
    data class OrderedList(val items: List<MdListItem>) : MdBlock
    data class Fence(val lang: String, val code: String) : MdBlock
    data class Table(val headers: List<String>, val rows: List<List<String>>) : MdBlock
}

data class MdListItem(
    val inlines: List<MdInline>,
    val children: List<MdBlock> = emptyList(),
)

sealed interface MdInline {
    data class Text(val text: String) : MdInline
    data class Code(val text: String) : MdInline
    data class Link(val text: String, val href: String) : MdInline
    data class Bold(val text: String) : MdInline
    data class Italic(val text: String) : MdInline
}

fun parseMarkdown(src: String): List<MdBlock> {
    val lines = src.replace("\r\n", "\n").split('\n')
    return parseBlockRange(lines, 0, lines.size)
}

private fun parseBlockRange(lines: List<String>, from: Int, to: Int): List<MdBlock> {
    val blocks = ArrayList<MdBlock>()
    var i = from
    while (i < to) {
        val line = lines[i]
        val trimmed = line.trimStart()
        if (trimmed.startsWith("```")) {
            val lang = trimmed.removePrefix("```").trim().ifBlank { "code" }
            val body = StringBuilder()
            i++
            while (i < to && !lines[i].trimStart().startsWith("```")) {
                if (body.isNotEmpty()) body.append('\n')
                body.append(lines[i])
                i++
            }
            if (i < to) i++
            blocks += MdBlock.Fence(lang, body.toString())
            continue
        }
        if (line.isBlank()) {
            i++
            continue
        }
        val heading = headingLevel(trimmed)
        if (heading != null) {
            val text = trimmed.drop(heading).trimStart()
            blocks += MdBlock.Heading(heading, parseInlines(text))
            i++
            continue
        }
        if (trimmed.startsWith(">")) {
            val inner = StringBuilder()
            while (i < to && lines[i].trimStart().startsWith(">")) {
                val q = lines[i].trimStart().removePrefix(">")
                val body = if (q.startsWith(" ")) q.drop(1) else q
                if (inner.isNotEmpty()) inner.append('\n')
                inner.append(body)
                i++
            }
            blocks += MdBlock.Quote(parseInlines(inner.toString()))
            continue
        }
        if (isTableRow(line) && i + 1 < to && isTableSep(lines[i + 1])) {
            val headers = tableCells(line)
            i += 2
            val rows = ArrayList<List<String>>()
            while (i < to && isTableRow(lines[i]) && !isTableSep(lines[i])) {
                rows += tableCells(lines[i])
                i++
            }
            blocks += MdBlock.Table(headers, rows)
            continue
        }
        if (isUnordered(line) || isOrdered(line)) {
            val indent = leadingSpaces(line)
            val (block, next) = parseList(lines, i, to, isOrdered(line), indent)
            blocks += block
            i = next
            continue
        }
        // Paragraph: ALWAYS consume the current line first so the outer loop can never stall —
        // a line no block consumer claims (e.g. a table row with no separator after it) must
        // still advance `i`, or parsing hangs on the main thread (final-review B3).
        val buf = StringBuilder(lines[i])
        i++
        while (i < to && !isBlockInterrupt(lines, i, to)) {
            buf.append('\n')
            buf.append(lines[i])
            i++
        }
        blocks += MdBlock.Paragraph(parseInlines(buf.toString()))
    }
    return blocks
}

private fun parseList(
    lines: List<String>,
    from: Int,
    to: Int,
    ordered: Boolean,
    indent: Int,
): Pair<MdBlock, Int> {
    val items = ArrayList<MdListItem>()
    var i = from
    while (i < to) {
        val line = lines[i]
        if (line.isBlank()) break
        val li = leadingSpaces(line)
        if (li < indent) break
        if (li == indent && isListLine(line)) {
            if (isOrdered(line) != ordered) break
            val inlines = parseInlines(stripListMarker(line))
            i++
            val children = ArrayList<MdBlock>()
            while (i < to && lines[i].isNotBlank()) {
                val nested = lines[i]
                val ni = leadingSpaces(nested)
                if (ni <= indent) break
                if (isUnordered(nested) || isOrdered(nested)) {
                    val (block, next) = parseList(lines, i, to, isOrdered(nested), ni)
                    children += block
                    i = next
                } else {
                    children += MdBlock.Paragraph(parseInlines(nested.trimStart()))
                    i++
                }
            }
            items += MdListItem(inlines, children)
            continue
        }
        break
    }
    val block = if (ordered) MdBlock.OrderedList(items) else MdBlock.BulletList(items)
    return block to i
}

private fun isBlockInterrupt(lines: List<String>, i: Int, to: Int): Boolean {
    val line = lines[i]
    if (line.isBlank()) return true
    val t = line.trimStart()
    if (t.startsWith("```")) return true
    if (headingLevel(t) != null) return true
    if (t.startsWith(">")) return true
    if (isUnordered(line) || isOrdered(line)) return true
    // A pipe row interrupts a paragraph only when it really starts a table (separator follows);
    // a lone `| a | b |` is paragraph text, matching the table consumer above.
    if (isTableRow(line) && i + 1 < to && isTableSep(lines[i + 1])) return true
    return false
}

private fun headingLevel(trimmed: String): Int? {
    var n = 0
    while (n < trimmed.length && trimmed[n] == '#') n++
    if (n !in 1..3) return null
    if (n == trimmed.length) return n
    return if (trimmed[n] == ' ') n else null
}

private fun leadingSpaces(line: String): Int {
    var i = 0
    while (i < line.length && line[i] == ' ') i++
    return i
}

private fun isListLine(line: String): Boolean = isUnordered(line) || isOrdered(line)

private fun isUnordered(line: String): Boolean {
    val t = line.trimStart()
    return t.startsWith("- ") || t.startsWith("* ") || t.startsWith("+ ")
}

private fun isOrdered(line: String): Boolean {
    val t = line.trimStart()
    var i = 0
    while (i < t.length && t[i].isDigit()) i++
    return i > 0 && i < t.length && t[i] == '.' && i + 1 < t.length && t[i + 1] == ' '
}

private fun stripListMarker(line: String): String {
    val t = line.trimStart()
    return when {
        t.startsWith("- ") || t.startsWith("* ") || t.startsWith("+ ") -> t.substring(2)
        else -> {
            val dot = t.indexOf(". ")
            if (dot >= 0) t.substring(dot + 2) else t
        }
    }
}

private fun isTableRow(line: String): Boolean {
    val t = line.trim()
    return t.startsWith("|") && t.count { it == '|' } >= 2
}

private fun isTableSep(line: String): Boolean {
    val cells = tableCells(line)
    if (cells.isEmpty()) return false
    return cells.all { cell ->
        val t = cell.trim()
        t.isNotEmpty() && t.any { it == '-' } && t.all { it == '-' || it == ':' || it == ' ' }
    }
}

private fun tableCells(line: String): List<String> {
    val t = line.trim()
    val inner = t.removePrefix("|").let { if (it.endsWith("|")) it.dropLast(1) else it }
    return inner.split('|').map { it.trim() }
}

fun parseInlines(src: String): List<MdInline> {
    val out = ArrayList<MdInline>()
    val buf = StringBuilder()
    var i = 0
    fun flush() {
        if (buf.isNotEmpty()) {
            out += MdInline.Text(buf.toString())
            buf.clear()
        }
    }
    while (i < src.length) {
        val c = src[i]
        when {
            c == '`' -> {
                val end = src.indexOf('`', i + 1)
                if (end < 0) {
                    buf.append(c)
                    i++
                } else {
                    flush()
                    out += MdInline.Code(src.substring(i + 1, end))
                    i = end + 1
                }
            }
            c == '[' -> {
                val close = src.indexOf(']', i + 1)
                val hrefStart = if (close >= 0 && close + 1 < src.length && src[close + 1] == '(') close + 2 else -1
                val hrefEnd = if (hrefStart >= 0) matchingParen(src, hrefStart) else -1
                if (close < 0 || hrefStart < 0 || hrefEnd < 0) {
                    buf.append(c)
                    i++
                } else {
                    flush()
                    out += MdInline.Link(src.substring(i + 1, close), src.substring(hrefStart, hrefEnd))
                    i = hrefEnd + 1
                }
            }
            c == '*' && i + 1 < src.length && src[i + 1] == '*' -> {
                val end = src.indexOf("**", i + 2)
                if (end < 0) {
                    buf.append("**")
                    i += 2
                } else {
                    flush()
                    out += MdInline.Bold(src.substring(i + 2, end))
                    i = end + 2
                }
            }
            c == '*' -> {
                val end = src.indexOf('*', i + 1)
                if (end < 0) {
                    buf.append(c)
                    i++
                } else {
                    flush()
                    out += MdInline.Italic(src.substring(i + 1, end))
                    i = end + 1
                }
            }
            else -> {
                buf.append(c)
                i++
            }
        }
    }
    flush()
    return out
}

/** First `)` that closes the `(` at [open], counting nested parens in the URL. */
private fun matchingParen(src: String, open: Int): Int {
    var depth = 1
    var i = open
    while (i < src.length) {
        when (src[i]) {
            '(' -> depth++
            ')' -> {
                depth--
                if (depth == 0) return i
            }
        }
        i++
    }
    return -1
}
