package io.rivethub.app.gateway

import java.io.InputStream

/**
 * Reads [input] to the end into memory and closes it, or returns null once
 * more than [maxBytes] have arrived. [checkActive] runs before every chunk
 * read; a coroutine caller passes `{ ensureActive() }` so a cancelled read
 * stops at the next chunk boundary with its CancellationException (the
 * stream is still closed). A read already blocked in the socket is unblocked
 * by the caller cancelling the OkHttp call.
 */
internal fun readCapped(input: InputStream, maxBytes: Long, checkActive: () -> Unit = {}): ByteArray? {
    val out = java.io.ByteArrayOutputStream()
    val buf = ByteArray(16 * 1024)
    input.use {
        while (true) {
            checkActive()
            val n = it.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
            if (out.size() > maxBytes) return null
        }
    }
    return out.toByteArray()
}
