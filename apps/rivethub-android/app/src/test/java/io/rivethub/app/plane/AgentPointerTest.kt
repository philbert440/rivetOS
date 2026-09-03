package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentPointerTest {
    private val nodeA = "https://192.0.2.10:5174"
    private val nodeB = "https://192.0.2.20:5174"

    @Test fun `stores and returns the last session per agent`() {
        val store = AgentPointers { 1 }
        assertNull(store.get("a1"))
        assertTrue(store.set("a1", "sess-1", nodeA))
        assertEquals(AgentPointer("sess-1", nodeA, 1), store.get("a1"))
        assertEquals("a1", store.agentForSession("sess-1"))
    }

    @Test fun `set-once a second write without replace does not steal the pin`() {
        val store = AgentPointers { 1 }
        assertTrue(store.set("a1", "sess-a", nodeA))
        assertFalse(store.set("a1", "sess-b", nodeB))
        assertEquals("sess-a", store.get("a1")!!.sessionId)
        assertNull(store.agentForSession("sess-b"))
    }

    @Test fun `plus new never steals`() {
        val store = AgentPointers { 2 }
        store.set("a1", "existing", nodeA)
        val draft = newDraftId()
        assertFalse(store.set("a1", draft, nodeA, replace = false))
        assertEquals("existing", store.get("a1")!!.sessionId)
    }

    @Test fun `replace drops the old pin and writes the new one`() {
        val store = AgentPointers { 3 }
        store.set("a1", "sess-a", nodeA)
        assertTrue(store.set("a1", "sess-b", nodeB, replace = true))
        assertEquals("sess-b", store.get("a1")!!.sessionId)
        assertEquals(nodeB, store.get("a1")!!.nodeBaseUrl)
        assertNull(store.agentForSession("sess-a"))
        assertEquals("a1", store.agentForSession("sess-b"))
    }

    @Test fun `rekey follows a rotation`() {
        val store = AgentPointers { 4 }
        store.set("a1", "claude-code:old", nodeA)
        store.rekey("claude-code:old", "claude-code:new")
        assertEquals("claude-code:new", store.get("a1")!!.sessionId)
        assertEquals("a1", store.agentForSession("claude-code:new"))
        assertNull(store.agentForSession("claude-code:old"))
    }

    @Test fun `clear drops the pin`() {
        val store = AgentPointers { 5 }
        store.set("a1", "sess-a", nodeA)
        store.clear("a1")
        assertNull(store.get("a1"))
        assertNull(store.agentForSession("sess-a"))
    }

    @Test fun `pointers are per-agent`() {
        val store = AgentPointers { 6 }
        store.set("a1", "s1", nodeA)
        store.set("a2", "s2", nodeB)
        assertEquals("s1", store.get("a1")!!.sessionId)
        assertEquals("s2", store.get("a2")!!.sessionId)
        assertEquals(2, store.all().size)
    }

    @Test fun `rekey no-op on empty or identical ids`() {
        val store = AgentPointers { 7 }
        store.set("a1", "s1", nodeA)
        store.rekey("", "s2")
        store.rekey("s1", "s1")
        assertEquals("s1", store.get("a1")!!.sessionId)
    }

    @Test fun `adopt rekeys a pinned draft onto the canonical id`() {
        val store = AgentPointers { 8 }
        val draft = "a1b2c3d4-1111-4222-8333-444455556666"
        store.set("claude", draft, nodeA, replace = true)
        assertTrue(rekeyPinnedDraft(store, "claude", draft, "claude-code:$draft", nodeA))
        assertEquals("claude-code:$draft", store.get("claude")!!.sessionId)
        assertEquals("claude", store.agentForSession("claude-code:$draft"))
        assertNull(store.agentForSession(draft))
    }

    @Test fun `adopt does not steal a pin held by another session`() {
        val store = AgentPointers { 9 }
        store.set("claude", "claude-code:existing", nodeA, replace = true)
        assertFalse(rekeyPinnedDraft(store, "claude", "new-draft", "claude-code:new-draft", nodeA))
        assertEquals("claude-code:existing", store.get("claude")!!.sessionId)
        assertFalse(rekeyPinnedDraft(store, "", "a", "b", nodeA))
        assertFalse(rekeyPinnedDraft(store, "missing", "a", "b", nodeA))
    }
}
