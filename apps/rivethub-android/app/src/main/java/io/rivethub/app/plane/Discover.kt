package io.rivethub.app.plane

import io.rivethub.app.gateway.GatewayException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import java.net.SocketTimeoutException

/** Per-node ceiling so one offline peer cannot stall the rest of the mesh. */
const val NODE_BUNDLE_TIMEOUT_MS = 8_000L

/**
 * Probe health first. When it fails (`false` or thrown), skip the rest of the
 * per-node bundle so an offline node cannot burn 15s × 2 paths × 4 calls.
 */
suspend fun <T> fetchAfterHealthz(
    healthz: suspend () -> Boolean,
    rest: suspend () -> T,
    skipped: (ok: Boolean, cause: Throwable?) -> T,
): T {
    val probed = try {
        Result.success(healthz())
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        Result.failure(e)
    }
    val ok = probed.getOrDefault(false)
    if (!ok) return skipped(ok, probed.exceptionOrNull())
    return rest()
}

/**
 * Run [fetch] per node with [timeoutMs]. Completions are delivered to [onEach]
 * as they finish so a hanging node cannot hide the rest. The function still
 * waits for every node (timed-out ones included) before returning.
 */
suspend fun <N, B> fetchBundlesProgressively(
    nodes: List<N>,
    timeoutMs: Long = NODE_BUNDLE_TIMEOUT_MS,
    fetch: suspend (N) -> B,
    onEach: (N, Result<B>) -> Unit,
) {
    if (nodes.isEmpty()) return
    coroutineScope {
        val arrivals = Channel<Pair<N, Result<B>>>(Channel.UNLIMITED)
        for (node in nodes) {
            launch {
                val result = try {
                    Result.success(withTimeout(timeoutMs) { fetch(node) })
                } catch (e: TimeoutCancellationException) {
                    Result.failure(e)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    Result.failure(e)
                }
                arrivals.send(node to result)
            }
        }
        repeat(nodes.size) {
            val (node, result) = arrivals.receive()
            onEach(node, result)
        }
    }
}

/**
 * 404 on `/api/harnesses` is a plane-less node (datahub / chat-loop), not a
 * badge. Timeouts and 5xx stay loud. Other non-404 failures stay loud too so
 * a 401 does not go quiet.
 */
fun nodeErrorBadge(errors: Iterable<Throwable?>): String? {
    for (raw in errors) {
        val error = raw ?: continue
        if (isQuietNodeError(error)) continue
        return badgeText(error)
    }
    return null
}

fun isQuietNodeError(error: Throwable): Boolean {
    var e: Throwable? = error
    while (e != null) {
        if (e is GatewayException && e.status == 404) return true
        e = e.cause
    }
    return false
}

private fun badgeText(error: Throwable): String {
    var e: Throwable? = error
    while (e != null) {
        if (e is TimeoutCancellationException || e is SocketTimeoutException) return "timed out"
        e = e.cause
    }
    return error.message?.takeIf { it.isNotBlank() } ?: error.javaClass.simpleName
}
