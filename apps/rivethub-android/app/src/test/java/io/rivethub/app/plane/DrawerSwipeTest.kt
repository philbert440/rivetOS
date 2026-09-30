package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DrawerSwipeTest {
    private val zone = 60f
    private val slop = 20f
    private val sheet = 810f

    private fun claims(startX: Float, dx: Float, dy: Float = 0f, open: Boolean = false) =
        claimsDrawerDrag(startX, dx, dy, open, sheet, zone, slop)

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
}
