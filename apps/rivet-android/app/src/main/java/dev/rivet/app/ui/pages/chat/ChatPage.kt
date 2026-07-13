package dev.rivet.app.ui.pages.chat

import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.DrawerState
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.PermanentNavigationDrawer
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.adaptive.currentWindowDpSize
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.dokar.sonner.ToastType
import dev.chrisbanes.haze.hazeSource
import dev.chrisbanes.haze.rememberHazeState
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import dev.rivet.ai.provider.Model
import dev.rivet.ai.core.MessageRole
import dev.rivet.ai.ui.UIMessagePart
import me.rerere.hugeicons.HugeIcons
import me.rerere.hugeicons.stroke.Cancel01
import me.rerere.hugeicons.stroke.Code
import me.rerere.hugeicons.stroke.Menu03
import me.rerere.hugeicons.stroke.MessageAdd01
import me.rerere.hugeicons.stroke.Refresh01
import me.rerere.hugeicons.stroke.Search01
import dev.rivet.app.R
import dev.rivet.app.data.datastore.Settings
import dev.rivet.app.data.datastore.findProvider
import dev.rivet.app.data.datastore.getCurrentAssistant
import dev.rivet.app.data.datastore.getCurrentChatModel
import dev.rivet.app.data.files.FilesManager
import dev.rivet.app.data.model.Conversation
import dev.rivet.app.service.ChatError
import dev.rivet.app.ui.components.ai.ChatInput
import androidx.compose.ui.platform.LocalContext
import dev.rivet.app.Screen
import dev.rivet.app.data.datastore.NodeRosterDefaults
import dev.rivet.app.data.datastore.RIVET_BRIDGE_PORT
import dev.rivet.app.data.datastore.isAgentSessionProvider
import dev.rivet.app.runtime.RivetRuntime
import dev.rivet.app.ui.context.LocalNavController
import dev.rivet.app.ui.context.LocalToaster
import dev.rivet.app.ui.context.Navigator
import dev.rivet.app.ui.hooks.ChatInputState
import dev.rivet.app.ui.hooks.EditStateContent
import dev.rivet.app.ui.hooks.useEditState
import dev.rivet.app.ui.pages.terminal.TerminalEscalate
import dev.rivet.app.utils.base64Decode
import dev.rivet.app.utils.navigateToChatPage
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import org.koin.androidx.compose.koinViewModel
import org.koin.compose.koinInject
import org.koin.core.parameter.parametersOf
import kotlin.uuid.Uuid

