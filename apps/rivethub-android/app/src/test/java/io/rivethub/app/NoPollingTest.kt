package io.rivethub.app

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The chat path must stay frame-driven (Phil, 2026-09-06): no poll loops, no
 * periodic refresh. A source-substring guard, like the web's `refetchInterval`
 * assertion, keeps a `while { delay() }` loop from creeping back.
 */
class NoPollingTest {
    private fun src(rel: String): String {
        val f = File("src/main/java/io/rivethub/app/$rel")
        assertTrue("missing $rel", f.exists())
        return f.readText()
    }

    @Test
    fun chat_view_model_and_attach_have_no_poll_loops() {
        val loop = Regex("""while\s*\([^)]*\)\s*\{[^}]*delay\(""")
        for (
            rel in listOf(
                "ui/HarnessChatViewModel.kt",
                "plane/Attach.kt",
                "plane/Outbound.kt",
                "ui/HubViewModel.kt",
                "ui/components/NodeStatusStrip.kt",
                "ui/components/RivetDrawer.kt",
            )
        ) {
            val s = src(rel)
            assertFalse("$rel: a while/delay poll loop", loop.containsMatchIn(s))
            assertFalse("$rel: poll constant", "TRANSCRIPT_POLL_EVERY_MS" in s || "SESSION_POLL_EVERY_MS" in s)
        }
    }

    @Test
    fun notifications_inbox_is_socket_driven_with_no_foreground_service() {
        val loop = Regex("""while\s*\([^)]*\)\s*\{[^}]*delay\(""")
        for (rel in listOf("ui/HubViewModel.kt", "plane/Inbox.kt", "plane/NotificationsWatch.kt", "plane/OpenTaskTap.kt", "notify/TaskNotifier.kt", "notify/AppVisibility.kt")) {
            val s = src(rel)
            assertFalse("$rel: a while/delay poll loop", loop.containsMatchIn(s))
            assertFalse("$rel: starts a foreground service", "startForeground" in s)
        }
        val manifest = File("src/main/AndroidManifest.xml")
        assertTrue("missing manifest", manifest.exists())
        val m = manifest.readText()
        assertTrue("POST_NOTIFICATIONS not declared", "android.permission.POST_NOTIFICATIONS" in m)
        assertFalse("a foreground-service permission crept in", "FOREGROUND_SERVICE" in m)
        assertFalse("a <service> crept in", "<service" in m)
    }

    /**
     * Drawer v2 status strip (U2b): the dots derive from state and a tap is
     * one refresh — no delay, timer or ticker anywhere on that path.
     */
    @Test
    fun node_status_path_has_no_timers() {
        val timer = Regex("""\bdelay\(|\bTimer\(|\bticker\(|scheduleAtFixedRate|while\s*\(\s*true\s*\)""")
        for (
            rel in listOf(
                "plane/NodeStatus.kt",
                "ui/components/NodeStatusStrip.kt",
                "ui/components/DrawerFooter.kt",
                "ui/components/AgentsPickerSheet.kt",
                "plane/ActiveScroll.kt",
                "ui/components/RivetDrawer.kt",
                "ui/HubViewModel.kt",
            )
        ) {
            assertFalse("$rel: a timer on the status path", timer.containsMatchIn(src(rel)))
        }
    }
}
