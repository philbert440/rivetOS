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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType
import io.rivethub.app.ui.theme.ThemeMode

private val GalleryRail = listOf(
    RailItem("conversations", "Convos", Icons.Outlined.ChatBubbleOutline),
    RailItem("agents", "Agents", Icons.Outlined.SmartToy),
    RailItem("nodes", "Nodes", Icons.Outlined.Dns),
    RailItem("settings", "Settings", Icons.Outlined.Settings),
    RailItem("more", "More", Icons.Outlined.MoreHoriz, enabled = false),
)

@Composable
fun ComponentGallery(modifier: Modifier = Modifier) {
    Column(
        modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .systemBarsPadding(),
    ) {
        GalleryThemeBlock("Dark", ThemeMode.Dark)
        GalleryThemeBlock("Light", ThemeMode.Light)
    }
}

@Composable
private fun GalleryThemeBlock(label: String, mode: ThemeMode) {
    RivetTheme(mode) {
        val colors = RivetTheme.colors
        var modeSel by remember { mutableStateOf("Chat") }
        var rail by remember { mutableStateOf("conversations") }
        var checked by remember { mutableStateOf(true) }
        var foldOpen by remember { mutableStateOf(false) }
        var live by remember { mutableStateOf(false) }
        Column(Modifier.fillMaxWidth().background(colors.bg).padding(bottom = Dimens.grid2)) {
            TopBar(
                title = "RivetHub · $label",
                actions = {
                    Pill("ct115", tone = PillTone.Em)
                },
                subRow = {
                    Row(
                        Modifier.padding(start = Dimens.touchTarget, end = Dimens.grid, bottom = Dimens.gridHalf),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Pill("grok-4", tone = PillTone.Dim)
                        SegmentedControl(listOf("Chat", "Terminal"), modeSel, onSelect = { modeSel = it })
                    }
                },
            )
            Column(Modifier.padding(horizontal = Dimens.grid2, vertical = Dimens.grid)) {
                SectionHeader("Type · $label")
                Spacer(Modifier.height(8.dp))
                Text("Body 15 / the desktop RivetHub app, phone-shaped.", color = colors.ink, style = RivetType.body)
                Text("Meta 13 · ink-dim", color = colors.inkDim, style = RivetType.meta)
                Text("mono terminal 12.5", color = colors.ink, style = RivetType.monoTerminal)
                Spacer(Modifier.height(Dimens.grid2))

                SectionHeader("Pills")
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Pill("dim")
                    Pill("em", tone = PillTone.Em)
                    Pill("warn", tone = PillTone.Warn)
                    Pill("sans", tone = PillTone.Dim, mono = false)
                }
                Spacer(Modifier.height(Dimens.grid2))

                SectionHeader("Toggle · button · mark")
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    RivetToggle(checked, onChange = { checked = it })
                    DenBotMark(32.dp)
                }
                Spacer(Modifier.height(8.dp))
                PrimaryButton("Primary", onClick = { })
                Spacer(Modifier.height(Dimens.grid2))

                SectionHeader("Rows")
                Spacer(Modifier.height(8.dp))
            }
            ListRow(
                title = "Pinned thread",
                meta = { Text("2m · grok-4", color = colors.inkDim, style = RivetType.meta) },
                trailing = { Pill("live", tone = PillTone.Em) },
                accent = colors.em,
                pinned = true,
                onClick = {},
                onLongClick = {},
            )
            ListRow(
                title = "Archived draft",
                meta = { Text("yesterday", color = colors.inkDim, style = RivetType.meta) },
                dim = true,
                onClick = {},
                onLongClick = {},
            )
            Column(Modifier.padding(horizontal = Dimens.grid2, vertical = Dimens.grid)) {
                SectionHeader("Transcript")
                Spacer(Modifier.height(8.dp))
                MessageBubble(Bubble.User) {
                    Text("Ship the phone-shaped hub.")
                }
                Spacer(Modifier.height(8.dp))
                MessageBubble(Bubble.Assistant) {
                    Text("On it — design tokens first.")
                }
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StreamChip("stream")
                    FoldChip("thinking", expanded = foldOpen, onClick = { foldOpen = !foldOpen })
                }
                Spacer(Modifier.height(Dimens.grid2))

                SectionHeader("Terminal keys")
                Spacer(Modifier.height(8.dp))
            }
            KeyToolbar(
                keys = listOf("Esc", "Tab", "Ctrl", "↑", "↓", "←", "→", "Paste"),
                onKey = {},
            )
            Spacer(Modifier.height(Dimens.grid))
            Composer(
                placeholder = "Message Rivet…",
                live = live,
                pickers = {
                    Pill("grok-4", tone = PillTone.Dim)
                    Pill("high", tone = PillTone.Dim)
                },
                chips = {
                    if (live) Pill("uploading.md", tone = PillTone.Warn)
                },
                onAttach = { live = !live },
                onSend = { live = true },
                onStop = { live = false },
            )
            TopBar(title = "With back", onBack = {})
            BottomRail(items = GalleryRail, active = rail, onSelect = { if (it != "more") rail = it })
        }
    }
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
