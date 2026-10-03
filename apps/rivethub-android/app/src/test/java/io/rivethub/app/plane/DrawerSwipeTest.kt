package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DrawerSwipeTest {
    private val zone = 60f
    private val slop = 20f
    private val sheet = 810f

    private fun claims(
        startX: Float,
        dx: Float,
        dy: Float = 0f,
        open: Boolean = false,
        childConsumed: Boolean = false,
    ) = claimsDrawerDrag(startX, dx, dy, open, sheet, zone, slop, childConsumed = childConsumed)

    @Test fun `left edge drag rightward takes the closed drawer`() {
        assertTrue(claims(startX = 10f, dx = 30f))
    }

    @Test fun `a drag still inside the touch slop takes nothing`() {
        assertFalse(claims(startX = 10f, dx = 15f))
    }

    @Test fun `a drag starting outside the edge zone takes nothing`() {
        assertFalse(claims(startX = 200f, dx = 150f))
    }

    @Test fun `a vertical-dominant drag at the bezel takes nothing`() {
        assertFalse(claims(startX = 10f, dx = 40f, dy = 120f))
        assertFalse(claims(startX = 10f, dx = 40f, dy = 40f))
    }

    @Test fun `a leftward drag at the bezel of a closed drawer takes nothing`() {
        assertFalse(claims(startX = 10f, dx = -40f))
    }

    @Test fun `an open drawer dragged left from the scrim is taken`() {
        assertTrue(claims(startX = 900f, dx = -40f, dy = 10f, open = true))
    }

    @Test fun `a drag starting on the open sheet is left to the sheet`() {
        assertFalse(claims(startX = 400f, dx = -150f, open = true))
    }

    @Test fun `an open drawer dragged further right is not taken`() {
        assertFalse(claims(startX = 900f, dx = 150f, open = true))
    }

    @Test fun `edge zone reaches past the gesture-navigation Back inset`() {
        assertEquals(24f, drawerEdgeZone(systemGestureInset = 0f), 0f)
        assertEquals(54f, drawerEdgeZone(systemGestureInset = 30f), 0f)
        // A tiny inset never shrinks the zone below the floor.
        assertEquals(24f, drawerEdgeZone(systemGestureInset = 1f, pastInset = 0f), 0f)
    }

    @Test fun `outside the hub exclusion band the zone stays max of floor and inset`() {
        assertEquals(30f, drawerEdgeZone(systemGestureInset = 30f, reachPastInset = false), 0f)
        assertEquals(24f, drawerEdgeZone(systemGestureInset = 10f, reachPastInset = false), 0f)
        assertEquals(24f, drawerEdgeZone(systemGestureInset = 0f, reachPastInset = false), 0f)
    }

    @Test fun `a horizontal child that already took the move keeps the drawer out`() {
        assertTrue(claims(startX = 10f, dx = 30f))
        assertFalse(claims(startX = 10f, dx = 30f, childConsumed = true))
        // Open scrim drag likewise yields when a child consumed.
        assertFalse(claims(startX = 900f, dx = -40f, open = true, childConsumed = true))
    }

    @Test fun `a fast fling goes its own way whatever the position`() {
        assertTrue(settlesOpen(fraction = 0.1f, velocity = 900f, flingThreshold = 800f))
        assertFalse(settlesOpen(fraction = 0.9f, velocity = -900f, flingThreshold = 800f))
    }

    @Test fun `a slow release lands on the nearer end`() {
        assertTrue(settlesOpen(fraction = 0.5f, velocity = 100f, flingThreshold = 800f))
        assertTrue(settlesOpen(fraction = 0.7f, velocity = -100f, flingThreshold = 800f))
        assertFalse(settlesOpen(fraction = 0.3f, velocity = 100f, flingThreshold = 800f))
    }

    @Test fun `predictive back eases the sheet shut with progress`() {
        assertEquals(1f, predictiveBackFraction(0f), 0f)
        assertEquals(1f - PREDICTIVE_BACK_TRAVEL, predictiveBackFraction(1f), 1e-6f)
        assertEquals(1f - PREDICTIVE_BACK_TRAVEL, predictiveBackFraction(3f), 1e-6f)
    }

    @Test fun `predictive back starts from a partly open sheet, not from fully open`() {
        assertEquals(0.4f, predictiveBackFraction(0f, from = 0.4f), 1e-6f)
        assertEquals(0.4f * (1f - PREDICTIVE_BACK_TRAVEL), predictiveBackFraction(1f, from = 0.4f), 1e-6f)
    }

    @Test fun `a claimed drag moves the sheet from the claim, not the down`() {
        // Closed, claimed 20px (the slop) right of the down: still closed.
        assertEquals(0f, drawerDragFraction(0f, dx = slop, slop = slop, startOpen = false, sheetWidth = sheet), 0f)
        assertEquals(0.5f, drawerDragFraction(0f, dx = slop + sheet / 2, slop = slop, startOpen = false, sheetWidth = sheet), 1e-6f)
        // Open, dragged left from the scrim.
        assertEquals(1f, drawerDragFraction(1f, dx = -slop, slop = slop, startOpen = true, sheetWidth = sheet), 0f)
        assertEquals(0.5f, drawerDragFraction(1f, dx = -slop - sheet / 2, slop = slop, startOpen = true, sheetWidth = sheet), 1e-6f)
        // Clamped at both ends.
        assertEquals(1f, drawerDragFraction(0.9f, dx = 5 * sheet, slop = slop, startOpen = false, sheetWidth = sheet), 0f)
        assertEquals(0f, drawerDragFraction(0.1f, dx = -5 * sheet, slop = slop, startOpen = true, sheetWidth = sheet), 0f)
    }
}
