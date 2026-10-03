package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionModeTest {
    @Test fun `blank and unknown persist as Chat`() {
        assertEquals(SessionMode.Chat, parseSessionMode(null))
        assertEquals(SessionMode.Chat, parseSessionMode(""))
        assertEquals(SessionMode.Chat, parseSessionMode("den"))
        assertEquals(SessionMode.Chat, parseSessionMode("CHAT"))
    }

    @Test fun `terminal is case-insensitive`() {
        assertEquals(SessionMode.Terminal, parseSessionMode("terminal"))
        assertEquals(SessionMode.Terminal, parseSessionMode(" Terminal "))
    }

    @Test fun `persist round-trips`() {
        assertEquals(MODE_CHAT, persistSessionMode(SessionMode.Chat))
        assertEquals(MODE_TERMINAL, persistSessionMode(SessionMode.Terminal))
        assertEquals(SessionMode.Terminal, parseSessionMode(persistSessionMode(SessionMode.Terminal)))
    }

    @Test fun `rekey copies the mode onto the canonical id`() {
        val next = rekeySessionModes(mapOf("draft" to MODE_TERMINAL), "draft", "claude-code:draft")
        assertEquals(MODE_TERMINAL, next["claude-code:draft"])
        assertEquals(null, next["draft"])
    }

    @Test fun `rekey does not overwrite an existing canonical mode`() {
        val modes = mapOf("draft" to MODE_TERMINAL, "claude-code:draft" to MODE_CHAT)
        val next = rekeySessionModes(modes, "draft", "claude-code:draft")
        assertEquals(MODE_CHAT, next["claude-code:draft"])
        assertEquals(null, next["draft"])
    }

    @Test fun `rekey no-op on empty or identical ids`() {
        val modes = mapOf("a" to MODE_CHAT)
        assertSame(modes, rekeySessionModes(modes, "", "b"))
        assertSame(modes, rekeySessionModes(modes, "a", "a"))
    }

    @Test fun `default view is Chat unless terminal was picked`() {
        assertEquals(SessionMode.Chat, parseDefaultView(null))
        assertEquals(SessionMode.Chat, parseDefaultView("chat"))
        assertEquals(SessionMode.Chat, parseDefaultView("bogus"))
        assertEquals(SessionMode.Terminal, parseDefaultView("terminal"))
    }

    @Test fun `an upgrade with no default view saved keeps conversations on Chat`() {
        assertEquals(SessionMode.Chat, resolveSessionMode(null, parseDefaultView(null), terminalOnly = false))
    }

    @Test fun `a conversation never switched opens on the default view`() {
        assertEquals(SessionMode.Terminal, resolveSessionMode(null, SessionMode.Terminal, terminalOnly = false))
        assertEquals(SessionMode.Chat, resolveSessionMode("", SessionMode.Chat, terminalOnly = false))
    }

    @Test fun `this conversation's own switch wins over everything`() {
        assertEquals(SessionMode.Chat, resolveSessionMode("chat", SessionMode.Terminal, terminalOnly = false))
        assertEquals(SessionMode.Terminal, resolveSessionMode("terminal", SessionMode.Chat, terminalOnly = false))
        assertEquals(SessionMode.Chat, resolveSessionMode("chat", SessionMode.Terminal, terminalOnly = true))
    }

    @Test fun `a session id naming no known harness is terminal-only, and opens there even on Chat`() {
        val known = setOf("claude-code", "codex")
        assertEquals("claude-code", harnessFromSessionId("claude-code:abc", known))
        assertEquals(null, harnessFromSessionId("legacy-thing:abc", known))
        assertEquals(null, harnessFromSessionId(":abc", known))
        assertEquals(null, harnessFromSessionId("no-prefix", known))
        val legacy = opensTerminalOnly(draft = false, harnessId = harnessFromSessionId("legacy-thing:abc", known))
        assertTrue(legacy)
        assertEquals(SessionMode.Terminal, resolveSessionMode(null, SessionMode.Chat, terminalOnly = legacy))
        // A draft has not picked its harness yet: never terminal-only.
        assertEquals(false, opensTerminalOnly(draft = true, harnessId = null))
    }

    @Test fun `a terminal-only session opens on Terminal whatever the default`() {
        assertEquals(SessionMode.Terminal, resolveSessionMode(null, SessionMode.Chat, terminalOnly = true))
    }

    @Test fun `only an explicit Terminal or Chat choice writes sessionModes`() {
        assertTrue(shouldPersistSessionMode(explicit = true))
        assertEquals(false, shouldPersistSessionMode(explicit = false))
    }

    @Test fun `Back must not invent a chat entry over an explicit Terminal or terminal-only row`() {
        // Explicit Terminal stays Terminal when Back leaves without writing.
        assertEquals(
            SessionMode.Terminal,
            resolveSessionMode("terminal", SessionMode.Chat, terminalOnly = false),
        )
        // A wrongly persisted "chat" would beat terminal-only on the next open.
        assertEquals(
            SessionMode.Chat,
            resolveSessionMode("chat", SessionMode.Chat, terminalOnly = true),
        )
        assertEquals(
            SessionMode.Terminal,
            resolveSessionMode(null, SessionMode.Chat, terminalOnly = true),
        )
    }
}
