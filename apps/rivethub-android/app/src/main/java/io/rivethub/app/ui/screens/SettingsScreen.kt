package io.rivethub.app.ui.screens

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
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.material3.MaterialTheme
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
import io.rivethub.app.AppContainer
import io.rivethub.app.BuildConfig
import io.rivethub.app.data.Prefs
import io.rivethub.app.ui.components.CircleIconButton
import io.rivethub.app.ui.components.TimeFmt
import io.rivethub.app.ui.components.VSpace
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

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
    val cs = MaterialTheme.colorScheme
    LaunchedEffect(prefs.entryUrl) { if (entry.isBlank()) entry = prefs.entryUrl }
    LaunchedEffect(prefs.handle) { handle = prefs.handle }

    fun bytes(uri: Uri): ByteArray? = ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() }
    val pickP12 = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let { pendingP12 = bytes(it) } }
    val pickCa = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri?.let { u ->
            scope.launch {
                withContext(Dispatchers.IO) { runCatching { c.identity.importCaPem(bytes(u) ?: ByteArray(0)) } }
                    .onSuccess { n -> msg = "Imported $n CA certificate(s)."; identityGen++; onRosterChanged() }
                    .onFailure { e -> msg = e.message }
            }
        }
    }

    Column(
        Modifier.fillMaxSize().background(cs.background).systemBarsPadding().imePadding()
            .verticalScroll(rememberScrollState()).padding(horizontal = 20.dp),
    ) {
        VSpace(8)
        Row(verticalAlignment = Alignment.CenterVertically) {
            CircleIconButton(Icons.AutoMirrored.Filled.ArrowBack, "Back", onBack)
            Spacer(Modifier.width(12.dp))
            Text("Settings", color = cs.onBackground, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
        }
        VSpace(20)
        msg?.let { Text(it, color = cs.onSurfaceVariant, fontSize = 13.sp); VSpace(12) }

        Section("Device identity") {
            if (summary == null) {
                Text("No device certificate imported.", color = cs.error, fontSize = 14.sp)
            } else {
                KV("Subject", summary.cn)
                KV("Issuer", summary.issuer)
                KV("Expires", TimeFmt.date(summary.notAfter))
                KV("CA chain", if (summary.hasCaChain) "present" else "missing — import a CA bundle")
            }
            VSpace(10)
            Row {
                OutlinedButton(onClick = { pickP12.launch(arrayOf("*/*")) }, shape = CircleShape, modifier = Modifier.heightIn(min = 48.dp)) { Text("Import .p12…") }
                Spacer(Modifier.width(8.dp))
                OutlinedButton(onClick = { pickCa.launch(arrayOf("*/*")) }, shape = CircleShape, modifier = Modifier.heightIn(min = 48.dp)) { Text("Import CA…") }
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
                        val bytesToImport = pendingP12 ?: return@Button
                        val pw = pass
                        scope.launch {
                            withContext(Dispatchers.IO) { runCatching { c.identity.importPkcs12(bytesToImport, pw) } }
                                .onSuccess { s -> msg = "Imported ${s.cn}."; pendingP12 = null; pass = ""; identityGen++; onRosterChanged() }
                                .onFailure { e -> msg = e.message }
                        }
                    },
                    shape = CircleShape,
                    colors = ButtonDefaults.buttonColors(containerColor = cs.inverseSurface, contentColor = cs.inverseOnSurface),
                    modifier = Modifier.heightIn(min = 48.dp),
                ) { Text("Install certificate") }
            }
            VSpace(8)
            TextButton(onClick = { confirmForget = true }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Forget identity & sign out", color = cs.error) }
        }

        Section("Mesh") {
            OutlinedTextField(
                value = entry, onValueChange = { entry = it }, singleLine = true,
                label = { Text("Entry node") }, modifier = Modifier.fillMaxWidth(),
            )
            VSpace(8)
            Button(
                onClick = { scope.launch { c.settings.setEntryUrl(entry); msg = "Entry node saved."; onRosterChanged() } },
                shape = CircleShape,
                colors = ButtonDefaults.buttonColors(containerColor = cs.inverseSurface, contentColor = cs.inverseOnSurface),
                modifier = Modifier.heightIn(min = 48.dp),
            ) { Text("Save") }
            VSpace(14)
            Text("Extra nodes", color = cs.onBackground, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            Text("Gateways the entry node doesn't list (a phone node, a friend's box).", color = cs.onSurfaceVariant, fontSize = 12.sp)
            prefs.extraNodes.forEach { u ->
                Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(u, color = cs.onBackground, fontSize = 13.sp, modifier = Modifier.weight(1f))
                    TextButton(onClick = { scope.launch { c.settings.removeExtraNode(u); onRosterChanged() } }) { Text("Remove") }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = newNode, onValueChange = { newNode = it }, singleLine = true,
                    placeholder = { Text("https://192.0.2.20:5174", color = cs.onSurfaceVariant) }, modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(8.dp))
                TextButton(onClick = {
                    if (newNode.startsWith("https://")) scope.launch { c.settings.addExtraNode(newNode); newNode = ""; onRosterChanged() }
                }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Add") }
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
                shape = CircleShape,
                colors = ButtonDefaults.buttonColors(containerColor = cs.inverseSurface, contentColor = cs.inverseOnSurface),
                modifier = Modifier.heightIn(min = 48.dp),
            ) { Text("Save") }
        }

        Section("Security") {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Strict hostname check", color = cs.onBackground, fontSize = 15.sp)
                    Text(
                        if (prefs.strictHostnames) "Node certs must match the address you dial."
                        else "Relaxed: any Rivet-CA-issued cert is accepted for any host. Re-enable once node certs carry their IPs.",
                        color = if (prefs.strictHostnames) cs.onSurfaceVariant else cs.error, fontSize = 12.sp,
                    )
                }
                Switch(checked = prefs.strictHostnames, onCheckedChange = { v ->
                    scope.launch { c.settings.setStrictHostnames(v); c.setStrictHostnames(v); onRosterChanged() }
                })
            }
        }

        Section("Bots") {
            Text("${prefs.hidden.size} hidden · ${prefs.pinned.size} pinned", color = cs.onSurfaceVariant, fontSize = 13.sp)
            VSpace(6)
            OutlinedButton(
                onClick = { scope.launch { c.settings.unhideAll() } },
                shape = CircleShape, enabled = prefs.hidden.isNotEmpty(), modifier = Modifier.heightIn(min = 48.dp),
            ) { Text("Unhide all") }
        }

        Section("About") {
            KV("Version", BuildConfig.VERSION_NAME)
            KV("License", "Apache-2.0")
            Text("Every bot is an agent on a RivetOS mesh node. Chats go straight to that node's gateway over device mTLS.", color = cs.onSurfaceVariant, fontSize = 12.sp, lineHeight = 17.sp)
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
                }) { Text("Forget", color = cs.error) }
            },
            dismissButton = { TextButton(onClick = { confirmForget = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Text(title, color = cs.onSurfaceVariant, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(bottom = 8.dp))
    Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) { content() }
    }
    VSpace(20)
}

@Composable
private fun KV(k: String, v: String) {
    val cs = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
        Text(k, color = cs.onSurfaceVariant, fontSize = 13.sp, modifier = Modifier.width(88.dp))
        Text(v, color = cs.onSurface, fontSize = 13.sp)
    }
}
