package io.rivethub.app.plane

import io.rivethub.app.gateway.TurnInFlight
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger
import java.util.UUID

class OutboundTest {
    private fun textPump(
        send: suspend (String) -> Unit,
        attachmentsUploading: () -> Boolean = { false },
        newId: () -> String = { UUID.randomUUID().toString() },
        nowMs: () -> Long = { System.currentTimeMillis() },
        idleDeadlineMs: Long = IDLE_DEADLINE_MS,
    ) = OutboundPump({ text, _ -> send(text) }, attachmentsUploading, newId, nowMs, idleDeadlineMs)

    @Test fun `refuses a send while an attachment chip is uploading`() = runBlocking {
        withTimeout(1_000) {
            var sent = 0
            val pump = textPump(send = { sent++ }, attachmentsUploading = { true })
            assertEquals(EnqueueResult.Uploading, pump.tryEnqueue("hi"))
            pump.pump()
            assertEquals(0, sent)
        }
    }

    @Test fun `send while idle dequeues and waits for turn-complete`() = runBlocking {
        withTimeout(1_000) {
            val seen = mutableListOf<String>()
            val pump = textPump(send = { seen += it }, attachmentsUploading = { false }, newId = { "id1" })
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
            val pump = textPump(
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
            val pump = textPump(send = { seen += it }, newId = { "id-${n++}" })
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
            val pump = textPump(send = { calls++ })
            pump.tryEnqueue("a")
            pump.tryEnqueue("b")
            pump.pump()
            pump.pump()
            assertEquals(1, calls)
        }
    }

    @Test fun `non-409 failure drops the item`() = runBlocking {
        withTimeout(1_000) {
            val pump = textPump(send = { error("boom") }, newId = { "x" })
            pump.tryEnqueue("nope")
            try {
                pump.pump()
                org.junit.Assert.fail("expected throw")
            } catch (e: IllegalStateException) {
                assertEquals("boom", e.message)
            }
            assertTrue(pump.queued.isEmpty())
            assertFalse(pump.awaitingTurnComplete)
        }
    }

    @Test fun `upload that starts after enqueue still blocks pump`() = runBlocking {
        withTimeout(1_000) {
            var uploading = false
            var sent = 0
            val pump = textPump(send = { sent++ }, attachmentsUploading = { uploading })
            pump.tryEnqueue("hi")
            uploading = true
            pump.pump()
            assertEquals(0, sent)
            assertEquals(1, pump.queued.size)
        }
    }

    @Test fun `concurrent pumps send exactly one turn`() = runBlocking {
        withTimeout(2_000) {
            val entered = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            val sends = AtomicInteger(0)
            var n = 0
            val pump = textPump(
                send = {
                    sends.incrementAndGet()
                    entered.complete(Unit)
                    release.await()
                },
                newId = { "id-${n++}" },
            )
            pump.tryEnqueue("one")
            pump.tryEnqueue("two")
            coroutineScope {
                launch { pump.pump() }
                launch { pump.pump() }
                entered.await()
                delay(50)
                assertEquals(1, sends.get())
                release.complete(Unit)
            }
            assertEquals(1, sends.get())
        }
    }

    @Test fun `409 pending acknowledge drops the item so poll complete does not resend`() = runBlocking {
        withTimeout(1_000) {
            var calls = 0
            val pump = textPump(
                send = {
                    calls++
                    throw TurnInFlight()
                },
                newId = { "q1" },
            )
            pump.tryEnqueue("hi")
            pump.pump()
            assertEquals(1, calls)
            assertTrue(pump.pendingOnServer)
            pump.acknowledgePending()
            assertFalse(pump.pendingOnServer)
            assertTrue(pump.queued.isEmpty())
            pump.onTurnComplete()
            assertEquals(1, calls)
        }
    }

    @Test fun `409 then success retries on pending cadence`() = runBlocking {
        withTimeout(1_000) {
            var calls = 0
            val pump = textPump(
                send = {
                    calls++
                    if (calls == 1) throw TurnInFlight()
                },
                newId = { "q1" },
            )
            pump.tryEnqueue("hi")
            pump.pump()
            assertEquals(1, calls)
            assertTrue(pump.pendingOnServer)
            assertEquals(1, pump.queued.size)
            pump.onIdle()
            assertEquals(2, calls)
            assertFalse(pump.pendingOnServer)
            assertTrue(pump.queued.isEmpty())
            assertTrue(pump.awaitingTurnComplete)
        }
    }

    @Test fun `cancel returns the item text and drops it`() = runBlocking {
        withTimeout(1_000) {
            var n = 0
            val pump = textPump(send = {}, newId = { "id-${n++}" })
            pump.tryEnqueue("keep me")
            pump.tryEnqueue("drop me")
            val dropped = pump.cancel("id-1")
            assertEquals("drop me", dropped!!.text)
            assertEquals(1, pump.queued.size)
            assertEquals("keep me", pump.queued.single().text)
            assertNull(pump.cancel("missing"))
        }
    }

    @Test fun `cancel returns staged attachments so the composer can restore them`() = runBlocking {
        withTimeout(1_000) {
            val atts = listOf(StagedTurnAttachment("image/png", "/up/a.png", "a.png"))
            val pump = OutboundPump(send = { _, _ -> }, newId = { "id1" })
            pump.tryEnqueue("caption", atts)
            val dropped = pump.cancel("id1")
            assertEquals("caption", dropped!!.text)
            assertEquals(atts, dropped.attachments)
            assertTrue(pump.queued.isEmpty())
        }
    }

    @Test fun `inject forceId sends that item while awaiting`() = runBlocking {
        withTimeout(1_000) {
            val seen = mutableListOf<String>()
            var n = 0
            val pump = textPump(send = { seen += it }, newId = { "id-${n++}" })
            pump.tryEnqueue("one")
            pump.tryEnqueue("two")
            pump.pump()
            assertEquals(listOf("one"), seen)
            assertTrue(pump.awaitingTurnComplete)
            pump.pump(forceId = "id-1")
            assertEquals(listOf("one", "two"), seen)
        }
    }

    @Test fun `onIdle retries a 409 once`() = runBlocking {
        withTimeout(1_000) {
            var calls = 0
            val pump = textPump(
                send = {
                    calls++
                    if (calls == 1) throw TurnInFlight()
                },
                newId = { "q1" },
            )
            pump.tryEnqueue("hi")
            pump.pump()
            assertEquals(1, calls)
            assertTrue(pump.pendingOnServer)
            pump.onIdle()
            assertEquals(2, calls)
            assertFalse(pump.pendingOnServer)
            pump.onIdle()
            assertEquals(2, calls)
        }
    }

    @Test fun `stalled await releases after the deadline and drains`() = runBlocking {
        withTimeout(1_000) {
            var t = 0L
            val seen = mutableListOf<String>()
            var n = 0
            val pump = textPump(
                send = { seen += it },
                newId = { "id-${n++}" },
                nowMs = { t },
                idleDeadlineMs = 100,
            )
            pump.tryEnqueue("one")
            pump.tryEnqueue("two")
            pump.pump()
            assertEquals(listOf("one"), seen)
            assertTrue(pump.awaitingTurnComplete)
            assertFalse(pump.isStalled(t))
            t = 101
            assertTrue(pump.isStalled(t))
            pump.onTurnComplete()
            assertEquals(listOf("one", "two"), seen)
            assertTrue(pump.queued.isEmpty())
        }
    }

    @Test fun `keeps staged image inputs attached to their queued turn`() = runBlocking {
        withTimeout(1_000) {
            val seen = mutableListOf<List<StagedTurnAttachment>>()
            val pump = OutboundPump(
                send = { _, atts -> seen += atts },
                newId = { "id1" },
            )
            val atts = listOf(StagedTurnAttachment("image/png", "/node/uploads/a.png", "a.png"))
            assertTrue(pump.tryEnqueue("caption", atts) is EnqueueResult.Accepted)
            assertEquals(atts, pump.queued.single().attachments)
            pump.pump()
            assertEquals(listOf(atts), seen)
            assertTrue(pump.queued.isEmpty())
        }
    }

    @Test fun `a pump waits out the send lock and busy tracks the queue`() = runBlocking {
        withTimeout(1_000) {
            val seen = mutableListOf<String>()
            val pump = textPump(send = { seen += it })
            assertFalse(pump.busy)
            val entered = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            coroutineScope {
                launch {
                    pump.withSendLock {
                        entered.complete(Unit)
                        release.await()
                    }
                }
                entered.await()
                assertTrue(pump.tryEnqueue("hi") is EnqueueResult.Accepted)
                assertTrue(pump.busy)
                val sender = launch { pump.pump() }
                delay(20)
                // the out-of-band holder still owns the lock: nothing went out
                assertTrue(seen.isEmpty())
                assertTrue(pump.busy)
                release.complete(Unit)
                sender.join()
            }
            assertEquals(listOf("hi"), seen)
            // sent and awaiting turn-complete: the transcript's in-flight, not busy
            assertTrue(pump.awaitingTurnComplete)
            assertFalse(pump.busy)
        }
    }

    @Test fun `send lock returns the block result`() = runBlocking {
        withTimeout(1_000) {
            val pump = textPump(send = { })
            assertEquals(42, pump.withSendLock { 42 })
            assertFalse(pump.withSendLock { pump.busy })
        }
    }

    @Test fun `each pass names the item and what happened to it`() = runBlocking {
        withTimeout(1_000) {
            var n = 0
            var calls = 0
            var uploading = false
            val seen = mutableListOf<PumpOutcome>()
            val pump = OutboundPump(
                send = { _, _ -> if (++calls == 2) throw TurnInFlight() },
                attachmentsUploading = { uploading },
                newId = { "id-${n++}" },
                onOutcome = { seen += it },
            )
            assertEquals(PumpOutcome.Idle, pump.pump())
            pump.tryEnqueue("one")
            pump.tryEnqueue("two")
            val sent = pump.pump()
            assertTrue(sent is PumpOutcome.Dispatched && sent.item.text == "one")
            val waiting = pump.pump()
            assertTrue(waiting is PumpOutcome.Deferred)
            assertEquals("id-1", waiting.itemId)
            val busy = pump.onTurnComplete()
            assertTrue(busy is PumpOutcome.Rejected && busy.reason == RejectReason.TURN_IN_FLIGHT)
            assertEquals("id-1", busy.itemId)
            assertEquals(1, pump.queued.size)
            uploading = true
            assertTrue(pump.onIdle() is PumpOutcome.Deferred)
            // every pass reached the listener, in order
            assertEquals(listOf(PumpOutcome.Idle, sent, waiting, busy), seen.take(4))
            assertEquals(5, seen.size)
        }
    }

    @Test fun `hard failure is reported as FAILED before it is rethrown`() = runBlocking {
        withTimeout(1_000) {
            val seen = mutableListOf<PumpOutcome>()
            val pump = OutboundPump(
                send = { _, _ -> error("boom") },
                newId = { "x" },
                onOutcome = { seen += it },
            )
            pump.tryEnqueue("nope")
            try {
                pump.pump()
                org.junit.Assert.fail("expected throw")
            } catch (e: IllegalStateException) {
                assertEquals("boom", e.message)
            }
            val failed = seen.single()
            assertTrue(failed is PumpOutcome.Rejected && failed.reason == RejectReason.FAILED)
            assertEquals("x", failed.itemId)
            assertEquals("nope", (failed as PumpOutcome.Rejected).item.text)
            assertEquals("boom", failed.cause?.message)
        }
    }
}
