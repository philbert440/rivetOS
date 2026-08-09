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
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.dokar.sonner.ToastType
import me.rerere.hugeicons.HugeIcons
import me.rerere.hugeicons.stroke.Add01
import me.rerere.hugeicons.stroke.Delete01
import me.rerere.hugeicons.stroke.Key01
import me.rerere.hugeicons.stroke.ServerStack01
import dev.rivet.ai.provider.ProviderManager
import dev.rivet.app.data.datastore.NodeChatBackend
import dev.rivet.app.data.datastore.NodeRosterDefaults
import dev.rivet.app.data.datastore.RosterNode
import dev.rivet.app.data.datastore.Settings
import dev.rivet.app.data.datastore.SettingsStore
import dev.rivet.app.data.node.NodeAuthRegistry
import dev.rivet.app.data.node.NodeAuthState
import dev.rivet.app.data.node.NodeTokenStore
import dev.rivet.app.runtime.RivetRuntime
import dev.rivet.app.service.ChatService
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
 *
 * Writes go through [NodeChatBackend.switchNode] (store-relative + mutex) so
 * `activeNodeDenUrl` and Rivet `baseUrl` always move together and the last switch wins.
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
    val settingsStore = koinInject<SettingsStore>()
    val nodeTokens = koinInject<NodeTokenStore>()
    val nodeAuth = koinInject<NodeAuthRegistry>()
    val chatService = koinInject<ChatService>()
    var showSheet by remember { mutableStateOf(false) }
    var switching by remember { mutableStateOf(false) }
    // The credential store is a prefs file, not a flow; bump this to re-read it
    // after a save so the row's lock affordance updates in place.
    var tokenEpoch by remember { mutableIntStateOf(0) }

    val roster = remember(settings.nodeRoster) {
        settings.nodeRoster.ifEmpty { NodeRosterDefaults.seed() }
    }
    val authStates by nodeAuth.states.collectAsStateWithLifecycle()
    val tokenedNodes = remember(roster, tokenEpoch) {
        roster.filter { nodeTokens.tokenFor(it.denUrl) != null }
            .map { NodeRosterDefaults.normalizeDenUrl(it.denUrl) }
            .toSet()
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
            authStates = authStates,
            tokenedNodes = tokenedNodes,
            onSetToken = { node, token ->
                val url = NodeRosterDefaults.normalizeDenUrl(node.denUrl)
                nodeTokens.put(url, token)
                // A fresh credential deserves a fresh verdict: drop the stale
                // "needs token" and force the next snapshot to re-probe rather
                // than serve a cached one read with the old bearer.
                nodeAuth.forget(url)
                chatService.harnessPlane.invalidate()
                tokenEpoch++
                toaster.show(
                    message = if (token.isNullOrBlank()) {
                        "Cleared token for ${node.name}"
                    } else {
                        "Saved token for ${node.name}"
                    },
                    type = ToastType.Success,
                )
            },
            onSelect = { node ->
                if (switching) return@NodeSwitcherSheet
                val url = NodeRosterDefaults.normalizeDenUrl(node.denUrl)
                val nextRoster = ensureLocalSeeded(roster)
                // Full settings (incl. active + provider) land after a successful repoint
                // so a dead node never wipes chat config. switching stays true until the
                // store write completes (not just until probe returns).
                showSheet = false
                switching = true
                scope.launch {
                    try {
                        NodeChatBackend.switchNode(
                            settingsStore = settingsStore,
                            denUrl = url,
                            listModels = { probe ->
                                providerManager.getProviderByType(probe).listModels(probe)
                            },
                            transform = { current ->
                                current.copy(nodeRoster = nextRoster)
                            },
                        )
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
            onAdd = { node, token ->
                val url = NodeRosterDefaults.normalizeDenUrl(node.denUrl)
                if (url.isBlank()) return@NodeSwitcherSheet
                val next = ensureLocalSeeded(roster).toMutableList()
                if (next.none { NodeRosterDefaults.normalizeDenUrl(it.denUrl) == url }) {
                    next.add(node.copy(denUrl = url))
                }
                // The bearer never enters the roster — it goes to the credential
                // store, keyed by the same normalized URL. No forget/invalidate
                // here on purpose: a newly added node is not the active one, so
                // there is no cached snapshot or stale verdict of its own to
                // clear. (Removal does forget, because the node may be active.)
                if (!token.isNullOrBlank()) {
                    nodeTokens.put(url, token)
                    tokenEpoch++
                }
                // Roster-only; do not change active/provider unless active was blank.
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
                // Removed node ⇒ its credential goes too, same as the hub does.
                nodeTokens.remove(url)
                nodeAuth.forget(url)
                tokenEpoch++
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
                // activeNodeDenUrl + Rivet baseUrl always move together (even on probe fail).
                switching = true
                scope.launch {
                    try {
                        NodeChatBackend.switchNode(
                            settingsStore = settingsStore,
                            denUrl = NodeRosterDefaults.localDenUrl(),
                            listModels = { probe ->
                                providerManager.getProviderByType(probe).listModels(probe)
                            },
                            transform = { current ->
                                current.copy(nodeRoster = next)
                            },
                        )
                        toaster.show(
                            message = "Chat → ${NodeRosterDefaults.LOCAL_NAME}",
                            type = ToastType.Success,
                        )
                    } catch (e: Exception) {
                        e.printStackTrace()
                        // Drop peer + force local active AND bridge baseUrl (atomic).
                        NodeChatBackend.removeActiveFallbackLocal(settingsStore, url)
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
    authStates: Map<String, NodeAuthState>,
    tokenedNodes: Set<String>,
    onSelect: (RosterNode) -> Unit,
    onAdd: (RosterNode, String?) -> Unit,
    onRemove: (RosterNode) -> Unit,
    onSetToken: (RosterNode, String?) -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberBottomSheetState(
        initialValue = SheetValue.Hidden,
        enabledValues = setOf(SheetValue.Hidden, SheetValue.Expanded),
    )
    var showAddForm by remember { mutableStateOf(false) }
    var nodeToRemove by remember { mutableStateOf<RosterNode?>(null) }
    var nodeToToken by remember { mutableStateOf<RosterNode?>(null) }

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
                    val norm = NodeRosterDefaults.normalizeDenUrl(node.denUrl)
                    val selected = norm == activeNorm
                    val isLocal = NodeRosterDefaults.isLocalNode(node)
                    val authState = authStates[norm] ?: NodeAuthState.UNKNOWN
                    val hasToken = norm in tokenedNodes
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
                            authNotice(authState)?.let { notice ->
                                Text(
                                    text = notice,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.error,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                        if (!isLocal) {
                            IconButton(
                                onClick = { nodeToToken = node },
                                enabled = !switching,
                            ) {
                                Icon(
                                    HugeIcons.Key01,
                                    contentDescription = "Token for ${node.name}",
                                    modifier = Modifier.size(20.dp),
                                    tint = when {
                                        authState.needsAttention ->
                                            MaterialTheme.colorScheme.error
                                        hasToken -> MaterialTheme.colorScheme.primary
                                        else -> MaterialTheme.colorScheme.onSurfaceVariant
                                    },
                                )
                            }
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
                    onSubmit = { node, token ->
                        onAdd(node, token)
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

    nodeToToken?.let { node ->
        NodeTokenDialog(
            node = node,
            hasToken = NodeRosterDefaults.normalizeDenUrl(node.denUrl) in tokenedNodes,
            authState = authStates[NodeRosterDefaults.normalizeDenUrl(node.denUrl)]
                ?: NodeAuthState.UNKNOWN,
            onDismiss = { nodeToToken = null },
            onSave = { token ->
                onSetToken(node, token)
                nodeToToken = null
            },
        )
    }
}

/**
 * Paste-a-bearer, per node — the same affordance RivetHub web puts in Settings,
 * and the same trust model: the operator reads the value off the node itself
 * with `rivetos gateway token` and types it in here. The field starts empty
 * even when a token is stored; a credential is written, never read back out.
 */
@Composable
private fun NodeTokenDialog(
    node: RosterNode,
    hasToken: Boolean,
    authState: NodeAuthState,
    onDismiss: () -> Unit,
    onSave: (String?) -> Unit,
) {
    var draft by remember(node.denUrl) { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Token for ${node.name}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = authNotice(authState)
                        ?: if (hasToken) {
                            "A token is stored for this node. Pasting replaces it; " +
                                "saving an empty field clears it."
                        } else {
                            "Only needed when the node gates its gateway. Get it on " +
                                "the node with `rivetos gateway token`."
                        },
                    style = MaterialTheme.typography.bodySmall,
                    color = if (authState.needsAttention) {
                        MaterialTheme.colorScheme.error
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                )
                OutlinedTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    label = { Text("Bearer token") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onSave(draft.trim().ifBlank { null }) }) {
                Text(if (draft.isBlank()) "Clear" else "Save")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel")
            }
        },
    )
}

/**
 * One line of why this node is not on the control plane, or null when there is
 * nothing to say. Stale and rejected read differently on purpose: one means the
 * node rotated its bearer under a client that used to work, the other means this
 * credential was never accepted. Both end at the same paste field, and both keep
 * the legacy surface running in the meantime.
 */
private fun authNotice(state: NodeAuthState): String? = when (state) {
    NodeAuthState.NEEDS_TOKEN ->
        "Gateway is token-gated — add a token (legacy surface until then)"
    NodeAuthState.STALE_TOKEN ->
        "Token no longer accepted — the node rotated it; paste the new one"
    NodeAuthState.TOKEN_REJECTED ->
        "Token rejected by this node — check `rivetos gateway token`"
    NodeAuthState.OK, NodeAuthState.UNKNOWN -> null
}

@Composable
private fun AddNodeForm(
    onCancel: () -> Unit,
    onSubmit: (RosterNode, String?) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var host by remember { mutableStateOf("") }
    var port by remember { mutableStateOf(RivetRuntime.DEN_PORT.toString()) }
    var token by remember { mutableStateOf("") }
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
        OutlinedTextField(
            value = token,
            onValueChange = { token = it },
            label = { Text("Token (only if the node gates its gateway)") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
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
                        ),
                        token.trim().ifBlank { null },
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
