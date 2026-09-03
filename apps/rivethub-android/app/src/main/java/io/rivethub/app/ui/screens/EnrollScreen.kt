package io.rivethub.app.ui.screens

import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import io.rivethub.app.AppContainer
import io.rivethub.app.R
import io.rivethub.app.plane.EnrollErrorKind
import io.rivethub.app.plane.EntryUrlError
import io.rivethub.app.plane.enrollError
import io.rivethub.app.plane.validateEntryUrl
import io.rivethub.app.ui.components.DenBot
import io.rivethub.app.ui.components.Lucide
import io.rivethub.app.ui.components.RivetButton
import io.rivethub.app.ui.components.RivetButtonVariant
import io.rivethub.app.ui.components.RivetField
import io.rivethub.app.ui.components.RivetFieldSize
import io.rivethub.app.ui.components.TimeFmt
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Entry URL + device PKCS#12 → verify against /api/mesh → hub. */
@Composable
fun EnrollScreen(c: AppContainer, onBack: (() -> Unit)?, onDone: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val colors = RivetTheme.colors
    var url by remember { mutableStateOf("") }
    LaunchedEffect(Unit) { if (url.isBlank()) url = c.settings.snapshot().entryUrl }
    var pass by remember { mutableStateOf("") }
    var p12Uri by remember { mutableStateOf<Uri?>(null) }
    var p12Name by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val existing = remember { c.identity.summary() }

    val pickP12 = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri ?: return@rememberLauncherForActivityResult
        var name = uri.lastPathSegment ?: "file"
        ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cur ->
            if (cur.moveToFirst()) name = cur.getString(0) ?: name
        }
        p12Uri = uri
        p12Name = name
    }

    val certRefused = stringResource(R.string.error_cert_required)
    val timeout = stringResource(R.string.error_timeout)
    val unreachable = stringResource(R.string.error_unreachable)
    val httpsRequired = stringResource(R.string.error_https_required)
    val pickCert = stringResource(R.string.error_pick_cert)

    Column(
        Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .imePadding(),
    ) {
        if (onBack != null) {
            Box(
                Modifier
                    .padding(12.dp)
                    .clickable(onClick = onBack),
            ) {
                Lucide(
                    R.drawable.lucide_arrow_left,
                    contentDescription = stringResource(R.string.action_back),
                    tint = colors.ink,
                    modifier = Modifier.padding(8.dp),
                )
            }
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
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Top,
            ) {
                DenBot(size = Dimens.denBotEnroll, modifier = Modifier.alpha(0.9f))
                Spacer(Modifier.height(16.dp))
                Text(
                    stringResource(R.string.brand_rivethub),
                    color = colors.em,
                    style = RivetType.lg.copy(fontFamily = RivetType.brand.fontFamily),
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    stringResource(R.string.enroll_blurb),
                    color = colors.inkDim,
                    style = RivetType.sm,
                )
                Spacer(Modifier.height(24.dp))
                Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.Start) {
                    Text(
                        stringResource(R.string.label_entry_url),
                        color = colors.inkDim,
                        style = RivetType.xs,
                        modifier = Modifier.padding(bottom = 4.dp),
                    )
                    RivetField(
                        value = url,
                        onValueChange = { url = it },
                        placeholder = stringResource(R.string.hint_entry_url),
                        keyboard = KeyboardOptions(keyboardType = KeyboardType.Uri),
                        size = RivetFieldSize.Settings,
                    )
                    Spacer(Modifier.height(16.dp))
                    if (existing != null && p12Uri == null) {
                        Text(
                            stringResource(R.string.using_existing_cert, existing.cn, TimeFmt.date(existing.notAfter)),
                            color = colors.inkDim,
                            style = RivetType.xs,
                        )
                        Spacer(Modifier.height(8.dp))
                    }
                    RivetButton(
                        text = stringResource(if (existing != null && p12Uri == null) R.string.action_replace_p12 else R.string.action_import_p12),
                        onClick = { pickP12.launch(arrayOf("*/*")) },
                        variant = RivetButtonVariant.Outline,
                    )
                    val chosen = p12Name ?: if (existing != null) "" else stringResource(R.string.p12_none)
                    if (chosen.isNotEmpty()) {
                        Spacer(Modifier.height(8.dp))
                        Text(chosen, color = colors.inkDim, style = RivetType.xs)
                    }
                    if (p12Uri != null || existing == null) {
                        Spacer(Modifier.height(16.dp))
                        Text(
                            stringResource(R.string.label_passphrase),
                            color = colors.inkDim,
                            style = RivetType.xs,
                            modifier = Modifier.padding(bottom = 4.dp),
                        )
                        RivetField(
                            value = pass,
                            onValueChange = { pass = it },
                            placeholder = stringResource(R.string.label_passphrase),
                            keyboard = KeyboardOptions(keyboardType = KeyboardType.Password),
                            password = true,
                            size = RivetFieldSize.Settings,
                        )
                    }
                    error?.let {
                        Spacer(Modifier.height(12.dp))
                        Text(it, color = colors.red, style = RivetType.mono14)
                    }
                    Spacer(Modifier.height(16.dp))
                    RivetButton(
                        text = stringResource(R.string.action_connect),
                        onClick = {
                            if (busy) return@RivetButton
                            error = null
                            val entry = url.trim().trimEnd('/')
                            when (validateEntryUrl(entry)) {
                                EntryUrlError.Blank, EntryUrlError.NotHttps -> {
                                    error = httpsRequired
                                    return@RivetButton
                                }
                                null -> Unit
                            }
                            scope.launch {
                                busy = true
                                try {
                                    withContext(Dispatchers.IO) {
                                        p12Uri?.let { uri ->
                                            val bytes = ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                                                ?: throw IllegalStateException(pickCert)
                                            c.identity.importPkcs12(bytes, pass)
                                        }
                                    }
                                    pass = ""
                                    p12Uri = null
                                    p12Name = null
                                    if (!c.identity.hasIdentity()) throw IllegalStateException(pickCert)
                                    c.settings.setEntryUrl(entry)
                                    c.dropClients()
                                    c.transport.retarget(entry, emptySet())
                                    withContext(Dispatchers.IO) { c.transport.discover() }
                                    c.settings.setOnboarded(true)
                                    onDone()
                                } catch (e: Exception) {
                                    val mapped = enrollError(e)
                                    error = when (mapped.kind) {
                                        EnrollErrorKind.CertRefused -> certRefused
                                        EnrollErrorKind.Timeout -> timeout
                                        EnrollErrorKind.Unreachable -> unreachable
                                        EnrollErrorKind.Cleartext -> httpsRequired
                                        EnrollErrorKind.Other -> {
                                            if (c.identity.hasIdentity() && c.identity.summary() == null) {
                                                ctx.getString(R.string.error_cert_load, c.identity.lastError ?: "")
                                            } else mapped.detail ?: e.javaClass.simpleName
                                        }
                                    }
                                } finally {
                                    busy = false
                                }
                            }
                        },
                        enabled = !busy,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(32.dp))
                }
            }
        }
    }
}
