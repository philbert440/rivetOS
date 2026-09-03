package io.rivethub.app.ui.screens

import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import io.rivethub.app.AppContainer
import io.rivethub.app.R
import io.rivethub.app.plane.EnrollErrorKind
import io.rivethub.app.plane.enrollError
import io.rivethub.app.ui.components.PrimaryButton
import io.rivethub.app.ui.components.SectionHeader
import io.rivethub.app.ui.components.TimeFmt
import io.rivethub.app.ui.components.TopBar
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
    var p12 by remember { mutableStateOf<Pair<String, ByteArray>?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val existing = remember { c.identity.summary() }

    fun readUri(uri: Uri): Pair<String, ByteArray>? {
        val bytes = ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return null
        var name = uri.lastPathSegment ?: "file"
        ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cur ->
            if (cur.moveToFirst()) name = cur.getString(0) ?: name
        }
        return name to bytes
    }
    val pickP12 = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri?.let { p12 = readUri(it) }
    }

    val certRefused = stringResource(R.string.error_cert_required)
    val timeout = stringResource(R.string.error_timeout)
    val unreachable = stringResource(R.string.error_unreachable)
    val httpsRequired = stringResource(R.string.error_https_required)
    val pickCert = stringResource(R.string.error_pick_cert)

    Column(
        Modifier
            .fillMaxSize()
            .background(colors.bg)
            .statusBarsPadding()
            .imePadding(),
    ) {
        TopBar(title = stringResource(R.string.title_enroll), onBack = onBack)
        Column(
            Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = Dimens.grid2, vertical = Dimens.grid2),
        ) {
            Text(stringResource(R.string.enroll_blurb), color = colors.inkDim, style = RivetType.body)
            Spacer(Modifier.height(Dimens.grid2))

            SectionHeader(stringResource(R.string.label_entry_url))
            Spacer(Modifier.height(Dimens.gridHalf))
            RivetField(
                value = url,
                onValueChange = { url = it },
                placeholder = stringResource(R.string.hint_entry_url),
                keyboard = KeyboardOptions(keyboardType = KeyboardType.Uri),
            )
            Spacer(Modifier.height(Dimens.grid2))

            SectionHeader(stringResource(R.string.label_p12))
            Spacer(Modifier.height(Dimens.gridHalf))
            if (existing != null && p12 == null) {
                Text(
                    stringResource(R.string.using_existing_cert, existing.cn, TimeFmt.date(existing.notAfter)),
                    color = colors.inkDim,
                    style = RivetType.meta,
                )
                Spacer(Modifier.height(Dimens.gridHalf))
            }
            PrimaryButton(
                text = stringResource(if (existing != null && p12 == null) R.string.action_replace_p12 else R.string.action_choose_p12),
                onClick = { pickP12.launch(arrayOf("*/*")) },
            )
            val chosen = p12?.first ?: if (existing != null) "" else stringResource(R.string.p12_none)
            if (chosen.isNotEmpty()) {
                Spacer(Modifier.height(Dimens.gridHalf))
                Text(chosen, color = colors.inkDim, style = RivetType.meta)
            }
            if (p12 != null || existing == null) {
                Spacer(Modifier.height(Dimens.grid))
                SectionHeader(stringResource(R.string.label_passphrase))
                Spacer(Modifier.height(Dimens.gridHalf))
                RivetField(
                    value = pass,
                    onValueChange = { pass = it },
                    placeholder = stringResource(R.string.label_passphrase),
                    keyboard = KeyboardOptions(keyboardType = KeyboardType.Password),
                    password = true,
                )
            }
            error?.let {
                Spacer(Modifier.height(Dimens.grid))
                Text(it, color = colors.red, style = RivetType.meta)
            }
            Spacer(Modifier.height(Dimens.grid2))
            PrimaryButton(
                text = stringResource(R.string.action_connect),
                onClick = {
                    if (busy) return@PrimaryButton
                    error = null
                    val entry = url.trim().trimEnd('/')
                    if (!entry.startsWith("https://")) {
                        error = httpsRequired
                        return@PrimaryButton
                    }
                    scope.launch {
                        busy = true
                        try {
                            withContext(Dispatchers.IO) {
                                p12?.let { c.identity.importPkcs12(it.second, pass) }
                            }
                            pass = ""
                            p12 = null
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
            Spacer(Modifier.height(Dimens.grid4))
        }
    }
}

@Composable
internal fun RivetField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    keyboard: KeyboardOptions = KeyboardOptions.Default,
    password: Boolean = false,
    singleLine: Boolean = true,
) {
    val colors = RivetTheme.colors
    val shape = RoundedCornerShape(Dimens.radius6)
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        singleLine = singleLine,
        textStyle = RivetType.body.copy(color = colors.ink),
        cursorBrush = SolidColor(colors.em),
        keyboardOptions = keyboard,
        visualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
        modifier = modifier
            .fillMaxWidth()
            .border(Dimens.line, colors.line, shape)
            .background(colors.panel, shape)
            .padding(horizontal = 12.dp, vertical = 12.dp),
        decorationBox = { inner ->
            Box {
                if (value.isEmpty()) Text(placeholder, color = colors.inkDim, style = RivetType.body)
                inner()
            }
        },
    )
}
