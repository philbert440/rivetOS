package io.rivethub.app.plane

import io.rivethub.app.gateway.NotificationFrame
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * English test fixture mirroring res/values/strings.xml. Production has no
 * InboxLabels defaults — MainActivity builds them from resources.
 */
internal val TEST_INBOX_LABELS = InboxLabels(
    escalationTitle = "Escalation — %1\$s",
    taskDoneTitle = "Task %1\$s",
    gateTitle = "Workflow paused — %1\$s",
    taskDoneStatusFallback = "done",
)

class InboxTest {
    private val labels = TEST_INBOX_LABELS

    private fun done(taskId: String = "task-0123456789", status: String = "completed", ts: Long = 100L) =
        inboxEntryFor(NotificationFrame.TaskDone(taskId, status, ts), labels)!!

    private fun entry(id: String, read: Boolean = false) =
        InboxEntry(id = id, kind = INBOX_KIND_TASK_DONE, title = "t", body = "b", atMs = 1L, taskId = id, read = read)

    @Test fun `escalation entry carries agent title summary body and task link`() {
        val e = inboxEntryFor(
            NotificationFrame.Escalation("t1", "reviewer", "  needs a decision  ", "/tasks/t1", 42L),
            labels,
        )!!
        assertEquals("escalation:t1:42", e.id)
        assertEquals(INBOX_KIND_ESCALATION, e.kind)
        assertEquals("Escalation — reviewer", e.title)
        assertEquals("needs a decision", e.body)
        assertEquals(42L, e.atMs)
        assertEquals("t1", e.taskId)
        assertEquals("/tasks/t1", e.href)
        assertFalse(e.read)
    }

    @Test fun `task done entry titles the status and shows the short id`() {
        val e = done(taskId = "abcdef0123456789", status = "failed", ts = 7L)
        assertEquals("task.done:abcdef0123456789:failed", e.id)
        assertEquals(INBOX_KIND_TASK_DONE, e.kind)
        assertEquals("Task failed", e.title)
        assertEquals("abcdef01", e.body)
        assertEquals("abcdef0123456789", e.taskId)
        assertEquals("/tasks/abcdef0123456789", e.href)
    }

    @Test fun `gate entry uses label and prompt and falls back when prompt is blank`() {
        val g = inboxEntryFor(
            NotificationFrame.WorkflowGate("r1", "wf-release", "Ship it?", "Approve the release", "/workflows/runs/r1", 9L),
            labels,
        )!!
        assertEquals("workflow.gate:r1:9", g.id)
        assertEquals("Workflow paused — Ship it?", g.title)
        assertEquals("Approve the release", g.body)
        assertNull(g.taskId)
        val bare = inboxEntryFor(NotificationFrame.WorkflowGate("r2", "wf-release", "Gate", "  ", "/workflows/runs/r2", 9L), labels)!!
        assertEquals("wf-release", bare.body)
        val noPrompt = inboxEntryFor(NotificationFrame.WorkflowGate("r3", "", "Gate", null, "/workflows/runs/r3", 9L), labels)!!
        assertEquals("r3", noPrompt.body)
    }

    @Test fun `unknown kind yields no entry`() {
        assertNull(inboxEntryFor(NotificationFrame.Other("outcome.new"), labels))
    }

    @Test fun `custom labels are applied and a missing ts takes now`() {
        val custom = labels.copy(escalationTitle = "E:%1\$s", taskDoneTitle = "T:%1\$s", gateTitle = "G:%1\$s")
        val e = inboxEntryFor(NotificationFrame.TaskDone("t9", "killed", 0L), custom, nowMs = 555L)!!
        assertEquals("T:killed", e.title)
        assertEquals(555L, e.atMs)
    }

    @Test fun `push is newest first and dedupes by id keeping read state`() {
        val a = done(taskId = "a")
        val b = done(taskId = "b")
        val one = pushInbox(emptyList(), a)
        val two = pushInbox(one, b)
        assertEquals(listOf("task.done:b:completed", "task.done:a:completed"), two.map { it.id })
        val read = markRead(two, a.id)
        val again = pushInbox(read, done(taskId = "a", ts = 999L))
        assertSame(read, again)
        assertTrue(again.first { it.id == a.id }.read)
    }

