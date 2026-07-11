package dev.rivet.app.ui.pages.setting

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeFlexibleTopAppBar
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import me.rerere.hugeicons.HugeIcons
import me.rerere.hugeicons.stroke.Copy01
import me.rerere.hugeicons.stroke.QrCode
import me.rerere.hugeicons.stroke.View
import me.rerere.hugeicons.stroke.ViewOff
import android.os.Build
import dev.rivet.app.data.datastore.MeshConfig
import dev.rivet.app.data.datastore.SettingsStore
import dev.rivet.app.net.MeshEnroll
import dev.rivet.app.net.RivetVpn
import dev.rivet.app.ui.components.mesh.QrScanner
import dev.rivet.app.ui.components.nav.BackButton
import dev.rivet.app.ui.components.ui.permission.PermissionCamera
import dev.rivet.app.ui.components.ui.permission.PermissionManager
import dev.rivet.app.ui.components.ui.permission.rememberPermissionState
import dev.rivet.app.ui.context.LocalSettings
import dev.rivet.app.ui.context.LocalToaster
import dev.rivet.app.ui.theme.CustomColors
import dev.rivet.app.utils.plus
import org.koin.compose.koinInject

/**
 * Settings → Node & Mesh: every environment-specific coordinate the app uses (datahub, shared
 * NFS export, WireGuard relay) is entered HERE by the user. Nothing is baked into the build —
 * blank fields simply leave the corresponding feature disabled.
 */
