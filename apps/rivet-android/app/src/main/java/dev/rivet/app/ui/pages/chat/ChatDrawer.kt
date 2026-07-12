package dev.rivet.app.ui.pages.chat

import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.SheetValue
import androidx.compose.material3.rememberBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.paging.compose.collectAsLazyPagingItems
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import me.rerere.hugeicons.HugeIcons
import dev.rivet.app.data.datastore.RIVET_SSH_PORT
import dev.rivet.app.data.datastore.SettingsStore
import dev.rivet.app.net.RivetVpn
import dev.rivet.app.runtime.RivetRuntime
import dev.rivet.app.service.RivetRuntimeService
import me.rerere.hugeicons.stroke.ChartColumn
import me.rerere.hugeicons.stroke.Code
import me.rerere.hugeicons.stroke.Connect
import me.rerere.hugeicons.stroke.Image02
import me.rerere.hugeicons.stroke.InLove
import me.rerere.hugeicons.stroke.LanguageCircle
import me.rerere.hugeicons.stroke.LookTop
import me.rerere.hugeicons.stroke.PencilEdit01
import me.rerere.hugeicons.stroke.Search01
import me.rerere.hugeicons.stroke.Settings03
import me.rerere.hugeicons.stroke.Sparkles
import me.rerere.hugeicons.stroke.TransactionHistory
import dev.rivet.app.R
import dev.rivet.app.Screen
import dev.rivet.app.data.datastore.Settings
import dev.rivet.app.data.model.Assistant
import dev.rivet.app.data.model.Conversation
import dev.rivet.app.data.repository.ConversationRepository
import dev.rivet.app.ui.components.ai.AssistantPickerSheet
import dev.rivet.app.ui.components.node.NodeSwitcher
import dev.rivet.app.ui.components.ui.BackupReminderCard
import dev.rivet.app.ui.components.ui.Greeting
import dev.rivet.app.ui.components.ui.Tooltip
import dev.rivet.app.ui.components.ui.UIAvatar
import dev.rivet.app.ui.context.Navigator
import dev.rivet.app.ui.hooks.EditStateContent
import dev.rivet.app.ui.hooks.readBooleanPreference
import dev.rivet.app.ui.hooks.rememberIsPlayStoreVersion
import dev.rivet.app.ui.hooks.useEditState
import dev.rivet.app.ui.modifier.onClick
import dev.rivet.app.utils.navigateToChatPage
import dev.rivet.app.utils.toDp
import org.koin.androidx.compose.koinViewModel
import org.koin.compose.koinInject
import kotlin.uuid.Uuid