    @Test fun `same completion from a second den collapses but a new status does not`() {
        val first = pushInbox(emptyList(), done(taskId = "x", status = "completed", ts = 1L))
        val dup = pushInbox(first, done(taskId = "x", status = "completed", ts = 2L))
        assertEquals(1, dup.size)
        val other = pushInbox(dup, done(taskId = "x", status = "failed", ts = 3L))
        assertEquals(2, other.size)
    }

    @Test fun `push caps at INBOX_MAX dropping the oldest`() {
        var list = emptyList<InboxEntry>()
        for (i in 0 until INBOX_MAX + 5) list = pushInbox(list, entry("e$i"))
        assertEquals(INBOX_MAX, list.size)
        assertEquals("e${INBOX_MAX + 4}", list.first().id)
        assertEquals("e5", list.last().id)
    }

    @Test fun `mark read and unread count`() {
        val list = listOf(entry("a"), entry("b"), entry("c", read = true))
        assertEquals(2, unreadCount(list))
        val next = markRead(list, "a")
        assertEquals(1, unreadCount(next))
        assertTrue(next.first { it.id == "a" }.read)
        assertSame(next, markRead(next, "a"))
        assertSame(next, markRead(next, "missing"))
        assertEquals(0, unreadCount(emptyList()))
    }

    @Test fun `route opens the task for completions and escalations only`() {
        assertEquals(InboxRoute.Task("t1"), inboxRoute(done(taskId = "t1")))
        val esc = inboxEntryFor(NotificationFrame.Escalation("t2", "a", "s", "/tasks/t2", 1L), labels)!!
        assertEquals(InboxRoute.Task("t2"), inboxRoute(esc))
        val gate = inboxEntryFor(NotificationFrame.WorkflowGate("r", "w", "l", null, "/workflows/runs/r", 1L), labels)!!
        assertNull(inboxRoute(gate))
        assertNull(inboxRoute(done().copy(taskId = " ")))
    }

    @Test fun `system notification only for a backgrounded completion with the toggle on`() {
        val d = done()
        assertTrue(shouldPostSystemNotification(d, appResumed = false, enabled = true))
        assertFalse(shouldPostSystemNotification(d, appResumed = true, enabled = true))
        assertFalse(shouldPostSystemNotification(d, appResumed = false, enabled = false))
        val esc = inboxEntryFor(NotificationFrame.Escalation("t", "a", "s", "/tasks/t", 1L), labels)!!
        assertFalse(shouldPostSystemNotification(esc, appResumed = false, enabled = true))
    }

    @Test fun `system notification id is stable per task`() {
        assertEquals(
            systemNotificationId(done(taskId = "t", status = "completed")),
            systemNotificationId(done(taskId = "t", status = "failed")),
        )
        assertEquals("t".hashCode(), systemNotificationId(done(taskId = "t")))
    }

    @Test fun `blank completion status takes the resource-backed fallback from the labels`() {
        val custom = labels.copy(taskDoneTitle = "T:%1\$s", taskDoneStatusFallback = "fertig")
        val e = inboxEntryFor(NotificationFrame.TaskDone("t9", "  ", 5L), custom)!!
        assertEquals("T:fertig", e.title)
        assertEquals("Task done", inboxEntryFor(NotificationFrame.TaskDone("t9", "", 5L), labels)!!.title)
    }

    @Test fun `a throwing notification hook is reported and does not escape`() {
        val errors = mutableListOf<Exception>()
        val ok = runNotificationHook(onError = { errors += it }) { throw IllegalStateException("boom") }
        assertFalse(ok)
        assertEquals(listOf("boom"), errors.map { it.message })
        // The next frame's hooks still run — the loop is alive.
        var ran = false
        assertTrue(runNotificationHook(onError = { errors += it }) { ran = true })
        assertTrue(ran)
        assertEquals(1, errors.size)
    }

    @Test fun `cancellation is not swallowed by the notification hook guard`() {
        val errors = mutableListOf<Exception>()
        val thrown = try {
            runNotificationHook(onError = { errors += it }) { throw kotlin.coroutines.cancellation.CancellationException("stop") }
            null
        } catch (e: kotlin.coroutines.cancellation.CancellationException) {
            e
        }
        assertEquals("stop", thrown?.message)
        assertTrue(errors.isEmpty())
    }
}
