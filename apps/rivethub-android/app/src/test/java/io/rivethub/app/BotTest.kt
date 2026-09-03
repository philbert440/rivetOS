package io.rivethub.app

import io.rivethub.app.data.BotEdit
import io.rivethub.app.data.SessionMessage
import io.rivethub.app.data.effective
import io.rivethub.app.domain.BlobShape
import io.rivethub.app.domain.Bot
import io.rivethub.app.domain.BotLooks
import io.rivethub.app.ui.mergeTranscript
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

class BotEditTest {
    private val bot = Bot("claude", "ct115", "ct115", "https://192.0.2.10:5174", true)
    private val identity = BotLooks.forAgent("claude")

    @Test fun `name falls back to pretty agent when edit is missing or blank`() {
        assertEquals("Claude", bot.effective(null).displayName)
        assertEquals("Claude", bot.effective(BotEdit()).displayName)
        assertEquals("Claude", bot.effective(BotEdit(name = "  ")).displayName)
    }

    @Test fun `custom name wins and trims`() {
        assertEquals("Desk", bot.effective(BotEdit(name = "  Desk  ")).displayName)
    }

    @Test fun `color and shape fall back to identity look`() {
        val shown = bot.effective(null)
        assertEquals(identity.color, shown.look.color)
        assertEquals(identity.shape, shown.look.shape)
        val partial = bot.effective(BotEdit(color = 0xFF7C5CFF))
        assertEquals(0xFF7C5CFF, partial.look.color)
        assertEquals(identity.shape, partial.look.shape)
    }

    @Test fun `shape name is parsed and unknown values keep the default`() {
        assertEquals(BlobShape.CLOUD, bot.effective(BotEdit(shape = "cloud")).look.shape)
        assertEquals(identity.shape, bot.effective(BotEdit(shape = "not-a-shape")).look.shape)
    }

    @Test fun `clearing the edit is identity`() {
        val edited = bot.effective(BotEdit(name = "Desk", color = 0xFF2F8CFF, shape = "HEX"))
        assertEquals("Desk", edited.displayName)
        assertEquals(0xFF2F8CFF, edited.look.color)
        assertEquals(BlobShape.HEX, edited.look.shape)
        val cleared = bot.effective(null)
        assertEquals(bot.displayName, cleared.displayName)
        assertEquals(identity, cleared.look)
    }

    @Test fun `rename does not change session id or bot id`() {
        val before = bot.defaultSessionId("ab12cd")
        val renamed = bot.effective(BotEdit(name = "Desk"))
        assertEquals("Claude", bot.displayName)
        assertEquals("Desk", renamed.displayName)
        assertEquals("ct115/claude", bot.id)
        assertEquals(before, bot.defaultSessionId("ab12cd"))
        assertFalse(before.contains(':'))
    }
}

class MergeDuplicatesTest {
    @Test fun `identical sends each keep a bubble until their own commit lands`() {
        val a = SessionMessage("local-a", "s", "user", "ok", 10)
        val b = SessionMessage("local-b", "s", "user", "ok", 20)
        val serverOne = listOf(SessionMessage("m1", "s", "user", "ok", 11))
        val merged = mergeTranscript(serverOne, listOf(a, b))
        assertEquals(listOf("m1", "local-b"), merged.map { it.id })
        val serverBoth = serverOne + SessionMessage("m2", "s", "user", "ok", 21)
        assertEquals(listOf("m1", "m2"), mergeTranscript(serverBoth, merged).map { it.id })
    }

    @Test fun `a committed live row does not claim a later identical promoted reply`() {
        // The WS commit handler drops a promoted twin at commit time; one that still
        // coexists with its committed twin is a second identical reply and must stay.
        val committed = SessionMessage("m1", "s", "assistant", "yo", 20)
        val promoted = SessionMessage("stream-1", "s", "assistant", "yo", 30)
        val merged = mergeTranscript(listOf(committed), listOf(committed, promoted))
        assertEquals(listOf("m1", "stream-1"), merged.map { it.id })
    }

    @Test fun `a promoted reply is claimed by its commit arriving via refetch`() {
        val promoted = SessionMessage("stream-1", "s", "assistant", "yo", 30)
        val server = listOf(SessionMessage("m1", "s", "assistant", "yo", 29))
        assertEquals(listOf("m1"), mergeTranscript(server, listOf(promoted)).map { it.id })
    }
}
