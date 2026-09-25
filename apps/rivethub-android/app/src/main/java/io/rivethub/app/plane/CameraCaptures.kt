package io.rivethub.app.plane

/** Stale captures (uploaded or abandoned) are swept once older than this. */
const val CAPTURE_KEEP_MS: Long = 60L * 60L * 1000L

/** One file in the camera cache directory, as the sweep sees it. */
data class CaptureFile(val name: String, val modifiedMs: Long)

/**
 * Camera capture files still in use, by file name: held from the moment the
 * camera is launched into the file until its upload finished (either way) or
 * the capture was cancelled. A held file is never swept, however old its
 * timestamp — a slow camera app, a suspended upload or a clock jump cannot
 * turn a live capture into "stale".
 */
class CaptureRegistry {
    private val live = LinkedHashSet<String>()

    /** Camera launched into [name], or its upload started. Idempotent. */
    fun hold(name: String) {
        if (name.isNotBlank()) live.add(name)
    }

    /** Capture cancelled, or its upload finished (ready or failed). */
    fun release(name: String) {
        live.remove(name)
    }

    fun isHeld(name: String): Boolean = name in live

    fun held(): Set<String> = live.toSet()
}

/**
 * File names to delete from the camera cache: older than [keepMs] and not
 * [held]. Run after a capture staged successfully — never ahead of a new
 * capture, when the previous one may still be in the camera app.
 */
fun capturesToSweep(
    files: List<CaptureFile>,
    held: Set<String>,
    nowMs: Long,
    keepMs: Long = CAPTURE_KEEP_MS,
): List<String> = files.filter { it.name !in held && nowMs - it.modifiedMs > keepMs }.map { it.name }
