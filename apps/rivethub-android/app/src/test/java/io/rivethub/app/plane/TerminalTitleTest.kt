package io.rivethub.app.plane

import io.rivethub.app.gateway.ModelOption
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalTitleTest {
    @Test
    fun `program title replaces model and conversation`() {
        assertEquals(
            "vim",
            terminalTitle("Opus", "Claude Code", "planning", "vim", TermStatus.Attached, false, "session"),
        )
    }

    @Test
    fun `blank program title falls through to model and conversation`() {
        assertEquals(
            "Opus · planning",
            terminalTitle("Opus", "Claude Code", "planning", "  ", TermStatus.Attached, false, "session"),
        )
        assertEquals(
            "Opus · planning",
            terminalTitle("Opus", "Claude Code", "planning", null, TermStatus.Connecting, false, "session"),
        )
    }

    @Test
    fun `model wins over harness`() {
        assertEquals(
            "Opus · planning",
            terminalTitle("Opus", "Claude Code", "planning", null, TermStatus.Closed, false, "session"),
        )
    }

    @Test
    fun `harness is used when the model label is blank`() {
        assertEquals(
            "Claude Code · planning",
            terminalTitle("  ", "Claude Code", "planning", null, TermStatus.Attached, false, "session"),
        )
        assertEquals(
            "Claude Code · planning",
            terminalTitle(null, "Claude Code", "planning", null, TermStatus.Attached, false, "session"),
        )
    }

    @Test
    fun `both labels blank skips the model part`() {
        assertEquals(
            "planning",
            terminalTitle(null, null, "planning", null, TermStatus.Attached, false, "session"),
        )
        assertEquals(
            "planning",
            terminalTitle("", "  ", "planning", null, TermStatus.Attached, false, "session"),
        )
    }

    @Test
    fun `blank conversation uses the untitled placeholder`() {
        assertEquals(
            "Opus · session",
            terminalTitle("Opus", "Claude Code", "", null, TermStatus.Attached, false, "session"),
        )
        assertEquals(
            "session",
            terminalTitle(null, null, "   ", null, TermStatus.Attached, false, "session"),
        )
    }

    @Test
    fun `exited appends ended`() {
        assertEquals(
            "Opus · planning (ended)",
            terminalTitle("Opus", null, "planning", null, TermStatus.Exited, false, "session"),
        )
        assertEquals(
            "vim (ended)",
            terminalTitle("Opus", null, "planning", "vim", TermStatus.Exited, false, "session"),
        )
    }

    @Test
    fun `running statuses do not append ended`() {
        for (status in listOf(TermStatus.Closed, TermStatus.Connecting, TermStatus.Attached)) {
            assertEquals(
                "Opus · planning",
                terminalTitle("Opus", null, "planning", null, status, false, "session"),
            )
        }
    }

    @Test
    fun `remote appends after ended`() {
        assertEquals(
            "Opus · planning · remote",
            terminalTitle("Opus", null, "planning", null, TermStatus.Attached, true, "session"),
        )
        assertEquals(
            "vim (ended) · remote",
            terminalTitle("Opus", null, "planning", "vim", TermStatus.Exited, true, "session"),
        )
        assertEquals(
            "planning (ended) · remote",
            terminalTitle(null, null, "planning", null, TermStatus.Exited, true, "session"),
        )
    }

    @Test
    fun `model display label prefers the sheet label`() {
        val sheet = HarnessSheet(
            models = listOf(ModelOption("opus", "Opus"), ModelOption("blank", "  ")),
        )
        assertEquals("Opus", modelDisplayLabel(sheet, "opus"))
        assertEquals("blank", modelDisplayLabel(sheet, "blank"))
        assertEquals("unknown", modelDisplayLabel(sheet, "unknown"))
        assertEquals("opus", modelDisplayLabel(null, "opus"))
        assertNull(modelDisplayLabel(sheet, ""))
        assertNull(modelDisplayLabel(null, "  "))
    }

    @Test
    fun `remote compares the session node with the entry url`() {
        assertFalse(terminalNodeIsRemote("https://192.0.2.10:5174", "https://192.0.2.10:5174/"))
        assertFalse(terminalNodeIsRemote("https://192.0.2.10:5174", ""))
        assertFalse(terminalNodeIsRemote("", "https://192.0.2.10:5174"))
        assertTrue(terminalNodeIsRemote("https://192.0.2.11:5174", "https://192.0.2.10:5174"))
    }
}
