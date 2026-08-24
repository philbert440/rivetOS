package dev.rivetos.bots

import dev.rivetos.bots.data.SessionMessage
import dev.rivetos.bots.domain.BlobShape
import dev.rivetos.bots.domain.Bot
import dev.rivetos.bots.domain.BotLooks
import dev.rivetos.bots.ui.mergeTranscript
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class BotTest {
    private val bot = Bot("Claude Code", "CT 115", "ct115", "https://192.0.2.10:5174", true)

    @Test fun `session ids are slugged and colon-free`() {
        val id = bot.defaultSessionId("ab12cd")
        assertEquals("rivetbots-ab12cd-ct-115-claude-code", id)
        assertFalse(id.contains(':'))
    }

    @Test fun `default-agent bots send no agent and read as Agent`() {
        val b = Bot(Bot.DEFAULT_AGENT, "n", "n", "https://192.0.2.10:5174", true)
        assertNull(b.sendAgent); assertEquals("Agent", b.displayName)
        assertEquals("claude", Bot("claude", "n", "n", "", true).sendAgent)
    }

    @Test fun `looks are stable per agent`() {
        assertEquals(BlobShape.EGG, BotLooks.forAgent("claude").shape)
        assertEquals(BotLooks.forAgent("mystery"), BotLooks.forAgent("mystery"))
    }

    @Test fun `merge drops optimistic twins and keeps unseen live rows`() {
        val local = SessionMessage("local-1", "s", "user", "hi", 10)
        val promoted = SessionMessage("stream-1", "s", "assistant", "yo", 30)
        val liveOnly = SessionMessage("m9", "s", "assistant", "later", 40)
        val server = listOf(SessionMessage("m1", "s", "user", "hi", 11), SessionMessage("m2", "s", "assistant", "yo", 20))
        val merged = mergeTranscript(server, listOf(local, promoted, liveOnly))
        assertEquals(listOf("m1", "m2", "m9"), merged.map { it.id })
    }
}
