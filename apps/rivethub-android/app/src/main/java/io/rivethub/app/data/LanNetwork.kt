package io.rivethub.app.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkAddress
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import java.net.Inet4Address
import java.util.concurrent.atomic.AtomicInteger

/**
 * Picks a live WiFi/Ethernet Network at call time. Mesh nodes are RFC1918, so
 * sockets must ride the LAN even when Android demotes a weak-RSSI WiFi link
 * and makes cellular the default. A cached Network handle is not safe: after
 * an SSID/band hop the netId stays "capable" in some checks but SYNs never
 * hit the wire (SYN-SENT, 0 packets). Always re-query ConnectivityService.
 */
class LanNetwork(context: Context) {
    private val cm = context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private val gen = AtomicInteger(0)

    @Volatile private var last: Network? = null

    /**
     * A currently-usable LAN network, or null. Prefers a network whose
     * LinkProperties already have a private IPv4 address (the mesh subnet)
     * over "whatever WIFI callback fired last".
     */
    fun current(): Network? {
        val candidates = cm.allNetworks.mapNotNull { n ->
            val caps = runCatching { cm.getNetworkCapabilities(n) }.getOrNull() ?: return@mapNotNull null
            val lan = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
            if (!lan) return@mapNotNull null
            val addrs = runCatching { cm.getLinkProperties(n)?.linkAddresses }.getOrNull().orEmpty()
            Triple(n, privateV4(addrs), caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN))
        }
        val picked = candidates.firstOrNull { it.second }?.first
            ?: candidates.firstOrNull()?.first
        if (picked != last) {
            last = picked
            gen.incrementAndGet()
        }
        return picked
    }

    fun generation(): Int = gen.get()

    init {
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET)
            .build()
        runCatching {
            cm.registerNetworkCallback(request, object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(n: Network) { gen.incrementAndGet() }
                override fun onLost(n: Network) { if (last == n) last = null; gen.incrementAndGet() }
            })
        }
    }

    private fun privateV4(addrs: List<LinkAddress>): Boolean =
        addrs.any { la ->
            val a = la.address
            a is Inet4Address && (a.isSiteLocalAddress || a.isLinkLocalAddress)
        }
}
