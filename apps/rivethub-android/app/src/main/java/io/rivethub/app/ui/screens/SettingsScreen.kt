package io.rivethub.app.ui.screens

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.rivethub.app.AppContainer
import io.rivethub.app.BuildConfig
import io.rivethub.app.R
import io.rivethub.app.plane.EntryUrlError
import io.rivethub.app.plane.validateEntryUrl
import io.rivethub.app.ui.HubViewModel
import io.rivethub.app.ui.components.PageHeader
import io.rivethub.app.ui.components.RivetButton
import io.rivethub.app.ui.components.RivetButtonVariant
import io.rivethub.app.ui.components.RivetConfirmDialog
import io.rivethub.app.ui.components.RivetField
import io.rivethub.app.ui.components.RivetFieldSize
import io.rivethub.app.ui.components.SegmentedControl
import io.rivethub.app.ui.components.ThemeGroup
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private sealed interface ProbeState {
    data object Idle : ProbeState
    data object Testing : ProbeState
    data class Ok(val node: String, val agents: Int) : ProbeState
    data class Fail(val message: String) : ProbeState
}

@Composable
fun SettingsScreen(
    c: AppContainer,
    vm: HubViewModel,
    onForget: () -> Unit,
    onOpenGallery: () -> Unit,
    onOpenDrawer: () -> Unit,
) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val colors = RivetTheme.colors
    val prefs by c.settings.prefs.collectAsState(initial = io.rivethub.app.data.Prefs())
    var identityGen by remember { mutableStateOf(0) }
    val summary = remember(identityGen) { c.identity.summary() }
    var entry by remember { mutableStateOf(prefs.entryUrl) }
    var pendingP12 by remember { mutableStateOf<Uri?>(null) }
    var pass by remember { mutableStateOf("") }
    var probe by remember { mutableStateOf<ProbeState>(ProbeState.Idle) }
    var confirmForget by remember { mutableStateOf(false) }
    LaunchedEffect(prefs.entryUrl) { if (entry.isBlank()) entry = prefs.entryUrl }

    val pickP12 = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri?.let { pendingP12 = it }
    }

    val appearSystem = stringResource(R.string.appearance_system)
    val appearLight = stringResource(R.string.appearance_light)
    val appearDark = stringResource(R.string.appearance_dark)
    val fontSmall = stringResource(R.string.font_small)
    val fontMedium = stringResource(R.string.font_medium)
    val fontLarge = stringResource(R.string.font_large)
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

    Column(Modifier.fillMaxSize().imePadding()) {
        Box(
            Modifier.pointerInput(onOpenGallery) {
                detectTapGestures(onLongPress = { onOpenGallery() })
            },
        ) {
            PageHeader(onOpenDrawer = onOpenDrawer)
        }
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val hPad = if (maxWidth < 400.dp) 16.dp else 24.dp
            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = hPad, vertical = 32.dp)
                    .widthIn(max = 576.dp)
                    .align(Alignment.TopCenter),
            ) {
                Text(
                    stringResource(R.string.title_settings),
                    color = colors.em,
                    style = RivetType.lg.copy(fontFamily = RivetType.brand.fontFamily),
                    modifier = Modifier.padding(bottom = 24.dp),
                )

                SettingsH2(stringResource(R.string.section_connection), first = true)
                FieldLabel(stringResource(R.string.label_entry_url))
                RivetField(
                    value = entry,
                    onValueChange = { entry = it },
                    placeholder = stringResource(R.string.hint_entry_url),
                    size = RivetFieldSize.Settings,
                )
                Spacer(Modifier.height(8.dp))
                FieldLabel(stringResource(R.string.label_strict_pair))
                val strictOn = stringResource(R.string.strict_on)
                val strictOff = stringResource(R.string.strict_off)
                SegmentedControl(
                    options = listOf(strictOn, strictOff),
                    selected = if (prefs.strictHostnames) strictOn else strictOff,
                    onSelect = { sel ->
                        val on = sel == strictOn
                        scope.launch {
                            c.settings.setStrictHostnames(on)
                            c.setStrictHostnames(on)
                            c.dropClients()
                            vm.refresh()
                        }
                    },
                )
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    RivetButton(
                        text = stringResource(R.string.action_test_connection),
                        onClick = {
                            when (validateEntryUrl(entry)) {
                                EntryUrlError.Blank, EntryUrlError.NotHttps -> {
                                    probe = ProbeState.Fail(ctx.getString(R.string.error_https_required))
                                }
                                null -> scope.launch {
                                    probe = ProbeState.Testing
                                    val result = withContext(Dispatchers.IO) {
                                        runCatching {
                                            val url = entry.trim().trimEnd('/')
                                            c.settings.setEntryUrl(url)
                                            c.transport.retarget(url, c.settings.snapshot().extraNodes)
                                            val hz = c.transport.entry().healthz()
                                            if (!hz.ok) error("unreachable (healthz failed)")
                                            val catalog = runCatching { c.transport.entry().catalogAgents() }.getOrNull()
                                            ProbeState.Ok(hz.name.ifBlank { url }, catalog?.agents?.size ?: 0)
                                        }
                                    }
                                    probe = result.getOrElse { ProbeState.Fail(it.message ?: it.javaClass.simpleName) }
                                }
                            }
                        },
                        variant = RivetButtonVariant.Outline,
                    )
                    RivetButton(
                        text = stringResource(R.string.action_save),
                        onClick = {
                            when (validateEntryUrl(entry)) {
                                EntryUrlError.Blank, EntryUrlError.NotHttps -> {
                                    probe = ProbeState.Fail(ctx.getString(R.string.error_https_required))
                                }
                                null -> scope.launch {
                                    c.settings.setEntryUrl(entry.trim().trimEnd('/'))
                                    vm.refresh()
                                    probe = ProbeState.Idle
                                }
                            }
                        },
                    )
                }
                Spacer(Modifier.height(16.dp))
                when (val p = probe) {
                    ProbeState.Idle -> Unit
                    ProbeState.Testing -> Text(stringResource(R.string.probe_probing), color = colors.inkDim, style = RivetType.mono14)
                    is ProbeState.Ok -> Text(
                        if (p.agents == 1) stringResource(R.string.probe_ok_one, p.node)
                        else stringResource(R.string.probe_ok, p.node, p.agents),
                        color = colors.em,
                        style = RivetType.mono14,
                    )
                    is ProbeState.Fail -> Text(stringResource(R.string.probe_fail, p.message), color = colors.red, style = RivetType.mono14)
                }

                SettingsH2(stringResource(R.string.section_identity))
                if (summary == null) {
                    Text(stringResource(R.string.no_identity), color = colors.red, style = RivetType.xs)
                } else {
                    Text(c.identity.deviceTag(), color = colors.ink, style = RivetType.mono11)
                }
                Spacer(Modifier.height(8.dp))
                RivetButton(
                    text = stringResource(R.string.action_import_p12),
                    onClick = { pickP12.launch(arrayOf("*/*")) },
                    variant = RivetButtonVariant.Outline,
                )
                if (pendingP12 != null) {
                    Spacer(Modifier.height(8.dp))
                    RivetField(
                        value = pass,
                        onValueChange = { pass = it },
                        placeholder = stringResource(R.string.label_passphrase),
                        password = true,
                    )
                    Spacer(Modifier.height(8.dp))
                    RivetButton(
                        text = stringResource(R.string.action_install_cert),
                        onClick = {
                            val uriToImport = pendingP12 ?: return@RivetButton
                            val pw = pass
                            scope.launch {
                                withContext(Dispatchers.IO) {
                                    runCatching {
                                        val bytes = ctx.contentResolver.openInputStream(uriToImport)?.use { it.readBytes() }
                                            ?: error("could not read p12")
                                        c.identity.importPkcs12(bytes, pw)
                                    }
                                }
                                    .onSuccess {
                                        pendingP12 = null
                                        pass = ""
                                        identityGen++
                                        c.dropClients()
                                        vm.refresh()
                                    }
                                    .onFailure { e -> probe = ProbeState.Fail(e.message ?: e.javaClass.simpleName) }
                            }
                        },
                    )
                }
                Spacer(Modifier.height(8.dp))
                ForgetButton(onClick = { confirmForget = true })

                SettingsH2(stringResource(R.string.section_appearance))
                ThemeGroup(
                    options = listOf(appearLight, appearDark, appearSystem),
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
                Text(
                    stringResource(R.string.appearance_helper),
                    color = colors.inkDim,
                    style = RivetType.xs,
                    modifier = Modifier.padding(top = 8.dp),
                )

                SettingsH2(stringResource(R.string.section_terminal))
                ThemeGroup(
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

                SettingsH2(stringResource(R.string.section_about))
                Text(
                    "${stringResource(R.string.about_version)} ${BuildConfig.VERSION_NAME}",
                    color = colors.inkDim,
                    style = RivetType.mono11,
                )
                Text(
                    BuildConfig.APPLICATION_ID,
                    color = colors.inkDim,
                    style = RivetType.mono11,
                )
                Spacer(Modifier.height(32.dp))
            }
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
private fun SettingsH2(text: String, first: Boolean = false) {
    val colors = RivetTheme.colors
    Text(
        text,
        color = colors.em,
        style = RivetType.monoSmSemibold,
        modifier = Modifier
            .padding(top = if (first) 0.dp else 40.dp)
            .then(if (first) Modifier else Modifier.drawTopPad(colors.line))
            .padding(top = if (first) 0.dp else 24.dp)
            .padding(bottom = 12.dp),
    )
}

@Composable
private fun FieldLabel(text: String) {
    Text(
        text,
        color = RivetTheme.colors.inkDim,
        style = RivetType.xs,
        modifier = Modifier.padding(bottom = 4.dp),
    )
}

@Composable
private fun ForgetButton(onClick: () -> Unit) {
    val colors = RivetTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val shape = RoundedCornerShape(Radius.sm)
    Text(
        stringResource(R.string.action_forget_device),
        color = if (pressed) colors.red else colors.ink,
        style = RivetType.sm,
        modifier = Modifier
            .clip(shape)
            .border(1.dp, colors.line, shape)
            .background(colors.panel2, shape)
            .clickable(interactionSource = interaction, indication = null, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 8.dp),
    )
}

private fun Modifier.drawTopPad(color: androidx.compose.ui.graphics.Color): Modifier =
    drawBehind {
        val stroke = 1.dp.toPx()
        drawLine(
            color,
            Offset(0f, stroke / 2f),
            Offset(size.width, stroke / 2f),
            stroke,
        )
    }
