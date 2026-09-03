package io.rivethub.app.plane

import io.rivethub.app.gateway.GatewayException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.SocketTimeoutException
import java.util.concurrent.atomic.AtomicInteger

class DiscoverTest {
    @Test fun `a bundle that never completes does not block the others`() = runBlocking {
        withTimeout(2_000) {
            val order = mutableListOf<String>()
            val hangStarted = CompletableDeferred<Unit>()
            fetchBundlesProgressively(
                nodes = listOf("hang", "fast"),
                timeoutMs = 400,
                fetch = { id ->
                    if (id == "hang") {
                        hangStarted.complete(Unit)
                        delay(60_000)
                    } else {
                        hangStarted.await()
                        delay(20)
                    }
                    id
                },
                onEach = { id, result ->
                    order += id
                    if (id == "fast") assertTrue(result.isSuccess)
                    if (id == "hang") assertTrue(result.isFailure)
                },
            )
            assertEquals("fast", order.first())
            assertEquals(listOf("fast", "hang"), order)
        }
    }

    @Test fun `a failing healthz short-circuits`() = runBlocking {
        val rest = AtomicInteger(0)
        val skippedFalse = fetchAfterHealthz(
            healthz = { false },
            rest = { rest.incrementAndGet(); "ran" },
            skipped = { _, _ -> "skipped" },
        )
        assertEquals("skipped", skippedFalse)
        assertEquals(0, rest.get())

        val skippedThrow = fetchAfterHealthz(
            healthz = { error("down") },
            rest = { rest.incrementAndGet(); "ran" },
            skipped = { ok, cause ->
                assertFalse(ok)
                assertTrue(cause != null)
                "skipped"
            },
        )
        assertEquals("skipped", skippedThrow)
        assertEquals(0, rest.get())

        val ran = fetchAfterHealthz(
            healthz = { true },
            rest = { rest.incrementAndGet(); "ran" },
            skipped = { _, _ -> "skipped" },
        )
        assertEquals("ran", ran)
        assertEquals(1, rest.get())
    }

    @Test fun `404 harness error is not a badge`() {
        assertNull(nodeErrorBadge(listOf(GatewayException(404, "HTTP 404"))))
        assertNull(nodeErrorBadge(listOf(GatewayException(404, "not found"), null)))
        assertTrue(isQuietNodeError(GatewayException(404, "HTTP 404")))
    }

    @Test fun `5xx and timeout are error badges`() {
        assertEquals("HTTP 503", nodeErrorBadge(listOf(GatewayException(503, "HTTP 503"))))
        assertEquals("HTTP 500", nodeErrorBadge(listOf(GatewayException(500, "HTTP 500"))))
        assertEquals("timed out", nodeErrorBadge(listOf(SocketTimeoutException("read timed out"))))
        val timed = runCatching {
            runBlocking { withTimeout(1) { delay(50) } }
        }.exceptionOrNull()
        assertEquals("timed out", nodeErrorBadge(listOf(timed)))
        assertEquals(
            "HTTP 503",
            nodeErrorBadge(listOf(GatewayException(404, "HTTP 404"), GatewayException(503, "HTTP 503"))),
        )
        assertFalse(isQuietNodeError(GatewayException(503, "HTTP 503")))
    }
}
