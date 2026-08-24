package dev.rivetos.bots

import dev.rivetos.bots.data.splitHermesReasoning
import dev.rivetos.bots.data.visibleAssistantText
import org.junit.Assert.assertEquals
import org.junit.Test

class HermesReasoningTest {
    private val header =
        "┌─ Reasoning ──────────────────────────────────────────────────────────────────────────────────────┐"
    private val footer =
        "└──────────────────────────────────────────────────────────────────────────────────────────────────┘"

    @Test fun `normal reply is untouched`() {
        val s = splitHermesReasoning("The parser is in src/parse.ts.")
        assertEquals("", s.reasoning)
        assertEquals("The parser is in src/parse.ts.", s.text)
    }

    @Test fun `tui box is stripped from the reply`() {
        val raw = listOf(header, "│ The user wants the leak fixed.", footer, "", "Fixed.").joinToString("\n")
        val s = splitHermesReasoning(raw)
        assertEquals("The user wants the leak fixed.", s.reasoning)
        assertEquals("Fixed.", s.text)
        assertEquals("Fixed.", visibleAssistantText(raw))
    }

    @Test fun `box-only payload has no visible text`() {
        val raw = listOf(header, "│ only thinking", footer).joinToString("\n")
        assertEquals("", visibleAssistantText(raw))
    }
}
