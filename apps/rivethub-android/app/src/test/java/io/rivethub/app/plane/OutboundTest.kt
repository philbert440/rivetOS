package io.rivethub.app.plane

import io.rivethub.app.gateway.TurnInFlight
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OutboundTest {
    @Test fun `refuses a send while an attachment chip is uploading`() = runBlocking {
        withTimeout(1_000) {
            var sent = 0
            val pump = OutboundPump(send = { sent++ }, attachmentsUploading = { true })
            assertEquals(EnqueueResult.Uploading, pump.tryEnqueue("hi"))
            pump.pump()
            assertEquals(0, sent)
        }
    }

    @Test fun `send while idle dequeues and waits for turn-complete`() = runBlocking {
        withTimeout(1_000) {
            val seen = mutableListOf<String>()
            val pump = OutboundPump(send = { seen += it }, attachmentsUploading = { false }, newId = { "id1" })
            assertTrue(pump.tryEnqueue("hello") is EnqueueResult.Accepted)
            pump.pump()
            assertEquals(listOf("hello"), seen)
            assertTrue(pump.queued.isEmpty())
            assertTrue(pump.awaitingTurnComplete)
        }
    }

    @Test fun `409 queues the turn and retries after turn-complete`() = runBlocking {
        withTimeout(1_000) {
            var calls = 0
            val pump = OutboundPump(
                send = {
                    calls++
                    if (calls == 1) throw TurnInFlight()
                },
                newId = { "q1" },
            )
            pump.tryEnqueue("hi")
            pump.pump()
            assertEquals(1, calls)
            assertEquals(1, pump.queued.size)
            assertEquals(OutboundItem.Status.QUEUED, pump.queued.single().status)
            assertTrue(pump.awaitingTurnComplete)
            pump.onTurnComplete()
            assertEquals(2, calls)
            assertTrue(pump.queued.isEmpty())
        }
    }

    @Test fun `turn-complete drains the next queued turn`() = runBlocking {
        withTimeout(1_000) {
            val seen = mutableListOf<String>()
            var n = 0
            val pump = OutboundPump(send = { seen += it }, newId = { "id-${n++}" })
            pump.tryEnqueue("one")
            pump.tryEnqueue("two")
            pump.pump()
            assertEquals(listOf("one"), seen)
            assertEquals(1, pump.queued.size)
            pump.onTurnComplete()
            assertEquals(listOf("one", "two"), seen)
            assertTrue(pump.queued.isEmpty())
        }
    }

    @Test fun `pump is a no-op while awaiting turn-complete`() = runBlocking {
        withTimeout(1_000) {
            var calls = 0
            val pump = OutboundPump(send = { calls++ })
            pump.tryEnqueue("a")
            pump.tryEnqueue("b")
            pump.pump()
            pump.pump()
            assertEquals(1, calls)
        }
    }

    @Test fun `non-409 failure marks the item failed`() = runBlocking {
        withTimeout(1_000) {
            val pump = OutboundPump(send = { error("boom") }, newId = { "x" })
            pump.tryEnqueue("nope")
            try {
                pump.pump()
                org.junit.Assert.fail("expected throw")
            } catch (e: IllegalStateException) {
                assertEquals("boom", e.message)
            }
            assertEquals(OutboundItem.Status.FAILED, pump.queued.single().status)
            assertFalse(pump.awaitingTurnComplete)
        }
    }

    @Test fun `upload that starts after enqueue still blocks pump`() = runBlocking {
        withTimeout(1_000) {
            var uploading = false
            var sent = 0
            val pump = OutboundPump(send = { sent++ }, attachmentsUploading = { uploading })
            pump.tryEnqueue("hi")
            uploading = true
            pump.pump()
            assertEquals(0, sent)
            assertEquals(1, pump.queued.size)
        }
    }
}
