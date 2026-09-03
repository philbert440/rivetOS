package io.rivethub.app.data

import io.rivethub.app.gateway.GatewayClients
import okhttp3.OkHttpClient

/** [HttpFactory] clients for one identity / TLS / LAN-bind generation. */
class HttpGatewayClients(
    private val http: HttpFactory,
    private val strict: () -> Boolean,
) : GatewayClients {
    override fun cacheKey(): String = http.cacheKey(strict())
    override fun primary(): OkHttpClient = http.client(strict())
    override fun fallback(): OkHttpClient? = http.fallbackClient(strict())
}
