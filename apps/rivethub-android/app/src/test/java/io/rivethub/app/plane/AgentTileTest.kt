package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Expected values are the web's (`lib/agent-accent.ts` agentInitials / inkOn / sameLabel). */
class AgentTileTest {
    @Test fun `initials take the first letter of the first two words`() {
        assertEquals("GS", agentInitials("grok scout"))
        assertEquals("R", agentInitials("reviewer"))
        assertEquals("CC", agentInitials("claude-code"))
        assertEquals("AB", agentInitials("a.b_c"))
        assertEquals("ÜB", agentInitials("ünïcode bot"))
        assertEquals("?", agentInitials("  "))
        assertEquals("?", agentInitials("-- __"))
    }

    @Test fun `tile ink is dark on bright accents and white on dark ones`() {
        assertEquals(TILE_INK_DARK, tileInkOn(0xFF34D399L))
        assertEquals(TILE_INK_DARK, tileInkOn(0xFFCC785CL))
        assertEquals(TILE_INK_DARK, tileInkOn(0xFF5B8DEFL))
        assertEquals(TILE_INK_LIGHT, tileInkOn(0xFF111111L))
        assertEquals(TILE_INK_DARK, tileInkOn(0xFFFFFFFFL))
    }

    @Test fun `labels match ignoring case, spaces, dashes and underscores`() {
        assertTrue(sameLabel("Claude Code", "claude-code"))
        assertTrue(sameLabel("grok_build", "Grok Build"))
        assertFalse(sameLabel("Reviewer", "claude-code"))
    }
}
