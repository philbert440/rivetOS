package io.rivethub.app

import android.app.Application
import io.rivethub.app.data.DeviceIdentityStore
import io.rivethub.app.data.HttpFactory
import io.rivethub.app.data.HttpGatewayClients
import io.rivethub.app.data.HubStateRepository
import io.rivethub.app.data.HubSyncIo
import io.rivethub.app.data.HubSynced
import io.rivethub.app.data.LanNetwork
import io.rivethub.app.data.PairingClient
import io.rivethub.app.data.Settings
import io.rivethub.app.data.hubPrefs
import io.rivethub.app.gateway.Gateway
import io.rivethub.app.gateway.HarnessGateway
import io.rivethub.app.gateway.HubState
import io.rivethub.app.gateway.HubStatePutResult
import io.rivethub.app.gateway.HubStateResponse
import io.rivethub.app.notify.AppVisibility
import io.rivethub.app.notify.TaskNotifier
import io.rivethub.app.plane.InboxLabels
import io.rivethub.app.plane.LocalHubPrefs
import io.rivethub.app.transport.DirectTransport
import io.rivethub.app.transport.NodeTransport
import io.rivethub.app.ui.HubViewModel
import io.rivethub.app.update.Updater
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking

/** Process-wide wiring. Small enough that a DI framework would be more code than it saves. */
class AppContainer(private val app: Application) {
    val settings = Settings(app)
    val identity = DeviceIdentityStore(app)
    val lan = LanNetwork(app)
    val http = HttpFactory(identity, lan)
    val pairing = PairingClient(lan)
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val clients = HttpGatewayClients(http, { strictHostnames })
    private val harnessCache = HashMap<String, Pair<String, HarnessGateway>>()

    @Volatile var strictHostnames: Boolean = true
        private set

    val transport: NodeTransport = DirectTransport("", emptySet(), clients)
    val updater = Updater(app.cacheDir, BuildConfig.VERSION_CODE, BuildConfig.VERSION_NAME)

    /** App on screen or not — MainActivity observes its lifecycle into this. */
    val visibility = AppVisibility()

    /** OS notification for a backgrounded task completion (Settings toggle). */
    val taskNotifier = TaskNotifier(app)

    /** Names, archive, pins, hidden and modes shared with desktop via the entry den. */
    val hubState: HubStateRepository = HubStateRepository(
        io = object : HubSyncIo {
            private var probed: Pair<String, String>? = null

            override suspend fun entryUrl(): String = settings.snapshot().entryUrl

            /** Only talk to the entry the transport is actually pointed at. */
            private suspend fun entry(): Gateway {
                val url = entryUrl()
                val gw = transport.entry()
                if (url.isBlank() || gw.baseUrl != url.trimEnd('/')) throw IllegalStateException("entry not ready")
                return gw
            }

            override suspend fun nodeId(): String? {
                val gw = entry()
                probed?.let { (url, node) -> if (url == gw.baseUrl) return node }
                val hz = gw.healthz()
                val node = hz.node.ifBlank { hz.name }.ifBlank { return null }
                probed = gw.baseUrl to node
                return node
            }

            override suspend fun fetch(): HubStateResponse = entry().hubState()
            override suspend fun put(baseVersion: Long, state: HubState): HubStatePutResult =
                entry().putHubState(baseVersion, state)
            override suspend fun local(): LocalHubPrefs = settings.snapshot().hubPrefs()
            override suspend fun apply(expected: LocalHubPrefs, next: LocalHubPrefs): Boolean =
                settings.applyHubPrefs(expected, next)
            override suspend fun loadSynced(): HubSynced? = settings.hubSynced()
            override suspend fun saveSynced(synced: HubSynced) {
                settings.setHubSynced(synced)
            }
        },
        prefs = settings.hubPrefs,
        scope = scope,
    )

    /**
     * The hub: conversation list, registry watches and the alert detection
     * (needs you, agent finished, inbox). It lives as long as the process,
     * not the activity, so the background connection (notify/AlertService)
     * keeps alerting after the screen is gone. Main thread only. MainActivity
     * re-hands the labels after a locale change and adds the open chat.
     */
    val hub: HubViewModel by lazy {
        HubViewModel(this, inboxLabels()).apply {
            systemNotifier = taskNotifier
            appResumed = { visibility.resumed }
            agentFinishedTitle = app.getString(R.string.notif_agent_finished_title)
            needsYouTitle = app.getString(R.string.notif_needs_you_title)
        }
    }

    fun inboxLabels() = InboxLabels(
        escalationTitle = app.getString(R.string.inbox_escalation_title),
        taskDoneTitle = app.getString(R.string.inbox_task_done_title),
        gateTitle = app.getString(R.string.inbox_gate_title),
        taskDoneStatusFallback = app.getString(R.string.inbox_task_done_status_fallback),
    )

    init {
        // Seed the TLS posture synchronously so the first request honours it.
        strictHostnames = runBlocking { settings.prefs.first().strictHostnames }
    }

    fun setStrictHostnames(v: Boolean) { strictHostnames = v }

    fun harness(denUrl: String): HarnessGateway {
        val key = clients.cacheKey()
        val norm = denUrl.trim().trimEnd('/')
        synchronized(harnessCache) {
            harnessCache[norm]?.let { (k, g) -> if (k == key) return g }
            val g = HarnessGateway(clients.primary(), norm, clients.fallback())
            harnessCache[norm] = key to g
            return g
        }
    }

    /** Identity or TLS posture changed — drop cached gateways so the next call rebuilds. */
    fun dropClients() {
        transport.clear()
        synchronized(harnessCache) { harnessCache.clear() }
    }
}

class BotsApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}