@Composable
fun ChatPage(id: Uuid, text: String?, files: List<Uri>, nodeId: Uuid? = null) {
    val vm: ChatVM = koinViewModel(
        parameters = {
            parametersOf(id.toString())
        }
    )
    val filesManager: FilesManager = koinInject()
    val navController = LocalNavController.current
    val scope = rememberCoroutineScope()

    val setting by vm.settings.collectAsStateWithLifecycle()
    val conversation by vm.conversation.collectAsStateWithLifecycle()
    val loadingJob by vm.conversationJob.collectAsStateWithLifecycle()
    val processingStatus by vm.processingStatus.collectAsStateWithLifecycle()
    val currentChatModel by vm.currentChatModel.collectAsStateWithLifecycle()
    val errors by vm.errors.collectAsStateWithLifecycle()

    // Mirror any in-app CLI turns back into this thread when the chat screen resumes
    // (e.g. returning from the terminal). No-op when nothing new / unaligned.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.syncCliTranscript() }

    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
    val softwareKeyboardController = LocalSoftwareKeyboardController.current

    // Handle back press when drawer is open
    BackHandler(enabled = drawerState.isOpen) {
        scope.launch {
            drawerState.close()
        }
    }

    // Hide keyboard when drawer is open
    LaunchedEffect(drawerState.isOpen) {
        if (drawerState.isOpen) {
            softwareKeyboardController?.hide()
        }
    }

    val windowAdaptiveInfo = currentWindowDpSize()
    val isBigScreen =
        windowAdaptiveInfo.width > windowAdaptiveInfo.height && windowAdaptiveInfo.width >= 1100.dp

    val inputState = vm.inputState

    // 初始化输入状态（处理传入的 files 和 text 参数）
    LaunchedEffect(files, text) {
        if (files.isNotEmpty()) {
            val localFiles = filesManager.createChatFilesByContents(files)
            val contentTypes = files.mapNotNull { file ->
                filesManager.getFileMimeType(file)
            }
            val parts = buildList {
                localFiles.forEachIndexed { index, file ->
                    val type = contentTypes.getOrNull(index)
                    if (type?.startsWith("image/") == true) {
                        add(UIMessagePart.Image(url = file.toString()))
                    } else if (type?.startsWith("video/") == true) {
                        add(UIMessagePart.Video(url = file.toString()))
                    } else if (type?.startsWith("audio/") == true) {
                        add(UIMessagePart.Audio(url = file.toString()))
                    }
                }
            }
            inputState.messageContent = parts
        }
        text?.base64Decode()?.let { decodedText ->
            if (decodedText.isNotEmpty()) {
                inputState.setMessageText(decodedText)
            }
        }
    }

    val chatListState = rememberLazyListState()
    LaunchedEffect(nodeId, conversation.messageNodes.size) {
        if (!vm.chatListInitialized && conversation.messageNodes.isNotEmpty()) {
            if (nodeId != null) {
                val index = conversation.messageNodes.indexOfFirst { it.id == nodeId }
                if (index >= 0) {
                    chatListState.scrollToItem(index)
                }
            } else {
                chatListState.requestScrollToItem(conversation.currentMessages.size + 5)
            }
            vm.chatListInitialized = true
        }
    }

    when {
        isBigScreen -> {
            PermanentNavigationDrawer(
                drawerContent = {
                    ChatDrawerContent(
                        navController = navController,
                        current = conversation,
                        vm = vm,
                        settings = setting
                    )
                }
            ) {
                ChatPageContent(
                    inputState = inputState,
                    loadingJob = loadingJob,
                    processingStatus = processingStatus,
                    setting = setting,
                    conversation = conversation,
                    drawerState = drawerState,
                    navController = navController,
                    vm = vm,
                    chatListState = chatListState,
                    currentChatModel = currentChatModel,
                    bigScreen = true,
                    errors = errors,
                    onDismissError = { vm.dismissError(it) },
                    onClearAllErrors = { vm.clearAllErrors() },
                )
            }
        }

        else -> {
            ModalNavigationDrawer(
                drawerState = drawerState,
                drawerContent = {
                    ChatDrawerContent(
                        navController = navController,
                        current = conversation,
                        vm = vm,
                        settings = setting,
                        drawerOpen = drawerState.isOpen,
                    )
                }
            ) {
                ChatPageContent(
                    inputState = inputState,
                    loadingJob = loadingJob,
                    processingStatus = processingStatus,
                    setting = setting,
                    conversation = conversation,
                    drawerState = drawerState,
                    navController = navController,
                    vm = vm,
                    chatListState = chatListState,
                    currentChatModel = currentChatModel,
                    bigScreen = false,
                    errors = errors,
                    onDismissError = { vm.dismissError(it) },
                    onClearAllErrors = { vm.clearAllErrors() },
                )
            }
            BackHandler(drawerState.isOpen) {
                scope.launch { drawerState.close() }
            }
        }
    }
}

