package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TitleBlockTest {
    private val context = contextBarView(50_202, "claude", emptyList())!!

    @Test fun `all identity and context combinations skip missing parts`() {
        for (agent in listOf(null, "Agent")) {
            for (model in listOf(null, "Model")) {
                for (harness in listOf(null, "Harness")) {
                    for (meter in listOf(null, context)) {
                        val identity = when {
                            agent != null && model != null -> "Agent / Model"
                            agent != null && harness != null -> "Agent / Harness"
                            agent != null -> "Agent"
                            model != null -> "Model"
                            harness != null -> "Harness"
                            else -> ""
                        }
                        val expected = when {
                            meter == null -> identity
                            identity.isEmpty() -> "50.2k/30%"
                            else -> "$identity · 50.2k/30%"
                        }
                        val block = titleBlock("Title", false, agent, model, harness, meter, "New chat")
                        assertEquals("Title", block.line1)
                        assertEquals(expected, block.line2)
                    }
                }
            }
        }
    }

    @Test fun `blank parts are skipped and blank or null model falls back to harness`() {
        assertEquals("", titleBlock("Title", false, " ", "", "\t", null, "New chat").line2)
        assertEquals("Harness", titleBlock("Title", false, "", " ", "Harness", null, "New chat").line2)
        assertEquals("Harness", titleBlock("Title", false, "", null, "Harness", null, "New chat").line2)
        assertEquals("Agent / Model", titleBlock("Title", false, " Agent ", " Model ", "H", null, "New chat").line2)
        assertEquals("50.2k/30%", titleBlock("Title", false, "", null, " ", context, "New chat").line2)
    }

    @Test fun `blank titles use localized new chat label including drafts`() {
        assertEquals("New chat", titleBlock(" ", true, null, null, null, null, "New chat").line1)
        assertEquals("Localized", titleBlock("", false, null, null, null, null, "Localized").line1)
        assertEquals("New chat", titleBlock("Named", true, null, null, null, null, "New chat").line1)
    }

    @Test fun `rename requires a nondraft with turns`() {
        assertFalse(renameAllowed(true, 0))
        assertFalse(renameAllowed(true, 1))
        assertFalse(renameAllowed(false, 0))
        assertTrue(renameAllowed(false, 1))
    }

    @Test fun `compact label uses fixed decimal thousands and meter percentage`() {
        assertEquals("50.2k/30%", context.compactLabel())
        assertEquals("0.5k/1%", context.copy(tokens = 500, pct = 1).compactLabel())
    }
}
