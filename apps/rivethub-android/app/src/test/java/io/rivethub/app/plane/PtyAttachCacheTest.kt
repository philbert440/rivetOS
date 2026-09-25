package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PtyAttachCacheTest {
    @Test
    fun `cached id is reused until restart`() {
        val cache = PtyAttachCache()
        assertNull(cache.cached())
        cache.remember("pty-1")
        assertEquals("pty-1", cache.cached())
        assertEquals("pty-1", cache.id)
        cache.restart()
        assertNull(cache.cached())
        cache.remember("pty-2")
        assertEquals("pty-2", cache.cached())
    }

    @Test
    fun `forget drops the id without counting as a restart`() {
        val cache = PtyAttachCache()
        assertNull(cache.cached())
        cache.remember("pty-1")
        cache.forget()
        assertNull(cache.cached())
        cache.remember("pty-2")
        assertEquals("pty-2", cache.cached())
    }

    @Test
    fun `restart during an in-flight resolve does not keep the old id`() {
        val cache = PtyAttachCache()
        assertNull(cache.cached())
        cache.restart()
        cache.remember("pty-old")
        assertNull(cache.cached())
        cache.remember("pty-new")
        assertEquals("pty-new", cache.cached())
        assertEquals("pty-new", cache.id)
    }
}
