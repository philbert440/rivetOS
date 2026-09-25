package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DrawerSwipeTest {
    private val width = 1080f
    private val zone = 60f
    private val travel = 120f
    private val sheet = 810f

    @Test fun `left edge drag rightward opens the left drawer`() {
        val action = decideDrawerSwipe(
            startX = 10f, dx = 150f, dy = 0f,
            leftOpen = false, sheetWidth = sheet,
            zone = zone, travel = travel,
        )
        assertEquals(DrawerSwipeAction.Open(DrawerSide.Left), action)
    }

    @Test fun `drag below the travel threshold does nothing`() {
        val action = decideDrawerSwipe(
            startX = 10f, dx = 100f, dy = 0f,
            leftOpen = false, sheetWidth = sheet,
            zone = zone, travel = travel,
        )
        assertNull(action)
    }

    @Test fun `open left drawer dragged back from the scrim closes`() {
        val action = decideDrawerSwipe(
            startX = 900f, dx = -130f, dy = 10f,
            leftOpen = true, sheetWidth = sheet,
            zone = zone, travel = travel,
        )
        assertEquals(DrawerSwipeAction.Close(DrawerSide.Left), action)
    }

    @Test fun `open drawer dragged further right stays open`() {
        val action = decideDrawerSwipe(
            startX = 600f, dx = 130f, dy = -10f,
            leftOpen = true, sheetWidth = sheet,
            zone = zone, travel = travel,
        )
        assertNull(action)
    }

    @Test fun `right edge drag never opens anything`() {
        val action = decideDrawerSwipe(
            startX = width - 5f, dx = -150f, dy = 0f,
            leftOpen = false, sheetWidth = sheet,
            zone = zone, travel = travel,
        )
        assertNull(action)
    }

    @Test fun `vertical dominant drag does nothing even at the bezel`() {
        val action = decideDrawerSwipe(
            startX = 5f, dx = 130f, dy = 200f,
            leftOpen = false, sheetWidth = sheet,
            zone = zone, travel = travel,
        )
        assertNull(action)
    }

    @Test fun `mid-screen drag does not open a drawer`() {
        val action = decideDrawerSwipe(
            startX = 500f, dx = 150f, dy = 0f,
            leftOpen = false, sheetWidth = sheet,
            zone = zone, travel = travel,
        )
        assertNull(action)
    }

    @Test fun `a leftward drag that starts on the open sheet is left to the rows`() {
        // Swipe-to-archive on a conversation row inside the sheet must not close the drawer.
        for (startX in listOf(10f, 400f, sheet)) {
            val action = decideDrawerSwipe(
                startX = startX, dx = -300f, dy = 5f,
                leftOpen = true, sheetWidth = sheet,
                zone = zone, travel = travel,
            )
            assertNull("startX=$startX", action)
        }
    }
}
