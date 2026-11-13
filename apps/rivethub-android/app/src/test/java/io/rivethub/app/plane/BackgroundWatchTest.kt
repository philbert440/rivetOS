package io.rivethub.app.plane

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BackgroundWatchTest {
    private val entry = "https://arctic.example:5174"

    @Test fun `any alert toggle on a paired phone wants the background connection`() {
        assertTrue(wantsBackgroundWatch(entry, taskNotifications = true, agentFinishedNotifications = false, needsYouNotifications = false))
        assertTrue(wantsBackgroundWatch(entry, taskNotifications = false, agentFinishedNotifications = true, needsYouNotifications = false))
        assertTrue(wantsBackgroundWatch(entry, taskNotifications = false, agentFinishedNotifications = false, needsYouNotifications = true))
    }

    @Test fun `every alert off, or no paired node, wants none`() {
        assertFalse(wantsBackgroundWatch(entry, taskNotifications = false, agentFinishedNotifications = false, needsYouNotifications = false))
        assertFalse(wantsBackgroundWatch("", taskNotifications = true, agentFinishedNotifications = true, needsYouNotifications = true))
        assertFalse(wantsBackgroundWatch("  ", taskNotifications = true, agentFinishedNotifications = false, needsYouNotifications = false))
    }

    @Test fun `on screen every socket retries, away only watchers, and only with the connection on`() {
        assertTrue(retriesAllowed(foreground = true, watcher = false, backgroundWatch = false))
        assertFalse(retriesAllowed(foreground = false, watcher = false, backgroundWatch = true))
        assertFalse(retriesAllowed(foreground = false, watcher = true, backgroundWatch = false))
        assertTrue(retriesAllowed(foreground = false, watcher = true, backgroundWatch = true))
    }
}
