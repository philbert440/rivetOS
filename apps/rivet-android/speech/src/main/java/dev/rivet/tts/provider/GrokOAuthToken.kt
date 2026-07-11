package dev.rivet.tts.provider

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.time.Instant

private const val TAG = "GrokOAuthToken"

/**
 * Reads the Grok Build OAuth access token from the on-device proot rootfs
 * (~/.grok/auth.json inside [filesDir]/rootfs).
 */
object GrokOAuthToken {
    fun read(context: Context): String? {
        val authFile = File(context.filesDir, "rootfs/home/rivet/.grok/auth.json")
        if (!authFile.isFile) {
            Log.d(TAG, "auth file missing: ${authFile.absolutePath}")
            return null
        }
        return runCatching {
            val root = JSONObject(authFile.readText())
            val entry = root.keys().asSequence()
                .mapNotNull { key -> root.optJSONObject(key) }
                .firstOrNull { it.has("key") }
                ?: return@runCatching null

            val expiresAt = entry.optString("expires_at", "")
            if (expiresAt.isNotBlank()) {
                runCatching { Instant.parse(expiresAt) }
                    .getOrNull()
                    ?.takeIf { Instant.now().isAfter(it) }
                    ?.let {
                        Log.w(TAG, "OAuth token expired at $expiresAt")
                        return@runCatching null
                    }
            }

            entry.optString("key").takeIf { it.isNotBlank() }
        }.onFailure { e ->
            Log.w(TAG, "failed to read OAuth token", e)
        }.getOrNull()
    }
}