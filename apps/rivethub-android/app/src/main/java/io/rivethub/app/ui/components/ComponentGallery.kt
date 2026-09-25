package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.plane.AgentRow
import io.rivethub.app.plane.Dot
import io.rivethub.app.plane.NodeDots
import io.rivethub.app.plane.AttachmentStatus
import io.rivethub.app.plane.FONT_SCALE_STEPS
import io.rivethub.app.plane.HubTab
import io.rivethub.app.plane.NodeSheetModel
import io.rivethub.app.plane.NodeSheetRow
import io.rivethub.app.plane.PendingAttachment
import io.rivethub.app.plane.TermStatus
import io.rivethub.app.plane.contextBarView
import io.rivethub.app.plane.fontScaleLabel
import io.rivethub.app.plane.ChatError
import io.rivethub.app.plane.cotSteps
import io.rivethub.app.plane.foldSteps
import io.rivethub.app.gateway.HarnessTranscriptTool
import io.rivethub.app.gateway.HarnessTranscriptTurn
import io.rivethub.app.plane.statsLine
import io.rivethub.app.ui.term.AnsiScreen
import io.rivethub.app.ui.term.TerminalPane
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.LocalUiFontScale
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType
import io.rivethub.app.ui.theme.Shape
import io.rivethub.app.ui.theme.ThemeMode
import io.rivethub.app.ui.theme.blueprintGrid

@Composable
fun ComponentGallery(modifier: Modifier = Modifier) {
    Column(
        modifier
            .fillMaxSize()
            .systemBarsPadding()
            .verticalScroll(rememberScrollState()),
    ) {
        GalleryThemeBlock("Dark", ThemeMode.Dark)
        GalleryThemeBlock("Light", ThemeMode.Light)
    }
}

