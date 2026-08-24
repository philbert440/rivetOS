package dev.rivetos.bots.ui.screens

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.rivetos.bots.AppContainer
import dev.rivetos.bots.BuildConfig
import dev.rivetos.bots.data.Prefs
import dev.rivetos.bots.ui.components.CircleIconButton
import dev.rivetos.bots.ui.components.TimeFmt
import dev.rivetos.bots.ui.components.VSpace
import dev.rivetos.bots.ui.theme.Danger
import dev.rivetos.bots.ui.theme.Ink
import dev.rivetos.bots.ui.theme.InkDim
import dev.rivetos.bots.ui.theme.Panel
import dev.rivetos.bots.ui.theme.Paper
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(c: AppContainer, onBack: () -> Unit, onForget: () -> Unit, onRosterChanged: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val prefs by c.settings.prefs.collectAsState(initial = Prefs())
    var identityGen by remember { mutableStateOf(0) }
    val summary = remember(identityGen) { c.identity.summary() }
    var entry by remember { mutableStateOf(prefs.entryUrl) }
    var handle by remember { mutableStateOf(prefs.handle) }
    var newNode by remember { mutableStateOf("") }
    var pendingP12 by remember { mutableStateOf<ByteArray?>(null) }
    var pass by remember { mutableStateOf("") }
    var msg by remember { mutableStateOf<String?>(null) }
    var confirmForget by remember { mutableStateOf(false) }
    LaunchedEffect(prefs.entryUrl) { if (entry.isBlank()) entry = prefs.entryUrl }
    LaunchedEffect(prefs.handle) { handle = prefs.handle }

    fun bytes(uri: Uri): ByteArray? = ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() }
    val pickP12 = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let { pendingP12 = bytes(it) } }
    val pickCa = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri?.let { u ->
            runCatching { c.identity.importCaPem(bytes(u) ?: ByteArray(0)) }
                .onSuccess { n -> msg = "Imported $n CA certificate(s)."; identityGen++ }
                .onFailure { e -> msg = e.message }
        }
    }

    Column(
        Modifier.fillMaxSize().background(Paper).systemBarsPadding().imePadding()
            .verticalScroll(rememberScrollState()).padding(horizontal = 20.dp),
    ) {
        VSpace(8)
        Row(verticalAlignment = Alignment.CenterVertically) {
            CircleIconButton(Icons.AutoMirrored.Filled.ArrowBack, "Back", onBack)
            Spacer(Modifier.width(12.dp))
            Text("Settings", color = Ink, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
        }
        VSpace(20)
        msg?.let { Text(it, color = InkDim, fontSize = 13.sp); VSpace(12) }

        Section("Device identity") {
            if (summary == null) {
                Text("No device certificate imported.", color = Danger, fontSize = 14.sp)
            } else {
                KV("Subject", summary.cn)
                KV("Issuer", summary.issuer)
                KV("Expires", TimeFmt.date(summary.notAfter))
                KV("CA chain", if (summary.hasCaChain) "present" else "missing — import a CA bundle")
            }
            VSpace(10)
            Row {
                OutlinedButton(onClick = { pickP12.launch(arrayOf("*/*")) }, shape = CircleShape) { Text("Import .p12…") }
                Spacer(Modifier.width(8.dp))
                OutlinedButton(onClick = { pickCa.launch(arrayOf("*/*")) }, shape = CircleShape) { Text("Import CA…") }
            }
            if (pendingP12 != null) {
                VSpace(8)
                OutlinedTextField(
                    value = pass, onValueChange = { pass = it }, singleLine = true,
                    label = { Text("Passphrase") }, visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
                VSpace(8)
                Button(
                    onClick = {
                        runCatching { c.identity.importPkcs12(pendingP12!!, pass) }
                            .onSuccess { s -> msg = "Imported ${s.cn}."; pendingP12 = null; pass = ""; identityGen++; onRosterChanged() }
                            .onFailure { e -> msg = e.message }
                    },
                    shape = CircleShape, colors = ButtonDefaults.buttonColors(containerColor = Ink, contentColor = Paper),
                ) { Text("Install certificate") }
            }
            VSpace(8)
            TextButton(onClick = { confirmForget = true }) { Text("Forget identity & sign out", color = Danger) }
        }

        Section("Mesh") {
            OutlinedTextField(
                value = entry, onValueChange = { entry = it }, singleLine = true,
                label = { Text("Entry node") }, modifier = Modifier.fillMaxWidth(),
            )
            VSpace(8)
            Button(
                onClick = { scope.launch { c.settings.setEntryUrl(entry); msg = "Entry node saved."; onRosterChanged() } },
                shape = CircleShape, colors = ButtonDefaults.buttonColors(containerColor = Ink, contentColor = Paper),
            ) { Text("Save") }
            VSpace(14)
            Text("Extra nodes", color = Ink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            Text("Gateways the entry node doesn't list (a phone node, a friend's box).", color = InkDim, fontSize = 12.sp)
            prefs.extraNodes.forEach { u ->
                Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(u, color = Ink, fontSize = 13.sp, modifier = Modifier.weight(1f))
                    TextButton(onClick = { scope.launch { c.settings.removeExtraNode(u); onRosterChanged() } }) { Text("Remove") }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = newNode, onValueChange = { newNode = it }, singleLine = true,
                    placeholder = { Text("https://192.0.2.20:5174", color = InkDim) }, modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(8.dp))
                TextButton(onClick = {
                    if (newNode.startsWith("https://")) scope.launch { c.settings.addExtraNode(newNode); newNode = ""; onRosterChanged() }
                }) { Text("Add") }
            }
        }

        Section("You") {
            OutlinedTextField(
                value = handle, onValueChange = { handle = it }, singleLine = true,
                label = { Text("Handle (sent as userId)") }, modifier = Modifier.fillMaxWidth(),
            )
            VSpace(8)
            Button(
                onClick = { scope.launch { c.settings.setHandle(handle); msg = "Saved." } },
                shape = CircleShape, colors = ButtonDefaults.buttonColors(containerColor = Ink, contentColor = Paper),
            ) { Text("Save") }
        }

        Section("Security") {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Strict hostname check", color = Ink, fontSize = 15.sp)
                    Text("Node certs are still verified against the Rivet CA either way.", color = InkDim, fontSize = 12.sp)
                }
                Switch(checked = prefs.strictHostnames, onCheckedChange = { v ->
                    scope.launch { c.settings.setStrictHostnames(v); c.setStrictHostnames(v); onRosterChanged() }
                })
            }
        }

        Section("Bots") {
            Text("${prefs.hidden.size} hidden · ${prefs.pinned.size} pinned", color = InkDim, fontSize = 13.sp)
            VSpace(6)
            OutlinedButton(onClick = { scope.launch { c.settings.unhideAll() } }, shape = CircleShape, enabled = prefs.hidden.isNotEmpty()) { Text("Unhide all") }
        }

        Section("About") {
            KV("Version", BuildConfig.VERSION_NAME)
            KV("License", "Apache-2.0")
            Text("Every bot is an agent on a RivetOS mesh node. Chats go straight to that node's gateway over device mTLS.", color = InkDim, fontSize = 12.sp, lineHeight = 17.sp)
        }
        VSpace(32)
    }

    if (confirmForget) {
        AlertDialog(
            onDismissRequest = { confirmForget = false },
            title = { Text("Forget identity?") },
            text = { Text("Removes the device certificate and all local settings. Threads stay on the nodes.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmForget = false
                    c.identity.clear()
                    scope.launch { c.settings.clearAll(); onForget() }
                }) { Text("Forget", color = Danger) }
            },
            dismissButton = { TextButton(onClick = { confirmForget = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Text(title, color = InkDim, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(bottom = 8.dp))
    Surface(color = Panel, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) { content() }
    }
    VSpace(20)
}

@Composable
private fun KV(k: String, v: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
        Text(k, color = InkDim, fontSize = 13.sp, modifier = Modifier.width(88.dp))
        Text(v, color = Ink, fontSize = 13.sp)
    }
}
