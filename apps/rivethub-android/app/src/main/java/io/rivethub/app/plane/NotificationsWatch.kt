package io.rivethub.app.plane

/**
 * Ownership rules for the ONE `WS /api/notifications/ws` socket the hub
 * holds on the entry node. Pure so the entry-switch / identity-bump / late-
 * frame cases have JVM tests; HubViewModel only executes the returned step.
 *
 * The key is derived from the authoritative entry URL (prefs) and the
 * identity generation — NOT from discovery — so the socket follows an entry
 * change made anywhere (Settings "Test connection" persists the new entry
 * without a refresh; a failed health check still leaves that entry saved).
 */
data class NotificationsWatchKey(val entryUrl: String, val identityGen: Int)

/** Null (no socket) when no entry node is configured. */
fun notificationsWatchKey(entryUrl: String, identityGen: Int): NotificationsWatchKey? {
    val url = entryUrl.trim().trimEnd('/')
    if (url.isEmpty()) return null
    return NotificationsWatchKey(url, identityGen)
}

/**
 * What the hub holds. [gen] is bumped on every subscribe and every close and
 * is stamped on each frame at subscribe time; a frame whose stamp is not the
 * current [gen] came from a superseded socket and is dropped.
 */
data class NotificationsWatch(
    val key: NotificationsWatchKey? = null,
    val socketOpen: Boolean = false,
    val gen: Int = 0,
)

/**
 * One reconcile decision. [close]: close the socket currently held. [open]:
 * subscribe for this key, stamping frames with `watch.gen`. [clearInbox]: the
 * entry node changed (or went away), so the inbox's entries belong to a
 * different mesh.
 */
data class NotificationsWatchStep(
    val watch: NotificationsWatch,
    val close: Boolean,
    val open: NotificationsWatchKey?,
    val clearInbox: Boolean,
)

/**
 * Same key with a live socket (or no key and no socket) → nothing to do.
 * Otherwise close whatever is held and subscribe for [next] under a new
 * generation. Same key without a socket (an earlier subscribe threw) retries
 * without clearing. An identity bump on the same entry keeps the inbox.
 */
fun reconcileNotificationsWatch(current: NotificationsWatch, next: NotificationsWatchKey?): NotificationsWatchStep {
    if (next == current.key && (next == null || current.socketOpen)) {
        return NotificationsWatchStep(current, close = false, open = null, clearInbox = false)
    }
    val prevUrl = current.key?.entryUrl
    return NotificationsWatchStep(
        watch = NotificationsWatch(key = next, socketOpen = false, gen = current.gen + 1),
        close = current.socketOpen,
        open = next,
        clearInbox = prevUrl != null && prevUrl != next?.entryUrl,
    )
}

/** The subscribe for the step's key returned (true) or threw (false). */
fun notificationsWatchOpened(watch: NotificationsWatch, ok: Boolean): NotificationsWatch =
    watch.copy(socketOpen = ok && watch.key != null)

/** Shutdown / VM cleared: no key, no socket, and any frame still in flight is stale. */
fun closeNotificationsWatch(current: NotificationsWatch): NotificationsWatch =
    NotificationsWatch(key = null, socketOpen = false, gen = current.gen + 1)

/** A frame stamped [frameGen] belongs to the socket held now. */
fun acceptNotificationFrame(current: NotificationsWatch, frameGen: Int): Boolean =
    current.key != null && frameGen == current.gen
