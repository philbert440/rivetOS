package io.rivethub.app.gateway

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

class ReconnectTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

    @After fun tearDown() {
        scope.cancel()
        AppForeground.set(true)
    }

    @Test fun `waits double from 500ms and cap at 15s`() {
        assertEquals(500L, reconnectDelayMs(0))
        assertEquals(1_000L, reconnectDelayMs(1))
        assertEquals(8_000L, reconnectDelayMs(4))
        assertEquals(15_000L, reconnectDelayMs(5))
        assertEquals(15_000L, reconnectDelayMs(40))
    }

    @Test fun `return reconnects a socket that is not open, or an open one after a long absence`() {
        assertTrue(reconnectOnForeground(WsStatus.CLOSED, 0))
        assertTrue(reconnectOnForeground(WsStatus.CONNECTING, 1_000))
        assertFalse(reconnectOnForeground(WsStatus.OPEN, STALE_AFTER_MS - 1))
        assertTrue(reconnectOnForeground(WsStatus.OPEN, STALE_AFTER_MS))
    }

    @Test fun `foreground signal reports time away and ignores repeats`() {
        val seen = mutableListOf<Pair<Boolean, Long>>()
        val reg = AppForeground.register { fg, away -> seen += fg to away }
        AppForeground.set(false, nowMs = 1_000)
        AppForeground.set(false, nowMs = 2_000)
        AppForeground.set(true, nowMs = 31_000)
        AppForeground.set(true, nowMs = 32_000)
        reg.close()
        AppForeground.set(false, nowMs = 40_000)
        assertEquals(listOf(false to 0L, true to 30_000L), seen)
    }

    @Test fun `no retry is armed in the background`() {
        val connects = AtomicInteger()
        var fg = false
        val retry = ReconnectScheduler(scope, isForeground = { fg }, jitterMs = { 0 }) { connects.incrementAndGet() }
        retry.schedule()
        assertEquals(0, retry.attempt)
        fg = true
        retry.schedule()
        assertEquals(1, retry.attempt)
    }

    @Test fun `connectNow resets the wait, drops the pending try and connects once`() {
        val connects = AtomicInteger()
        val retry = ReconnectScheduler(scope, isForeground = { true }, jitterMs = { 0 }) { connects.incrementAndGet() }
        retry.schedule() // armed for 500ms
        assertEquals(1, retry.attempt)
        retry.connectNow()
        assertEquals(0, retry.attempt)
        assertEquals(1, connects.get())
        Thread.sleep(700) // the dropped 500ms try would have fired by now
        assertEquals(1, connects.get())
    }

    @Test fun `an open resets the attempt count`() {
        val retry = ReconnectScheduler(scope, isForeground = { true }, jitterMs = { 0 }) {}
        retry.schedule()
        retry.pause()
        retry.schedule()
        assertEquals(2, retry.attempt)
        retry.onOpen()
        assertEquals(0, retry.attempt)
    }
}
