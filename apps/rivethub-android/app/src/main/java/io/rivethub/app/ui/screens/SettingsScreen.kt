package io.rivethub.app.ui.screens

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.rivethub.app.AppContainer
import io.rivethub.app.BuildConfig
import io.rivethub.app.R
import io.rivethub.app.ui.HubViewModel
import io.rivethub.app.ui.components.PrimaryButton
import io.rivethub.app.ui.components.RivetConfirmDialog
import io.rivethub.app.ui.components.RivetToggle
import io.rivethub.app.ui.components.SectionHeader
import io.rivethub.app.ui.components.SegmentedControl
import io.rivethub.app.ui.components.TopBar
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun SettingsScreen(
    c: AppContainer,
    vm: HubViewModel,
    onForget: () -> Unit,
    onOpenGallery: () -> Unit,
) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val colors = RivetTheme.colors
    val prefs by c.settings.prefs.collectAsState(initial = io.rivethub.app.data.Prefs())
    var identityGen by remember { mutableStateOf(0) }
    val summary = remember(identityGen) { c.identity.summary() }
    var entry by remember { mutableStateOf(prefs.entryUrl) }
    var pendingP12 by remember { mutableStateOf<ByteArray?>(null) }
    var pass by remember { mutableStateOf("") }
    var msg by remember { mutableStateOf<String?>(null) }
    var confirmForget by remember { mutableStateOf(false) }
    LaunchedEffect(prefs.entryUrl) { if (entry.isBlank()) entry = prefs.entryUrl }

    fun bytes(uri: Uri): ByteArray? = ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() }
    val pickP12 = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri?.let { pendingP12 = bytes(it) }
    }

    val appearSystem = stringResource(R.string.appearance_system)
    val appearLight = stringResource(R.string.appearance_light)
    val appearDark = stringResource(R.string.appearance_dark)
    val fontSmall = stringResource(R.string.font_small)
    val fontMedium = stringResource(R.string.font_medium)
    val fontLarge = stringResource(R.string.font_large)
    val appearOptions = listOf(appearSystem, appearLight, appearDark)
    val appearSelected = when (prefs.themeMode) {
        "light" -> appearLight
        "dark" -> appearDark
        else -> appearSystem
    }
    val fontSelected = when {
        prefs.terminalFontSp <= 11 -> fontSmall
        prefs.terminalFontSp >= 16 -> fontLarge
        else -> fontMedium
    }

    Column(Modifier.fillMaxSize().background(colors.bg).imePadding()) {
        Box(
            Modifier.pointerInput(onOpenGallery) {
                detectTapGestures(onLongPress = { onOpenGallery() })
            },
        ) {
            TopBar(title = stringResource(R.string.title_settings))
        }
        Column(
            Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = Dimens.grid2, vertical = Dimens.grid),
        ) {
            msg?.let { Text(it, color = colors.inkDim, style = RivetType.meta); Spacer(Modifier.height(Dimens.grid)) }

            SectionHeader(stringResource(R.string.section_connection))
            Spacer(Modifier.height(Dimens.gridHalf))
            RivetField(
                value = entry,
                onValueChange = { entry = it },
                placeholder = stringResource(R.string.hint_entry_url),
            )
            Spacer(Modifier.height(Dimens.grid))
            PrimaryButton(
                text = stringResource(R.string.action_save),
                onClick = {
                    scope.launch {
                        c.settings.setEntryUrl(entry)
                        msg = ctx.getString(R.string.entry_saved)
                        vm.refresh()
                    }
                },
            )
            Spacer(Modifier.height(Dimens.grid2))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f).padding(end = Dimens.grid)) {
                    Text(stringResource(R.string.label_strict_hostname), color = colors.ink, style = RivetType.body)
                    Text(
                        if (prefs.strictHostnames) stringResource(R.string.strict_hostname_on) else stringResource(R.string.strict_hostname_off),
                        color = if (prefs.strictHostnames) colors.inkDim else colors.red,
                        style = RivetType.meta,
                    )
                }
                RivetToggle(
                    checked = prefs.strictHostnames,
                    onChange = { v ->
                        scope.launch {
                            c.settings.setStrictHostnames(v)
                            c.setStrictHostnames(v)
                            c.dropClients()
                            vm.refresh()
                        }
                    },
                )
            }

            Spacer(Modifier.height(Dimens.grid3))
            SectionHeader(stringResource(R.string.section_identity))
            Spacer(Modifier.height(Dimens.gridHalf))
            if (summary == null) {
                Text(stringResource(R.string.no_identity), color = colors.red, style = RivetType.meta)
            } else {
                Kv(stringResource(R.string.label_subject), summary.cn)
                Kv(stringResource(R.string.label_fingerprint), c.identity.deviceTag())
            }
            Spacer(Modifier.height(Dimens.grid))
            PrimaryButton(
                text = stringResource(R.string.action_import_identity),
                onClick = { pickP12.launch(arrayOf("*/*")) },
            )
            if (pendingP12 != null) {
                Spacer(Modifier.height(Dimens.grid))
                RivetField(
                    value = pass,
                    onValueChange = { pass = it },
                    placeholder = stringResource(R.string.label_passphrase),
                    password = true,
                )
                Spacer(Modifier.height(Dimens.grid))
                PrimaryButton(
                    text = stringResource(R.string.action_install_cert),
                    onClick = {
                        val bytesToImport = pendingP12 ?: return@PrimaryButton
                        val pw = pass
                        scope.launch {
                            withContext(Dispatchers.IO) { runCatching { c.identity.importPkcs12(bytesToImport, pw) } }
                                .onSuccess {
                                    msg = it.cn
                                    pendingP12 = null
                                    pass = ""
                                    identityGen++
                                    c.dropClients()
                                    vm.refresh()
                                }
                                .onFailure { e -> msg = e.message }
                        }
                    },
                )
            }
            Spacer(Modifier.height(Dimens.grid))
            Text(
                stringResource(R.string.action_forget_device),
                color = colors.red,
                style = RivetType.body,
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { confirmForget = true }
                    .padding(vertical = Dimens.grid),
            )

            Spacer(Modifier.height(Dimens.grid2))
            SectionHeader(stringResource(R.string.section_appearance))
            Spacer(Modifier.height(Dimens.grid))
            SegmentedControl(
                options = appearOptions,
                selected = appearSelected,
                onSelect = { sel ->
                    val mode = when (sel) {
                        appearLight -> "light"
                        appearDark -> "dark"
                        else -> "system"
                    }
                    scope.launch { c.settings.setThemeMode(mode) }
                },
            )

            Spacer(Modifier.height(Dimens.grid3))
            SectionHeader(stringResource(R.string.section_terminal))
            Spacer(Modifier.height(Dimens.gridHalf))
            Text(stringResource(R.string.label_font_size), color = colors.inkDim, style = RivetType.meta)
            Spacer(Modifier.height(Dimens.gridHalf))
            SegmentedControl(
                options = listOf(fontSmall, fontMedium, fontLarge),
                selected = fontSelected,
                onSelect = { sel ->
                    val sp = when (sel) {
                        fontSmall -> 11
                        fontLarge -> 16
                        else -> 13
                    }
                    scope.launch { c.settings.setTerminalFontSp(sp) }
                },
            )

            Spacer(Modifier.height(Dimens.grid3))
            SectionHeader(stringResource(R.string.section_about))
            Spacer(Modifier.height(Dimens.gridHalf))
            Kv(stringResource(R.string.about_version), BuildConfig.VERSION_NAME)
            Kv(stringResource(R.string.about_package), BuildConfig.APPLICATION_ID)
            Spacer(Modifier.height(Dimens.grid4))
        }
    }

    if (confirmForget) {
        RivetConfirmDialog(
            title = stringResource(R.string.forget_title),
            message = stringResource(R.string.forget_body),
            confirmLabel = stringResource(R.string.forget_confirm),
            cancelLabel = stringResource(R.string.action_cancel),
            danger = true,
            onConfirm = {
                confirmForget = false
                c.identity.clear()
                c.dropClients()
                scope.launch { c.settings.clearAll(); onForget() }
            },
            onDismiss = { confirmForget = false },
        )
    }
}

@Composable
private fun Kv(k: String, v: String) {
    val colors = RivetTheme.colors
    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
        Text(k, color = colors.inkDim, style = RivetType.meta, modifier = Modifier.weight(0.4f))
        Text(v, color = colors.ink, style = RivetType.meta, modifier = Modifier.weight(0.6f))
    }
}
