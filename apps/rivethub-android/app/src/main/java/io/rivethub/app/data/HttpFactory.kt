package io.rivethub.app.data

import okhttp3.OkHttpClient
import java.net.InetAddress
import java.net.Socket
import java.time.Duration
import javax.net.SocketFactory
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext

/**
 * One OkHttp client per (identity generation, strict-hostnames, bind) triple.
 * mTLS comes from the device p12; trust from its chain / the CA PEM.
 *
 * LAN bind must NOT freeze a Network.socketFactory onto the client: that
 * netId dies on SSID/band hop and SYNs go to a black hole. The bound client
 * uses a live SocketFactory that re-resolves the Network on every createSocket.
 */
class HttpFactory(private val identity: DeviceIdentityStore, private val lan: LanNetwork? = null) {
    private val cache = HashMap<String, OkHttpClient>()

    @Synchronized
    fun clear() { cache.values.forEach { it.connectionPool.evictAll() }; cache.clear() }

    fun cacheKey(strictHostnames: Boolean): String =
        "${identity.generation()}:$strictHostnames:${lan?.generation() ?: -1}"

    /**
     * [bindLan] false = Android default routing (what Chrome uses).
     * true = sockets created via a live LAN Network lookup.
     * Callers try default first and fall back to the bound client on connect timeout.
     */
    @Synchronized
    fun client(strictHostnames: Boolean, bindLan: Boolean = false): OkHttpClient {
        val key = "${cacheKey(strictHostnames)}:$bindLan"
        cache[key]?.let { return it }
        if (cache.size > 8) cache.clear()
        val built = build(strictHostnames, bindLan)
        cache[key] = built
        return built
    }

    fun fallbackClient(strictHostnames: Boolean): OkHttpClient? =
        if (lan == null) null else client(strictHostnames, bindLan = true)

    private fun build(strictHostnames: Boolean, bindLan: Boolean): OkHttpClient {
        val b = OkHttpClient.Builder()
            .connectTimeout(Duration.ofSeconds(15))
            .readTimeout(Duration.ofSeconds(30))
            .writeTimeout(Duration.ofSeconds(30))
            .pingInterval(Duration.ofSeconds(25))
            .retryOnConnectionFailure(true)
        if (bindLan && lan != null) b.socketFactory(LiveLanSocketFactory(lan))
        val loaded = identity.load()
        if (loaded == null && identity.hasIdentity()) {
            throw IllegalStateException("device certificate failed to load: ${identity.lastError ?: "unknown"}")
        }
        if (loaded != null) {
            val ctx = SSLContext.getInstance("TLS")
            ctx.init(loaded.keyManagers, loaded.trustManager?.let { arrayOf(it) }, null)
            val tm = loaded.trustManager ?: platformTrustManager()
            b.sslSocketFactory(ctx.socketFactory, tm)
        }
        if (!strictHostnames) {
            b.hostnameVerifier(HostnameVerifier { _, _ -> true })
        }
        return b.build()
    }

    private fun platformTrustManager(): javax.net.ssl.X509TrustManager {
        val tmf = javax.net.ssl.TrustManagerFactory.getInstance(javax.net.ssl.TrustManagerFactory.getDefaultAlgorithm())
        tmf.init(null as java.security.KeyStore?)
        return tmf.trustManagers.filterIsInstance<javax.net.ssl.X509TrustManager>().first()
    }
}

/** Resolves [LanNetwork.current] on every socket, never a cached netId. */
internal class LiveLanSocketFactory(private val lan: LanNetwork) : SocketFactory() {
    private fun delegate(): SocketFactory =
        lan.current()?.socketFactory ?: SocketFactory.getDefault()

    override fun createSocket(): Socket = delegate().createSocket()
    override fun createSocket(host: String?, port: Int): Socket = delegate().createSocket(host, port)
    override fun createSocket(host: String?, port: Int, localHost: InetAddress?, localPort: Int): Socket =
        delegate().createSocket(host, port, localHost, localPort)
    override fun createSocket(host: InetAddress?, port: Int): Socket = delegate().createSocket(host, port)
    override fun createSocket(host: InetAddress?, port: Int, localHost: InetAddress?, localPort: Int): Socket =
        delegate().createSocket(host, port, localHost, localPort)
}
