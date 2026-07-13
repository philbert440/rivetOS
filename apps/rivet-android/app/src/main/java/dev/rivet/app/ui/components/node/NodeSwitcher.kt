package dev.rivet.app.ui.components.node

import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SheetValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.dokar.sonner.ToastType
import me.rerere.hugeicons.HugeIcons
import me.rerere.hugeicons.stroke.Add01
import me.rerere.hugeicons.stroke.Delete01
import me.rerere.hugeicons.stroke.ServerStack01
import dev.rivet.ai.provider.ProviderManager
import dev.rivet.app.data.datastore.NodeChatBackend
import dev.rivet.app.data.datastore.NodeRosterDefaults
import dev.rivet.app.data.datastore.RosterNode
import dev.rivet.app.data.datastore.Settings
import dev.rivet.app.runtime.RivetRuntime
import dev.rivet.app.ui.context.LocalToaster
import kotlinx.coroutines.launch
import org.koin.compose.koinInject

/**
 * Drawer slot for the active RivetOS node.
 *
 * Selecting a node **repoints the native Rivet chat provider** (`baseUrl` + model list)
 * at that node's OpenAI-compat `/v1` (local bridge for this device). The hub WebView is
 * never opened as a switch destination — native chat is the UI.
 *
 * Mirrors desktop `NodeSwitcher` roster (`{name, baseUrl}`) without loading remote dist.
 */
@Composable
fun NodeSwitcher(
    settings: Settings,
    onUpdateSettings: (Settings) -> Unit,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    val toaster = LocalToaster.current
    val providerManager = koinInject<ProviderManager>()
    var showSheet by remember { mutableStateOf(false) }
    var switching by remember { mutableStateOf(false) }

    val roster = remember(settings.nodeRoster) {
        settings.nodeRoster.ifEmpty { NodeRosterDefaults.seed() }
    }
    val activeUrl = settings.activeNodeDenUrl.ifBlank { NodeRosterDefaults.localDenUrl() }
    val active = roster.firstOrNull {
        NodeRosterDefaults.normalizeDenUrl(it.denUrl) == NodeRosterDefaults.normalizeDenUrl(activeUrl)
    } ?: roster.firstOrNull() ?: NodeRosterDefaults.localNode()

    NavigationDrawerItem(
        icon = {
            Icon(HugeIcons.ServerStack01, contentDescription = null)
        },
        label = {
            Column(modifier = Modifier.fillMaxWidth()) {
                Text(
                    text = active.name,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodyLarge,
                )
                Text(
                    text = displayHost(active.denUrl),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        onClick = { showSheet = true },
        modifier = modifier,
        selected = false,
    )

    if (showSheet) {
        NodeSwitcherSheet(
            roster = roster,
            activeDenUrl = active.denUrl,
            switching = switching,
            onSelect = { node ->
                if (switching) return@NodeSwitcherSheet
                val url = NodeRosterDefaults.normalizeDenUrl(node.denUrl)
                val nextRoster = ensureLocalSeeded(roster)
                // Optimistic roster seed only; full settings (incl. active + provider) land
                // after a successful repoint so a dead node never wipes chat config.
                showSheet = false
                switching = true
                scope.launch {
                    try {
                        val withRoster = settings.copy(nodeRoster = nextRoster)
                        val next = NodeChatBackend.repointProvider(
                            settings = withRoster,
                            denUrl = url,
                        ) { probe ->
                            providerManager.getProviderByType(probe).listModels(probe)
                        }
                        onUpdateSettings(next)
                        toaster.show(
                            message = "Chat → ${node.name}",
                            type = ToastType.Success,
                        )
                    } catch (e: Exception) {
                        e.printStackTrace()
                        toaster.show(
                            message = "Can't reach ${node.name}: ${e.message ?: "unreachable"}",
                            type = ToastType.Error,
                        )
                    } finally {
                        switching = false
                    }
                }
            },
            onAdd = { node ->
                val url = NodeRosterDefaults.normalizeDenUrl(node.denUrl)
                if (url.isBlank()) return@NodeSwitcherSheet
                val next = ensureLocalSeeded(roster).toMutableList()
                if (next.none { NodeRosterDefaults.normalizeDenUrl(it.denUrl) == url }) {
                    next.add(node.copy(denUrl = url))
                }
                onUpdateSettings(
                    settings.copy(
                        nodeRoster = next,
                        activeNodeDenUrl = settings.activeNodeDenUrl.ifBlank { url },
                    )
                )
            },
            onRemove = { node ->
                if (NodeRosterDefaults.isLocalNode(node)) return@NodeSwitcherSheet
                val url = NodeRosterDefaults.normalizeDenUrl(node.denUrl)
                val next = ensureLocalSeeded(roster).filter {
                    NodeRosterDefaults.normalizeDenUrl(it.denUrl) != url
                }
                val wasActive =
                    NodeRosterDefaults.normalizeDenUrl(settings.activeNodeDenUrl) == url
                if (!wasActive) {
                    onUpdateSettings(settings.copy(nodeRoster = next))
                    return@NodeSwitcherSheet
                }
                // Removing the active remote node — fall back to local chat backend.
                switching = true
                scope.launch {
                    try {
                        val withRoster = settings.copy(nodeRoster = next)
                        val nextSettings = NodeChatBackend.repointProvider(
                            settings = withRoster,
                            denUrl = NodeRosterDefaults.localDenUrl(),
                        ) { probe ->
                            providerManager.getProviderByType(probe).listModels(probe)
                        }
                        onUpdateSettings(nextSettings)
                        toaster.show(
                            message = "Chat → ${NodeRosterDefaults.LOCAL_NAME}",
                            type = ToastType.Success,
                        )
                    } catch (e: Exception) {
                        e.printStackTrace()
                        // Still drop the peer from the roster; leave provider as-is.
                        onUpdateSettings(
                            settings.copy(
                                nodeRoster = next,
                                activeNodeDenUrl = NodeRosterDefaults.localDenUrl(),
                            )
                        )
                        toaster.show(
                            message = "Removed peer; local agent refresh failed: ${e.message}",
                            type = ToastType.Error,
                        )
                    } finally {
                        switching = false
                    }
                }
            },
            onDismiss = { showSheet = false },
        )
    }
}

@Composable
private fun NodeSwitcherSheet(
    roster: List<RosterNode>,
    activeDenUrl: String,
    switching: Boolean,
    onSelect: (RosterNode) -> Unit,
    onAdd: (RosterNode) -> Unit,
    onRemove: (RosterNode) -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberBottomSheetState(
        initialValue = SheetValue.Hidden,
        enabledValues = setOf(SheetValue.Hidden, SheetValue.Expanded),
    )
    var showAddForm by remember { mutableStateOf(false) }
    var nodeToRemove by remember { mutableStateOf<RosterNode?>(null) }

    val activeNorm = NodeRosterDefaults.normalizeDenUrl(activeDenUrl)

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp)
                .padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = "Nodes",
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.padding(bottom = 4.dp),
            )
            Text(
                text = "Pick which RivetOS node native chat talks to. Selecting re-points the Rivet provider (local bridge or remote den /v1) — no WebView.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            LazyColumn(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(280.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                items(roster, key = { it.denUrl }) { node ->
                    val selected =
                        NodeRosterDefaults.normalizeDenUrl(node.denUrl) == activeNorm
                    val isLocal = NodeRosterDefaults.isLocalNode(node)
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .combinedClickable(
                                enabled = !switching,
                                onClick = { onSelect(node) },
                                onLongClick = {
                                    if (!isLocal) nodeToRemove = node
                                },
                            )
                            .padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(
                            selected = selected,
                            onClick = { onSelect(node) },
                            enabled = !switching,
                        )
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = node.name,
                                style = MaterialTheme.typography.bodyLarge,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                text = displayHost(node.denUrl),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        if (!isLocal) {
                            IconButton(
                                onClick = { nodeToRemove = node },
                                enabled = !switching,
                            ) {
                                Icon(
                                    HugeIcons.Delete01,
                                    contentDescription = "Remove ${node.name}",
                                    modifier = Modifier.size(20.dp),
                                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }

            HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))

            if (!showAddForm) {
                TextButton(
                    onClick = { showAddForm = true },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !switching,
                ) {
                    Icon(
                        HugeIcons.Add01,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(Modifier.size(8.dp))
                    Text("Add node")
                }
            } else {
                AddNodeForm(
                    onCancel = { showAddForm = false },
                    onSubmit = { node ->
                        onAdd(node)
                        showAddForm = false
                    },
                )
            }
        }
    }

    nodeToRemove?.let { node ->
        AlertDialog(
            onDismissRequest = { nodeToRemove = null },
            title = { Text("Remove node?") },
            text = {
                Text("Remove \"${node.name}\" (${displayHost(node.denUrl)}) from the roster?")
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        onRemove(node)
                        nodeToRemove = null
                    },
                ) {
                    Text("Remove")
                }
            },
            dismissButton = {
                TextButton(onClick = { nodeToRemove = null }) {
                    Text("Cancel")
                }
            },
        )
    }
}

