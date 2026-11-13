package io.rivethub.app.plane

/**
 * Background alerts (UX-SPEC §6): while any alert toggle is on and a node is
 * paired, a foreground service (notify/AlertService) keeps the process alive
 * with a quiet ongoing notice, and the hub's watcher sockets (registry,
 * session events, notifications) keep reconnecting while the app is away.
 * Chat and terminal sockets still pause in the background.
 */

/** Whether the background connection should run. */
fun wantsBackgroundWatch(
    entryUrl: String,
    taskNotifications: Boolean,
    agentFinishedNotifications: Boolean,
    needsYouNotifications: Boolean,
): Boolean = entryUrl.isNotBlank() &&
    (taskNotifications || agentFinishedNotifications || needsYouNotifications)

/**
 * Whether a socket keeps retrying while the app is away: always on screen;
 * in the background only a watcher socket, and only while the background
 * connection runs.
 */
fun retriesAllowed(foreground: Boolean, watcher: Boolean, backgroundWatch: Boolean): Boolean =
    foreground || (watcher && backgroundWatch)
