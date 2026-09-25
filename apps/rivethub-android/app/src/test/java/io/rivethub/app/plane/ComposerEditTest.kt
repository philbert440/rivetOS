package io.rivethub.app.plane

import io.rivethub.app.gateway.TurnInFlight
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ComposerEditTest {
    private fun item(id: String, edit: EditState?) =
        OutboundItem(id, "fixed text", OutboundItem.Status.QUEUED, editing = edit)

    /**
     * The view model's settle loop, minus Android: the pump reports every
     * outcome and the "screen" applies [editAfterOutcome] to its banner; a
     * hard failure also puts the item's text back in the composer.
     */
    private class Screen(var editing: EditState?, var composer: String = "")

    private fun settle(screen: Screen, o: PumpOutcome) {
        val id = o.itemId ?: return
        if (o is PumpOutcome.Rejected && o.reason == RejectReason.FAILED) screen.composer = o.item.text
        screen.editing = editAfterOutcome(screen.editing, id, o)
    }

    @Test
    fun `begin edit keeps the original text`() {
        assertEquals(EditState("fix the tests"), beginEdit("fix the tests"))
    }

    @Test
    fun `banner shows only while editing`() {
        assertTrue(editBannerVisible(beginEdit("x")))
        assertFalse(editBannerVisible(null))
    }

    @Test
    fun `dispatch of the edited item ends editing`() {
        val sent = beginEdit("x")
        assertNull(editAfterOutcome(sent, "a", PumpOutcome.Dispatched(item("a", sent))))
        assertNull(editAfterOutcome(null, "a", PumpOutcome.Dispatched(item("a", null))))
    }

    @Test
    fun `only a dispatch of that item settles its edit`() {
        val sent = beginEdit("x")
        val mine = item("a", sent)
        assertSame(sent, editAfterOutcome(sent, "a", PumpOutcome.Dispatched(item("b", null))))
        assertSame(sent, editAfterOutcome(sent, "a", PumpOutcome.Deferred(mine)))
        assertSame(sent, editAfterOutcome(sent, "a", PumpOutcome.Rejected(mine, RejectReason.TURN_IN_FLIGHT)))
        assertSame(sent, editAfterOutcome(sent, "a", PumpOutcome.Idle))
    }

    @Test
    fun `hard failure restores the item's edit with its text`() {
        val sent = beginEdit("x")
        val failed = PumpOutcome.Rejected(item("a", sent), RejectReason.FAILED)
        assertSame(sent, editAfterOutcome(sent, "a", failed))
        // even if the banner was dismissed meanwhile, the restored text brings it back
        assertSame(sent, editAfterOutcome(null, "a", failed))
        assertNull(editAfterOutcome(null, "a", PumpOutcome.Rejected(item("a", null), RejectReason.FAILED)))
    }

    @Test
    fun `a newer edit survives the item settling`() {
        val sent = beginEdit("x")
        val newer = beginEdit("y")
        assertSame(newer, editAfterOutcome(newer, "a", PumpOutcome.Dispatched(item("a", sent))))
        assertSame(newer, editAfterOutcome(newer, "a", PumpOutcome.Rejected(item("a", sent), RejectReason.FAILED)))
    }

    @Test
    fun `an edit already riding on a queued item is not attached again`() {
        val sent = beginEdit("x")
        assertSame(sent, editForEnqueue(sent, emptyList()))
        assertNull(editForEnqueue(sent, listOf(item("a", sent))))
        // an equal but distinct edit is a new one
        val again = beginEdit("x")
        assertSame(again, editForEnqueue(again, listOf(item("a", sent))))
        assertNull(editForEnqueue(null, emptyList()))
    }

    @Test
    fun `cancelled queued item brings its edit back`() {
        val sent = beginEdit("x")
        assertSame(sent, restoredEdit(null, item("a", sent)))
        val newer = beginEdit("y")
        assertSame(newer, restoredEdit(newer, item("a", sent)))
    }

    @Test
    fun `no dispatch keeps editing while the item waits`() = runBlocking {
        withTimeout(1_000) {
            val edit = beginEdit("x")
            val screen = Screen(edit)
            var n = 0
            var sends = 0
            val pump = OutboundPump(
                send = { _, _ -> sends++ },
                newId = { "id-${n++}" },
                onOutcome = { settle(screen, it) },
            )
            pump.tryEnqueue("earlier")
            pump.pump() // id-0 dispatched: now awaiting its turn-complete
            assertSame(edit, screen.editing)
            pump.tryEnqueue("fixed text", editing = editForEnqueue(screen.editing, pump.queued))
            val outcome = pump.pump()
            assertTrue(outcome is PumpOutcome.Deferred)
            assertEquals("id-1", outcome.itemId)
            assertEquals(1, sends)
            assertSame(edit, screen.editing)
            pump.onTurnComplete() // id-1 goes out now
            assertEquals(2, sends)
            assertNull(screen.editing)
        }
    }

    @Test
    fun `409 then acceptance clears editing`() = runBlocking {
        withTimeout(1_000) {
            val edit = beginEdit("x")
            val screen = Screen(edit)
            var calls = 0
            val pump = OutboundPump(
                send = { _, _ -> if (++calls == 1) throw TurnInFlight() },
                newId = { "q1" },
                onOutcome = { settle(screen, it) },
            )
            pump.tryEnqueue("fixed text", editing = edit)
            val first = pump.pump() // returns normally, but nothing was accepted
            assertTrue(first is PumpOutcome.Rejected && first.reason == RejectReason.TURN_IN_FLIGHT)
            assertEquals(1, pump.queued.size)
            assertSame(edit, screen.editing)
            val retry = pump.onIdle()
            assertTrue(retry is PumpOutcome.Dispatched)
            assertNull(screen.editing)
        }
    }

    @Test
    fun `409 then hard failure restores the text with its edit`() = runBlocking {
        withTimeout(1_000) {
            val edit = beginEdit("x")
            val screen = Screen(edit)
            var calls = 0
            val pump = OutboundPump(
                send = { _, _ -> if (++calls == 1) throw TurnInFlight() else error("boom") },
                newId = { "q1" },
                onOutcome = { settle(screen, it) },
            )
            pump.tryEnqueue("fixed text", editing = edit)
            pump.pump()
            assertSame(edit, screen.editing)
            screen.editing = null // the banner was dismissed while it waited
            try {
                pump.pump(forceId = "q1") // the inject path
                fail("expected throw")
            } catch (e: IllegalStateException) {
                assertEquals("boom", e.message)
            }
            assertTrue(pump.queued.isEmpty())
            assertEquals("fixed text", screen.composer)
            assertSame(edit, screen.editing)
        }
    }

    @Test
    fun `acknowledged 409 counts as acceptance`() = runBlocking {
        withTimeout(1_000) {
            val edit = beginEdit("x")
            val screen = Screen(edit)
            val pump = OutboundPump(
                send = { _, _ -> throw TurnInFlight() },
                newId = { "q1" },
                onOutcome = { settle(screen, it) },
            )
            pump.tryEnqueue("fixed text", editing = edit)
            pump.pump()
            assertSame(edit, screen.editing)
            pump.acknowledgePending() // the registry found the reply to it
            assertNull(screen.editing)
        }
    }
}
