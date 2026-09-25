package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CodeHighlightTest {
    private data class Sample(val aliases: List<String>, val keyword: String, val comment: String, val label: String)

    private val samples = listOf(
        Sample(listOf("kotlin", "kt"), "val", "// comment", "Kotlin"),
        Sample(listOf("java"), "class", "// comment", "Java"),
        Sample(listOf("typescript", "ts", "tsx"), "const", "// comment", "TypeScript"),
        Sample(listOf("javascript", "js", "jsx"), "let", "// comment", "JavaScript"),
        Sample(listOf("python", "py"), "def", "# comment", "Python"),
        Sample(listOf("bash", "sh", "shell", "zsh"), "if", "# comment", "Shell"),
        // Accept comments in JSON-like snippets too; this tokenizer is not a validator.
        Sample(listOf("json"), "true", "// comment", "JSON"),
        Sample(listOf("yaml", "yml"), "false", "# comment", "YAML"),
        Sample(listOf("sql"), "SELECT", "-- comment", "SQL"),
        Sample(listOf("go"), "func", "// comment", "Go"),
        Sample(listOf("rust", "rs"), "fn", "// comment", "Rust"),
    )

    @Test fun everyLanguageAndAliasRecognizesItsTokens() {
        val quoted = "\"a\\\"b\""
        for (sample in samples) for (alias in sample.aliases) {
            val code = "${sample.keyword} value: $quoted 42 ${sample.comment}"
            val spans = highlightCode(alias, code)
            assertToken(alias, code, spans, sample.keyword, TokKind.Keyword)
            assertToken(alias, code, spans, quoted, TokKind.String)
            assertToken(alias, code, spans, "42", TokKind.Number)
            assertToken(alias, code, spans, sample.comment, TokKind.Comment)
            assertCoverage(code, spans)
            assertEquals(spans, highlightCode(alias.uppercase(), code))
            assertEquals(sample.label, langLabel(alias.uppercase()))
        }
    }

    @Test fun escapedSingleQuotesAndBackslashesStayInsideStrings() {
        val quoted = "'it\\'s \\\\ fine'"
        samples.filter { it.label !in listOf("Shell", "Rust") }.flatMap { it.aliases }.forEach { lang ->
            assertEquals(listOf(CodeSpan(0, quoted.length, TokKind.String)), highlightCode(lang, quoted))
        }
    }

    @Test fun backticksInApplicableLanguages() {
        val code = "`a\\`b`"
        listOf("kt", "ts", "tsx", "js", "jsx", "sh").forEach { lang ->
            assertEquals(lang, listOf(CodeSpan(0, code.length, TokKind.String)), highlightCode(lang, code))
        }
    }

    @Test fun typesAreCapitalizedIdentifiersOnlyInTypedLanguages() {
        listOf("kt", "java", "ts", "rust", "go").forEach { lang ->
            assertEquals(listOf(CodeSpan(0, 6, TokKind.Type)), highlightCode(lang, "Widget"))
        }
        listOf("js", "python", "sh", "json", "yaml", "sql").forEach { lang ->
            assertEquals(listOf(CodeSpan(0, 6, TokKind.Plain)), highlightCode(lang, "Widget"))
        }
        assertEquals(TokKind.Keyword, highlightCode("py", "True").single().kind)
    }

    @Test fun blockCommentsEndOnTheSameLine() {
        val code = "/* comment */ val n = 7"
        listOf("kt", "java", "ts", "js", "json", "sql", "go", "rs").forEach { lang ->
            val spans = highlightCode(lang, code)
            assertToken(lang, code, spans, "/* comment */", TokKind.Comment)
            assertToken(lang, code, spans, "7", TokKind.Number)
            assertCoverage(code, spans)
        }
    }

    @Test fun unfinishedStringsAndCommentsDoNotLeakAcrossLines() {
        listOf("\"unfinished", "'unfinished", "/* unfinished", "// comment").forEach { prefix ->
            val code = "$prefix\nval n = 42"
            val spans = highlightCode("kt", code)
            assertToken("kt", code, spans, "val", TokKind.Keyword)
            assertToken("kt", code, spans, "42", TokKind.Number)
            assertCoverage(code, spans)
        }
    }

    @Test fun markersInsideStringsAndStringsInsideCommentsAreNotRetokenized() {
        val code = "\"// # -- /* 42\" // \"quoted\" 1"
        val spans = highlightCode("ts", code)
        assertToken("ts", code, spans, "\"// # -- /* 42\"", TokKind.String)
        assertToken("ts", code, spans, "// \"quoted\" 1", TokKind.Comment)
        assertCoverage(code, spans)
    }

    @Test fun decimalExponentAndRadixNumbersDoNotSwallowOperators() {
        val code = "12.5e-2 + 0xFF - 0b101 + 1_000"
        val spans = highlightCode("kt", code)
        listOf("12.5e-2", "0xFF", "0b101", "1_000").forEach {
            assertToken("kt", code, spans, it, TokKind.Number)
        }
        assertToken("kt", code, spans, "+", TokKind.Punct)
        assertToken("kt", code, spans, "-", TokKind.Punct)
        assertCoverage(code, spans)
    }

    @Test fun keywordsMustBeWholeIdentifiers() {
        val code = "value classy iffy returnValue var2"
        assertEquals(listOf(CodeSpan(0, code.length, TokKind.Plain)), highlightCode("kt", code))
    }

    @Test fun unknownLanguageIsExactlyOnePlainSpanAndKeepsItsLabel() {
        val code = "val n = 1\n\"hello\" // comment"
        assertEquals(listOf(CodeSpan(0, code.length, TokKind.Plain)), highlightCode("custom", code))
        assertEquals("CuStOm", langLabel("CuStOm"))
        assertEquals("code", langLabel(""))
        assertEquals("code", langLabel("  "))
    }

    @Test fun emptyAndWhitespaceAndUnicodeRemainCovered() {
        listOf("", "unknown", "kt", "py", "sql").forEach { lang ->
            listOf("", " \t\n\r\n", "val 名 = \"🌱\"\r\n# ü\n", "@x\\ ?").forEach { code ->
                assertCoverage(code, highlightCode(lang, code))
            }
        }
        assertEquals(listOf(CodeSpan(0, 0, TokKind.Plain)), highlightCode("unknown", ""))
    }

    @Test fun rustLifetimesArePunctuationAndCharsRemainStrings() {
        val code = "fn f<'a>(x: &'a str)"
        val spans = highlightCode("rs", code)
        assertEquals(0, spans.count { it.kind == TokKind.String })
        assertEquals(2, spans.count { it.kind == TokKind.Punct && code.substring(it.start, it.end) == "'" })
        assertCoverage(code, spans)
        listOf("'a'", "'\\n'", "'\\''", "'\\u{1F331}'", "'🌱'").forEach { char ->
            assertEquals(listOf(CodeSpan(0, char.length, TokKind.String)), highlightCode("rust", char))
        }
    }

    @Test fun yamlApostrophesInPlainValuesDoNotStartStrings() {
        val code = "title: Don't panic"
        val spans = highlightCode("yaml", code)
        assertTrue(spans.none { it.kind == TokKind.String })
        assertCoverage(code, spans)
        listOf("  'value'", "title: 'value'", "- 'value'").forEach { value ->
            assertToken("yaml", value, highlightCode("yaml", value), "'value'", TokKind.String)
        }
    }

    @Test fun shellSingleQuotesDoNotEscapeClosingQuote() {
        val code = "'it\\'s'"
        val spans = highlightCode("bash", code)
        assertEquals(CodeSpan(0, 5, TokKind.String), spans.first())
        assertToken("bash", code, spans, "s", TokKind.Plain)
        assertCoverage(code, spans)
    }

    @Test fun goRawBackticksDoNotEscapeClosingQuote() {
        val code = "`a\\`b`"
        val spans = highlightCode("go", code)
        assertEquals(CodeSpan(0, 4, TokKind.String), spans.first())
        assertToken("go", code, spans, "b", TokKind.Plain)
        assertCoverage(code, spans)
    }

    @Test fun hashCommentsRequireWhitespaceOrLineStart() {
        val code = "\$# \${#arr[@]} url#frag\n# comment\nx # tail"
        listOf("bash", "py", "yaml").forEach { lang ->
            val spans = highlightCode(lang, code)
            assertEquals(2, spans.count { it.kind == TokKind.Comment })
            assertToken(lang, code, spans, "# comment", TokKind.Comment)
            assertToken(lang, code, spans, "# tail", TokKind.Comment)
            assertCoverage(code, spans)
        }
    }

    @Test fun shellAndSqlCommentMarkersInsideStringsStayStrings() {
        listOf("bash" to "#", "sql" to "--").forEach { (lang, marker) ->
            val quoted = "'$marker inside'"
            val code = "$quoted $marker outside"
            val spans = highlightCode(lang, code)
            assertToken(lang, code, spans, quoted, TokKind.String)
            assertToken(lang, code, spans, "$marker outside", TokKind.Comment)
            assertCoverage(code, spans)
        }
    }

    @Test(timeout = 2000) fun manyUnclosedBlockCommentsHaveLinearCoverage() {
        val code = "/* unfinished\n".repeat(2000)
        val spans = highlightCode("kt", code)
        assertEquals(4000, spans.size)
        assertEquals(2000, spans.count { it.kind == TokKind.Comment })
        assertCoverage(code, spans)
    }

    @Test fun numberScanStopsAtLineEnd() {
        val code = "12e\n3\r\n0x\nFF"
        val spans = highlightCode("kt", code)
        listOf("12", "3", "0").forEach { assertToken("kt", code, spans, it, TokKind.Number) }
        assertCoverage(code, spans)
    }

    private fun assertToken(lang: String, code: String, spans: List<CodeSpan>, token: String, kind: TokKind) {
        assertTrue("$lang: expected $kind for $token", spans.any {
            it.kind == kind && code.substring(it.start, it.end) == token
        })
    }

    private fun assertCoverage(code: String, spans: List<CodeSpan>) {
        assertTrue(spans.isNotEmpty())
        var next = 0
        spans.forEach {
            assertEquals("gap or overlap at $next", next, it.start)
            assertTrue(it.end <= code.length)
            assertTrue(it.end > it.start || code.isEmpty())
            next = it.end
        }
        assertEquals(code.length, next)
    }
}
