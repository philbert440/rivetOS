package io.rivethub.app

import android.app.Application
import io.rivethub.app.data.DeviceIdentityStore
import io.rivethub.app.data.HttpFactory
import io.rivethub.app.data.HttpGatewayClients
import io.rivethub.app.data.LanNetwork
import io.rivethub.app.data.Settings
import io.rivethub.app.gateway.HarnessGateway
import io.rivethub.app.transport.DirectTransport
import io.rivethub.app.transport.NodeTransport
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking

/** Process-wide wiring. Small enough that a DI framework would be more code than it saves. */
class AppContainer(app: Application) {
    val settings = Settings(app)
    val identity = DeviceIdentityStore(app)
    val lan = LanNetwork(app)
    val http = HttpFactory(identity, lan)
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val clients = HttpGatewayClients(http, { strictHostnames })
    private val harnessCache = HashMap<String, Pair<String, HarnessGateway>>()

    @Volatile var strictHostnames: Boolean = true
        private set

    val transport: NodeTransport = DirectTransport("", emptySet(), clients)

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