@Composable
private fun GalleryThemeBlock(label: String, mode: ThemeMode) {
    RivetTheme(mode) {
        val colors = RivetTheme.colors
        var confirmOpen by remember { mutableStateOf(false) }
        var themeSel by remember { mutableStateOf("Dark") }
        var field by remember { mutableStateOf("") }
        Column(
            Modifier
                .fillMaxWidth()
                .background(colors.bg)
                .blueprintGrid(colors.gridLine)
                .padding(bottom = Dimens.grid2),
        ) {
            ShapeGallery(mode)
            TopBar(title = "RivetHub · $label", onOpenDrawer = {}, padStatusBar = false)
            Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                GalleryH("Top bar · $label")
            }
            TopBar(title = "RivetHub", onOpenDrawer = {}, padStatusBar = false)
            Spacer(Modifier.height(8.dp))
            TopBar(title = "Settings", onOpenDrawer = {}, padStatusBar = false)
            Spacer(Modifier.height(8.dp))
            TopBar(title = "RivetHub", onOpenDrawer = null, padStatusBar = false)
            Spacer(Modifier.height(8.dp))
            // U1 chat row: menu, title, Stop, Terminal chip, search, new chat.
            ChatSessionHeader(
                sessionLabel = "claude-code:e256ef81-dbaf-4e75-bf8f-8c8f3553bcc7",
                context = contextBarView(50_202, "claude", listOf("hello")),
                modeOptions = listOf("Terminal", "Chat"),
                selectedMode = "Chat",
                mode = io.rivethub.app.plane.SessionMode.Chat,
                titleBlock = io.rivethub.app.plane.TitleBlock("Release notes", "Rivet / Claude · 50.2k/30%"),
                onSelectMode = {},
                onOpenMenu = {},
                onOpenHistory = {},
                showStop = true,
                onStop = {},
                padStatusBar = false,
            )
            Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                GalleryH("Drawer nav · $label")
                NavRow("Conversations", R.drawable.lucide_message_square, active = true, onClick = {})
                NavRow("Memory", R.drawable.lucide_library, active = false, onClick = {}, enabled = false, comingSoon = "coming soon")
                NavRow("Settings", R.drawable.lucide_settings, active = false, onClick = {})
                Spacer(Modifier.height(12.dp))

                GalleryH("Conversation rows")
            }
            ConversationRowChrome(
                title = "idle thread",
                accent = rivetHexColor("#CC785C"),
                onOpen = {},
                onArchive = {},
                onLong = {},
                harness = "Claude Code",
                swipeEnabled = false,
            )
            ConversationRowChrome(
                title = "active thread",
                accent = colors.em,
                onOpen = {},
                onArchive = {},
                onLong = {},
                active = true,
                harness = "Claude Code",
                swipeEnabled = false,
            )
            ConversationRowChrome(
                title = "in-flight thread",
                accent = colors.em,
                onOpen = {},
                onArchive = {},
                onLong = {},
                status = ConversationRowStatus.InFlight,
                harness = "Claude Code",
                swipeEnabled = false,
            )
            ConversationRowChrome(
                title = "idle session",
                accent = colors.inkDim,
                onOpen = {},
                onArchive = {},
                onLong = {},
                status = ConversationRowStatus.Alive,
                harness = "grok Build",
                swipeEnabled = false,
            )
            ConversationRowChrome(
                title = "archived draft",
                accent = colors.inkDim,
                onOpen = {},
                onArchive = {},
                onLong = {},
                archived = true,
                swipeEnabled = false,
            )
            Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                GalleryH("Buttons")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    RivetButton(text = "Save", onClick = {})
                    RivetButton(text = "Ghost", onClick = {}, variant = RivetButtonVariant.Ghost)
                    RivetButton(text = "Outline", onClick = {}, variant = RivetButtonVariant.Outline)
                }
                Spacer(Modifier.height(12.dp))
                GalleryH("Chip · input · theme")
                HarnessChip("Claude Code")
                Spacer(Modifier.height(8.dp))
                RivetField(
                    value = field,
                    onValueChange = { field = it },
                    placeholder = "filter…",
                    size = RivetFieldSize.Filter,
                )
                Spacer(Modifier.height(8.dp))
                ThemeGroup(
                    options = listOf("Light", "Dark", "System"),
                    selected = themeSel,
                    onSelect = { themeSel = it },
                )
                Spacer(Modifier.height(12.dp))
                GalleryH("Agent row")
                AgentRowChrome(
                    row = AgentRow(
                        agentId = "a1",
                        name = "rivet",
                        harnessId = "claude-code",
                        nodeId = "n",
                        nodeName = "node",
                        nodeDenUrl = "https://192.0.2.10:5174",
                        pointerSessionId = "s",
                        color = "#CC785C",
                        node = "ct115",
                        directory = "/srv/agents/rivet",
                    ),
                    onTap = {},
                    onLong = {},
                    activityActive = true,
                )
                Spacer(Modifier.height(12.dp))
                GalleryH("Settings rhythm")
                SettingsH2("Identity")
                FieldLabel("Subject")
                Text("device:pixel", color = colors.ink, style = RivetType.mono12)
                Spacer(Modifier.height(8.dp))
                FieldLabel("Entry URL")
                RivetField(
                    value = field,
                    onValueChange = { field = it },
                    placeholder = "https://192.0.2.10:5174",
                    size = RivetFieldSize.Settings,
                )
                Text(
                    "Auth is the device client certificate, imported below as a .p12.",
                    color = colors.inkDim,
                    style = RivetType.xs,
                    modifier = Modifier.padding(top = 8.dp),
                )
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    RivetButton(text = "Test connection", onClick = {}, variant = RivetButtonVariant.Outline)
                    RivetButton(text = "Save", onClick = {})
                }
                Spacer(Modifier.height(12.dp))
                GalleryH("Confirm")
                RivetButton(
                    text = "Open confirm",
                    onClick = { confirmOpen = true },
                    variant = RivetButtonVariant.Outline,
                )
                if (confirmOpen) {
                    RivetConfirmDialog(
                        title = "Forget this device?",
                        message = "Removes the device certificate.",
                        confirmLabel = "Forget",
                        cancelLabel = "Cancel",
                        danger = true,
                        onConfirm = { confirmOpen = false },
                        onDismiss = { confirmOpen = false },
                    )
                }
                Spacer(Modifier.height(12.dp))
                GalleryH("DenBot")
                DenBot(size = 28.dp)
                Spacer(Modifier.height(8.dp))
                SegmentedControl(listOf("Chat", "Terminal"), "Chat", onSelect = {})
                Spacer(Modifier.height(12.dp))
                GalleryH("Pills")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Pill("idle", PillTone.Dim)
                    Pill("streaming", PillTone.Em)
                    Pill("thinking", PillTone.Warn)
                }
                Spacer(Modifier.height(12.dp))
                GalleryH("Chat header · idle")
            }
            ChatSessionHeader(
                sessionLabel = "claude-code:e256ef81-dbaf-4e75-bf8f-8c8f3553bcc7",
                context = contextBarView(50_202, "claude", emptyList()),
                modeOptions = listOf("Terminal", "Chat"),
                selectedMode = "Chat",
                mode = io.rivethub.app.plane.SessionMode.Chat,
                titleBlock = io.rivethub.app.plane.TitleBlock("Release notes", "Rivet / Claude · 50.2k/30%"),
                onSelectMode = {},
                onOpenMenu = {},
                onOpenHistory = {},
                showStop = false,
                onStop = {},
                padStatusBar = false,
            )
            GalleryH("Chat header · in-flight")
            ChatSessionHeader(
                sessionLabel = "claude-code:e256ef81-dbaf-4e75-bf8f-8c8f3553bcc7",
                context = contextBarView(50_202, "claude", emptyList()),
                modeOptions = listOf("Terminal", "Chat"),
                selectedMode = "Chat",
                mode = io.rivethub.app.plane.SessionMode.Chat,
                titleBlock = io.rivethub.app.plane.TitleBlock("Release notes", "Rivet / Claude · 50.2k/30%"),
                onSelectMode = {},
                onOpenMenu = {},
                onOpenHistory = {},
                showStop = true,
                onStop = {},
                padStatusBar = false,
            )
            GalleryH("Chat header · draft")
            ChatSessionHeader(
                sessionLabel = "new conversation",
                context = null,
                modeOptions = listOf("Terminal", "Chat"),
                selectedMode = "Chat",
                mode = io.rivethub.app.plane.SessionMode.Chat,
                titleBlock = io.rivethub.app.plane.TitleBlock("New chat", "Rivet / Claude"),
                onSelectMode = {},
                onOpenMenu = {},
                onOpenHistory = {},
                showStop = false,
                onStop = {},
                padStatusBar = false,
            )
            Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                GalleryH("Context bar")
                ContextBar(contextBarView(50_202, "claude", listOf("hello"))!!)
                Spacer(Modifier.height(8.dp))
                ContextBar(contextBarView(150_000, "claude", listOf("hello"))!!)
                Spacer(Modifier.height(8.dp))
                ContextBar(contextBarView(null, "grok", listOf("abcd"))!!)
                Spacer(Modifier.height(12.dp))
                GalleryH("Transcript")
                TranscriptUserTurn(
                    text = "Reply with exactly the word PONG and nothing else.",
                    time = "07:00 PM",
                    onCopy = {},
                    attachments = listOf(
                        io.rivethub.app.plane.AttachedRef("/up/notes.pdf", "notes.pdf", isImage = false),
                    ),
                    actionRow = {
                        MessageActionRow(
                            actions = io.rivethub.app.plane.messageActions("user", inFlight = false, hasPrecedingUser = false),
                            onAction = {},
                            onMore = {},
                        )
                    },
                )
                Spacer(Modifier.height(12.dp))
                val gallerySteps = remember {
                    cotSteps(
                        turn = HarnessTranscriptTurn(
                            role = "assistant",
                            thinking = "the user wants a one-word reply",
                            tools = listOf(
                                HarnessTranscriptTool("Read", status = "done"),
                                HarnessTranscriptTool("Grep", status = "error"),
                                HarnessTranscriptTool("Bash", status = "running"),
                            ),
                        ),
                        liveReasoning = "",
                        liveTools = emptyList(),
                        reasoningDurationMs = 3_400,
                        live = false,
                    )
                }
                var galleryCotOpen by remember { mutableStateOf(false) }
                TranscriptAssistantTurn(
                    text = "PONG with `code` and a [link](https://example.com).",
                    model = "claude-fable-5-1",
                    time = "07:00 PM",
                    accent = rivetHexColor("#CC785C"),
                    steps = gallerySteps,
                    fold = foldSteps(gallerySteps, galleryCotOpen),
                    expanded = galleryCotOpen,
                    onToggleFold = { galleryCotOpen = !galleryCotOpen },
                    onToolTap = {},
                    stats = statsLine(50_202, 5, 30_032),
                    onCopy = {},
                    actionRow = {
                        MessageActionRow(
                            actions = io.rivethub.app.plane.messageActions("assistant", inFlight = false, hasPrecedingUser = true),
                            onAction = {},
                            onMore = {},
                        )
                    },
                )
                Spacer(Modifier.height(12.dp))
                GalleryH("Error stack")
                ChatErrorStack(
                    errors = listOf(ChatError(1, "connection reset"), ChatError(2, "turn timed out")),
                    onDismiss = {},
                    onClearAll = {},
                )
                Spacer(Modifier.height(12.dp))
                GalleryH("Composer · idle")
                var composer by remember { mutableStateOf("") }
                Composer(
                    value = composer,
                    onValueChange = { composer = it },
                    placeholder = "Message Rivet…",
                    connected = true,
                    sending = false,
                    sendEnabled = composer.isNotBlank(),
                    canStop = false,
                    onAttach = {},
                    onSend = {},
                    onStop = {},
                    pickers = { compact ->
                        ComposerPicker(
                            icon = R.drawable.lucide_server,
                            label = "ct115",
                            compact = compact,
                            options = listOf(SelectOption("n", "ct115")),
                            value = "n",
                            onChange = {},
                            title = "Node",
                        )
                        ComposerPicker(
                            icon = R.drawable.lucide_bot,
                            label = "Claude Code",
                            compact = compact,
                            options = listOf(SelectOption("claude", "Claude Code")),
                            value = "claude",
                            onChange = {},
                            title = "Model",
                        )
                        ComposerPicker(
                            icon = R.drawable.lucide_lightbulb,
                            label = "Medium",
                            compact = compact,
                            options = listOf(SelectOption("medium", "Medium")),
                            value = "medium",
                            onChange = {},
                            title = "Effort",
                        )
                    },
                )
                Spacer(Modifier.height(12.dp))
                GalleryH("Composer · attachments")
                Composer(
                    value = "",
                    onValueChange = {},
                    placeholder = "Message Rivet…",
                    connected = true,
                    sending = false,
                    sendEnabled = true,
                    canStop = false,
                    onAttach = {},
                    onSend = {},
                    onStop = {},
                    attachments = listOf(
                        PendingAttachment("1", "notes.md", AttachmentStatus.READY),
                        PendingAttachment("2", "shot.png", AttachmentStatus.UPLOADING),
                        PendingAttachment("3", "bad.bin", AttachmentStatus.FAILED),
                    ),
                )
                Spacer(Modifier.height(12.dp))
                GalleryH("Composer · disconnected")
                Composer(
                    value = "",
                    onValueChange = {},
                    placeholder = "reconnecting…",
                    connected = false,
                    sending = false,
                    sendEnabled = false,
                    canStop = false,
                    onAttach = {},
                    onSend = {},
                    onStop = {},
                )
                Spacer(Modifier.height(12.dp))
                GalleryH("Composer · sending")
                Composer(
                    value = "hello",
                    onValueChange = {},
                    placeholder = "Message Rivet…",
                    connected = true,
                    sending = true,
                    sendEnabled = false,
                    canStop = true,
                    onAttach = {},
                    onSend = {},
                    onStop = {},
                )
                Spacer(Modifier.height(12.dp))
                GalleryH("Picker sheet")
                var sel by remember { mutableStateOf("medium") }
                RivetSelect(
                    value = sel,
                    options = listOf(
                        SelectOption("low", "Low"),
                        SelectOption("medium", "Medium"),
                        SelectOption("high", "High"),
                    ),
                    onChange = { sel = it },
                    title = "Effort",
                )
                Spacer(Modifier.height(12.dp))
                GalleryH("Terminal pane")
                val termScreen = remember {
                    AnsiScreen(40, 8).also { it.feed("rivet@node:~$ ls\n".toByteArray()) }
                }
                Box(Modifier.height(120.dp).fillMaxWidth()) {
                    TerminalPane(
                        screen = termScreen,
                        rev = 0,
                        fontSp = 13,
                        status = TermStatus.Attached,
                        onResize = { _, _ -> },
                        onBytes = {},
                        ctrl = false,
                    )
                }
                Spacer(Modifier.height(12.dp))
                GalleryH("Key toolbar")
                KeyToolbar(
                    keys = listOf(
                        ToolbarKey.Label("esc", "Esc"),
                        ToolbarKey.Label("tab", "Tab"),
                        ToolbarKey.Sticky("ctrl", "Ctrl"),
                    ),
                    onKey = {},
                    latched = setOf("ctrl"),
                )
                Spacer(Modifier.height(12.dp))
                GalleryH("RivetToggle")
                var tog by remember { mutableStateOf(true) }
                RivetToggle(checked = tog, onChange = { tog = it })
                Spacer(Modifier.height(12.dp))
                GalleryH("Drawer")
            }
            Box(Modifier.height(420.dp).fillMaxWidth()) {
                RivetDrawerContent(
                    width = Dimens.drawerWidth,
                    tab = HubTab.Conversations,
                    unread = 2,
                    dots = NodeDots(agent = Dot.Up, mesh = Dot.Down, hub = Dot.Unknown),
                    currentNodeName = "ct115",
                    nodeSheet = NodeSheetModel(
                        saved = listOf(
                            NodeSheetRow(
                                id = "ct115",
                                name = "ct115",
                                denUrl = "https://192.0.2.10:5174",
                                current = true,
                                saved = true,
                                marker = "●",
                                sessions = 3,
                                removable = false,
                                online = true,
                                selectable = true,
                            ),
                        ),
                        discovered = listOf(
                            NodeSheetRow(
                                id = "peer",
                                name = "peer",
                                denUrl = "https://192.0.2.12:5174",
                                current = false,
                                saved = false,
                                marker = "○",
                                sessions = 4,
                                removable = false,
                                online = true,
                                selectable = true,
                            ),
                        ),
                        meshUnavailable = false,
                    ),
                    onClose = {},
                    onNav = {},
                    onFooter = {},
                    onUnread = {},
                    onRefreshStatus = {},
                    onSelectNode = {},
                    onRemoveNode = {},
                    onSaveDiscovered = {},
                ) {
                    Text(
                        stringResource(R.string.gallery_drawer_body_sample, 0),
                        color = colors.inkDim,
                        style = RivetType.mono11,
                        modifier = Modifier.padding(12.dp),
                    )
                }
            }
            Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                GalleryH("Node sheet")
                Text("NODES", color = colors.inkDim, style = RivetType.mono10)
                Text("● ct115", color = colors.em, style = RivetType.xs)
                Text("○ ct119  offline", color = colors.inkDim, style = RivetType.xs)
                Text("ON THE MESH", color = colors.inkDim, style = RivetType.mono10, modifier = Modifier.padding(top = 8.dp))
                Text("+ peer (4 sessions)", color = colors.inkDim, style = RivetType.xs)
            }
        }
    }
}

