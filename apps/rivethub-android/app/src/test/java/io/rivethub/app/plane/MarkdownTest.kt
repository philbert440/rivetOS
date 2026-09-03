package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownTest {
    @Test
    fun `atx headings one through three`() {
        val blocks = parseMarkdown("# Title\n## Section\n### Bit")
        assertEquals(3, blocks.size)
        val h1 = blocks[0] as MdBlock.Heading
        val h2 = blocks[1] as MdBlock.Heading
        val h3 = blocks[2] as MdBlock.Heading
        assertEquals(1, h1.level)
        assertEquals(listOf(MdInline.Text("Title")), h1.inlines)
        assertEquals(2, h2.level)
        assertEquals(listOf(MdInline.Text("Section")), h2.inlines)
        assertEquals(3, h3.level)
        assertEquals(listOf(MdInline.Text("Bit")), h3.inlines)
    }

    @Test
    fun `bold emphasis`() {
        val inlines = parseInlines("say **hello** there")
        assertEquals(
            listOf(MdInline.Text("say "), MdInline.Bold("hello"), MdInline.Text(" there")),
            inlines,
        )
    }

    @Test
    fun `italic emphasis`() {
        val inlines = parseInlines("say *hello* there")
        assertEquals(
            listOf(MdInline.Text("say "), MdInline.Italic("hello"), MdInline.Text(" there")),
            inlines,
        )
    }

    @Test
    fun `blockquote strips the marker`() {
        val blocks = parseMarkdown("> keep going\n> still quoted")
        val quote = blocks.single() as MdBlock.Quote
        assertEquals(
            listOf(MdInline.Text("keep going\nstill quoted")),
            quote.inlines,
        )
    }

    @Test
    fun `pipe table does not leak pipes`() {
        val src = """
            | col | val |
            | --- | --- |
            | a | 1 |
        """.trimIndent()
        val table = parseMarkdown(src).single() as MdBlock.Table
        assertEquals(listOf("col", "val"), table.headers)
        assertEquals(listOf(listOf("a", "1")), table.rows)
        val dumped = table.headers.joinToString(" ") + table.rows.flatten().joinToString(" ")
        assertTrue(!dumped.contains('|'))
    }

    @Test
    fun `nested lists keep child items`() {
        val src = """
            - outer
              - inner
            - again
        """.trimIndent()
        val list = parseMarkdown(src).single() as MdBlock.BulletList
        assertEquals(2, list.items.size)
        assertEquals(listOf(MdInline.Text("outer")), list.items[0].inlines)
        val nested = list.items[0].children.single() as MdBlock.BulletList
        assertEquals(listOf(MdInline.Text("inner")), nested.items.single().inlines)
        assertEquals(listOf(MdInline.Text("again")), list.items[1].inlines)
        assertTrue(list.items[1].children.isEmpty())
    }

    @Test
    fun `unclosed fence renders as code to the end`() {
        val blocks = parseMarkdown("```kotlin\nfun x() = 1\nstill going")
        val fence = blocks.single() as MdBlock.Fence
        assertEquals("kotlin", fence.lang)
        assertEquals("fun x() = 1\nstill going", fence.code)
    }

    @Test
    fun `link href keeps parentheses in the URL`() {
        val inlines = parseInlines("[Foo](https://en.wikipedia.org/wiki/Bar_(baz))")
        assertEquals(
            listOf(MdInline.Link("Foo", "https://en.wikipedia.org/wiki/Bar_(baz)")),
            inlines,
        )
    }

    @Test
    fun `inline code and unmatched backtick stay literal`() {
        val inlines = parseInlines("use `code` and a lone ` tick")
        assertEquals(
            listOf(
                MdInline.Text("use "),
                MdInline.Code("code"),
                MdInline.Text(" and a lone ` tick"),
            ),
            inlines,
        )
    }

    @Test
    fun `ordered list items`() {
        val list = parseMarkdown("1. one\n2. two").single() as MdBlock.OrderedList
        assertEquals(2, list.items.size)
        assertEquals(listOf(MdInline.Text("one")), list.items[0].inlines)
        assertEquals(listOf(MdInline.Text("two")), list.items[1].inlines)
    }

    @Test
    fun `unclosed bold stays literal`() {
        val inlines = parseInlines("this **never ends")
        assertEquals(listOf(MdInline.Text("this **never ends")), inlines)
    }

    @Test
    fun `claude-style reply fixture`() {
        val src = """
            ## Summary

            Here is **bold** and *italic* plus a [wiki](https://en.wikipedia.org/wiki/Foo_(bar)).

            > Note the constraint.

            1. First
               - nested
            2. Second

            | col | val |
            | --- | --- |
            | a | 1 |

            ```python
            print("hi")
            ```
        """.trimIndent()
        val blocks = parseMarkdown(src)
        val heading = blocks[0] as MdBlock.Heading
        assertEquals(2, heading.level)
        assertEquals(listOf(MdInline.Text("Summary")), heading.inlines)
        val para = blocks[1] as MdBlock.Paragraph
        assertTrue(para.inlines.any { it is MdInline.Bold && it.text == "bold" })
        assertTrue(para.inlines.any { it is MdInline.Italic && it.text == "italic" })
        assertTrue(
            para.inlines.any {
                it is MdInline.Link &&
                    it.text == "wiki" &&
                    it.href == "https://en.wikipedia.org/wiki/Foo_(bar)"
            },
        )
        assertTrue(blocks.any { it is MdBlock.Quote })
        val ordered = blocks.first { it is MdBlock.OrderedList } as MdBlock.OrderedList
        assertEquals(2, ordered.items.size)
        val nested = ordered.items[0].children.single() as MdBlock.BulletList
        assertEquals(listOf(MdInline.Text("nested")), nested.items.single().inlines)
        val table = blocks.first { it is MdBlock.Table } as MdBlock.Table
        assertEquals(listOf("col", "val"), table.headers)
        val fence = blocks.first { it is MdBlock.Fence } as MdBlock.Fence
        assertEquals("python", fence.lang)
        assertEquals("print(\"hi\")", fence.code)
    }

    @Test(timeout = 2000)
    fun `table row with no separator is paragraph text, never a hang`() {
        val blocks = parseMarkdown("Here:\n| a | b |")
        assertEquals(1, blocks.size)
        assertTrue(blocks[0] is MdBlock.Paragraph)
    }

    @Test(timeout = 2000)
    fun `streamed table header before its separator does not stall and later rows still parse`() {
        // mid-stream: header row arrived, separator not yet — must return, not spin
        val partial = parseMarkdown("text\n| x | y |\nmore")
        assertEquals(1, partial.size)
        assertTrue(partial[0] is MdBlock.Paragraph)
        // once the separator lands the same text becomes paragraph + table
        val full = parseMarkdown("text\n| x | y |\n| --- | --- |\n| 1 | 2 |")
        assertEquals(2, full.size)
        assertTrue(full[0] is MdBlock.Paragraph)
        assertTrue(full[1] is MdBlock.Table)
    }
}
