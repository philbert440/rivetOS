package io.rivethub.app.ui.components

import androidx.compose.runtime.MonotonicFrameClock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The drawer state the gesture layer and predictive Back drive. No Android
 * deps: a frame clock that yields between frames stands in for Choreographer,
 * so a running settle can be interrupted the way a new drag interrupts it.
 */
class RivetDrawerStateTest {
    private class YieldingClock : MonotonicFrameClock {
        private var nanos = 0L
        override suspend fun <R> withFrameNanos(onFrame: (Long) -> R): R {
            yield()
            nanos += 16_000_000L
            return onFrame(nanos)
        }
    }

    private fun drawerTest(block: suspend CoroutineScope.(RivetDrawerState) -> Unit) =
        runBlocking(YieldingClock()) { block(RivetDrawerState()) }

    @Test fun `an opening drag heads open at once, a closing one keeps the target`() = drawerTest { s ->
        assertFalse(s.isOpen)
        s.dragTo(0.3f)
        assertTrue(s.targetOpen)
        assertTrue(s.isOpen)
        s.dragTo(0.1f)
        assertTrue(s.targetOpen)
        assertEquals(0.1f, s.fraction, 0f)
        s.dragTo(-2f)
        assertEquals(0f, s.fraction, 0f)
    }

    @Test fun `settle lands fully open or fully closed`() = drawerTest { s ->
        s.dragTo(0.4f)
        s.settle(open = true)
        assertEquals(1f, s.fraction, 1e-3f)
        assertTrue(s.targetOpen)
        s.close()
        assertEquals(0f, s.fraction, 1e-3f)
        assertFalse(s.targetOpen)
        assertFalse(s.isOpen)
    }

    @Test fun `a new drag cancels a running settle`() = drawerTest { s ->
        s.open()
        val closing = launch { s.close() }
        yield()
        yield()
        s.dragTo(0.8f)
        closing.join()
        assertTrue(closing.isCancelled)
        assertEquals(0.8f, s.fraction, 0f)
    }

    @Test fun `peek moves the sheet without changing where it is headed`() = drawerTest { s ->
        s.open()
        s.peek(0.7f)
        assertEquals(0.7f, s.fraction, 0f)
        assertTrue(s.targetOpen)
        // A cancelled predictive Back springs it open again.
        s.open()
        assertEquals(1f, s.fraction, 1e-3f)
    }

    @Test fun `dragBy follows a finger delta within the bounds`() = drawerTest { s ->
        s.open()
        s.dragBy(-0.25f)
        assertEquals(0.75f, s.fraction, 1e-3f)
        s.dragBy(-5f)
        assertEquals(0f, s.fraction, 0f)
    }
}
