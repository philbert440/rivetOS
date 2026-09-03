package io.rivethub.app.data

import android.util.Log
import io.rivethub.app.gateway.Logger

/** Android `Log` backing for [io.rivethub.app.gateway.Logger]. */
object AndroidLogger : Logger {
    override fun warn(tag: String, message: String, error: Throwable?) {
        Log.w(tag, message, error)
    }
}