@Composable
fun ChatDrawerContent(
    navController: Navigator,
    vm: ChatVM,
    settings: Settings,
    current: Conversation,
    drawerOpen: Boolean = true,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val isPlayStore = rememberIsPlayStoreVersion()
    val repo = koinInject<ConversationRepository>()

    val activity = context as ComponentActivity
    val drawerVm: ChatDrawerVM = koinViewModel(viewModelStoreOwner = activity)

    val conversations = drawerVm.conversations.collectAsLazyPagingItems()
    val conversationListState = rememberLazyListState(
        initialFirstVisibleItemIndex = drawerVm.scrollIndex,
        initialFirstVisibleItemScrollOffset = drawerVm.scrollOffset,
    )

    LaunchedEffect(conversationListState) {
        snapshotFlow {
            conversationListState.firstVisibleItemIndex to
                conversationListState.firstVisibleItemScrollOffset
        }
            .distinctUntilChanged()
            .collectLatest { (index, offset) ->
                drawerVm.saveScrollPosition(index, offset)
            }
    }

    val conversationJobs by vm.conversationJobs.collectAsStateWithLifecycle(
        initialValue = emptyMap(),
    )

    // 昵称编辑状态
    val nicknameEditState = useEditState<String> { newNickname ->
        vm.updateSettings(
            settings.copy(
                displaySetting = settings.displaySetting.copy(
                    userNickname = newNickname
                )
            )
        )
    }

    // 移动对话状态
    var showMoveToAssistantSheet by remember { mutableStateOf(false) }
    var conversationToMove by remember { mutableStateOf<Conversation?>(null) }
    val bottomSheetState = rememberBottomSheetState(initialValue = SheetValue.Hidden)

    // Menu popup 状态
    var showMenuPopup by remember { mutableStateOf(false) }
    // Assistants moved out of the drawer header slot — still reachable from the menu.
    var showAssistantPicker by remember { mutableStateOf(false) }

    ModalDrawerSheet(
        modifier = Modifier.width(300.dp)
    ) {
        Column(
            modifier = Modifier.padding(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            BackupReminderCard(
                settings = settings,
                onClick = { navController.navigate(Screen.Backup) },
            )

            // 用户头像和昵称自定义区域
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 8.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                UIAvatar(
                    name = settings.displaySetting.userNickname.ifBlank { stringResource(R.string.user_default_name) },
                    value = settings.displaySetting.userAvatar,
                    onUpdate = { newAvatar ->
                        vm.updateSettings(
                            settings.copy(
                                displaySetting = settings.displaySetting.copy(
                                    userAvatar = newAvatar
                                )
                            )
                        )
                    },
                    modifier = Modifier.size(50.dp),
                )

                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Text(
                            text = settings.displaySetting.userNickname.ifBlank { stringResource(R.string.user_default_name) },
                            style = MaterialTheme.typography.titleMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.clickable {
                                nicknameEditState.open(settings.displaySetting.userNickname)
                            }
                        )

                        Icon(
                            imageVector = HugeIcons.PencilEdit01,
                            contentDescription = "Edit",
                            modifier = Modifier
                                .onClick {
                                    nicknameEditState.open(settings.displaySetting.userNickname)
                                }
                                .size(LocalTextStyle.current.fontSize.toDp())
                        )
                    }
                    Greeting(
                        style = MaterialTheme.typography.labelMedium,
                    )
                }
            }

            DrawerActions(navController = navController)

            RivetNodeControls(navController = navController, drawerOpen = drawerOpen)

            ConversationList(
                current = current,
                conversations = conversations,
                conversationJobs = conversationJobs.keys,
                listState = conversationListState,
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
                onClick = {
                    navigateToChatPage(navController, it.id)
                },
                onRegenerateTitle = {
                    vm.generateTitle(it, true)
                },
                onDelete = {
                    vm.deleteConversation(it)
                    // Refresh the conversation list to immediately remove the deleted item
                    // This fixes the issue where deleted conversations sometimes remain visible
                    // until manually clicked (issue #747)
                    conversations.refresh()
                    if (it.id == current.id) {
                        navigateToChatPage(navController)
                    }
                },
                onPin = {
                    vm.updatePinnedStatus(it)
                },
                onMoveToAssistant = {
                    conversationToMove = it
                    showMoveToAssistantSheet = true
                }
            )

            // Node switcher (replaces the drawer assistant-profile picker — Phil's ask).
            // Assistants remain chat-config; selection lives in Settings / the menu below.
            NodeSwitcher(
                settings = settings,
                onUpdateSettings = { vm.updateSettings(it) },
                navController = navController,
                modifier = Modifier.fillMaxWidth(),
            )

            Row(
                horizontalArrangement = Arrangement.SpaceAround,
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 8.dp)
            ) {
                Box {
                    DrawerAction(
                        icon = {
                            Icon(HugeIcons.Sparkles, "Menu")
                        },
                        label = {
                            Text(stringResource(R.string.menu))
                        },
                        onClick = {
                            showMenuPopup = true
                        },
                    )
                    DropdownMenu(
                        expanded = showMenuPopup,
                        onDismissRequest = { showMenuPopup = false }
                    ) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.assistant_page_title)) },
                            leadingIcon = { Icon(HugeIcons.LookTop, null) },
                            onClick = {
                                showMenuPopup = false
                                showAssistantPicker = true
                            }
                        )
                        if (settings.developerMode) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.chat_page_menu_image_generation)) },
                                leadingIcon = { Icon(HugeIcons.Image02, null) },
                                onClick = {
                                    showMenuPopup = false
                                    navController.navigate(Screen.ImageGen)
                                }
                            )
                        }
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.chat_page_menu_ai_translator)) },
                            leadingIcon = { Icon(HugeIcons.LanguageCircle, null) },
                            onClick = {
                                showMenuPopup = false
                                navController.navigate(Screen.Translator)
                            }
                        )
                    }
                }

                DrawerAction(
                    icon = {
                        Icon(HugeIcons.InLove, stringResource(R.string.favorite_page_title))
                    },
                    label = {
                        Text(stringResource(R.string.favorite_page_title))
                    },
                    onClick = {
                        navController.navigate(Screen.Favorite)
                    },
                )

                if (settings.developerMode) {
                    DrawerAction(
                        icon = {
                            Icon(HugeIcons.ChartColumn, "Stats")
                        },
                        label = {
                            Text("Stats")
                        },
                        onClick = {
                            navController.navigate(Screen.Stats)
                        },
                    )
                }

                Spacer(Modifier.weight(1f))

                DrawerAction(
                    icon = {
                        Icon(HugeIcons.Settings03, null)
                    },
                    label = { Text(stringResource(R.string.settings)) },
                    onClick = {
                        navController.navigate(Screen.Setting)
                    },
                )
            }
        }
    }

    // 昵称编辑对话框
    nicknameEditState.EditStateContent { nickname, onUpdate ->
        AlertDialog(
            onDismissRequest = {
                nicknameEditState.dismiss()
            },
            title = {
                Text(stringResource(R.string.chat_page_edit_nickname))
            },
            text = {
                OutlinedTextField(
                    value = nickname,
                    onValueChange = onUpdate,
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    placeholder = { Text(stringResource(R.string.chat_page_nickname_placeholder)) }
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        nicknameEditState.confirm()
                    }
                ) {
                    Text(stringResource(R.string.chat_page_save))
                }
            },
            dismissButton = {
                TextButton(
                    onClick = {
                        nicknameEditState.dismiss()
                    }
                ) {
                    Text(stringResource(R.string.chat_page_cancel))
                }
            }
        )
    }

    // Assistant selection (formerly the drawer header picker; now menu/settings entry).
    if (showAssistantPicker) {
        AssistantPickerSheet(
            settings = settings,
            onUpdateSettings = { vm.updateSettings(it) },
            onDismiss = { showAssistantPicker = false },
            onAfterSelect = { updated ->
                scope.launch {
                    val id = if (context.readBooleanPreference("create_new_conversation_on_start", true)) {
                        Uuid.random()
                    } else {
                        repo.getConversationsOfAssistant(updated.assistantId)
                            .first()
                            .firstOrNull()
                            ?.id ?: Uuid.random()
                    }
                    navigateToChatPage(navigator = navController, chatId = id)
                }
            },
        )
    }

    // 移动到助手 Bottom Sheet
    if (showMoveToAssistantSheet) {
        ModalBottomSheet(
            onDismissRequest = {
                showMoveToAssistantSheet = false
                conversationToMove = null
            },
            sheetState = bottomSheetState
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 400.dp)
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Text(
                    text = stringResource(R.string.chat_page_move_to_assistant),
                    style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.padding(bottom = 8.dp)
                )

                LazyColumn(
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(settings.assistants) { assistant ->
                        AssistantItem(
                            assistant = assistant,
                            isCurrentAssistant = assistant.id == conversationToMove?.assistantId,
                            onClick = {
                                conversationToMove?.let { conversation ->
                                    vm.moveConversationToAssistant(conversation, assistant.id)
                                    scope.launch {
                                        bottomSheetState.hide()
                                        showMoveToAssistantSheet = false
                                        conversationToMove = null
                                    }
                                }
                            }
                        )
                    }
                }
            }
        }
    }
}