@Composable
fun SettingMeshPage() {
    val settingsStore: SettingsStore = koinInject()
    val settings = LocalSettings.current
    val scope = rememberCoroutineScope()
    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
    val context = LocalContext.current
    val clipboardManager = LocalClipboardManager.current
    val toaster = LocalToaster.current

    fun update(fn: (MeshConfig) -> MeshConfig) {
        scope.launch {
            settingsStore.update { it.copy(meshConfig = fn(it.meshConfig)) }
        }
    }

    val mesh = settings.meshConfig

    var showScanner by remember { mutableStateOf(false) }
    var enrolling by remember { mutableStateOf(false) }
    val sheetState = rememberModalBottomSheetState()
    val cameraPermission = rememberPermissionState(setOf(PermissionCamera))
    PermissionManager(permissionState = cameraPermission)

    fun onScanned(qr: String) {
        showScanner = false
        enrolling = true
        scope.launch {
            val deviceName = "${Build.MANUFACTURER} ${Build.MODEL}".trim().ifBlank { "phone" }
            val result = withContext(Dispatchers.IO) {
                val pubkey = RivetVpn.publicKeyBase64(context)
                MeshEnroll.enroll(qr, pubkey, deviceName)
            }
            enrolling = false
            when (result) {
                is MeshEnroll.Result.Joined -> {
                    settingsStore.update { it.copy(meshConfig = result.config) }
                    toaster.show("Joined the mesh · ${result.address}")
                }
                is MeshEnroll.Result.Error -> toaster.show(result.message)
            }
        }
    }

    if (showScanner) {
        ModalBottomSheet(onDismissRequest = { showScanner = false }, sheetState = sheetState) {
            Column(
                modifier = Modifier.fillMaxWidth().padding(16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text("Scan the QR from RivetHub on your desktop", style = MaterialTheme.typography.titleMedium)
                Text(
                    "Desktop → Settings → Devices → Add device",
                    style = MaterialTheme.typography.bodySmall,
                )
                if (cameraPermission.allPermissionsGranted) {
                    QrScanner(onScanned = ::onScanned, accept = MeshEnroll::looksLikeEnroll)
                } else {
                    Text("Camera permission is needed to scan.", style = MaterialTheme.typography.bodySmall)
                    androidx.compose.material3.Button(onClick = { cameraPermission.requestPermissions() }) {
                        Text("Grant camera access")
                    }
                }
            }
        }
    }

    Scaffold(
        topBar = {
            LargeFlexibleTopAppBar(
                title = { Text("Node & Mesh") },
                navigationIcon = { BackButton() },
                scrollBehavior = scrollBehavior,
                colors = CustomColors.topBarColors,
            )
        },
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        containerColor = CustomColors.topBarColors.containerColor
    ) { innerPadding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = innerPadding + PaddingValues(8.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            item("intro") {
                Column(
                    modifier = Modifier.padding(horizontal = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(
                        text = "Point RivetHub at your own RivetOS node(s). Everything on this page " +
                            "is optional — leave a section blank to keep that feature off. Nothing " +
                            "here ships with the app.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    androidx.compose.material3.OutlinedButton(
                        onClick = { showScanner = true },
                        enabled = !enrolling,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Icon(HugeIcons.QrCode, null, modifier = Modifier.size(18.dp))
                        Text(
                            if (enrolling) "  Joining…" else "  Scan from desktop to join a mesh",
                        )
                    }
                }
            }

            item("datahub") {
                MeshSection(title = "Datahub & shared files") {
                        MeshTextField(
                            value = mesh.sharedHost,
                            label = "Shared host",
                            placeholder = "hostname or IP of your datahub/NFS node",
                            onSave = { v -> update { it.copy(sharedHost = v) } },
                        )
                        MeshTextField(
                            value = mesh.sharedExport,
                            label = "NFS export path",
                            placeholder = "/rivet-shared",
                            onSave = { v -> update { it.copy(sharedExport = v) } },
                        )
                        MeshTextField(
                            value = mesh.pgUrl,
                            label = "Memory Postgres URL",
                            placeholder = "postgres://user:pass@host:5432/db",
                            secret = true,
                            onSave = { v -> update { it.copy(pgUrl = v) } },
                        )
                        MeshTextField(
                            value = mesh.embedUrl,
                            label = "Embedding endpoint URL",
                            placeholder = "http://host:9402",
                            onSave = { v -> update { it.copy(embedUrl = v) } },
                        )
                }
            }

            item("wireguard") {
                MeshSection(title = "Mesh VPN (WireGuard)") {
                        MeshTextField(
                            value = mesh.wgEndpoint,
                            label = "Relay endpoint",
                            placeholder = "host:port",
                            onSave = { v -> update { it.copy(wgEndpoint = v) } },
                        )
                        MeshTextField(
                            value = mesh.wgPeerPublicKey,
                            label = "Relay public key",
                            placeholder = "base64 WireGuard public key",
                            onSave = { v -> update { it.copy(wgPeerPublicKey = v) } },
                        )
                        MeshTextField(
                            value = mesh.wgAddress,
                            label = "This device's address",
                            placeholder = "e.g. 192.168.99.6/32",
                            onSave = { v -> update { it.copy(wgAddress = v) } },
                        )
                        MeshTextField(
                            value = mesh.wgAllowedIps,
                            label = "Allowed IPs (mesh subnet)",
                            placeholder = "e.g. 192.168.99.0/24",
                            onSave = { v -> update { it.copy(wgAllowedIps = v) } },
                        )
                        MeshTextField(
                            value = mesh.homeSubnet,
                            label = "Home subnet prefix (optional)",
                            placeholder = "e.g. 192.168.1. — tunnel auto-idles on this LAN",
                            onSave = { v -> update { it.copy(homeSubnet = v) } },
                        )
                        OutlinedTextField(
                            value = RivetVpn.publicKeyBase64(context),
                            onValueChange = {},
                            readOnly = true,
                            label = { Text("This device's public key") },
                            supportingText = { Text("Register this as the peer on your relay. The private key never leaves the device.") },
                            trailingIcon = {
                                IconButton(onClick = {
                                    clipboardManager.setText(AnnotatedString(RivetVpn.publicKeyBase64(context)))
                                    toaster.show("Copied")
                                }) {
                                    Icon(HugeIcons.Copy01, "Copy")
                                }
                            },
                            modifier = Modifier.fillMaxWidth(),
                        )
                }
            }
        }
    }
}

@Composable
private fun MeshSection(
    title: String,
    content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        content()
    }
}

@Composable
private fun MeshTextField(
    value: String,
    label: String,
    placeholder: String,
    secret: Boolean = false,
    onSave: (String) -> Unit,
) {
    var text by remember(value) { mutableStateOf(value) }
    var visible by remember { mutableStateOf(!secret) }
    OutlinedTextField(
        value = text,
        onValueChange = {
            text = it
            onSave(it.trim())
        },
        label = { Text(label) },
        placeholder = { Text(placeholder, style = MaterialTheme.typography.bodySmall) },
        singleLine = true,
        visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
        keyboardOptions = if (secret) KeyboardOptions(keyboardType = KeyboardType.Password) else KeyboardOptions.Default,
        trailingIcon = if (secret) {
            {
                IconButton(onClick = { visible = !visible }) {
                    Icon(if (visible) HugeIcons.ViewOff else HugeIcons.View, if (visible) "Hide" else "Show")
                }
            }
        } else null,
        modifier = Modifier.fillMaxWidth(),
    )
}
