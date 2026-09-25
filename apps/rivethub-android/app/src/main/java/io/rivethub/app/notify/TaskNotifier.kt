package io.rivethub.app.notify

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import io.rivethub.app.MainActivity
import io.rivethub.app.R
import io.rivethub.app.plane.InboxEntry
import io.rivethub.app.plane.SystemNotifier
import io.rivethub.app.plane.systemNotificationId

/**
 * OS notification for a task completion while the app is backgrounded
 * (UX-SPEC §6 Inbox). v1 only: it posts while the process is alive — no
 * foreground service, no push; delivery after process death is phase 2.
 * The decision to post lives in plane/Inbox.kt shouldPostSystemNotification;
 * this class only renders and delivers.
 */
class TaskNotifier(context: Context) : SystemNotifier {
    private val app = context.applicationContext

    /** Creating a channel that already exists only refreshes its name, so this is safe to repeat. */
    fun ensureChannel() {
        val mgr = app.getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(
            CHANNEL_TASKS,
            app.getString(R.string.notif_channel_tasks),
            NotificationManager.IMPORTANCE_DEFAULT,
        )
        mgr.createNotificationChannel(channel)
    }

    @SuppressLint("MissingPermission") // checked inline below (API 33+) and guarded by the catch
    override fun post(entry: InboxEntry) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(app, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) return
        if (!NotificationManagerCompat.from(app).areNotificationsEnabled()) return
        ensureChannel()
        val id = systemNotificationId(entry)
        val open = Intent(app, MainActivity::class.java).apply {
            // NEW_TASK: the notification manager starts this with no source
            // activity (required by the startActivity contract); SINGLE_TOP +
            // the singleTask launch mode still deliver onNewIntent when running.
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_SINGLE_TOP or
                Intent.FLAG_ACTIVITY_CLEAR_TOP
            entry.taskId?.let { putExtra(EXTRA_OPEN_TASK_ID, it) }
            // Per-post nonce: a fresh tap for the same task opens again, a
            // re-read of an already-consumed intent does not (plane/OpenTaskTap.kt).
            putExtra(EXTRA_OPEN_TASK_NONCE, System.currentTimeMillis().toString())
        }
        val tap = PendingIntent.getActivity(
            app,
            id,
            open,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = NotificationCompat.Builder(app, CHANNEL_TASKS)
            .setSmallIcon(R.mipmap.ic_launcher_mono)
            .setContentTitle(entry.title)
            .setContentText(entry.body)
            .setWhen(entry.atMs)
            .setShowWhen(entry.atMs > 0L)
            .setAutoCancel(true)
            .setContentIntent(tap)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .build()
        try {
            NotificationManagerCompat.from(app).notify(id, n)
        } catch (e: SecurityException) {
            // permission revoked between the check and the post — drop this one
        }
    }

    companion object {
        const val CHANNEL_TASKS = "tasks"
        /** Intent extra carrying the completed task's id from a tapped notification. */
        const val EXTRA_OPEN_TASK_ID = "open_task_id"
        /** Intent extra: nonce stamped when the notification was posted. */
        const val EXTRA_OPEN_TASK_NONCE = "open_task_nonce"
    }
}