/**
 * Drawer controls for the on-device Rivet runtime, separate from chat sessions:
 *  - a standalone root **Terminal** (a proot bash shell, not tied to any conversation), and
 *  - the **SSH server** toggle (dropbear via [RivetRuntimeService], persisted across restarts).
 * Hub access is the drawer [NodeSwitcher] (select local node → WebView :5174).
 */
@Composable
private fun RivetNodeControls(navController: Navigator, drawerOpen: Boolean) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val settingsStore = koinInject<SettingsStore>()
    val sshEnabled by settingsStore.sshEnabledFlow.collectAsStateWithLifecycle(initialValue = false)
    val vpnEnabled by settingsStore.vpnEnabledFlow.collectAsStateWithLifecycle(initialValue = false)
    val vpnStatus by RivetVpn.status.collectAsStateWithLifecycle(initialValue = RivetVpn.Status.DOWN)

    // VpnService consent is Activity-scoped: prepare() returns an intent the first time, and we
    // only flip the tunnel on after the user grants it. Subsequent enables short-circuit (null).
    val vpnConsentLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == android.app.Activity.RESULT_OK) {
            scope.launch { settingsStore.setVpnEnabled(true) }
            RivetRuntimeService.setVpn(context, true)
            requestBatteryExemption(context)
        }
    }

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 4.dp),
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerLow,
    ) {
        Column {
            // Node health at a glance — polls only while the drawer is open; tap to re-poll.
            NodeStatusStrip(active = drawerOpen)

            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.4f))

            // Full RivetOS monorepo self-provision (Phase 5 prereq / #374). Standalone den
            // stays up until dist/rivetos.js exists; this row only kicks the FGS provision
            // action. Hub access is via NodeSwitcher above (no duplicate Hub row — #377).
            val provisionStatus by RivetRuntime.provisionProgress.collectAsStateWithLifecycle(
                initialValue = null,
            )
            var fullRuntimeReady by remember {
                mutableStateOf(RivetRuntime.isFullRuntimeProvisioned(context))
            }
            // Re-check when the drawer opens or provision progress clears (done / failed).
            LaunchedEffect(drawerOpen, provisionStatus) {
                if (drawerOpen) {
                    fullRuntimeReady = RivetRuntime.isFullRuntimeProvisioned(context)
                }
            }
            val isProvisioning = provisionStatus != null || RivetRuntime.isProvisioning()
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .then(
                        if (!fullRuntimeReady && !isProvisioning) {
                            Modifier.onClick { RivetRuntimeService.startProvision(context) }
                        } else {
                            Modifier
                        }
                    )
                    .padding(start = 8.dp, end = 8.dp, top = 8.dp, bottom = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Icon(
                    imageVector = HugeIcons.Sparkles,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                    tint = if (fullRuntimeReady) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.onSurface
                    },
                )
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = when {
                            fullRuntimeReady -> "Node runtime ready"
                            isProvisioning -> "Provisioning node runtime…"
                            else -> "Provision node runtime"
                        },
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Text(
                        text = when {
                            fullRuntimeReady -> "full RivetOS · plugins + chat"
                            isProvisioning ->
                                "${provisionStatus ?: "working…"} · ~15 min · keep app open"
                            else -> "~15 min · downloads + builds RivetOS"
                        },
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.4f))

            // Standalone root terminal — a proot bash shell not tied to any conversation.
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .onClick {
                        navController.navigate(
                            Screen.Terminal(title = "Terminal", launchCommand = listOf("/bin/bash", "-l"))
                        )
                    }
                    .padding(start = 8.dp, end = 8.dp, top = 8.dp, bottom = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Icon(
                    imageVector = HugeIcons.Code,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                    tint = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    text = "Terminal",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.weight(1f),
                )
            }

            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.4f))

            // App-managed SSH server (dropbear) — survives doze via the runtime service.
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 8.dp, end = 8.dp, top = 6.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Icon(
                    imageVector = HugeIcons.Connect,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                    tint = MaterialTheme.colorScheme.onSurface,
                )
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = "SSH server",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Text(
                        text = if (sshEnabled) "on · port $RIVET_SSH_PORT · key-only" else "off",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Switch(
                    checked = sshEnabled,
                    onCheckedChange = { checked ->
                        scope.launch { settingsStore.setSshEnabled(checked) }
                        RivetRuntimeService.setSsh(context, checked)
                    },
                )
            }

            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.4f))

            // Mesh VPN (in-app WireGuard → rivet-prod relay → home mesh). Lets the on-device agents
            // + memory plugin reach datahub whether on home WiFi or away. Survives doze via the
            // runtime service + a battery-optimization exemption requested on first enable.
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 8.dp, end = 8.dp, top = 4.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Icon(
                    imageVector = HugeIcons.Connect,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                    tint = MaterialTheme.colorScheme.onSurface,
                )
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = "Mesh VPN",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Text(
                        text = when {
                            !RivetVpn.isConfigured -> "not configured"
                            !vpnEnabled -> "off"
                            vpnStatus == RivetVpn.Status.UP -> "connected · mesh reachable"
                            vpnStatus == RivetVpn.Status.ERROR -> "error — check relay"
                            RivetVpn.isOnHomeNetwork(context) -> "on · home WiFi (direct, tunnel idle)"
                            else -> "connecting…"
                        },
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Switch(
                    enabled = RivetVpn.isConfigured,
                    checked = vpnEnabled,
                    onCheckedChange = { checked ->
                        if (checked) {
                            val consent = RivetVpn.consentIntent(context)
                            if (consent != null) {
                                vpnConsentLauncher.launch(consent)
                            } else {
                                scope.launch { settingsStore.setVpnEnabled(true) }
                                RivetRuntimeService.setVpn(context, true)
                                requestBatteryExemption(context)
                            }
                        } else {
                            scope.launch { settingsStore.setVpnEnabled(false) }
                            RivetRuntimeService.setVpn(context, false)
                        }
                    },
                )
            }
        }
    }
}

