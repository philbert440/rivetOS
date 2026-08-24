package dev.rivetos.bots.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import java.util.concurrent.atomic.AtomicInteger

/**
 * Tracks the device's WiFi/Ethernet network. The mesh lives on RFC1918
 * addresses, so its traffic must ride the LAN even when Android has demoted
 * a weak-RSSI WiFi link and made cellular the default network — the exact
 * failure seen in the field: wlan0 reaches the node in 8 ms while the app's
 * connects time out over 5G.
 */
class LanNetwork(context: Context) {
    private val cm = context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private val gen = AtomicInteger(0)

    @Volatile private var network: Network? = null

    /**
     * The tracked LAN network, verified alive RIGHT NOW against
     * ConnectivityService. Callbacks are deferred while the app is frozen in
     * the background (Android 12+), so after an SSID/band hop the cached
     * handle can be a dead netId — a socket bound to it goes to a black hole
     * (SYN-SENT, nothing on the wire). getNetworkCapabilities() is a
     * synchronous binder call and is the ground truth.
     */
    fun current(): Network? {
        val n = network ?: return null
        return if (runCatching { cm.getNetworkCapabilities(n) }.getOrNull() != null) n else null
    }

    /** Changes whenever the tracked network appears/changes/disappears — cache keys hang off it. */
    fun generation(): Int = gen.get()

    init {
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET)
            .build()
        runCatching {
            cm.registerNetworkCallback(request, object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(n: Network) { network = n; gen.incrementAndGet() }
                override fun onLost(n: Network) { if (network == n) { network = null; gen.incrementAndGet() } }
            })
        }
    }
}
