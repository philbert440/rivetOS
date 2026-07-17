package dev.rivet.app.device

import android.content.Context
import android.os.Build
import android.os.Environment
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.security.SecureRandom
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Shared constants + the per-install secret for the on-device control surface.
 * The ControlServer (hosted by [RivetAccessibilityService]) binds 127.0.0.1 only and
 * requires this token (as the "X-Rivet-Token" header) on every privileged endpoint.
 *
 * Retrieval, in order of preference:
 *   1. /sdcard/rivet/control.json  (written by [exportControlInfo]; readable by the
 *      on-device agent running under another uid, e.g. Termux) -- needs All-Files-Access.
 *   2. adb logcat -s RivetDevice
 */
object DeviceControl {
    const val TAG = "RivetDevice"
    const val CONTROL_PORT = 9876

    private const val PREFS = "rivet_device"
    private const val KEY_TOKEN = "control_token"
    private const val KEY_MODE = "control_mode"
    private const val MAX_EXEC_TIMEOUT_MS = 120_000L      // cap a single /exec run at 2 min
    private const val MAX_EXEC_OUTPUT = 512 * 1024        // bound captured stdout/stderr at 512 KB each

    fun getControlToken(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.getString(KEY_TOKEN, null)?.takeIf { it.isNotEmpty() }?.let { return it }
        val bytes = ByteArray(24)
        SecureRandom().nextBytes(bytes)
        val token = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        prefs.edit().putString(KEY_TOKEN, token).apply()
        return token
    }

    /**
     * Control kill-switch: `full` | `eyes` | `parked` (default `full`).
     * Persisted in SharedPreferences [PREFS] under [KEY_MODE].
     */
    fun getControlMode(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val raw = prefs.getString(KEY_MODE, "full") ?: "full"
        return if (ControlMode.parse(raw) != null) raw.lowercase() else "full"
    }

    /** Persist mode; [mode] must be full|eyes|parked (caller validates for API 400). */
    fun setControlMode(context: Context, mode: String) {
        val normalized = mode.lowercase()
        require(ControlMode.parse(normalized) != null) { "invalid control mode: $mode" }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_MODE, normalized)
            .apply()
    }

    /**
     * Mirror the control surface (port + token) to a well-known external path so an
     * on-device agent under a different uid can discover and authenticate to it.
     */
    fun exportControlInfo(context: Context) {
        // Legacy cross-uid hand-off (plaintext token on shared /sdcard, readable by any
        // All-Files-Access app). The in-app agents run inside the proot rootfs — which binds only
        // /dev,/proc,/sys, so /sdcard is invisible to them; they read the token from the rootfs
        // ~/.rivet/control.json instead. So this export is debug-only (adb/Termux diagnostics).
        if (!dev.rivet.app.BuildConfig.DEBUG) return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && !Environment.isExternalStorageManager()) {
                Log.w(TAG, "All-Files-Access not granted -- token NOT exported.")
                return
            }
            val token = getControlToken(context)
            val dir = File(Environment.getExternalStorageDirectory(), "rivet")
            if (!dir.exists()) dir.mkdirs()
            File(dir, "control.json").writeText("{\"port\":$CONTROL_PORT,\"token\":\"$token\"}\n")
            Log.i(TAG, "Exported control info")
        } catch (t: Throwable) {
            Log.e(TAG, "control info export failed", t)
        }
    }

    /**
     * Run an arbitrary argv under RivetHub's uid, capturing stdout/stderr/exit. Backs the
     * loopback, token-guarded `POST /exec` control endpoint — the diagnostic + future control
     * path into the runtime. `env` entries are merged onto the inherited process environment.
     */
    fun runExec(cmd: List<String>, env: Map<String, String>?, cwd: String?, timeoutMs: Long): JSONObject {
        val res = JSONObject()
        val start = System.currentTimeMillis()
        // Hard caps so a runaway/abusive request can't stall or OOM the app process.
        val cappedTimeout = timeoutMs.coerceIn(1, MAX_EXEC_TIMEOUT_MS)
        try {
            val pb = ProcessBuilder(cmd)
            if (cwd != null) pb.directory(File(cwd))
            if (env != null) { val e = pb.environment(); for ((k, v) in env) e[k] = v }
            val p = pb.start()
            val outSb = StringBuilder()
            val errSb = StringBuilder()
            fun appendCapped(sb: StringBuilder, line: String) { if (sb.length < MAX_EXEC_OUTPUT) sb.append(line).append('\n') }
            val tOut = thread { p.inputStream.bufferedReader().forEachLine { appendCapped(outSb, it) } }
            val tErr = thread { p.errorStream.bufferedReader().forEachLine { appendCapped(errSb, it) } }
            val finished = p.waitFor(cappedTimeout, TimeUnit.MILLISECONDS)
            if (!finished) { p.destroyForcibly(); res.put("timeout", true) }
            tOut.join(1500); tErr.join(1500)
            res.put("ok", finished && p.exitValue() == 0)
            res.put("exit", if (finished) p.exitValue() else -1)
            res.put("out", outSb.toString())
            res.put("err", errSb.toString())
        } catch (t: Throwable) {
            res.put("ok", false).put("exit", -1).put("error", "${t.javaClass.simpleName}: ${t.message}")
        }
        res.put("durationMs", System.currentTimeMillis() - start)
        return res
    }
}
