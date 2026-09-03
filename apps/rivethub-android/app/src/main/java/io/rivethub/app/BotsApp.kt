package io.rivethub.app

import android.app.Application
import io.rivethub.app.data.BotRepository
import io.rivethub.app.data.DeviceIdentityStore
import io.rivethub.app.data.GatewayPool
import io.rivethub.app.data.HttpFactory
import io.rivethub.app.data.LanNetwork
import io.rivethub.app.data.Settings
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

    @Volatile var strictHostnames: Boolean = true
        private set

    val gateways = GatewayPool(http, { strictHostnames }, identity)
    val bots = BotRepository(gateways)

    init {
        // Seed the TLS posture synchronously so the first request honours it.
        strictHostnames = runBlocking { settings.prefs.first().strictHostnames }
    }

    fun setStrictHostnames(v: Boolean) { strictHostnames = v }
}

class BotsApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}
