package io.rivethub.app.plane

import io.rivethub.app.gateway.GatewayException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

enum class EnrollErrorKind { CertRefused, Timeout, Unreachable, Cleartext, Other }

data class EnrollError(val kind: EnrollErrorKind, val detail: String? = null)

fun enrollError(err: Throwable): EnrollError {
    var cur: Throwable? = err
    var status: Int? = null
    while (cur != null) {
        if (cur is GatewayException) status = cur.status
        if (cur is SocketTimeoutException) return EnrollError(EnrollErrorKind.Timeout)
        if (cur is UnknownHostException) return EnrollError(EnrollErrorKind.Unreachable)
        if (isCleartextMessage(cur.message)) return EnrollError(EnrollErrorKind.Cleartext)
        cur = cur.cause
    }
    if (status == 401 || status == 403) return EnrollError(EnrollErrorKind.CertRefused)
    return EnrollError(EnrollErrorKind.Other, err.message)
}

fun isCleartextMessage(message: String?): Boolean {
    val m = message ?: return false
    return m.contains("Cleartext HTTP traffic", ignoreCase = true) ||
        m.contains("CLEARTEXT communication not permitted", ignoreCase = true)
}

enum class EntryUrlError { Blank, NotHttps }

/** Null means [raw] is an acceptable `https://` entry URL (trailing slash stripped by the caller). */
fun validateEntryUrl(raw: String): EntryUrlError? {
    val entry = raw.trim()
    if (entry.isBlank()) return EntryUrlError.Blank
    if (!entry.startsWith("https://", ignoreCase = true)) return EntryUrlError.NotHttps
    return null
}