@Composable
private fun ChatPageContent(
    inputState: ChatInputState,
    loadingJob: Job?,
    processingStatus: String? = null,
    setting: Settings,
    bigScreen: Boolean,
    conversation: Conversation,
    drawerState: DrawerState,
    navController: Navigator,
    vm: ChatVM,
    chatListState: LazyListState,
    currentChatModel: Model?,
    errors: List<ChatError>,
    onDismissError: (Uuid) -> Unit,
    onClearAllErrors: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val toaster = LocalToaster.current
    var previewMode by rememberSaveable { mutableStateOf(false) }
    val hazeState = rememberHazeState()

    TTSAutoPlay(vm = vm, setting = setting, conversation = conversation)

    Surface(
        color = MaterialTheme.colorScheme.background,
        modifier = Modifier.fillMaxSize()
    ) {
        AssistantBackground(setting = setting, modifier = Modifier.hazeSource(hazeState))
        Scaffold(
            topBar = {
                TopBar(
                    settings = setting,
                    conversation = conversation,
                    bigScreen = bigScreen,
                    drawerState = drawerState,
                    previewMode = previewMode,
                    onNewChat = {
                        navigateToChatPage(navController)
                    },
                    onClickMenu = {
                        previewMode = !previewMode
                    },
                    onResync = {
                        vm.resyncCliTranscript()
                    },
                    onUpdateTitle = {
                        vm.updateTitle(it)
                    }
                )
            },
            bottomBar = {
                ChatInput(
                    state = inputState,
                    loading = loadingJob != null,
                    settings = setting,
                    conversation = conversation,
                    mcpManager = vm.mcpManager,
                    hazeState = hazeState,
                    onCancelClick = {
                        vm.stopGeneration()
                    },
                    onSendClick = {
                        if (currentChatModel == null) {
                            toaster.show("Select a model first", type = ToastType.Error)
                            return@ChatInput
                        }
                        if (inputState.isEditing()) {
                            vm.handleMessageEdit(
                                parts = inputState.getContents(),
                                messageId = inputState.editingMessage!!,
                            )
                        } else {
                            vm.handleMessageSend(inputState.getContents())
                            scope.launch {
                                chatListState.requestScrollToItem(conversation.currentMessages.size + 5)
                            }
                        }
                        inputState.clearInput()
                    },
                    onLongSendClick = {
                        if (inputState.isEditing()) {
                            vm.handleMessageEdit(
                                parts = inputState.getContents(),
                                messageId = inputState.editingMessage!!,
                            )
                        } else {
                            vm.handleMessageSend(content = inputState.getContents(), answer = false)
                            scope.launch {
                                chatListState.requestScrollToItem(conversation.currentMessages.size + 5)
                            }
                        }
                        inputState.clearInput()
                    },
                    onUpdateChatModel = {
                        vm.setChatModel(assistant = setting.getCurrentAssistant(), model = it)
                    },
                    onUpdateAssistant = {
                        vm.updateSettings(
                            setting.copy(
                                assistants = setting.assistants.map { assistant ->
                                    if (assistant.id == it.id) {
                                        it
                                    } else {
                                        assistant
                                    }
                                }
                            )
                        )
                    },
                    onUpdateConversation = {
                        vm.updateConversation(it)
                        vm.saveConversationAsync()
                    },
                    onCompressContext = { additionalPrompt, targetTokens, keepRecentMessages ->
                        vm.handleCompressContext(additionalPrompt, targetTokens, keepRecentMessages)
                    },
                )
            },
            containerColor = Color.Transparent,
        ) { innerPadding ->
            ChatList(
                innerPadding = innerPadding,
                conversation = conversation,
                state = chatListState,
                loading = loadingJob != null,
                processingStatus = processingStatus,
                previewMode = previewMode,
                settings = setting,
                hazeState = hazeState,
                errors = errors,
                onDismissError = onDismissError,
                onClearAllErrors = onClearAllErrors,
                onRegenerate = {
                    vm.regenerateAtMessage(it)
                },
                onEdit = {
                    inputState.editingMessage = it.id
                    inputState.setContents(it.parts)
                },
                onForkMessage = {
                    scope.launch {
                        val fork = vm.forkMessage(message = it)
                        navigateToChatPage(navController, chatId = fork.id)
                    }
                },
                onDelete = {
                    if (loadingJob != null) {
                        vm.showDeleteBlockedWhileGeneratingError()
                    } else {
                        vm.deleteMessage(it)
                    }
                },
                onUpdateMessage = { newNode ->
                    vm.updateConversation(
                        conversation.copy(
                            messageNodes = conversation.messageNodes.map { node ->
                                if (node.id == newNode.id) {
                                    newNode
                                } else {
                                    node
                                }
                            }
                        ))
                    vm.saveConversationAsync()
                },
                onClickSuggestion = { suggestion ->
                    inputState.editingMessage = null
                    // Submit the tapped chip directly as the user's reply (free text stays
                    // available via the normal input box). Falls back to just filling the
                    // input when sending isn't possible right now.
                    if (currentChatModel != null && loadingJob == null) {
                        inputState.clearInput()
                        vm.handleMessageSend(listOf(UIMessagePart.Text(suggestion)))
                        scope.launch {
                            chatListState.requestScrollToItem(conversation.currentMessages.size + 5)
                        }
                    } else {
                        inputState.setMessageText(suggestion)
                    }
                },
                onTranslate = { message, locale ->
                    vm.translateMessage(message, locale)
                },
                onClearTranslation = { message ->
                    vm.clearTranslationField(message.id)
                },
                onJumpToMessage = { index ->
                    previewMode = false
                    scope.launch {
                        chatListState.animateScrollToItem(index)
                    }
                },
                onToolApproval = { toolCallId, approved, reason ->
                    vm.handleToolApproval(toolCallId, approved, reason)
                },
                onToolAnswer = { toolCallId, answer ->
                    vm.handleToolAnswer(toolCallId, answer)
                },
                onToggleFavorite = { node ->
                    vm.toggleMessageFavorite(node)
                },
                onConversationSystemPromptChange = { newPrompt ->
                    vm.updateConversation(conversation.copy(customSystemPrompt = newPrompt))
                    vm.saveConversationAsync()
                },
            )
        }
    }
}

