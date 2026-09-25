package io.rivethub.app.plane

import io.rivethub.app.gateway.NotificationFrame
import kotlin.coroutines.cancellation.CancellationException

/**
 * The in-memory notification inbox (UX-SPEC §6 Inbox), fed only by
 * `WS /api/notifications/ws` on the entry node. Nothing here persists —
 * `/api/outcomes` is the durable record on the den; this is the tap on the
 * shoulder. Pure so the dedupe / cap / routing rules have JVM tests.
 */

/** Most entries kept; the oldest fall off the end. */
const val INBOX_MAX = 50

const val INBOX_KIND_ESCALATION = "escalation"
const val INBOX_KIND_TASK_DONE = "task.done"
const val INBOX_KIND_GATE = "workflow.gate"

/** Short task id shown as a completion's body (and in a blank escalation). */
private const val SHORT_ID_LEN = 8

data class InboxEntry(
    val id: String,
    val kind: String,
    val title: String,
    val body: String,
    val atMs: Long,
    val taskId: String? = null,
    val href: String? = null,
    val read: Boolean = false,
)

/**
 * Title templates, each with one `%1$s` slot, plus the word shown for a
 * completion whose frame carried no status. Every field is required and has
 * no default: strings.xml is the ONE wording source. MainActivity builds these
 * from resources and hands them to the HubViewModel constructor; tests use
 * their own fixture.
 */
data class InboxLabels(
    val escalationTitle: String,
    val taskDoneTitle: String,
    val gateTitle: String,
    val taskDoneStatusFallback: String,
)

/** Where tapping an inbox row goes. Gates have no phone screen yet. */
sealed interface InboxRoute {
    data class Task(val taskId: String) : InboxRoute
}

/** Posts an OS notification for one entry — implemented on the Android side. */
fun interface SystemNotifier {
    fun post(entry: InboxEntry)
}

fun shortTaskId(taskId: String): String = taskId.take(SHORT_ID_LEN)

/**
 * One frame → one entry, or null for a kind this build does not show.
 * [nowMs] stamps a frame whose `ts` is missing. Ids: escalation and gate
 * `<kind>:<taskId|runId>:<ts>`; completion `<kind>:<taskId>:<status>` — so
 * the same completion rebroadcast by a second den collapses to one row.
 */
fun inboxEntryFor(frame: NotificationFrame, labels: InboxLabels, nowMs: Long = 0L): InboxEntry? = when (frame) {
    is NotificationFrame.Escalation -> InboxEntry(
        id = "$INBOX_KIND_ESCALATION:${frame.taskId}:${frame.ts}",
        kind = INBOX_KIND_ESCALATION,
        title = labels.escalationTitle.format(frame.agentId.ifBlank { shortTaskId(frame.taskId) }),
        body = frame.summary.trim().ifBlank { shortTaskId(frame.taskId) },
        atMs = stamp(frame.ts, nowMs),
        taskId = frame.taskId,
        href = frame.href,
    )
    is NotificationFrame.TaskDone -> InboxEntry(
        id = "$INBOX_KIND_TASK_DONE:${frame.taskId}:${frame.status}",
        kind = INBOX_KIND_TASK_DONE,
        title = labels.taskDoneTitle.format(frame.status.ifBlank { labels.taskDoneStatusFallback }),
        body = shortTaskId(frame.taskId),
        atMs = stamp(frame.ts, nowMs),
        taskId = frame.taskId,
        href = "/tasks/${frame.taskId}",
    )
    is NotificationFrame.WorkflowGate -> InboxEntry(
        id = "$INBOX_KIND_GATE:${frame.runId}:${frame.ts}",
        kind = INBOX_KIND_GATE,
        title = labels.gateTitle.format(frame.label.ifBlank { frame.workflowId.ifBlank { frame.runId } }),
        body = frame.prompt?.trim()?.takeIf { it.isNotEmpty() } ?: frame.workflowId.ifBlank { frame.runId },
        atMs = stamp(frame.ts, nowMs),
        href = frame.href,
    )
    is NotificationFrame.Other -> null
}

private fun stamp(ts: Long, nowMs: Long): Long = if (ts > 0L) ts else nowMs

/**
 * Newest first, capped at [INBOX_MAX]. An id already present leaves the list
 * untouched (keeps its read state) — the dedupe for a phone attached to more
 * than one den, and for a socket that re-delivers after a reconnect.
 */
fun pushInbox(list: List<InboxEntry>, entry: InboxEntry): List<InboxEntry> {
    if (list.any { it.id == entry.id }) return list
    return (listOf(entry) + list).take(INBOX_MAX)
}

fun markRead(list: List<InboxEntry>, id: String): List<InboxEntry> {
    if (list.none { it.id == id && !it.read }) return list
    return list.map { if (it.id == id) it.copy(read = true) else it }
}

fun unreadCount(list: List<InboxEntry>): Int = list.count { !it.read }

fun inboxRoute(entry: InboxEntry): InboxRoute? {
    val taskId = entry.taskId?.takeIf { it.isNotBlank() } ?: return null
    return when (entry.kind) {
        INBOX_KIND_TASK_DONE, INBOX_KIND_ESCALATION -> InboxRoute.Task(taskId)
        else -> null
    }
}

/**
 * v1 scope: only a task completion, only while the process is alive but the
 * app is NOT on screen, only with the Settings toggle on. On screen the
 * inbox badge already says it.
 */
fun shouldPostSystemNotification(entry: InboxEntry, appResumed: Boolean, enabled: Boolean): Boolean =
    enabled && !appResumed && entry.kind == INBOX_KIND_TASK_DONE

/** Stable OS notification id per task, so a repeat completion replaces rather than stacks. */
fun systemNotificationId(entry: InboxEntry): Int = (entry.taskId ?: entry.id).hashCode()

/**
 * Runs one side effect of a notification frame (the Tasks refresh hook, the
 * OS post) so that a throw from it cannot end the single frame-reading loop:
 * any [Exception] goes to [onError] and is swallowed; cancellation still
 * propagates. True when [block] completed.
 */
fun runNotificationHook(onError: (Exception) -> Unit, block: () -> Unit): Boolean =
    try {
        block()
        true
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        onError(e)
        false
    }
