package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CodeFoldTest {
    private fun lines(count: Int) = (1..count).map { "line $it" }

    @Test fun atMostTenLinesStayUnfolded() {
        assertEquals(10, CODE_FOLD_AFTER_LINES)
        for (count in 1..10) {
            val view = codeView(lines(count).joinToString("\n"), expanded = false)
            assertEquals(lines(count), view.lines)
            assertFalse(view.folded)
            assertEquals(0, view.hiddenLines)
        }
    }

    @Test fun elevenLinesHideExactlyOne() {
        val view = codeView(lines(11).joinToString("\n"), expanded = false)
        assertEquals(lines(10), view.lines)
        assertTrue(view.folded)
        assertEquals(1, view.hiddenLines)
    }

    @Test fun expandedShowsAllAndCanBeFoldedAgain() {
        val code = lines(25).joinToString("\n")
        val view = codeView(code, expanded = true)
        assertEquals(lines(25), view.lines)
        assertFalse(view.folded)
        assertEquals(0, view.hiddenLines)
        assertEquals(15, codeView(code, expanded = false).hiddenLines)
    }

    @Test fun trailingNewlinesAreTrimmedButIndentationAndInternalBlankLinesRemain() {
        assertEquals(listOf("  first  ", "", " last "), codeView("  first  \n\n last \n\n", false).lines)
        assertFalse(codeView(lines(10).joinToString("\n") + "\n", false).folded)
        assertEquals(lines(11), codeView(lines(11).joinToString("\r\n") + "\r\n", true).lines)
        assertEquals(CodeView(listOf(""), false, 0), codeView("", false))
        assertEquals(CodeView(listOf(""), false, 0), codeView("\n\n", false))
    }

    @Test fun namesAndMimesCoverEveryAliasAndFallback() {
        val aliases = mapOf(
            "kt" to listOf("kotlin", "kt"),
            "java" to listOf("java"),
            "ts" to listOf("typescript", "ts", "tsx"),
            "js" to listOf("javascript", "js", "jsx"),
            "py" to listOf("python", "py"),
            "sh" to listOf("bash", "sh", "shell", "zsh"),
            "json" to listOf("json"),
            "yaml" to listOf("yaml", "yml"),
            "sql" to listOf("sql"),
            "go" to listOf("go"),
            "rs" to listOf("rust", "rs"),
            "txt" to listOf("", "custom", "../../file"),
        )
        aliases.forEach { (ext, languages) ->
            languages.forEach { lang ->
                assertEquals("snippet-1.$ext", saveFileName(lang, 1))
                assertEquals("snippet-12.$ext", saveFileName(lang.uppercase(), 12))
                assertEquals("text/plain", saveMime(lang))
            }
        }
    }
}
