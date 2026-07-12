package dev.rivet.app.service

import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import dev.rivet.app.R
import dev.rivet.app.RIVET_RUNTIME_NOTIFICATION_CHANNEL_ID
import dev.rivet.app.data.datastore.RIVET_BRIDGE_PORT
import dev.rivet.app.data.datastore.RIVET_SSH_PORT
import dev.rivet.app.data.datastore.SettingsStore
import dev.rivet.app.net.RivetVpn
import dev.rivet.app.runtime.RivetRuntime
import dev.rivet.app.runtime.RuntimeCommand
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.koin.android.ext.android.inject

/**
 * Foreground service that owns the on-device agent runtime: it launches the proot+node
 * bridge (Claude/Grok on loopback :8765) and the den-server gateway (rivethub-web + den
 * API/WS on loopback :5174), and keeps both alive across crashes and doze.
 * The actual scaffold + launch recipe lives in [RivetRuntime]; this is just lifecycle.
 *
 * Modeled on [WebServerService] (specialUse FGS). START_STICKY so Android revives it.
 */
class RivetRuntimeService : Service() {

    companion object {
        const val ACTION_START = "dev.rivet.app.action.RIVET_RUNTIME_START"
        const val ACTION_STOP = "dev.rivet.app.action.RIVET_RUNTIME_STOP"
        const val ACTION_SSH_START = "dev.rivet.app.action.RIVET_SSH_START"
        const val ACTION_SSH_STOP = "dev.rivet.app.action.RIVET_SSH_STOP"
        const val ACTION_VPN_START = "dev.rivet.app.action.RIVET_VPN_START"
        const val ACTION_VPN_STOP = "dev.rivet.app.action.RIVET_VPN_STOP"
        /** Clone + build the full RivetOS monorepo in the rootfs (~15 min). */
        const val ACTION_PROVISION = "dev.rivet.app.action.RIVET_RUNTIME_PROVISION"
        const val NOTIFICATION_ID = 2002
        private const val TAG = "RivetRuntimeService"

        /** Turn the on-device SSH server on/off. Ensures the runtime service is up first. */
        fun setSsh(context: Context, enabled: Boolean) {
            val intent = Intent(context, RivetRuntimeService::class.java).apply {
                action = if (enabled) ACTION_SSH_START else ACTION_SSH_STOP
            }
            context.startForegroundService(intent)
        }

        /** Bring the in-app mesh VPN tunnel up/down. VPN consent must already be granted. */
        fun setVpn(context: Context, enabled: Boolean) {
            val intent = Intent(context, RivetRuntimeService::class.java).apply {
                action = if (enabled) ACTION_VPN_START else ACTION_VPN_STOP
            }
            context.startForegroundService(intent)
        }

        /**
         * Start (or resume) the runtime service and kick off full-runtime self-provisioning.
         * Long-running (~15 min); must stay under this FGS so Android does not kill it.
         */
        fun startProvision(context: Context) {
            val intent = Intent(context, RivetRuntimeService::class.java).apply {
                action = ACTION_PROVISION
            }
            context.startForegroundService(intent)
        }
    }

    private val settingsStore: SettingsStore by inject()

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Volatile private var shouldRun = false
    @Volatile private var process: Process? = null
    @Volatile private var denProcess: Process? = null
    private var bridgeJob: Job? = null
    private var denJob: Job? = null
    private var provisionJob: Job? = null

    // --- dropbear SSH (track B) -------------------------------------------------------
    @Volatile private var sshShouldRun = false
    @Volatile private var sshProcess: Process? = null
    private var sshJob: Job? = null
    private var sshWakeLock: PowerManager.WakeLock? = null

