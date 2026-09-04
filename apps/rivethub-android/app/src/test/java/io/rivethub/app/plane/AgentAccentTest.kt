package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AgentAccentTest {
    @Test
    fun `preset hex wins`() {
        assertEquals("#3b82f6", accentFor("#3b82f6", "claude-code", "claude"))
        assertEquals("#ABC", accentFor("#ABC", "grok-build", "grok"))
    }

    @Test
    fun `invalid preset falls through to harness`() {
        assertEquals(ACCENT_CLAUDE, accentFor("blue", "claude-code", null))
        assertEquals(ACCENT_CLAUDE, accentFor("#gggggg", "claude-code", null))
        assertEquals(ACCENT_CLAUDE, accentFor("", "claude-code", null))
    }

    @Test
    fun `claude clay and grok grey and local emerald`() {
        assertEquals(ACCENT_CLAUDE, harnessAccentHex("claude-code", null))
        assertEquals(ACCENT_GROK, harnessAccentHex("grok-build", null))
        assertEquals(ACCENT_LOCAL, harnessAccentHex("hermes", null))
        assertEquals(ACCENT_CLAUDE, harnessAccentHex(null, "claude"))
        assertEquals(ACCENT_GROK, harnessAccentHex("grok-build", "claude"))
    }

    @Test
    fun `same inputs match on agent and conversation surfaces`() {
        val a = accentFor("#CC785C", "claude-code", "claude")
        val b = accentFor("#CC785C", "claude-code", "claude")
        assertEquals(a, b)
        assertEquals(
            accentFor(null, "grok-build", "grok"),
            harnessAccentHex("grok-build", "grok"),
        )
    }

    @Test
    fun `drawer and conversation dots match for the same agent`() {
        val harnessId = "grok-build"
        val model = "claude-opus"
        val sessionCommand = "claude"
        val drawer = accentForDrawer(null, harnessId, model)
        val convo = accentForConversation(null, harnessId, sessionCommand)
        assertEquals(drawer, convo)
        assertEquals(ACCENT_GROK, drawer)
        assertEquals(
            accentForDrawer("#3b82f6", harnessId, model),
            accentForConversation("#3b82f6", harnessId, sessionCommand),
        )
    }

    @Test
    fun `parseAccentArgb reads 3 and 6 digit hex`() {
        assertEquals(0xFFAABBCCL, parseAccentArgb("#abc"))
        assertEquals(0xFFCC785CL, parseAccentArgb("#CC785C"))
        assertNull(parseAccentArgb("cc785c"))
        assertNull(parseAccentArgb("#ffff"))
    }
}
