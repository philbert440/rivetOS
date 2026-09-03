package io.rivethub.app.gateway

import okhttp3.OkHttpClient

/** Already-built OkHttp clients for one identity / TLS generation. */
interface GatewayClients {
    fun cacheKey(): String
    fun primary(): OkHttpClient
    fun fallback(): OkHttpClient?
}
