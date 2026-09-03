package io.rivethub.app.gateway

/** Default no-op; the Android app supplies a logcat-backed implementation (see data/AndroidLogger). */
interface Logger {
    fun warn(tag: String, message: String, error: Throwable? = null)

    companion object {
        val Noop: Logger = object : Logger {
            override fun warn(tag: String, message: String, error: Throwable?) {}
        }
    }
}
