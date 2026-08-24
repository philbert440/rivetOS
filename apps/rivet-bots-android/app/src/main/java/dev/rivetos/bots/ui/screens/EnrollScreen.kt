package dev.rivetos.bots.ui.screens

import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.rivetos.bots.AppContainer
import dev.rivetos.bots.ui.components.CircleIconButton
import dev.rivetos.bots.ui.components.VSpace
import dev.rivetos.bots.ui.theme.Danger
import dev.rivetos.bots.ui.theme.Ink
import dev.rivetos.bots.ui.theme.InkDim
import dev.rivetos.bots.ui.theme.Paper
import kotlinx.coroutines.launch

/** Entry node + device PKCS#12 → verify against /api/mesh → home. */
@Composable
fun EnrollScreen(c: AppContainer, onBack: () -> Unit, onDone: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var url by remember { mutableStateOf("") }
    var pass by remember { mutableStateOf("") }
    var p12 by remember { mutableStateOf<Pair<String, ByteArray>?>(null) }
    var ca by remember { mutableStateOf<Pair<String, ByteArray>?>(null) }
    var strict by remember { mutableStateOf(true) }
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
    val pickP12 = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let { p12 = readUri(it) } }
    val pickCa = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let { ca = readUri(it) } }

    Column(
        Modifier.fillMaxSize().background(Paper).systemBarsPadding().imePadding()
            .verticalScroll(rememberScrollState()).padding(horizontal = 20.dp),
    ) {
        VSpace(8)
        CircleIconButton(Icons.AutoMirrored.Filled.ArrowBack, "Back", onBack)
        VSpace(20)
        Text("Join the mesh", color = Ink, fontSize = 28.sp, fontWeight = FontWeight.SemiBold)
        VSpace(6)
        Text(
            "Point at any Rivet node and hand the phone its device certificate. Bots on every node the mesh knows about show up.",
            color = InkDim, fontSize = 14.sp, lineHeight = 19.sp,
        )
        VSpace(22)

        Label("Entry node")
        OutlinedTextField(
            value = url, onValueChange = { url = it }, singleLine = true,
            placeholder = { Text("https://192.0.2.10:5174", color = InkDim) },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth(),
        )
        VSpace(18)

        Label("Device certificate (.p12)")
        if (existing != null && p12 == null) {
            Text("Using ${existing.cn} (expires ${dev.rivetos.bots.ui.components.TimeFmt.date(existing.notAfter)})", color = InkDim, fontSize = 13.sp)
            VSpace(6)
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton(onClick = { pickP12.launch(arrayOf("*/*")) }, shape = CircleShape) {
                Text(if (existing != null && p12 == null) "Replace…" else "Choose file…")
            }
            Spacer(Modifier.width(12.dp))
            Text(p12?.first ?: if (existing != null) "" else "none selected", color = InkDim, fontSize = 13.sp)
        }
        if (p12 != null || existing == null) {
            VSpace(10)
            OutlinedTextField(
                value = pass, onValueChange = { pass = it }, singleLine = true,
                label = { Text("Passphrase") },
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        VSpace(18)

        Label("CA bundle (optional)")
        Text("Only needed when the .p12 doesn't carry the Rivet CA chain.", color = InkDim, fontSize = 12.sp)
        VSpace(6)
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton(onClick = { pickCa.launch(arrayOf("*/*")) }, shape = CircleShape) { Text("Choose PEM…") }
            Spacer(Modifier.width(12.dp))
            Text(ca?.first ?: "", color = InkDim, fontSize = 13.sp)
        }
        VSpace(18)

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Strict hostname check", color = Ink, fontSize = 15.sp)
                Text("Turn off only for node certs without IP SANs.", color = InkDim, fontSize = 12.sp)
            }
            Switch(checked = strict, onCheckedChange = { strict = it })
        }
        VSpace(20)

        error?.let { Text(it, color = Danger, fontSize = 13.sp); VSpace(12) }

        Button(
            onClick = {
                if (busy) return@Button
                error = null
                val entry = url.trim().trimEnd('/')
                if (!entry.startsWith("https://")) { error = "Entry node must be an https:// URL."; return@Button }
                scope.launch {
                    busy = true
                    try {
                        ca?.let { c.identity.importCaPem(it.second) }
                        p12?.let { c.identity.importPkcs12(it.second, pass) }
                        if (!c.identity.hasIdentity()) throw IllegalStateException("Pick the device certificate first.")
                        c.settings.setStrictHostnames(strict); c.setStrictHostnames(strict)
                        c.settings.setEntryUrl(entry)
                        c.bots.discover(entry, emptySet())
                        c.settings.setOnboarded(true)
                        onDone()
                    } catch (e: Exception) {
                        error = e.message ?: e.javaClass.simpleName
                    } finally { busy = false }
                }
            },
            shape = CircleShape,
            enabled = !busy,
            colors = ButtonDefaults.buttonColors(containerColor = Ink, contentColor = Paper),
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (busy) CircularProgressIndicator(Modifier.width(18.dp), color = Paper, strokeWidth = 2.dp)
            else Text("Connect", fontSize = 15.sp, fontWeight = FontWeight.Medium)
        }
        VSpace(32)
    }
}

@Composable
private fun Label(text: String) {
    Text(text, color = Ink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    VSpace(6)
}
