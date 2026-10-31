package io.rivethub.app

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The chat path must stay frame-driven (2026-09-06): no poll loops, no
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

    /**
     * The alert path is socket-driven: no poll loops anywhere on it. Since
     * 2026-10-31 one foreground service is allowed, the background connection
     * (notify/AlertService, UX-SPEC §6). It only keeps the process alive so
     * the sockets stay up; it never fetches on a timer, and no other service
     * or foreground-service type may join it.
     */
    @Test
    fun notifications_are_socket_driven_and_only_the_background_connection_is_a_service() {
        val loop = Regex("""while\s*\([^)]*\)\s*\{[^}]*delay\(""")
        val timer = Regex("""\bdelay\(|\bTimer\(|\bticker\(|scheduleAtFixedRate|WorkManager|AlarmManager""")
        for (rel in listOf("ui/HubViewModel.kt", "plane/Inbox.kt", "plane/NotificationsWatch.kt", "plane/OpenTaskTap.kt", "notify/TaskNotifier.kt", "notify/AppVisibility.kt", "notify/AlertService.kt", "plane/BackgroundWatch.kt")) {
            val s = src(rel)
            assertFalse("$rel: a while/delay poll loop", loop.containsMatchIn(s))
            if (rel != "notify/AlertService.kt") assertFalse("$rel: starts a foreground service", "startForeground" in s)
        }
        assertFalse("notify/AlertService.kt: a timer", timer.containsMatchIn(src("notify/AlertService.kt")))
        val manifest = File("src/main/AndroidManifest.xml")
        assertTrue("missing manifest", manifest.exists())
        val m = manifest.readText()
        assertTrue("POST_NOTIFICATIONS not declared", "android.permission.POST_NOTIFICATIONS" in m)
        assertTrue("one <service>, the background connection", Regex("<service").findAll(m).count() == 1 && ".notify.AlertService" in m)
        val fgsPerms = Regex("""android\.permission\.FOREGROUND_SERVICE[A-Z_]*""").findAll(m).map { it.value }.toSet()
        assertTrue(
            "foreground-service permissions beyond remote messaging: $fgsPerms",
            fgsPerms == setOf("android.permission.FOREGROUND_SERVICE", "android.permission.FOREGROUND_SERVICE_REMOTE_MESSAGING"),
        )
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
