package io.rivethub.app.plane

sealed interface MdBlock {
    data class Paragraph(val inlines: List<MdInline>) : MdBlock
    data class BulletList(val items: List<List<MdInline>>) : MdBlock
    data class OrderedList(val items: List<List<MdInline>>) : MdBlock
    data class Fence(val lang: String, val code: String) : MdBlock
}

sealed interface MdInline {
    data class Text(val text: String) : MdInline
    data class Code(val text: String) : MdInline
    data class Link(val text: String, val href: String) : MdInline
}

fun parseMarkdown(src: String): List<MdBlock> {
    val lines = src.replace("\r\n", "\n").split('\n')
    val blocks = ArrayList<MdBlock>()
    var i = 0
    while (i < lines.size) {
        val line = lines[i]
        if (line.startsWith("```")) {
            val lang = line.removePrefix("```").trim().ifBlank { "code" }
            val body = StringBuilder()
            i++
            while (i < lines.size && !lines[i].startsWith("```")) {
                if (body.isNotEmpty()) body.append('\n')
                body.append(lines[i])
                i++
            }
            if (i < lines.size) i++
            blocks += MdBlock.Fence(lang, body.toString())
            continue
        }
        if (line.isBlank()) {
            i++
            continue
        }
        if (isUnordered(line) || isOrdered(line)) {
            val ordered = isOrdered(line)
            val items = ArrayList<List<MdInline>>()
            while (i < lines.size && if (ordered) isOrdered(lines[i]) else isUnordered(lines[i])) {
                items += parseInlines(stripListMarker(lines[i]))
                i++
            }
            blocks += if (ordered) MdBlock.OrderedList(items) else MdBlock.BulletList(items)
            continue
        }
        val buf = StringBuilder()
        while (
            i < lines.size &&
            lines[i].isNotBlank() &&
            !lines[i].startsWith("```") &&
            !isUnordered(lines[i]) &&
            !isOrdered(lines[i])
        ) {
            if (buf.isNotEmpty()) buf.append('\n')
            buf.append(lines[i])
            i++
        }
        blocks += MdBlock.Paragraph(parseInlines(buf.toString()))
    }
    return blocks
}

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
                val hrefEnd = if (hrefStart >= 0) src.indexOf(')', hrefStart) else -1
                if (close < 0 || hrefStart < 0 || hrefEnd < 0) {
                    buf.append(c)
                    i++
                } else {
                    flush()
                    out += MdInline.Link(src.substring(i + 1, close), src.substring(hrefStart, hrefEnd))
                    i = hrefEnd + 1
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
