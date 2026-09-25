package io.rivethub.app.gateway

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.InputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class CappedReadTest {
    /** An endless body that counts reads and records close. */
    private class Endless(private val onRead: () -> Unit = {}) : InputStream() {
        val reads = AtomicInteger()
        @Volatile var closed = false
        override fun read(): Int = 0
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            reads.incrementAndGet()
            onRead()
            return len.coerceAtMost(1024)
        }
        override fun close() {
            closed = true
        }
    }

    @Test
    fun `reads a small body whole and closes it`() {
        var closed = false
        val src = object : java.io.ByteArrayInputStream(byteArrayOf(1, 2, 3)) {
            override fun close() {
                closed = true
            }
        }
        assertArrayEquals(byteArrayOf(1, 2, 3), readCapped(src, 10))
        assertTrue(closed)
    }

    @Test
    fun `refuses a body over the cap and closes it`() {
        val src = Endless()
        assertNull(readCapped(src, 4_000))
        assertTrue(src.closed)
    }

    @Test
    fun `a cancelled check stops the loop at the next chunk and closes the stream`() {
        val src = Endless()
        var checks = 0
        try {
            readCapped(src, Long.MAX_VALUE) {
                checks++
                if (checks == 3) throw CancellationException("gone")
            }
            fail("expected CancellationException")
        } catch (_: CancellationException) {
        }
        assertEquals(2, src.reads.get())
        assertTrue(src.closed)
    }

    @Test
    fun `cancelling the coroutine stops a slow read`() = runBlocking {
        val started = CountDownLatch(1)
        val src = Endless(onRead = {
            started.countDown()
            Thread.sleep(5)
        })
        var result: Throwable? = null
        val job = launch(Dispatchers.Default) {
            try {
                readCapped(src, Long.MAX_VALUE) { ensureActive() }
            } catch (t: Throwable) {
                result = t
                throw t
            }
        }
        assertTrue(started.await(5, TimeUnit.SECONDS))
        job.cancelAndJoin()
        assertTrue(result is CancellationException)
        assertTrue(src.closed)
        val after = src.reads.get()
        Thread.sleep(30)
        assertEquals(after, src.reads.get())
    }
}
