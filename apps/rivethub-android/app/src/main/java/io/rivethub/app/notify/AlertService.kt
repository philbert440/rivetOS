package io.rivethub.app.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import io.rivethub.app.BotsApp
import io.rivethub.app.MainActivity
import io.rivethub.app.R
import io.rivethub.app.data.AndroidLogger
import io.rivethub.app.gateway.AppForeground

/**
 * The background connection (UX-SPEC §6, plane/BackgroundWatch.kt). A
 * foreground service with a quiet ongoing notice: it keeps the process alive
 * and unfrozen so the hub's watcher sockets stay connected and alerts post
 * while the app is away. It holds no socket itself; the process-scoped hub
 * (AppContainer.hub) does the watching. MainActivity starts and stops it
 * from the alert toggles.
 */
class AlertService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val container = (application as BotsApp).container
        ensureChannel(this)
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notice = NotificationCompat.Builder(this, CHANNEL_CONNECTION)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.notif_connection_title))
            .setContentText(getString(R.string.notif_connection_body))
            .setContentIntent(open)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
        } else {
            0
        }
        try {
            ServiceCompat.startForeground(this, NOTICE_ID, notice, type)
        } catch (e: RuntimeException) {
            // Android refuses a foreground start from the background (e.g. a
            // sticky restart after the process died). The next app open starts it again.
            AndroidLogger.warn("RivetHub", "background connection not started: ${e.javaClass.simpleName}: ${e.message}", e)
            stopSelf()
            return START_NOT_STICKY
        }
        AppForeground.backgroundWatch = true
        // A restart without the screen: bring the hub up so the watches open.
        if (container.hub.state.value.nodes.isEmpty()) container.hub.refresh()
        return START_STICKY
    }

    override fun onDestroy() {
        AppForeground.backgroundWatch = false
        super.onDestroy()
    }

    companion object {
        const val CHANNEL_CONNECTION = "connection"
        private const val NOTICE_ID = 0x5257 // any id that no other notice uses

        fun ensureChannel(context: Context) {
            val mgr = context.getSystemService(NotificationManager::class.java) ?: return
            mgr.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_CONNECTION,
                    context.getString(R.string.notif_channel_connection),
                    NotificationManager.IMPORTANCE_MIN,
                ),
            )
        }

        /** Start or stop the background connection. Call while the app is on screen. */
        fun sync(context: Context, wanted: Boolean) {
            val intent = Intent(context, AlertService::class.java)
            if (wanted) {
                runCatching { ContextCompat.startForegroundService(context, intent) }
                    .onFailure { AndroidLogger.warn("RivetHub", "background connection start failed: ${it.message}", it) }
            } else {
                context.stopService(intent)
            }
        }
    }
}
