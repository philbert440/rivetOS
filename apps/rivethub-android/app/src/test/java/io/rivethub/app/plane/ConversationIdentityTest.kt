package io.rivethub.app.plane

import io.rivethub.app.gateway.HarnessSessionSummary
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationIdentityTest {
    private val nodeA = "https://192.0.2.10:5174"
    private val uuid = "a1b2c3d4-1111-4222-8333-444455556666"
    private val canonical = "claude-code:$uuid"
    private val rotated = "claude-code:b2c3d4e5-2222-4333-8444-555566667777"
    private val zone = ZoneId.of("Europe/Berlin")
    private val now = LocalDateTime.of(2026, 9, 25, 10, 0).atZone(zone).toInstant().toEpochMilli()
    private val labels = SectionLabels(
        pinned = "Pinned",
        today = "Today",
        yesterday = "Yesterday",
        dayFormat = DateTimeFormatter.ofPattern("MM-dd", Locale.US),
        dayWithYearFormat = DateTimeFormatter.ofPattern("yyyy-MM-dd", Locale.US),
    )

    private fun agent(pointerSessionId: String?) = AgentRow(
        agentId = "a1",
        name = "Scout",
        harnessId = "claude-code",
        nodeId = "ct115",
        nodeName = "ct115",
        nodeDenUrl = nodeA,
        pointerSessionId = pointerSessionId,
    )

    private fun summary(sessionId: String) = HarnessSessionSummary(
        sessionId = sessionId,
        harnessId = "claude-code",
        createdAt = "2026-09-25T07:00:00Z",
        updatedAt = "2026-09-25T07:05:00Z",
        status = "idle",
    )

    private fun located(items: List<ChatItem>) = items.map { locate(it, "ct115", "ct115", nodeA) }

    /** The agent's unopened draft as the list builds it: pointer on a bare id, draft row suppressed. */
    private fun agentDraftList(pointers: AgentPointers): List<ChatItem> {
        pointers.set("a1", uuid, nodeA)
        val pins = pinChatItems(pointers.all(), listOf(agent(uuid)), nodeA)
        return chatItems(emptyMap(), emptyList(), listOf(uuid), mapOf(uuid to now - 1_000), pins)
    }

    /** The same conversation after the den adopts it (session-created path in HubViewModel). */
    private fun adoptedList(pointers: AgentPointers): Pair<List<ChatItem>, Rekey> {
        val rekey = adopt(uuid, summary(canonical))
        assertNotNull(rekey)
        pointers.rekey(rekey!!.from, rekey.to)
        val pins = pinChatItems(pointers.all(), listOf(agent(canonical)), nodeA)
        val items = chatItems(
            mapOf("claude-code" to Result.success(listOf(summary(canonical)))),
            emptyList(),
            pins = pins,
        )
        return items to rekey
    }

    @Test fun `a synthesized agent draft only offers discard`() {
        val row = agentDraftList(AgentPointers(nowMs = { 1L })).single()
        // The pointer row stands in for the draft: HARNESS kind, pin flag set.
        assertEquals(ChatItemKind.HARNESS, row.kind)
        assertTrue(row.pin)
        assertTrue(isDraftRow(row, listOf(uuid)))
        assertEquals(
            listOf(ConversationAction.DiscardDraft),
            conversationActions(pinned = false, archived = false, draft = isDraftRow(row, listOf(uuid)), agentCount = 3),
        )
    }

    @Test fun `draft identity by row shape`() {
        val draft = ChatItem(key = uuid, kind = ChatItemKind.DRAFT, title = "new conversation")
        val legacy = ChatItem(key = uuid, kind = ChatItemKind.LEGACY, title = "stored")
        val live = ChatItem(key = canonical, kind = ChatItemKind.HARNESS, title = "t", sessionId = canonical)
        val livePin = live.copy(pin = true)
        val barePointer = ChatItem(key = uuid, kind = ChatItemKind.HARNESS, title = "Scout", sessionId = uuid)
        assertTrue(isDraftRow(draft, emptyList()))
        assertFalse(isDraftRow(legacy, listOf(uuid)))
        assertFalse(isDraftRow(live, listOf(canonical)))
        assertFalse(isDraftRow(livePin, listOf(canonical)))
        // A bare-id HARNESS row is a draft only when it is an agent's pointer.
        assertTrue(isDraftRow(barePointer, listOf(uuid)))
        assertFalse(isDraftRow(barePointer, emptyList()))
    }

    @Test fun `rekeyIdSet moves one exact id and is a no-op otherwise`() {
        val set = setOf(uuid, "other")
        assertEquals(setOf(canonical, "other"), rekeyIdSet(set, uuid, canonical))
        assertSame(set, rekeyIdSet(set, "absent", canonical))
        assertSame(set, rekeyIdSet(set, uuid, uuid))
        assertSame(set, rekeyIdSet(set, "", canonical))
        assertSame(set, rekeyIdSet(set, uuid, ""))
        // Exact ids only: a native half does not move another harness's mark.
        val canon = setOf(canonical)
        assertSame(canon, rekeyIdSet(canon, uuid, "grok-build:$uuid"))
    }

    @Test fun `a pinned draft stays pinned after adopt and the draft id is gone`() {
        val pointers = AgentPointers(nowMs = { 1L })
        agentDraftList(pointers)
        val pinned = setOf(uuid)
        val (items, rekey) = adoptedList(pointers)
        val row = items.single()
        assertEquals(canonical, row.key)
        assertFalse(isDraftRow(row, listOf(canonical)))
        // Without the migration the adopted row would drop out of Pinned.
        assertEquals(SectionKind.Today, sectionRows(located(items), pinned, now, zone, labels).single().kind)

        val (nextPinned, _) = migrateLocalPrefs(pinned, emptySet(), rekey.from, rekey.to)
        assertEquals(setOf(canonical), nextPinned)
        val sections = sectionRows(located(items), nextPinned, now, zone, labels)
        assertEquals(SectionKind.Pinned, sections.single().kind)
        assertEquals(listOf(canonical), sections.single().rows.map { it.item.key })
    }

    @Test fun `a hidden draft stays hidden after adopt`() {
        val pointers = AgentPointers(nowMs = { 1L })
        agentDraftList(pointers)
        val hidden = setOf(uuid)
        val (items, rekey) = adoptedList(pointers)
        val rows = located(items)
        // Without the migration the adopted row comes back.
        assertEquals(1, filterConversations(rows, ConversationFilter.All, emptySet(), "", hidden = hidden).live.size)

        val (_, nextHidden) = migrateLocalPrefs(emptySet(), hidden, rekey.from, rekey.to)
        assertEquals(setOf(canonical), nextHidden)
        val lists = filterConversations(rows, ConversationFilter.All, emptySet(), "", hidden = nextHidden)
        assertTrue(lists.live.isEmpty())
        assertTrue(lists.archived.isEmpty())
    }

    @Test fun `a destination that already carries the mark keeps one entry`() {
        val (pinned, hidden) = migrateLocalPrefs(setOf(uuid, canonical), setOf(uuid, canonical, "x"), uuid, canonical)
        assertEquals(setOf(canonical), pinned)
        assertEquals(setOf(canonical, "x"), hidden)
    }

    @Test fun `a rotated session id carries pin and hide marks`() {
        val (pinned, hidden) = migrateLocalPrefs(setOf(canonical, "p"), setOf(canonical), canonical, rotated)
        assertEquals(setOf(rotated, "p"), pinned)
        assertEquals(setOf(rotated), hidden)
        val untouchedPinned = setOf("p")
        val untouchedHidden = setOf("h")
        val (samePinned, sameHidden) = migrateLocalPrefs(untouchedPinned, untouchedHidden, canonical, rotated)
        assertSame(untouchedPinned, samePinned)
        assertSame(untouchedHidden, sameHidden)
    }
}