@Composable
private fun ShapeGallery(mode: ThemeMode) {
    val colors = RivetTheme.colors
    var field by remember { mutableStateOf("") }
    var checked by remember { mutableStateOf(true) }
    var selected by remember { mutableStateOf("M") }
    var sheetOpen by remember { mutableStateOf(false) }
    val sample = stringResource(R.string.gallery_shape_sample)
    Column(
        Modifier.fillMaxWidth().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        GalleryH(stringResource(R.string.gallery_shapes))
        SectionHeader(stringResource(R.string.gallery_shapes))
        NavRow(sample, R.drawable.lucide_message_square, active = true, onClick = {})
        Pill(sample)
        HarnessChip(sample)
        SegmentedControl(FONT_SCALE_STEPS.map(::fontScaleLabel), selected, { selected = it })
        RivetButton(sample, onClick = {})
        RivetField(field, { field = it }, sample)
        RivetToggle(checked, { checked = it })
        RivetSelect(selected, FONT_SCALE_STEPS.map { SelectOption(fontScaleLabel(it), fontScaleLabel(it)) }, { selected = it })
        Text(
            stringResource(R.string.gallery_card), color = colors.ink, style = RivetType.sm,
            modifier = Modifier.fillMaxWidth()
                .background(colors.panel, RoundedCornerShape(Shape.card))
                .border(1.dp, colors.line, RoundedCornerShape(Shape.card)).padding(16.dp),
        )
        Text(
            stringResource(R.string.gallery_bubble), color = colors.ink, style = RivetType.sm,
            modifier = Modifier.background(colors.emDim, RoundedCornerShape(Shape.bubble)).padding(16.dp),
        )
        Text(
            stringResource(R.string.gallery_tight), color = colors.inkDim, style = RivetType.mono11,
            modifier = Modifier.background(colors.panel2, RoundedCornerShape(Shape.tight)).padding(8.dp),
        )
        RivetButton(stringResource(R.string.gallery_open_sheet), onClick = { sheetOpen = true })
        GalleryH(stringResource(R.string.gallery_font_scale))
        val density = LocalDensity.current
        val uiScale = LocalUiFontScale.current
        FONT_SCALE_STEPS.forEach { step ->
            CompositionLocalProvider(
                LocalDensity provides if (uiScale == 1f) density else Density(density.density, density.fontScale / uiScale),
                LocalUiFontScale provides 1f,
            ) {
                RivetTheme(mode = mode, fontScale = step) {
                    Text(
                        stringResource(R.string.gallery_font_sample, fontScaleLabel(step)),
                        color = RivetTheme.colors.ink,
                        style = RivetType.sm,
                    )
                }
            }
        }
    }
    if (sheetOpen) {
        RivetModalSheet(onDismiss = { sheetOpen = false }) {
            SectionHeader(stringResource(R.string.gallery_shapes))
            Text(stringResource(R.string.gallery_card), color = colors.ink, style = RivetType.sm)
        }
    }
}

@Composable
private fun GalleryH(text: String) {
    Text(
        text,
        color = RivetTheme.colors.em,
        style = RivetType.mono11,
        modifier = Modifier.padding(vertical = 8.dp),
    )
}

@Preview(name = "Gallery", showBackground = true, widthDp = 412, heightDp = 915)
@Composable
fun ComponentGalleryPreview() {
    ComponentGallery()
}

@Preview(name = "Gallery · dark wrap", showBackground = true, widthDp = 412, heightDp = 915)
@Composable
fun ComponentGalleryDarkPreview() {
    RivetTheme(ThemeMode.Dark) { ComponentGallery() }
}

@Preview(name = "Gallery · light wrap", showBackground = true, widthDp = 412, heightDp = 915)
@Composable
fun ComponentGalleryLightPreview() {
    RivetTheme(ThemeMode.Light) { ComponentGallery() }
}
