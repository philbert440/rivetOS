package dev.rivet.app.ui.onboarding

import android.Manifest
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext

/**
 * First-launch permission onboarding.
 *
 * Surfaces every permission the node needs up front so the user grants them in one pass
 * instead of digging into App Info → Permissions by hand. The flow chains, one screen at a
 * time, so the user never sees stacked system dialogs:
 *   1. the batched runtime permissions (notifications, microphone, camera, local network),
 *   2. All-files access (`MANAGE_EXTERNAL_STORAGE`, a special Settings toggle), then
 *   3. Battery-optimization exemption.
 *
 * Each special toggle is skipped if already granted. Shown only on the first launch (tracked
 * in a private SharedPreferences flag); placed as a sibling of the nav host so its launchers
 * stay alive for the whole chain.
 */
@Composable
fun FirstRunPermissions() {
    val context = LocalContext.current
    val prefs = remember {
        context.getSharedPreferences("rivet_onboarding", Context.MODE_PRIVATE)
    }
    var showDialog by remember { mutableStateOf(!prefs.getBoolean("prompted", false)) }

    fun markDone() {
        prefs.edit().putBoolean("prompted", true).apply()
    }

    // Returned from the All-files Settings screen → finish with the battery prompt.
    val allFilesLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        requestBatteryExemption(context)
        markDone()
    }

    // Returned from the batched runtime dialog → All-files (if needed) → battery.
    val runtimeLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) {
        val needsAllFiles = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
            !Environment.isExternalStorageManager()
        if (needsAllFiles) {
            val launched = runCatching {
                allFilesLauncher.launch(
                    Intent(
                        Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                        Uri.parse("package:${context.packageName}"),
                    )
                )
            }.isSuccess
            if (!launched) {
                requestBatteryExemption(context)
                markDone()
            }
        } else {
            requestBatteryExemption(context)
            markDone()
        }
    }

    if (showDialog) {
        AlertDialog(
            onDismissRequest = {},
            title = { Text("Set up RivetHub") },
            text = {
                Text(
                    "RivetHub runs an on-device agent and needs a few permissions: " +
                        "notifications, microphone, camera, local-network access, all-files " +
                        "access, and battery-optimization exemption. Grant them now so you " +
                        "don't have to dig through Android settings later."
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    showDialog = false
                    runtimeLauncher.launch(runtimePermissions())
                }) { Text("Grant permissions") }
            },
            dismissButton = {
                TextButton(onClick = {
                    showDialog = false
                    markDone()
                }) { Text("Skip") }
            },
        )
    }
}

/** The dangerous runtime permissions we request as one batch, gated by API level. */
private fun runtimePermissions(): Array<String> = buildList {
    add(Manifest.permission.CAMERA)
    add(Manifest.permission.RECORD_AUDIO)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        add(Manifest.permission.POST_NOTIFICATIONS)
    }
    if (Build.VERSION.SDK_INT >= 37) {
        add(Manifest.permission.ACCESS_LOCAL_NETWORK)
    }
}.toTypedArray()

/** Ask the system to exempt us from battery optimization (no-op if already exempt). */
private fun requestBatteryExemption(context: Context) {
    val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
    if (!pm.isIgnoringBatteryOptimizations(context.packageName)) {
        runCatching {
            context.startActivity(
                Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:${context.packageName}"),
                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        }
    }
}
