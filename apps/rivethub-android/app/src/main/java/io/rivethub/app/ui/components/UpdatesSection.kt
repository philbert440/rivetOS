package io.rivethub.app.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.rivethub.app.AppContainer
import io.rivethub.app.BuildConfig
import io.rivethub.app.R
import io.rivethub.app.ui.theme.RivetColors
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType
import io.rivethub.app.update.AndroidManifestEntry
import io.rivethub.app.update.UpdateState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.round

/**
 * Settings → Updates. Copy and order match rivethub-web updates-section.tsx
 * plus Android extras (progress %, unknown-sources hint). Manual check only.
 */
@Composable
fun UpdatesSection(c: AppContainer) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val colors = RivetTheme.colors
    val prefs by c.settings.prefs.collectAsState(initial = io.rivethub.app.data.Prefs())
    val updater = c.updater
    val appVersion = remember { BuildConfig.VERSION_NAME.removeSuffix("-debug") }

    var state by remember { mutableStateOf<UpdateState?>(null) }
    var progressPct by remember { mutableStateOf<Int?>(null) }
    var actionError by remember { mutableStateOf<String?>(null) }
    var hintUnknownSources by remember { mutableStateOf(false) }
    var confirm by remember { mutableStateOf<AndroidManifestEntry?>(null) }

    var reusing by remember { mutableStateOf(false) }
    val busy = state is UpdateState.Checking || progressPct != null || reusing
    val available = when (val s = state) {
        is UpdateState.Available -> s.entry
        is UpdateState.NeedsInstallPermission -> s.entry
        else -> null
    }
    val verified = state as? UpdateState.NeedsInstallPermission

    Column(Modifier.fillMaxWidth()) {
        SettingsH2(stringResource(R.string.section_updates))
        Text(
            stringResource(R.string.updates_helper),
            color = colors.inkDim,
            style = RivetType.xs,
            modifier = Modifier.padding(bottom = 12.dp),
        )
        Row(
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth(),
        ) {
            RivetButton(
                text = stringResource(R.string.action_check_updates),
                onClick = {
                    scope.launch {
                        hintUnknownSources = false
                        actionError = null
                        state = UpdateState.Checking
                        val url = prefs.entryUrl.trim()
                        if (url.isBlank()) {
                            state = UpdateState.Error("no connected node")
                            return@launch
                        }
                        state = updater.check(c.harness(url))
                    }
                },
                enabled = !busy,
            )
            if (available != null) {
                RivetButton(
                    text = stringResource(R.string.action_install_update, available.version),
                    onClick = {
                        val reuse = verified
                        if (reuse != null && !reusing) {
                            reusing = true
                            scope.launch {
                                hintUnknownSources = false
                                actionError = null
                                try {
                                    val file = updater.reuseVerified(reuse.file, reuse.entry)
                                    val launched = updater.install(ctx, file)
                                    if (!launched) {
                                        hintUnknownSources = true
                                        state = UpdateState.NeedsInstallPermission(file, reuse.entry)
                                    }
                                } catch (e: CancellationException) {
                                    throw e
                                } catch (e: Exception) {
                                    actionError = e.message ?: e.javaClass.simpleName
                                    state = UpdateState.Available(reuse.entry)
                                } finally {
                                    reusing = false
                                }
                            }
                        } else {
                            confirm = available
                        }
                    },
                    enabled = !busy,
                )
            }
        }
        val status = statusLine(state, progressPct)
        if (status != null) {
            Text(
                status.text,
                color = status.color(colors),
                style = RivetType.mono14,
                modifier = Modifier.padding(top = 8.dp),
            )
        }
        val err = actionError
        if (err != null) {
            Text(
                stringResource(R.string.updates_error, err),
                color = colors.red,
                style = RivetType.mono14,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
        Text(
            stringResource(R.string.updates_shell_version, appVersion),
            color = colors.inkDim,
            style = RivetType.mono11,
            modifier = Modifier.padding(top = 8.dp),
        )
        if (hintUnknownSources) {
            Text(
                stringResource(R.string.updates_hint_unknown_sources),
                color = colors.warn,
                style = RivetType.xs,
                modifier = Modifier.padding(top = 8.dp),
            )
        }
    }

    val pending = confirm
    if (pending != null) {
        RivetConfirmDialog(
            title = stringResource(R.string.updates_install_title, pending.version),
            message = stringResource(R.string.updates_install_body, prefs.entryUrl),
            confirmLabel = stringResource(R.string.updates_install_confirm, pending.version),
            cancelLabel = stringResource(R.string.action_cancel),
            onConfirm = {
                confirm = null
                val url = prefs.entryUrl.trim()
                if (url.isBlank()) {
                    actionError = "no connected node"
                    return@RivetConfirmDialog
                }
                scope.launch {
                    hintUnknownSources = false
                    actionError = null
                    progressPct = 0
                    try {
                        val gw = c.harness(url)
                        val latest = updater.prepareInstall(gw)
                        when (latest) {
                            is UpdateState.Available -> {
                                state = latest
                                if (latest.entry != pending) {
                                    progressPct = null
                                    return@launch
                                }
                                val file = updater.download(gw, latest.entry) { frac ->
                                    withContext(Dispatchers.Main.immediate) {
                                        progressPct = (frac * 100).toInt().coerceIn(0, 99)
                                    }
                                }
                                progressPct = 100
                                val launched = updater.install(ctx, file)
                                progressPct = null
                                if (!launched) {
                                    hintUnknownSources = true
                                    state = UpdateState.NeedsInstallPermission(file, latest.entry)
                                }
                            }
                            else -> {
                                progressPct = null
                                state = latest
                            }
                        }
                    } catch (e: CancellationException) {
                        progressPct = null
                        throw e
                    } catch (e: Exception) {
                        progressPct = null
                        actionError = e.message ?: e.javaClass.simpleName
                    }
                }
            },
            onDismiss = { confirm = null },
        )
    }
}

private data class StatusLine(val text: String, val color: (RivetColors) -> Color)

@Composable
private fun statusLine(state: UpdateState?, progressPct: Int?): StatusLine? {
    if (progressPct != null) {
        return StatusLine(
            stringResource(R.string.updates_downloading) + " ${progressPct}%",
        ) { it.inkDim }
    }
    return when (state) {
        null -> null
        UpdateState.Checking -> StatusLine(stringResource(R.string.updates_checking)) { it.inkDim }
        is UpdateState.UpToDate -> StatusLine(stringResource(R.string.updates_current, state.current)) { it.em }
        is UpdateState.Available -> {
            val mb = round(state.entry.sizeBytes / 1e6).toInt()
            StatusLine(stringResource(R.string.updates_available_size, state.entry.version, mb)) { it.em }
        }
        is UpdateState.NeedsInstallPermission -> {
            val mb = round(state.entry.sizeBytes / 1e6).toInt()
            StatusLine(stringResource(R.string.updates_available_size, state.entry.version, mb)) { it.em }
        }
        UpdateState.NoAndroidBuild -> StatusLine(stringResource(R.string.updates_no_android)) { it.inkDim }
        is UpdateState.Error -> StatusLine(stringResource(R.string.updates_error, state.message)) { it.red }
    }
}
