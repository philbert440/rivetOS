package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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
    fun `every known harness id maps to a distinct colour`() {
        val ids = listOf(
            "claude-code",
            "grok-build",
            "codex",
            "kimi-code",
            "hermes",
            "opencode",
            "pi",
        )
        val expected = mapOf(
            "claude-code" to ACCENT_CLAUDE,
            "grok-build" to ACCENT_GROK,
            "codex" to ACCENT_CODEX,
            "kimi-code" to ACCENT_KIMI,
            "hermes" to ACCENT_HERMES,
            "opencode" to ACCENT_OPENCODE,
            "pi" to ACCENT_PI,
        )
        val colors = ids.map { harnessAccentHex(it, null) }
        assertEquals(ids.size, colors.toSet().size)
        for (id in ids) {
            assertEquals(expected[id], harnessAccentHex(id, null))
        }
        assertEquals(ACCENT_LOCAL, harnessAccentHex("unknown-bot", null))
        assertEquals(ACCENT_LOCAL, harnessAccentHex("deepseek-harness", null))
        assertTrue(ACCENT_LOCAL !in colors)
    }

    @Test
    fun `claude clay and grok grey and roster aliases`() {
        assertEquals(ACCENT_CLAUDE, harnessAccentHex("claude-code", null))
        assertEquals(ACCENT_GROK, harnessAccentHex("grok-build", null))
        assertEquals(ACCENT_HERMES, harnessAccentHex("hermes", null))
        assertEquals(ACCENT_CLAUDE, harnessAccentHex(null, "claude"))
        assertEquals(ACCENT_GROK, harnessAccentHex("grok-build", "claude"))
        assertEquals(ACCENT_KIMI, harnessAccentHex(null, "kimi"))
    }

    @Test
    fun `codex accent is distinct`() {
        assertEquals(ACCENT_CODEX, harnessAccentHex("codex", null))
        assertEquals(ACCENT_CODEX, harnessAccentHex(null, "codex"))
        assertEquals(ACCENT_CODEX, accentFor(null, "codex", null))
        assertTrue(ACCENT_CODEX != ACCENT_CLAUDE)
        assertTrue(ACCENT_CODEX != ACCENT_GROK)
        assertTrue(ACCENT_CODEX != ACCENT_LOCAL)
    }

    @Test
    fun `opencode accent is distinct`() {
        assertEquals(ACCENT_OPENCODE, harnessAccentHex("opencode", null))
        assertEquals(ACCENT_OPENCODE, harnessAccentHex(null, "opencode"))
        assertEquals(ACCENT_OPENCODE, harnessAccentHex("opencode-cli", null))
        assertEquals(ACCENT_LOCAL, harnessAccentHex("opencode-migration-helper", null))
        assertEquals(ACCENT_OPENCODE, accentFor(null, "opencode", null))
        assertTrue(ACCENT_OPENCODE != ACCENT_CLAUDE)
        assertTrue(ACCENT_OPENCODE != ACCENT_GROK)
        assertTrue(ACCENT_OPENCODE != ACCENT_CODEX)
        assertTrue(ACCENT_OPENCODE != ACCENT_LOCAL)
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
    fun `short keys do not match inside free-form agent names`() {
        assertEquals(ACCENT_LOCAL, harnessAccentHex("gippity", null))
        assertEquals(ACCENT_LOCAL, harnessAccentHex("copilot", null))
        assertEquals(ACCENT_LOCAL, harnessAccentHex("pixtral", null))
        assertEquals(ACCENT_LOCAL, harnessAccentHex(null, "gippity"))
        assertEquals(ACCENT_LOCAL, harnessAccentHex(null, "copilot"))
        assertEquals(ACCENT_LOCAL, harnessAccentHex(null, "pixtral"))
    }

    @Test
    fun `delimited tokens and cli aliases keep their colours`() {
        assertEquals(ACCENT_PI, harnessAccentHex("pi", null))
        assertEquals(ACCENT_PI, harnessAccentHex("pi-cli", null))
        assertEquals(ACCENT_OPENCODE, harnessAccentHex("opencode", null))
        assertEquals(ACCENT_KIMI, harnessAccentHex("rivet-kimi", null))
        assertEquals(ACCENT_PI, harnessAccentHex(null, "pi-cli"))
        assertEquals(ACCENT_KIMI, harnessAccentHex(null, "rivet-kimi"))
    }

    @Test
    fun `parseAccentArgb reads 3 and 6 digit hex`() {
        assertEquals(0xFFAABBCCL, parseAccentArgb("#abc"))
        assertEquals(0xFFCC785CL, parseAccentArgb("#CC785C"))
        assertNull(parseAccentArgb("cc785c"))
        assertNull(parseAccentArgb("#ffff"))
    }
}
