package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.plane.AgentRow
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType
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
            PageHeader(onOpenDrawer = {}) {
                Text("RivetHub · $label", color = colors.em, style = RivetType.brand)
            }
            Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                GalleryH("Drawer nav · $label")
                NavRow("Conversations", R.drawable.lucide_message_square, active = true, onClick = {})
                NavRow("Memory", R.drawable.lucide_library, active = false, onClick = {}, enabled = false, comingSoon = "coming soon")
                NavRow("Settings", R.drawable.lucide_settings, active = false, onClick = {})
                Spacer(Modifier.height(12.dp))

                GalleryH("Conversation rows")
            }
            ConversationRowChrome(
                title = "active thread",
                accent = colors.em,
                onOpen = {},
                onArchive = {},
                onLong = {},
                active = true,
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
                    ),
                    onTap = {},
                    onLong = {},
                    activityActive = true,
                )
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
            }
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
