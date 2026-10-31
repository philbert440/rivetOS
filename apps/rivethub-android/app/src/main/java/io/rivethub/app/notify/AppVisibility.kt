package io.rivethub.app.notify

import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import io.rivethub.app.gateway.AppForeground

/**
 * Whether RivetHub is on screen. The app is a single `singleTask` activity,
 * so MainActivity's own start/stop IS the app's foreground/background — the
 * same lifecycle signal the terminal already uses for its attach — and no
 * process-lifecycle dependency is needed. MainActivity registers this as an
 * observer on its lifecycle; the inbox reads [resumed] per frame, and the
 * gateway sockets follow [AppForeground] (paused retries, reconnect on return).
 */
class AppVisibility : DefaultLifecycleObserver {
    @Volatile var resumed: Boolean = false
        private set

    override fun onStart(owner: LifecycleOwner) {
        resumed = true
        AppForeground.set(true)
    }

    override fun onStop(owner: LifecycleOwner) {
        resumed = false
        AppForeground.set(false)
    }
}