/**
 * Best-effort: ask the user to exempt RivetHub from battery optimization so doze doesn't freeze
 * the runtime/VPN when the screen's off and away from home. No-op if already exempt.
 */
private fun requestBatteryExemption(context: android.content.Context) {
    val pm = context.getSystemService(android.content.Context.POWER_SERVICE) as android.os.PowerManager
    if (!pm.isIgnoringBatteryOptimizations(context.packageName)) {
        runCatching {
            context.startActivity(
                android.content.Intent(
                    android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    android.net.Uri.parse("package:${context.packageName}")
                ).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        }
    }
}

@Composable
private fun DrawerActions(navController: Navigator) {
    Column {
        // 搜索入口
        Surface(
            onClick = { navController.navigate(Screen.MessageSearch) },
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 4.dp),
            shape = MaterialTheme.shapes.medium,
            color = MaterialTheme.colorScheme.surfaceContainerLow,
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 8.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Icon(
                    imageVector = HugeIcons.Search01,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                    tint = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    text = stringResource(R.string.chat_page_search_chats),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
        }

        // 历史记录入口
        Surface(
            onClick = { navController.navigate(Screen.History) },
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 4.dp),
            shape = MaterialTheme.shapes.medium,
            color = MaterialTheme.colorScheme.surfaceContainerLow,
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 8.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Icon(
                    imageVector = HugeIcons.TransactionHistory,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                    tint = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    text = stringResource(R.string.chat_page_history),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
        }
    }
}

@Composable
private fun DrawerAction(
    modifier: Modifier = Modifier,
    icon: @Composable () -> Unit,
    label: @Composable () -> Unit,
    onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        modifier = modifier,
        color = MaterialTheme.colorScheme.primaryContainer,
        shape = CircleShape,
        contentColor = MaterialTheme.colorScheme.onSurface,
    ) {
        Tooltip(
            tooltip = {
                label()
            }
        ) {
            Box(
                modifier = Modifier
                    .padding(10.dp)
                    .size(20.dp),
            ) {
                icon()
            }
        }
    }
}

@Composable
private fun AssistantItem(
    assistant: Assistant,
    isCurrentAssistant: Boolean,
    onClick: () -> Unit
) {
    Surface(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.medium,
        color = if (isCurrentAssistant) {
            MaterialTheme.colorScheme.surfaceVariant
        } else {
            MaterialTheme.colorScheme.surface
        },
        tonalElevation = if (isCurrentAssistant) 2.dp else 0.dp
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            UIAvatar(
                name = assistant.name,
                value = assistant.avatar,
                onUpdate = {},
                modifier = Modifier.size(40.dp),
            )
            Column(
                modifier = Modifier.weight(1f)
            ) {
                Text(
                    text = assistant.name.ifBlank { stringResource(R.string.assistant_page_default_assistant) },
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                if (isCurrentAssistant) {
                    Text(
                        text = stringResource(R.string.assistant_page_current_assistant),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }
    }
}
