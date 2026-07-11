package dev.rivet.app.ui.pages.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.rivet.app.data.datastore.RIVET_BRIDGE_PORT
import dev.rivet.app.data.datastore.SettingsStore
import dev.rivet.app.device.RivetAccessibilityService
import dev.rivet.app.net.RivetVpn
import dev.rivet.app.ui.modifier.onClick
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import org.koin.compose.koinInject
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL

/**
 * Compact node-health row for the drawer: one dot per subsystem, polled on a 20s ticker
 * ONLY while the drawer is open ([active]) — zero background battery cost. Tap re-polls.
 *
 *  - **agent**: the LLM bridge answering GET :8765/health (unauthenticated). The bridge only
 *    runs if the proot runtime is up, so this doubles as the runtime check (the service
 *    exposes no cheap process-alive state — deliberately folded rather than inventing IPC).
 *  - **a11y**: device control — the accessibility-service binding state, read in-process
 *    (the ControlServer lives inside that service), so it reacts instantly to the toggle.
 *  - **mesh**: WireGuard tunnel state straight from [RivetVpn] (no polling needed); the
 *    home-WiFi auto-idle state renders distinctly (hollow dot, primary tint).
 *  - **hub**: datahub Postgres — TCP reach to <configured shared host>:5432 (idle if unset).
 */
@Composable
fun NodeStatusStrip(
    active: Boolean,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current

    var bridgeUp by remember { mutableStateOf<Boolean?>(null) }
    var datahubUp by remember { mutableStateOf<Boolean?>(null) }
    var onHomeWifi by remember { mutableStateOf(false) }
    var pollNonce by remember { mutableIntStateOf(0) }

    val settingsStore = koinInject<SettingsStore>()
    val vpnEnabled by settingsStore.vpnEnabledFlow.collectAsStateWithLifecycle(initialValue = false)
    val vpnStatus by RivetVpn.status.collectAsStateWithLifecycle(initialValue = RivetVpn.Status.DOWN)
    val a11yUp by RivetAccessibilityService.connected.collectAsStateWithLifecycle()

    LaunchedEffect(active, pollNonce) {
        if (!active) return@LaunchedEffect
        while (isActive) {
            coroutineScope {
                val bridge = async(Dispatchers.IO) {
                    httpReachable("http://127.0.0.1:$RIVET_BRIDGE_PORT/health")
                }
                val datahub = async(Dispatchers.IO) {
                    dev.rivet.app.net.MeshRuntimeConfig.current.sharedHost
                        .takeIf { it.isNotBlank() }?.let { tcpReachable(it, 5432) }
                }
                val home = async(Dispatchers.IO) { RivetVpn.isOnHomeNetwork(context) }
                bridgeUp = bridge.await()
                datahubUp = datahub.await()
                onHomeWifi = home.await()
            }
            delay(20_000)
        }
    }

    val cs = MaterialTheme.colorScheme
    val up = cs.primary
    val down = cs.error
    val idle = cs.onSurfaceVariant

    Row(
        modifier = modifier
            .fillMaxWidth()
            .onClick { pollNonce++ }
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        StatusDot(
            label = "agent",
            filled = bridgeUp == true,
            color = when (bridgeUp) { true -> up; false -> down; null -> idle },
        )
        StatusDot(
            label = "a11y",
            filled = a11yUp,
            color = if (a11yUp) up else down,
        )
        // Mesh: enabled+UP = solid primary; enabled but idle on home WiFi = hollow primary
        // (tunnel intentionally down, mesh still reachable directly); enabled+down/error =
        // solid error; off/unconfigured = hollow neutral.
        val meshHome = vpnEnabled && vpnStatus != RivetVpn.Status.UP && onHomeWifi
        StatusDot(
            label = if (meshHome) "mesh·home" else "mesh",
            filled = vpnEnabled && vpnStatus == RivetVpn.Status.UP,
            color = when {
                !RivetVpn.isConfigured || !vpnEnabled -> idle
                vpnStatus == RivetVpn.Status.UP -> up
                meshHome -> up
                else -> down
            },
        )
        StatusDot(
            label = "hub",
            filled = datahubUp == true,
            color = when (datahubUp) { true -> up; false -> down; null -> idle },
        )
    }
}

@Composable
private fun StatusDot(label: String, filled: Boolean, color: Color) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            text = if (filled) "●" else "○",
            style = MaterialTheme.typography.labelSmall,
            color = color,
        )
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** GET [url]; true on any HTTP response (the service answered — status code irrelevant). */
private fun httpReachable(url: String): Boolean = runCatching {
    (URL(url).openConnection() as HttpURLConnection).run {
        connectTimeout = 1500
        readTimeout = 1500
        requestMethod = "GET"
        try { responseCode >= 100 } finally { disconnect() }
    }
}.getOrDefault(false)

/** True if a TCP connection to [host]:[port] succeeds within a short timeout. */
private fun tcpReachable(host: String, port: Int): Boolean = runCatching {
    Socket().use { it.connect(InetSocketAddress(host, port), 1500); true }
}.getOrDefault(false)
