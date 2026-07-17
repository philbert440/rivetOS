package dev.rivet.app.device

import org.json.JSONArray

// ---------------------------------------------------------------------------
// Pure performGlobalAction mapping (JVM-testable; no Android framework types)
// Integer values match AccessibilityService.GLOBAL_ACTION_* (compileSdk 37).
// ---------------------------------------------------------------------------

/** AccessibilityService.GLOBAL_ACTION_BACK — API 16 */
const val GLOBAL_ACTION_BACK = 1

/** AccessibilityService.GLOBAL_ACTION_HOME — API 16 */
const val GLOBAL_ACTION_HOME = 2

/** AccessibilityService.GLOBAL_ACTION_RECENTS — API 16 */
const val GLOBAL_ACTION_RECENTS = 3

/** AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS — API 16 */
const val GLOBAL_ACTION_NOTIFICATIONS = 4

/** AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS — API 17 */
const val GLOBAL_ACTION_QUICK_SETTINGS = 5

/** AccessibilityService.GLOBAL_ACTION_POWER_DIALOG — API 21 */
const val GLOBAL_ACTION_POWER_DIALOG = 6

/** AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN — API 28 */
const val GLOBAL_ACTION_LOCK_SCREEN = 8

/** AccessibilityService.GLOBAL_ACTION_TAKE_SCREENSHOT — API 30 (system UI shot) */
const val GLOBAL_ACTION_TAKE_SCREENSHOT = 9

/** AccessibilityService.GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE — API 31 */
const val GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE = 15

/**
 * Supported `global.action` wire names (order stable for /status).
 * Case-insensitive on the wire; listed uppercase.
 */
val GLOBAL_ACTION_NAMES: List<String> = listOf(
    "BACK",
    "HOME",
    "RECENTS",
    "NOTIFICATIONS",
    "QUICK_SETTINGS",
    "POWER_DIALOG",
    "LOCK_SCREEN",
    "TAKE_SCREENSHOT",
    "DISMISS_NOTIFICATION_SHADE",
)

/**
 * Map a `global` action name to AccessibilityService.GLOBAL_ACTION_* id.
 * Unknown / blank → null (caller treats as action_failed / ok:false).
 */
fun globalActionCode(name: String): Int? = when (name.trim().uppercase()) {
    "BACK" -> GLOBAL_ACTION_BACK
    "HOME" -> GLOBAL_ACTION_HOME
    "RECENTS" -> GLOBAL_ACTION_RECENTS
    "NOTIFICATIONS" -> GLOBAL_ACTION_NOTIFICATIONS
    "QUICK_SETTINGS" -> GLOBAL_ACTION_QUICK_SETTINGS
    "POWER_DIALOG" -> GLOBAL_ACTION_POWER_DIALOG
    "LOCK_SCREEN" -> GLOBAL_ACTION_LOCK_SCREEN
    "TAKE_SCREENSHOT" -> GLOBAL_ACTION_TAKE_SCREENSHOT
    "DISMISS_NOTIFICATION_SHADE" -> GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE
    else -> null
}

/**
 * Minimum SDK_INT required to *call* performGlobalAction for this code.
 * Null means available at or below minSdk 26 (safe on all RivetHub devices).
 *
 * - LOCK_SCREEN: API 28
 * - TAKE_SCREENSHOT: API 30
 * - DISMISS_NOTIFICATION_SHADE: API 31
 * - POWER_DIALOG: API 21 (always ok at minSdk 26)
 */
fun globalActionMinSdk(code: Int): Int? = when (code) {
    GLOBAL_ACTION_LOCK_SCREEN -> 28
    GLOBAL_ACTION_TAKE_SCREENSHOT -> 30
    GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE -> 31
    else -> null
}

/** True when this global action code may be invoked on [sdkInt]. */
fun isGlobalActionSupported(code: Int, sdkInt: Int): Boolean {
    val min = globalActionMinSdk(code) ?: return true
    return sdkInt >= min
}

/**
 * Resolve wire name → action id only when the device SDK can run it.
 * Unknown name → null; known but below minSdk → null (same as unsupported).
 */
fun resolveGlobalAction(name: String, sdkInt: Int): Int? {
    val code = globalActionCode(name) ?: return null
    return if (isGlobalActionSupported(code, sdkInt)) code else null
}

/** Build `globals` JSONArray for GET /status capabilities (SDK-filtered). */
fun globalsCapabilityArray(sdkInt: Int): JSONArray {
    val arr = JSONArray()
    for (name in GLOBAL_ACTION_NAMES) {
        val code = globalActionCode(name) ?: continue
        if (isGlobalActionSupported(code, sdkInt)) {
            arr.put(name)
        }
    }
    return arr
}
