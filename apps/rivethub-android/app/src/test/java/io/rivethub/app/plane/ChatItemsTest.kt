package io.rivethub.app.plane

import io.rivethub.app.gateway.HarnessCapabilities
import io.rivethub.app.gateway.HarnessDescriptor
import io.rivethub.app.gateway.HarnessSessionSummary
import io.rivethub.app.gateway.LegacyHarnessSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatItemsTest {
    private val uuidA = "a1b2c3d4-1111-4222-8333-444455556666"
    private val uuidB = "b2c3d4e5-2222-4333-8444-555566667777"
    private val uuidC = "c3d4e5f6-3333-4444-8555-666677778888"

    private val claude = HarnessDescriptor(
        "claude-code",
        HarnessCapabilities(interrupt = true, resume = true, liveStream = true, listSessions = true),
    )

    private fun summary(
        native: String,
        harnessId: String = "claude-code",
        title: String? = null,
        updatedAt: String = "2026-08-08T00:05:00.000Z",
        status: String = "idle",
        model: String? = null,
    ) = HarnessSessionSummary(
        sessionId = "$harnessId:$native",
        harnessId = harnessId,
        title = title,
        createdAt = "2026-08-08T00:00:00.000Z",
        updatedAt = updatedAt,
        status = status,
        model = model,
    )

    private fun legacy(id: String, command: String, updatedAt: Long, title: String = "stored") =
        LegacyHarnessSession(id, command, title, updatedAt)

    @Test fun `plane beats legacy on the same native id`() {
        val items = chatItems(
            mapOf("claude-code" to Result.success(listOf(summary(uuidA, title = "plane title")))),
            listOf(legacy(uuidA, "claude", 1_000, "store title")),
        )
        assertEquals(1, items.size)
        assertEquals("claude-code:$uuidA", items[0].key)
        assertEquals(ChatItemKind.HARNESS, items[0].kind)
        assertEquals("plane title", items[0].title)
        assertEquals("claude", items[0].command)
        assertEquals("idle", items[0].status)
    }

    @Test fun `a failing driver keeps other drivers rows`() {
        val plane: Map<String, Result<List<HarnessSessionSummary>>> = mapOf(
            "claude-code" to Result.success(listOf(summary(uuidA))),
            "hermes" to Result.failure(Exception("store unreadable")),
        )
        val items = chatItems(plane, listOf(legacy(uuidB, "hermes", 2_000)))
        assertEquals(setOf("claude-code:$uuidA", uuidB), items.map { it.key }.toSet())
        assertEquals(ChatItemKind.LEGACY, items.find { it.key == uuidB }!!.kind)
        assertEquals(ChatItemKind.HARNESS, items.find { it.key == "claude-code:$uuidA" }!!.kind)
    }

    @Test fun `failing every driver still shows the legacy scan`() {
        val plane: Map<String, Result<List<HarnessSessionSummary>>> = mapOf(
            "claude-code" to Result.failure(Exception("down")),
        )
        val items = chatItems(plane, listOf(legacy(uuidA, "claude", 1)))
        assertEquals(1, items.size)
        assertEquals(ChatItemKind.LEGACY, items[0].kind)
    }

    @Test fun `copies summary model onto the chat item`() {
        val items = chatItems(
            mapOf("claude-code" to Result.success(listOf(summary(uuidA, model = "fable")))),
            emptyList(),
        )
        assertEquals("fable", items[0].model)
    }

    @Test fun `legacy-only harnesses stay bare`() {
        val items = chatItems(
            mapOf("claude-code" to Result.success(listOf(summary(uuidA)))),
            listOf(legacy(uuidB, "grok", 2_000), legacy(uuidC, "hermes", 1_000)),
        )
        // Newest-first (web harness-chat.test.ts): plane ISO stamp beats the
        // epoch-ms legacy rows, so the claimed row leads; grok/hermes stay bare.
        assertEquals(
            listOf(
                "claude-code:$uuidA" to ChatItemKind.HARNESS,
                uuidB to ChatItemKind.LEGACY,
                uuidC to ChatItemKind.LEGACY,
            ),
            items.map { it.key to it.kind },
        )
        assertNull(items.find { it.key == uuidB }!!.sessionId)
    }

    @Test fun `draft drops once the plane claims its native id`() {
        val items = chatItems(
            mapOf("claude-code" to Result.success(listOf(summary(uuidC)))),
            emptyList(),
            drafts = listOf(uuidC),
        )
        assertEquals(listOf(ChatItemKind.HARNESS), items.map { it.kind })
    }

    @Test fun `skips unparseable plane ids and falls back to native title`() {
        val bad = summary(uuidB).copy(sessionId = "not-a-session-id")
        val items = chatItems(
            mapOf("claude-code" to Result.success(listOf(summary(uuidA), bad))),
            emptyList(),
        )
        assertEquals(1, items.size)
        assertEquals(uuidA, items[0].title)
    }

    @Test fun `recency with pins mingled in one order`() {
        val items = listOf(
            ChatItem("a", ChatItemKind.LEGACY, "a", updatedAt = 1),
            ChatItem("b", ChatItemKind.LEGACY, "b", updatedAt = 5),
        )
        val pins = listOf(ChatItem("p", ChatItemKind.DRAFT, "pin", updatedAt = 3))
        assertEquals(listOf("b", "p", "a"), sortByRecency(items, pins).map { it.key })
        assertTrue(sortByRecency(items, pins).find { it.key == "p" }!!.pin)
    }

    @Test fun `existing row is not duplicated when a pin matches`() {
        val items = listOf(ChatItem("a", ChatItemKind.HARNESS, "a", updatedAt = 9))
        val pins = listOf(ChatItem("a", ChatItemKind.DRAFT, "pin", updatedAt = 1, model = "fable", harnessId = "claude-code"))
        val out = sortByRecency(items, pins)
        assertEquals(1, out.size)
        assertFalse(out[0].pin)
        assertEquals(9L, out[0].updatedAt)
        assertEquals("a", out[0].title)
        assertEquals("fable", out[0].model)
        assertEquals("claude-code", out[0].harnessId)
    }

    @Test fun `matched harness row is not pin true`() {
        val items = listOf(
            ChatItem("a", ChatItemKind.HARNESS, "live", sessionId = "a", harnessId = "hermes", updatedAt = 9),
        )
        val pins = listOf(ChatItem("a", ChatItemKind.HARNESS, "pin title", updatedAt = 1))
        val out = sortByRecency(items, pins)
        assertEquals(1, out.size)
        assertFalse(out[0].pin)
        assertEquals("live", out[0].title)
    }

    @Test fun `draft whose key is a pin is dropped so the pin supplies title`() {
        val items = listOf(ChatItem("a", ChatItemKind.DRAFT, "new conversation", updatedAt = 0))
        val pins = listOf(ChatItem("a", ChatItemKind.DRAFT, "Hermes", updatedAt = 5))
        val out = sortByRecency(items, pins)
        assertEquals(1, out.size)
        assertTrue(out[0].pin)
        assertEquals("Hermes", out[0].title)
        assertEquals(5L, out[0].updatedAt)
    }

    @Test fun `parseIsoMillis accepts offset timestamps`() {
        assertTrue(parseIsoMillis("2026-08-08T00:05:00.000Z") > 0L)
        val offset = parseIsoMillis("2026-08-08T02:05:00.000+02:00")
        val zulu = parseIsoMillis("2026-08-08T00:05:00.000Z")
        assertEquals(zulu, offset)
        assertEquals(0L, parseIsoMillis("not-a-date"))
    }

    @Test fun `sortByRecency newest first and stable on ties`() {
        val tied = listOf(
            ChatItem("a", ChatItemKind.LEGACY, "a", updatedAt = 2),
            ChatItem("b", ChatItemKind.LEGACY, "b", updatedAt = 2),
            ChatItem("c", ChatItemKind.LEGACY, "c", updatedAt = 1),
        )
        assertEquals(listOf("a", "b", "c"), sortByRecency(tied).map { it.key })
        val zero = listOf(
            ChatItem("zero", ChatItemKind.DRAFT, "z", updatedAt = 0),
            ChatItem("old", ChatItemKind.LEGACY, "o", updatedAt = 1),
            ChatItem("new", ChatItemKind.LEGACY, "n", updatedAt = 9),
        )
        assertEquals(listOf("new", "old", "zero"), sortByRecency(zero).map { it.key })
    }

    @Test fun `harnessGate opens only for a driver-owned registered row`() {
        val item = ChatItem(
            key = "claude-code:$uuidA",
            kind = ChatItemKind.HARNESS,
            title = "t",
            sessionId = "claude-code:$uuidA",
            harnessId = "claude-code",
        )
        val open = harnessGate(item, listOf(claude))
        assertTrue(open.bound)
        assertTrue(open.stream)
        assertTrue(open.canInterrupt)
        assertFalse(open.canApprove)
        assertTrue(open.canResume)
        assertFalse(harnessGate(item, emptyList()).bound)
        assertFalse(harnessGate(item, null).bound)
        assertFalse(harnessGate(ChatItem("x", ChatItemKind.LEGACY, "x"), listOf(claude)).bound)
        assertFalse(harnessGate(null, listOf(claude)).bound)
    }

    @Test fun `harnessGate mirrors false flags`() {
        val bare = HarnessDescriptor(
            "claude-code",
            HarnessCapabilities(listSessions = true),
        )
        val item = ChatItem(
            "claude-code:$uuidA", ChatItemKind.HARNESS, "t",
            sessionId = "claude-code:$uuidA", harnessId = "claude-code",
        )
        assertEquals(
            HarnessGate(bound = true, stream = false, canInterrupt = false, canApprove = false, canResume = false),
            harnessGate(item, listOf(bare)),
        )
    }

    @Test fun `listableHarnesses skips drivers that cannot list`() {
        assertEquals(
            emptyList<String>(),
            listableHarnesses(listOf(claude.copy(capabilities = claude.capabilities.copy(listSessions = false)))),
        )
        assertEquals(listOf("claude-code"), listableHarnesses(listOf(claude)))
    }

    @Test fun `findChatItem matches canonical then native`() {
        val items = chatItems(
            mapOf("claude-code" to Result.success(listOf(summary(uuidA)))),
            listOf(legacy(uuidB, "grok", 1_000)),
            drafts = listOf(uuidC),
        )
        assertEquals(ChatItemKind.HARNESS, findChatItem(items, "claude-code:$uuidA")?.kind)
        assertEquals("claude-code:$uuidA", findChatItem(items, uuidA)?.key)
        assertEquals(ChatItemKind.LEGACY, findChatItem(items, uuidB)?.kind)
        assertNull(findChatItem(items, "nope"))
        assertNull(findChatItem(items, null))
    }
}