@Composable
private fun TopBar(
    settings: Settings,
    conversation: Conversation,
    drawerState: DrawerState,
    bigScreen: Boolean,
    previewMode: Boolean,
    onClickMenu: () -> Unit,
    onNewChat: () -> Unit,
    onResync: () -> Unit,
    onUpdateTitle: (String) -> Unit
) {
    val scope = rememberCoroutineScope()
    val toaster = LocalToaster.current
    val titleState = useEditState<String> {
        onUpdateTitle(it)
    }
    var showResyncConfirm by rememberSaveable { mutableStateOf(false) }

    TopAppBar(
        colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
        navigationIcon = {
            if (!bigScreen) {
                IconButton(
                    onClick = {
                        scope.launch { drawerState.open() }
                    }
                ) {
                    Icon(HugeIcons.Menu03, "Messages")
                }
            }
        },
        title = {
            val editTitleWarning = stringResource(R.string.chat_page_edit_title_warning)
            Surface(
                onClick = {
                    if (conversation.messageNodes.isNotEmpty()) {
                        titleState.open(conversation.title)
                    } else {
                        toaster.show(editTitleWarning, type = ToastType.Warning)
                    }
                },
                color = Color.Transparent,
            ) {
                Column {
                    val assistant = settings.getCurrentAssistant()
                    val model = settings.getCurrentChatModel()
                    val provider = model?.findProvider(providers = settings.providers, checkOverwrite = false)
                    Text(
                        text = conversation.title.ifBlank { stringResource(R.string.chat_page_new_chat) },
                        maxLines = 1,
                        style = MaterialTheme.typography.bodyMedium,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (model != null && provider != null) {
                        // Claude-Code-style status line: the backing agent model (from the
                        // bridge's rivet_model, e.g. "Fable 5") and a context meter computed
                        // from the latest turn's usage (prompt folds in cache reads, v2.4).
                        val lastAssistant = conversation.currentMessages
                            .lastOrNull { it.role == MessageRole.ASSISTANT && (it.agentModel != null || it.usage != null) }
                        val modelLabel = lastAssistant?.agentModel?.let { prettyAgentModel(it) }
                            ?: model.displayName
                        val ctx = lastAssistant?.usage
                            ?.let { u -> u.promptTokens + u.completionTokens }
                            ?.takeIf { it > 0 }
                            ?.let { used ->
                                val pct = (used * 100L / contextWindowOf(model.modelId)).coerceAtMost(100)
                                " · ${used / 1000}k/$pct%"
                            } ?: ""
                        Text(
                            text = "${assistant.name.ifBlank { stringResource(R.string.assistant_page_default_assistant) }} / $modelLabel (${provider.name})$ctx",
                            overflow = TextOverflow.Ellipsis,
                            maxLines = 1,
                            color = LocalContentColor.current.copy(0.65f),
                            style = MaterialTheme.typography.labelSmall.copy(
                                fontSize = 8.sp,
                            )
                        )
                    }
                }
            }
        },
        actions = {
            // Escalate to an in-app terminal for Rivet agent sessions (any active node).
            // TerminalPage routes local → proot PTY, remote → den WS (#382).
            val navController = LocalNavController.current
            val escalateContext = LocalContext.current
            val actionModel = settings.getCurrentChatModel()
            val actionProvider = actionModel?.findProvider(providers = settings.providers, checkOverwrite = false)
            val agentSession = actionModel != null && isAgentSessionProvider(actionProvider)
            // Resync rewrites the GUI transcript from the local CLI session file — local only.
            val localBridge = agentSession &&
                actionProvider is dev.rivet.ai.provider.ProviderSetting.OpenAI &&
                actionProvider.baseUrl.contains("127.0.0.1:$RIVET_BRIDGE_PORT")
            if (agentSession && actionModel != null) {
                // The chat⇄terminal handoff is the headline feature — a labeled chip, not a
                // bare icon. Resume this exact CLI/agent session in the terminal when possible.
                // Remote den models are `grok`/`claude` (not only local `rivet-*` aliases).
                AssistChip(
                    onClick = {
                        val convId = conversation.id.toString()
                        val hasTurns = conversation.messageNodes.isNotEmpty()
                        val activeDen = settings.activeNodeDenUrl
                            .ifBlank { NodeRosterDefaults.localDenUrl() }
                        val isLocal = NodeRosterDefaults.isLocalDenUrl(activeDen)
                        val launch = TerminalEscalate.launchCommand(
                            modelId = actionModel.modelId,
                            conversationId = convId,
                            hasTurns = hasTurns,
                            isLocalNode = isLocal,
                            localGrokSessionId = if (isLocal) {
                                RivetRuntime.grokSessionId(escalateContext, convId)
                            } else {
                                null
                            },
                        )
                        navController.navigate(
                            Screen.Terminal(
                                title = "${actionModel.displayName} · ${conversation.title.ifBlank { "session" }}",
                                launchCommand = launch,
                                conversationId = convId,
                            )
                        )
                    },
                    label = {
                        Text("Terminal", maxLines = 1)
                    },
                    leadingIcon = {
                        Icon(
                            imageVector = HugeIcons.Code,
                            contentDescription = "Open terminal",
                            modifier = Modifier.size(AssistChipDefaults.IconSize),
                        )
                    },
                )
            }
            if (localBridge) {
                // Un-wedge a thread that diverged from the CLI transcript (the append-only
                // mirror can't recover). Destructive to chat-only edits → confirm first.
                IconButton(onClick = { showResyncConfirm = true }) {
                    Icon(HugeIcons.Refresh01, "Resync transcript")
                }
            }

            IconButton(
                onClick = {
                    onClickMenu()
                }
            ) {
                Icon(if (previewMode) HugeIcons.Cancel01 else HugeIcons.Search01, "Chat Options")
            }

            IconButton(
                onClick = {
                    onNewChat()
                }
            ) {
                Icon(HugeIcons.MessageAdd01, "New Message")
            }
        },
    )
    titleState.EditStateContent { title, onUpdate ->
        AlertDialog(
            onDismissRequest = {
                titleState.dismiss()
            },
            title = {
                Text(stringResource(R.string.chat_page_edit_title))
            },
            text = {
                OutlinedTextField(
                    value = title,
                    onValueChange = onUpdate,
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        titleState.confirm()
                    }
                ) {
                    Text(stringResource(R.string.chat_page_save))
                }
            },
            dismissButton = {
                TextButton(
                    onClick = {
                        titleState.dismiss()
                    }
                ) {
                    Text(stringResource(R.string.chat_page_cancel))
                }
            }
        )
    }

    if (showResyncConfirm) {
        AlertDialog(
            onDismissRequest = { showResyncConfirm = false },
            title = { Text("Resync transcript?") },
            text = {
                Text(
                    "Rebuilds this thread from the on-device CLI transcript, dropping any " +
                        "chat-only messages that diverged from it. Use this if the chat looks " +
                        "stuck or out of sync with the terminal session.",
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        showResyncConfirm = false
                        onResync()
                    }
                ) {
                    Text("Resync")
                }
            },
            dismissButton = {
                TextButton(onClick = { showResyncConfirm = false }) {
                    Text(stringResource(R.string.chat_page_cancel))
                }
            }
        )
    }
}

// Context window sizes for the bridge CLIs; raw API providers fall back to the claude figure.
private fun contextWindowOf(modelId: String): Int = when (modelId) {
    "rivet-claude" -> 200_000
    "rivet-grok" -> 256_000
    else -> 200_000
}

// Pretty-print a backing model id for the status line:
// "claude-fable-5[1m]" -> "Fable 5", "claude-opus-4-8" -> "Opus 4.8",
// "claude-haiku-4-5-20251001" -> "Haiku 4.5", "grok-4-0709" -> "Grok 4".
private fun prettyAgentModel(id: String): String {
    val clean = id.substringBefore('[').removePrefix("claude-")
    val parts = clean.split('-').filter { it.isNotBlank() }
    val name = parts.firstOrNull()?.replaceFirstChar { it.uppercase() } ?: return id
    val nums = parts.drop(1).takeWhile { it.length <= 2 && it.all(Char::isDigit) }
    return if (nums.isEmpty()) name else "$name ${nums.joinToString(".")}"
}
