package io.rivethub.app.plane

import io.rivethub.app.plane.ConversationAction.Archive
import io.rivethub.app.plane.ConversationAction.DiscardDraft
import io.rivethub.app.plane.ConversationAction.Hide
import io.rivethub.app.plane.ConversationAction.MoveToAgent
import io.rivethub.app.plane.ConversationAction.Pin
import io.rivethub.app.plane.ConversationAction.Rename
import io.rivethub.app.plane.ConversationAction.Unarchive
import io.rivethub.app.plane.ConversationAction.Unpin
import org.junit.Assert.assertEquals
import org.junit.Test

class ConversationMenuTest {
    private val nodeA = "https://192.0.2.10:5174"
    private val nodeB = "https://192.0.2.20:5174"

    @Test fun `a draft only offers discard`() {
        assertEquals(listOf(DiscardDraft), conversationActions(pinned = false, archived = false, draft = true, agentCount = 3))
        assertEquals(listOf(DiscardDraft), conversationActions(pinned = true, archived = true, draft = true, agentCount = 0))
    }

    @Test fun `a live unpinned row with several agents`() {
        assertEquals(
            listOf(Pin, Rename, MoveToAgent, Archive, Hide),
            conversationActions(pinned = false, archived = false, draft = false, agentCount = 2),
        )
    }

    @Test fun `pinned and archived flip their toggles`() {
        assertEquals(
            listOf(Unpin, Rename, MoveToAgent, Unarchive, Hide),
            conversationActions(pinned = true, archived = true, draft = false, agentCount = 5),
        )
    }

    @Test fun `move to agent needs more than one agent`() {
        assertEquals(
            listOf(Pin, Rename, Archive, Hide),
            conversationActions(pinned = false, archived = false, draft = false, agentCount = 1),
        )
        assertEquals(
            listOf(Pin, Rename, Archive, Hide),
            conversationActions(pinned = false, archived = false, draft = false, agentCount = 0),
        )
    }

    @Test fun `move re-points the chosen agent and frees the previous owner`() {
        val before = mapOf(
            "a1" to AgentPointer("s1", nodeA, 1),
            "a2" to AgentPointer("s2", nodeA, 1),
            "a3" to AgentPointer("s3", nodeB, 1),
        )
        val after = moveSessionToAgent(before, "s1", "a2", nodeA, 9)
        assertEquals(
            mapOf(
                "a2" to AgentPointer("s1", nodeA, 9),
                "a3" to AgentPointer("s3", nodeB, 1),
            ),
            after,
        )
    }

    @Test fun `move to an agent with no pointer adds one`() {
        val before = mapOf("a1" to AgentPointer("s1", nodeA, 1))
        val after = moveSessionToAgent(before, "s9", "a2", nodeB, 5)
        assertEquals(
            mapOf(
                "a1" to AgentPointer("s1", nodeA, 1),
                "a2" to AgentPointer("s9", nodeB, 5),
            ),
            after,
        )
    }

    @Test fun `move to the agent that already owns it only restamps`() {
        val before = mapOf("a1" to AgentPointer("s1", nodeA, 1))
        assertEquals(mapOf("a1" to AgentPointer("s1", nodeA, 7)), moveSessionToAgent(before, "s1", "a1", nodeA, 7))
    }
}
