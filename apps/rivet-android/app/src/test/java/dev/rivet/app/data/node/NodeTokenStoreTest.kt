package dev.rivet.app.data.node

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The store's keying and lifecycle rules, exercised against the real
 * [KeyedNodeTokenStore] logic with an in-memory backing map. No fixture carries
 * anything that looks like a live credential.
 */
class NodeTokenStoreTest {
    private val store = InMemoryNodeTokenStore()

    @Test
    fun `stores and reads a token per node`() {
        store.put("http://node-a:5174", "aaa")
        store.put("http://node-b:5174", "bbb")

        assertEquals("aaa", store.tokenFor("http://node-a:5174"))
        assertEquals("bbb", store.tokenFor("http://node-b:5174"))
        assertNull(store.tokenFor("http://node-c:5174"))
    }

    @Test
    fun `key is the normalized den url`() {
        store.put("http://node-a:5174", "aaa")

        // Trailing slash and surrounding whitespace are the two shapes the roster
        // and the add form can disagree about; they must hit the same slot.
        assertEquals("aaa", store.tokenFor("http://node-a:5174/"))
        assertEquals("aaa", store.tokenFor("  http://node-a:5174  "))
        assertNull(store.tokenFor("http://node-a:5175"))
    }

    @Test
    fun `blank token clears the slot`() {
        store.put("http://node-a:5174", "aaa")
        store.put("http://node-a:5174", "   ")

        assertNull(store.tokenFor("http://node-a:5174"))
    }

    @Test
    fun `null token clears the slot`() {
        store.put("http://node-a:5174", "aaa")
        store.put("http://node-a:5174", null)

        assertNull(store.tokenFor("http://node-a:5174"))
    }

    @Test
    fun `stored token is trimmed`() {
        store.put("http://node-a:5174", "  aaa\n")

        assertEquals("aaa", store.tokenFor("http://node-a:5174"))
    }

    @Test
    fun `remove drops the token and its acceptance history`() {
        store.put("http://node-a:5174", "aaa")
        store.markAuthorized("http://node-a:5174")

        store.remove("http://node-a:5174")

        assertNull(store.tokenFor("http://node-a:5174"))
        assertFalse(store.wasAuthorized("http://node-a:5174"))
        assertTrue(store.isEmpty)
    }

    @Test
    fun `replacing a token resets its acceptance history`() {
        store.put("http://node-a:5174", "aaa")
        store.markAuthorized("http://node-a:5174")
        assertTrue(store.wasAuthorized("http://node-a:5174"))

        store.put("http://node-a:5174", "bbb")

        assertFalse(store.wasAuthorized("http://node-a:5174"))
    }

    @Test
    fun `re-saving the same token keeps its acceptance history`() {
        store.put("http://node-a:5174", "aaa")
        store.markAuthorized("http://node-a:5174")

        store.put("http://node-a:5174/", " aaa ")

        assertTrue(store.wasAuthorized("http://node-a:5174"))
    }

    @Test
    fun `the acceptance bit is written durably`() {
        store.put("http://node-a:5174", "aaa")
        assertEquals(0, store.durableWrites)

        store.markAuthorized("http://node-a:5174")

        assertEquals(1, store.durableWrites)
    }

    @Test
    fun `acceptance history is per node`() {
        store.put("http://node-a:5174", "aaa")
        store.put("http://node-b:5174", "bbb")
        store.markAuthorized("http://node-a:5174")

        assertTrue(store.wasAuthorized("http://node-a:5174"))
        assertFalse(store.wasAuthorized("http://node-b:5174"))
    }
}

/** In-memory [KeyedNodeTokenStore]; the shared fake for the node auth suites. */
class InMemoryNodeTokenStore : KeyedNodeTokenStore() {
    private val map = mutableMapOf<String, String>()

    val isEmpty: Boolean get() = map.isEmpty()

    override fun read(key: String): String? = map[key]

    var durableWrites: Int = 0
        private set

    override fun write(key: String, value: String, durable: Boolean) {
        if (durable) durableWrites++
        map[key] = value
    }

    override fun delete(vararg keys: String) {
        keys.forEach { map.remove(it) }
    }
}