    // Partial wakelock for the ~15 min provision so doze doesn't freeze npm/nx.
    private var provisionWakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopSsh()
                stopVpn()
                stopProvision()
                stopRuntime()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }

            ACTION_SSH_START -> {
                startForegroundCompat(buildNotification("Starting the on-device runtime…"))
                startRuntime()
                startSsh()
            }

            ACTION_SSH_STOP -> {
                startForegroundCompat(buildNotification("Claude + Grok bridge on 127.0.0.1:$RIVET_BRIDGE_PORT"))
                startRuntime()
                stopSsh()
            }

            ACTION_VPN_START -> {
                startForegroundCompat(buildNotification("Starting the on-device runtime…"))
                startRuntime()
                startVpn()
            }

            ACTION_VPN_STOP -> {
                startForegroundCompat(buildNotification("Starting the on-device runtime…"))
                startRuntime()
                stopVpn()
            }

            ACTION_PROVISION -> {
                startForegroundCompat(buildNotification("Provisioning node runtime — starting…"))
                // Keep bridge + standalone den up during provision (no regression while building).
                startRuntime()
                if (settingsStore.sshEnabledNow()) startSsh()
                if (settingsStore.vpnEnabledNow()) startVpn()
                startProvision()
            }

            else -> {
                // ACTION_START or null (sticky restart)
                startForegroundCompat(buildNotification("Starting the on-device runtime…"))
                startRuntime()
                // Resume SSH + mesh VPN across a sticky restart if the user had them on.
                if (settingsStore.sshEnabledNow()) startSsh()
                if (settingsStore.vpnEnabledNow()) startVpn()
            }
        }
        return START_STICKY
    }

    /**
     * Run [RivetRuntime.provisionFullRuntime] on a service coroutine. Updates the FGS
     * notification with progress. On success, restarts the den supervise job so it re-evaluates
     * [RivetRuntime.isFullRuntimeProvisioned] and launches the full monorepo runtime.
     */
    private fun startProvision() {
        if (provisionJob?.isActive == true || RivetRuntime.isProvisioning()) {
            Log.i(TAG, "provision already in flight — ignoring")
            updateNotification(buildNotification("Provisioning node runtime — ${RivetRuntime.provisionProgress.value ?: "in progress…"}"))
            return
        }
        acquireProvisionWakeLock()
        provisionJob = serviceScope.launch {
            try {
                val ok = RivetRuntime.provisionFullRuntime(this@RivetRuntimeService) { line ->
                    val short = RivetRuntime.provisionProgress.value ?: "working…"
                    updateNotification(buildNotification("Provisioning node runtime — $short"))
                    // line already logged by RivetRuntime under RivetProvision
                }
                if (ok) {
                    Log.i(TAG, "provision succeeded — restarting den for full runtime")
                    updateNotification(buildNotification("Full runtime ready — restarting den…"))
                    restartDen()
                    updateNotification(buildNotification("Full RivetOS runtime on 127.0.0.1:${RivetRuntime.DEN_PORT}"))
                } else {
                    updateNotification(buildNotification("Provision failed — see logcat RivetProvision"))
                }
            } finally {
                releaseProvisionWakeLock()
            }
        }
    }

    /** Cancel the den supervise slot and relaunch so command() re-picks full vs standalone. */
    private fun restartDen() {
        denJob?.cancel()
        denJob = null
        denProcess?.destroyForcibly()
        denProcess = null
        // startRuntime only starts den if denJob is not active.
        startRuntime()
    }

    private fun acquireProvisionWakeLock() {
        if (provisionWakeLock?.isHeld == true) return
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        provisionWakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RivetHub:provision").apply {
            setReferenceCounted(false)
            // ~20 min cap (build is ~15 min); auto-release if something goes wrong.
            acquire(20 * 60 * 1000L)
        }
    }

    private fun releaseProvisionWakeLock() {
        runCatching { if (provisionWakeLock?.isHeld == true) provisionWakeLock?.release() }
        provisionWakeLock = null
    }

    private fun stopProvision() {
        provisionJob?.cancel()
        provisionJob = null
        RivetRuntime.cancelProvision()
        releaseProvisionWakeLock()
    }

    /**
     * Supervise the bridge (:8765) and den-server (:5174) as parallel coroutines.
     * Both wait on [RivetRuntime.prepare] (overlays extracted) before first launch.
     */
    private fun startRuntime() {
        shouldRun = true
        if (bridgeJob?.isActive != true) {
            bridgeJob = serviceScope.launch {
                supervise(
                    name = "bridge",
                    logTag = "RivetBridge",
                    ownsSetupNotification = true,
                    onRunning = {
                        updateNotification(buildNotification("Claude + Grok bridge on 127.0.0.1:$RIVET_BRIDGE_PORT"))
                    },
                    onRestarting = {
                        updateNotification(buildNotification("Bridge stopped — restarting…"))
                    },
                    setProcess = { process = it },
                    command = { RivetRuntime.bridgeCommand(this@RivetRuntimeService) },
                )
            }
        }
        if (denJob?.isActive != true) {
            denJob = serviceScope.launch {
                supervise(
                    name = "den",
                    logTag = "RivetDen",
                    ownsSetupNotification = false,
                    onRunning = null,
                    onRestarting = null,
                    setProcess = { denProcess = it },
                    // Full runtime when provisioned (chat + den gateway); else standalone den bundle.
                    // Same RivetDen slot — never both (they collide on :5174).
                    command = {
                        if (RivetRuntime.isFullRuntimeProvisioned(this@RivetRuntimeService)) {
                            RivetRuntime.fullRuntimeCommand(this@RivetRuntimeService)
                        } else {
                            RivetRuntime.denCommand(this@RivetRuntimeService)
                        }
                    },
                )
            }
        }
    }

    /**
     * Shared supervise loop: prepare → launch → drain stdout to logcat → exponential
     * backoff on exit (1s→30s, reset after 30s healthy). Copied from the original bridge
     * supervisor so den gets identical keep-alive behavior.
     */
    private suspend fun supervise(
        name: String,
        logTag: String,
        ownsSetupNotification: Boolean,
        onRunning: (() -> Unit)?,
        onRestarting: (() -> Unit)?,
        setProcess: (Process?) -> Unit,
        command: () -> RuntimeCommand,
    ) {
        var backoffMs = 1_000L
        while (shouldRun) {
            if (ownsSetupNotification && !RivetRuntime.isRootfsReady(this)) {
                updateNotification(buildNotification("Installing the on-device runtime (first run, ~1 min)…"))
            }
            val notReady = RivetRuntime.prepare(this)
            if (notReady != null) {
                Log.w(TAG, "$name: runtime not ready: $notReady")
                if (ownsSetupNotification) {
                    updateNotification(buildNotification("Runtime setup failed — retrying… ($notReady)"))
                }
                delay(15_000)
                continue
            }

            val cmd = command()
            val startedAt = System.currentTimeMillis()
            try {
                val p = ProcessBuilder(cmd.argv)
                    .directory(cmd.workingDir)
                    .redirectErrorStream(true)
                    .apply { environment().putAll(cmd.env) }
                    .start()
                setProcess(p)
                onRunning?.invoke()
                Log.i(TAG, "$name launched via proot")

                val drain = serviceScope.launch {
                    runCatching {
                        p.inputStream.bufferedReader().forEachLine { Log.i(logTag, it) }
                    }
                }
                val code = p.waitFor()
                drain.cancel()
                Log.w(TAG, "$name exited code=$code")
            } catch (t: Throwable) {
                Log.e(TAG, "$name launch failed", t)
            } finally {
                setProcess(null)
            }

            if (!shouldRun) break

            // Reset backoff if the process had been up for a healthy while.
            if (System.currentTimeMillis() - startedAt > 30_000) backoffMs = 1_000L
            onRestarting?.invoke()
            delay(backoffMs)
            backoffMs = (backoffMs * 2).coerceAtMost(30_000L)
        }
    }

    private fun stopRuntime() {
        shouldRun = false
        bridgeJob?.cancel()
        bridgeJob = null
        denJob?.cancel()
        denJob = null
        process?.destroyForcibly()
        process = null
        denProcess?.destroyForcibly()
        denProcess = null
    }

    // --- dropbear SSH supervision (track B) -------------------------------------------

    private fun startSsh() {
        if (sshJob?.isActive == true) return
        sshShouldRun = true
        acquireSshWakeLock()
        sshJob = serviceScope.launch { superviseSsh() }
    }

    /** Keep dropbear alive across crashes + doze (a partial wakelock holds CPU so the listener runs). */
    private suspend fun superviseSsh() {
        var backoffMs = 1_000L
        while (sshShouldRun) {
            // prepare() is idempotent + sets up the native dropbear host key / authorized_keys
            // (ensureNativeSsh), so an app update can enable SSH without a full rootfs re-extract.
            val notReady = RivetRuntime.prepare(this)
            if (notReady != null) {
                Log.w(TAG, "ssh: runtime not ready: $notReady")
                delay(5_000)
                continue
            }
            val cmd = RivetRuntime.sshCommand(this)
            val startedAt = System.currentTimeMillis()
            try {
                val p = ProcessBuilder(cmd.argv)
                    .directory(cmd.workingDir)
                    .redirectErrorStream(true)
                    .apply { environment().putAll(cmd.env) }
                    .start()
                sshProcess = p
                updateNotification(buildNotification("SSH on :$RIVET_SSH_PORT · Claude + Grok bridge on :$RIVET_BRIDGE_PORT"))
                Log.i(TAG, "dropbear launched on :$RIVET_SSH_PORT")
                val drain = serviceScope.launch {
                    runCatching { p.inputStream.bufferedReader().forEachLine { Log.i("RivetDropbear", it) } }
                }
                val code = p.waitFor()
                drain.cancel()
                Log.w(TAG, "dropbear exited code=$code")
            } catch (t: Throwable) {
                Log.e(TAG, "dropbear launch failed", t)
            } finally {
                sshProcess = null
            }
            if (!sshShouldRun) break
            if (System.currentTimeMillis() - startedAt > 30_000) backoffMs = 1_000L
            delay(backoffMs)
            backoffMs = (backoffMs * 2).coerceAtMost(30_000L)
        }
    }

    private fun stopSsh() {
        sshShouldRun = false
        sshJob?.cancel()
        sshJob = null
        sshProcess?.destroyForcibly()
        sshProcess = null
        releaseSshWakeLock()
    }

    private fun acquireSshWakeLock() {
        if (sshWakeLock?.isHeld == true) return
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        sshWakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RivetHub:ssh").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun releaseSshWakeLock() {
        runCatching { if (sshWakeLock?.isHeld == true) sshWakeLock?.release() }
        sshWakeLock = null
    }

    // --- mesh VPN (in-app WireGuard via GoBackend) ------------------------------------
    // The tunnel auto-engages only when OFF the home network: on the home/mesh subnet the phone
    // already reaches datahub directly, and tunneling the mesh subnet there overlaps the very subnet
    // it's sitting on. So `vpnEnabled` is the user's intent ("use mesh when away") and we reconcile
    // desired-vs-actual on every connectivity change.
    @Volatile private var netCallback: ConnectivityManager.NetworkCallback? = null

    private fun startVpn() {
        registerNetCallback()
        serviceScope.launch { reconcileVpn() }
    }

    private fun stopVpn() {
        unregisterNetCallback()
        serviceScope.launch { RivetVpn.down(this@RivetRuntimeService) }
    }

    /** Match the tunnel to intent (vpnEnabled) AND network (off-home only). Idempotent. */
    private suspend fun reconcileVpn() {
        val want = settingsStore.vpnEnabledNow() && !RivetVpn.isOnHomeNetwork(this)
        val isUp = RivetVpn.status.value == RivetVpn.Status.UP
        when {
            want && !isUp -> {
                RivetVpn.up(this)
                // Surface the real outcome (incl. failure) — off-home memory rides this tunnel.
                updateNotification(buildNotification(when (RivetVpn.status.value) {
                    RivetVpn.Status.UP -> "Mesh VPN up (away) · bridge on :$RIVET_BRIDGE_PORT"
                    RivetVpn.Status.ERROR -> "Mesh VPN error (away) — mesh unreachable, check relay"
                    else -> "Mesh VPN connecting (away)…"
                }))
            }
            !want && isUp -> {
                RivetVpn.down(this)
                val text = if (RivetVpn.status.value == RivetVpn.Status.DOWN)
                    "Mesh VPN idle (home WiFi — direct) · bridge on :$RIVET_BRIDGE_PORT"
                else "Mesh VPN: failed to disengage (state ${RivetVpn.status.value})"
                updateNotification(buildNotification(text))
            }
        }
    }

    /** Watch wifi/cellular transitions so we engage/disengage the tunnel when home↔away changes. */
    private fun registerNetCallback() {
        if (netCallback != null) return
        val cm = getSystemService(ConnectivityManager::class.java) ?: return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { serviceScope.launch { reconcileVpn() } }
            override fun onLost(network: Network) { serviceScope.launch { reconcileVpn() } }
        }
        netCallback = cb
        val req = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR)
            .addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET)
            .build()
        runCatching { cm.registerNetworkCallback(req, cb) }
    }

    private fun unregisterNetCallback() {
        netCallback?.let { cb -> runCatching { getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(cb) } }
        netCallback = null
    }

    override fun onDestroy() {
        stopSsh()
        stopVpn()
        stopProvision()
        stopRuntime()
        serviceScope.cancel()
        super.onDestroy()
    }

    // --- notifications ----------------------------------------------------------------

    private fun startForegroundCompat(notification: android.app.Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun updateNotification(notification: android.app.Notification) {
        val nm = getSystemService(NOTIFICATION_SERVICE) as android.app.NotificationManager
        nm.notify(NOTIFICATION_ID, notification)
    }

    private fun buildLaunchPendingIntent() = PendingIntent.getActivity(
        this,
        0,
        packageManager.getLaunchIntentForPackage(packageName),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )

    private fun buildNotification(text: String): android.app.Notification {
        val stopIntent = Intent(this, RivetRuntimeService::class.java).apply { action = ACTION_STOP }
        val stopPendingIntent = PendingIntent.getService(this, 0, stopIntent, PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, RIVET_RUNTIME_NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(R.drawable.small_icon)
            .setContentTitle("Rivet runtime")
            .setContentText(text)
            .setContentIntent(buildLaunchPendingIntent())
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(0, "Stop", stopPendingIntent)
            .build()
    }
}