@Composable
private fun AddNodeForm(
    onCancel: () -> Unit,
    onSubmit: (RosterNode) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var host by remember { mutableStateOf("") }
    var port by remember { mutableStateOf(RivetRuntime.DEN_PORT.toString()) }
    val portInt = port.toIntOrNull()
    val canSubmit = name.isNotBlank() && host.isNotBlank() && portInt != null && portInt in 1..65535

    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = "Add node",
            style = MaterialTheme.typography.titleMedium,
        )
        OutlinedTextField(
            value = name,
            onValueChange = { name = it },
            label = { Text("Name") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("phildesk") },
        )
        OutlinedTextField(
            value = host,
            onValueChange = { host = it },
            label = { Text("Host") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("192.0.2.10") },
        )
        OutlinedTextField(
            value = port,
            onValueChange = { port = it.filter { c -> c.isDigit() }.take(5) },
            label = { Text("Port") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.End,
        ) {
            TextButton(onClick = onCancel) {
                Text("Cancel")
            }
            TextButton(
                onClick = {
                    if (!canSubmit || portInt == null) return@TextButton
                    onSubmit(
                        RosterNode(
                            name = name.trim(),
                            denUrl = NodeRosterDefaults.buildDenUrl(host, portInt),
                        )
                    )
                },
                enabled = canSubmit,
            ) {
                Text("Add")
            }
        }
        Spacer(Modifier.height(8.dp))
    }
}

private fun ensureLocalSeeded(roster: List<RosterNode>): List<RosterNode> {
    val local = NodeRosterDefaults.localNode()
    val localUrl = NodeRosterDefaults.normalizeDenUrl(local.denUrl)
    return if (roster.any { NodeRosterDefaults.normalizeDenUrl(it.denUrl) == localUrl }) {
        roster.map { it.copy(denUrl = NodeRosterDefaults.normalizeDenUrl(it.denUrl)) }
    } else {
        listOf(local) + roster.map { it.copy(denUrl = NodeRosterDefaults.normalizeDenUrl(it.denUrl)) }
    }
}

/** Short label for the drawer: host:port without scheme when possible. */
private fun displayHost(denUrl: String): String {
    val n = NodeRosterDefaults.normalizeDenUrl(denUrl)
    return n.removePrefix("http://").removePrefix("https://")
}
