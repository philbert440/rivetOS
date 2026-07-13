package dev.rivet.app.ui.pages.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TerminalEscalateTest {

    private val conv = "f594456b-a75c-46d6-a598-baa1b1805795"

    @Test
    fun `roster keys accept local and den model ids`() {
        assertEquals("claude", TerminalEscalate.rosterKeyForModel("rivet-claude"))
        assertEquals("claude", TerminalEscalate.rosterKeyForModel("claude"))
        assertEquals("grok", TerminalEscalate.rosterKeyForModel("rivet-grok"))
        assertEquals("grok", TerminalEscalate.rosterKeyForModel("grok"))
        assertEquals("grok", TerminalEscalate.rosterKeyForModel("grok-fast"))
        assertEquals("hermes", TerminalEscalate.rosterKeyForModel("hermes"))
        assertNull(TerminalEscalate.rosterKeyForModel("gpt-4o"))
    }

    @Test
    fun `no turns always opens shell`() {
        assertEquals(
            listOf("/bin/bash", "-l"),
            TerminalEscalate.launchCommand("grok", conv, hasTurns = false, isLocalNode = false),
        )
    }

    @Test
    fun `remote grok resumes conversation join key`() {
        assertEquals(
            listOf("grok", "--resume", conv),
            TerminalEscalate.launchCommand(
                modelId = "grok",
                conversationId = conv,
                hasTurns = true,
                isLocalNode = false,
            ),
        )
        // den model aliases
        assertEquals(
            listOf("grok", "--resume", conv),
            TerminalEscalate.launchCommand("grok-fast", conv, true, false),
        )
    }

    @Test
    fun `remote claude resumes conversation join key`() {
        assertEquals(
            listOf("claude", "--resume", conv, "--dangerously-skip-permissions"),
            TerminalEscalate.launchCommand("claude", conv, true, false),
        )
        assertEquals(
            listOf("claude", "--resume", conv, "--dangerously-skip-permissions"),
            TerminalEscalate.launchCommand("rivet-claude", conv, true, false),
        )
    }

    @Test
    fun `local grok prefers bridge-captured session id`() {
        assertEquals(
            listOf("grok", "--resume", "native-sid-1"),
            TerminalEscalate.launchCommand(
                modelId = "rivet-grok",
                conversationId = conv,
                hasTurns = true,
                isLocalNode = true,
                localGrokSessionId = "native-sid-1",
            ),
        )
        assertEquals(
            listOf("grok"),
            TerminalEscalate.launchCommand(
                modelId = "rivet-grok",
                conversationId = conv,
                hasTurns = true,
                isLocalNode = true,
                localGrokSessionId = null,
            ),
        )
    }

    @Test
    fun `spawnRequest maps resume into den session fields`() {
        val launch = TerminalEscalate.launchCommand("grok", conv, true, false)
        val req = DenTermClient.spawnRequestFor(launch, conv)
        assertEquals("grok", req.command)
        assertEquals(conv, req.session)
        assertEquals(conv, req.resume)
    }
}
