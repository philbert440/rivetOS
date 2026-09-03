package io.rivethub.app.gateway

/** Default no-op; the Android app supplies a `android.util.Log` implementation. */
interface Logger {
    fun warn(tag: String, message: String, error: Throwable? = null)

    companion object {
        val Noop: Logger = object : Logger {
            override fun warn(tag: String, message: String, error: Throwable?) {}
        }
    }
}
