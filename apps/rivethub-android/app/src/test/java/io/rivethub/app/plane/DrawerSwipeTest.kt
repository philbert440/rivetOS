package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DrawerSwipeTest {
    private val width = 1080f
    private val zone = 60f
    private val travel = 120f

    @Test fun `left edge drag rightward opens the left drawer`() {
        val action = decideDrawerSwipe(
            startX = 10f, dx = 150f, dy = 0f, viewportWidth = width,
            sessionOpen = false, leftOpen = false, rightOpen = false,
            zone = zone, travel = travel,
        )
        assertEquals(DrawerSwipeAction.Open(DrawerSide.Left), action)
    }

    @Test fun `drag below the travel threshold does nothing`() {
        val action = decideDrawerSwipe(
            startX = 10f, dx = 100f, dy = 0f, viewportWidth = width,
            sessionOpen = true, leftOpen = false, rightOpen = false,
            zone = zone, travel = travel,
        )
        assertNull(action)
    }

    @Test fun `open left drawer dragged back toward its bezel closes`() {
        val action = decideDrawerSwipe(
            startX = 400f, dx = -130f, dy = 10f, viewportWidth = width,
            sessionOpen = true, leftOpen = true, rightOpen = false,
            zone = zone, travel = travel,
        )
        assertEquals(DrawerSwipeAction.Close(DrawerSide.Left), action)
    }

    @Test fun `open right drawer dragged back toward its bezel closes`() {
        val action = decideDrawerSwipe(
            startX = 600f, dx = 130f, dy = -10f, viewportWidth = width,
            sessionOpen = true, leftOpen = false, rightOpen = true,
            zone = zone, travel = travel,
        )
        assertEquals(DrawerSwipeAction.Close(DrawerSide.Right), action)
    }

    @Test fun `right edge drag opens the history drawer only in a session`() {
        val inSession = decideDrawerSwipe(
            startX = width - 5f, dx = -150f, dy = 0f, viewportWidth = width,
            sessionOpen = true, leftOpen = false, rightOpen = false,
            zone = zone, travel = travel,
        )
        assertEquals(DrawerSwipeAction.Open(DrawerSide.Right), inSession)
        val outsideSession = decideDrawerSwipe(
            startX = width - 5f, dx = -150f, dy = 0f, viewportWidth = width,
            sessionOpen = false, leftOpen = false, rightOpen = false,
            zone = zone, travel = travel,
        )
        assertNull(outsideSession)
    }

    @Test fun `vertical dominant drag does nothing even at the bezel`() {
        val action = decideDrawerSwipe(
            startX = 5f, dx = 130f, dy = 200f, viewportWidth = width,
            sessionOpen = true, leftOpen = false, rightOpen = false,
            zone = zone, travel = travel,
        )
        assertNull(action)
    }

    @Test fun `mid-screen drag does not open a drawer`() {
        val action = decideDrawerSwipe(
            startX = 500f, dx = 150f, dy = 0f, viewportWidth = width,
            sessionOpen = true, leftOpen = false, rightOpen = false,
            zone = zone, travel = travel,
        )
        assertNull(action)
    }
}
