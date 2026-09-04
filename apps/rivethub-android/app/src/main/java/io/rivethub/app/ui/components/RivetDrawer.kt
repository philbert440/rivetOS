package io.rivethub.app.ui.components

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import io.rivethub.app.R
import io.rivethub.app.plane.AgentRow
import io.rivethub.app.plane.DrawerDest
import io.rivethub.app.plane.HubTab
import io.rivethub.app.plane.NodeSheetModel
import io.rivethub.app.plane.NodeSheetRow
import io.rivethub.app.plane.accentForDrawer
import io.rivethub.app.plane.discoveredNodeLabel
import io.rivethub.app.plane.ExperimentalFlags
import io.rivethub.app.plane.drawerDestEnabled
import io.rivethub.app.plane.drawerItemActive
import io.rivethub.app.plane.drawerVisiblePrimary
import io.rivethub.app.plane.drawerVisibleSecondary
import io.rivethub.app.plane.formatUnreadBadge
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

@Composable
fun RivetDrawerContent(
    width: Dp,
    tab: HubTab,
    unread: Int,
    agents: List<AgentRow>,
    agentsCollapsed: Boolean,
    currentNodeName: String,
    nodeSheet: NodeSheetModel,
    onClose: () -> Unit,
    onNav: (DrawerDest) -> Unit,
    onUnread: () -> Unit,
    onToggleAgents: () -> Unit,
    onAddAgent: () -> Unit,
    onAgentTap: (AgentRow) -> Unit,
    onAgentStartOver: (AgentRow) -> Unit,
    onAgentNew: (AgentRow) -> Unit,
    onSelectNode: (NodeSheetRow) -> Unit,
    onRemoveNode: (NodeSheetRow) -> Unit,
    onSaveDiscovered: (NodeSheetRow) -> Unit,
    exp: ExperimentalFlags = ExperimentalFlags(),
    modifier: Modifier = Modifier,
) {
    val colors = RivetTheme.colors
    var nodeOpen by remember { mutableStateOf(false) }
    var agentSheet by remember { mutableStateOf<AgentRow?>(null) }
    Column(
        modifier
            .width(width)
            .fillMaxHeight()
            .background(colors.panel)
            .then(Modifier.drawEndBorder(colors.line)),
    ) {
        DrawerHeader(
            unread = unread,
            onToggle = onClose,
            onUnread = onUnread,
            modifier = Modifier.statusBarsPadding(),
        )
        Column(
            Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState()),
        ) {
            Column(
                Modifier.padding(horizontal = 8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                drawerVisiblePrimary(exp).forEach { dest ->
                    DrawerNavItem(dest, tab, onNav, exp)
                }
                val secondary = drawerVisibleSecondary(exp)
                if (secondary.isNotEmpty()) {
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .padding(vertical = 8.dp)
                            .height(1.dp)
                            .background(colors.line),
                    )
                    secondary.forEach { dest ->
                        DrawerNavItem(dest, tab, onNav, exp)
                    }
                }
            }
            AgentsBlock(
                agents = agents,
                collapsed = agentsCollapsed,
                onToggle = onToggleAgents,
                onAdd = onAddAgent,
                onTap = onAgentTap,
                onLong = { agentSheet = it },
            )
        }
        Column(Modifier.navigationBarsPadding()) {
            Box(Modifier.padding(horizontal = 8.dp)) {
                DrawerNavItem(DrawerDest.Settings, tab, onNav, exp)
            }
            NodeSwitcherFooter(
                currentName = currentNodeName,
                open = nodeOpen,
                onToggle = { nodeOpen = !nodeOpen },
            )
        }
    }
    if (nodeOpen) {
        NodeSheet(
            model = nodeSheet,
            onDismiss = { nodeOpen = false },
            onSelect = {
                onSelectNode(it)
                nodeOpen = false
            },
            onRemove = onRemoveNode,
            onSaveDiscovered = {
                onSaveDiscovered(it)
                nodeOpen = false
            },
        )
    }
    agentSheet?.let { row ->
        AgentActionSheet(
            name = row.name,
            onDismiss = { agentSheet = null },
            onStartOver = {
                onAgentStartOver(row)
                agentSheet = null
            },
            onNew = {
                onAgentNew(row)
                agentSheet = null
            },
        )
    }
}

@Composable
private fun DrawerNavItem(dest: DrawerDest, tab: HubTab, onNav: (DrawerDest) -> Unit, exp: ExperimentalFlags) {
    val enabled = drawerDestEnabled(dest, exp)
    val coming = if (!enabled) stringResource(R.string.cd_coming_soon) else null
    NavRow(
        label = dest.label(),
        icon = dest.icon(),
        active = drawerItemActive(dest, tab),
        onClick = { onNav(dest) },
        enabled = enabled,
        comingSoon = coming,
    )
}

@Composable
private fun DrawerDest.label(): String = stringResource(
    when (this) {
        DrawerDest.Conversations -> R.string.nav_conversations
        DrawerDest.Memory -> R.string.nav_memory
        DrawerDest.Files -> R.string.nav_files
        DrawerDest.Tasks -> R.string.nav_tasks
        DrawerDest.Workflows -> R.string.nav_workflows
        DrawerDest.Settings -> R.string.nav_settings
    },
)

private fun DrawerDest.icon(): Int = when (this) {
    DrawerDest.Conversations -> R.drawable.lucide_message_square
    DrawerDest.Memory -> R.drawable.lucide_library
    DrawerDest.Files -> R.drawable.lucide_folder
    DrawerDest.Tasks -> R.drawable.lucide_list_checks
    DrawerDest.Workflows -> R.drawable.lucide_workflow
    DrawerDest.Settings -> R.drawable.lucide_settings
}

@Composable
private fun DrawerHeader(unread: Int, onToggle: () -> Unit, onUnread: () -> Unit, modifier: Modifier = Modifier) {
    val colors = RivetTheme.colors
    val badge = formatUnreadBadge(unread)
    Row(
        modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        val closeMenu = stringResource(R.string.cd_close_drawer)
        Box(
            Modifier
                .sizeIn(minWidth = 44.dp, minHeight = 44.dp)
                .semantics {
                    contentDescription = closeMenu
                    this.role = Role.Button
                }
                .clickable(role = Role.Button, onClick = onToggle),
            contentAlignment = Alignment.Center,
        ) {
            DenBot(size = Dimens.denBotHeader, decorative = true)
        }
        Text(
            stringResource(R.string.brand_rivethub),
            color = colors.em,
            style = RivetType.brand,
            modifier = Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (badge != null) {
            Row(
                Modifier
                    .clip(RoundedCornerShape(Radius.full))
                    .border(1.dp, colors.red.copy(alpha = 0.5f), RoundedCornerShape(Radius.full))
                    .background(colors.red.copy(alpha = 0.1f))
                    .clickable(role = Role.Button, onClick = onUnread)
                    .padding(horizontal = 8.dp, vertical = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Lucide(
                    R.drawable.lucide_bell,
                    contentDescription = stringResource(R.string.unread_notifications, unread),
                    tint = colors.red,
                    modifier = Modifier.size(12.dp),
                )
                Text(badge, color = colors.red, style = RivetType.mono11)
            }
        }
    }
}

@Composable
private fun AgentsBlock(
    agents: List<AgentRow>,
    collapsed: Boolean,
    onToggle: () -> Unit,
    onAdd: () -> Unit,
    onTap: (AgentRow) -> Unit,
    onLong: (AgentRow) -> Unit,
) {
    val colors = RivetTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .drawTopBorder(colors.line)
            .padding(horizontal = 8.dp, vertical = 8.dp),
    ) {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(
                Modifier
                    .weight(1f)
                    .sizeIn(minHeight = 44.dp)
                    .clip(RoundedCornerShape(Radius.sm))
                    .clickable(role = Role.Button, onClick = onToggle)
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Lucide(R.drawable.lucide_bot, null, tint = colors.inkDim, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.agents_section), color = colors.inkDim, style = RivetType.sm)
                Spacer(Modifier.width(4.dp))
                Lucide(
                    if (collapsed) R.drawable.lucide_chevron_right else R.drawable.lucide_chevron_down,
                    contentDescription = null,
                    tint = colors.inkDim,
                    modifier = Modifier.size(12.dp),
                )
            }
            if (!collapsed) {
                Box(
                    Modifier
                        .sizeIn(minWidth = 44.dp, minHeight = 44.dp)
                        .clickable(role = Role.Button, onClick = onAdd),
                    contentAlignment = Alignment.Center,
                ) {
                    Lucide(
                        R.drawable.lucide_plus,
                        contentDescription = stringResource(R.string.add_agent),
                        tint = colors.inkDim,
                        modifier = Modifier.size(16.dp),
                    )
                }
            }
        }
        if (!collapsed) {
            if (agents.isEmpty()) {
                Text(
                    stringResource(R.string.empty_agents),
                    color = colors.inkDim,
                    style = RivetType.xs,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                )
            } else {
                agents.forEach { row ->
                    AgentRowChrome(row = row, onTap = { onTap(row) }, onLong = { onLong(row) })
                }
            }
        }
    }
}

@Composable
fun AgentRowChrome(
    row: AgentRow,
    onTap: () -> Unit,
    onLong: () -> Unit,
    modifier: Modifier = Modifier,
    activityActive: Boolean = row.pointerSessionId != null && row.online,
    activityIdle: Boolean = row.pointerSessionId != null && !row.online,
) {
    val colors = RivetTheme.colors
    val hex = accentForDrawer(row.color, row.harnessId, row.model)
    val enabled = row.online
    Row(
        modifier
            .fillMaxWidth()
            .sizeIn(minHeight = 44.dp)
            .alpha(if (enabled) 1f else 0.5f)
            .clip(RoundedCornerShape(Radius.sm))
            .combinedClickable(enabled = enabled, onClick = onTap, onLongClick = onLong)
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            Modifier
                .size(8.dp)
                .clip(CircleShape)
                .background(rivetHexColor(hex)),
        )
        Text(
            row.name,
            color = colors.ink,
            style = RivetType.xs,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        when {
            activityActive -> PulseDot(colors.em)
            activityIdle -> Box(
                Modifier
                    .size(6.dp)
                    .clip(CircleShape)
                    .background(colors.inkDim),
            )
        }
    }
}

@Composable
fun PulseDot(color: Color, modifier: Modifier = Modifier) {
    val t = rememberInfiniteTransition(label = "pulse")
    val a = t.animateFloat(
        initialValue = 0.35f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(700), RepeatMode.Reverse),
        label = "alpha",
    )
    Box(
        modifier
            .size(6.dp)
            .graphicsLayer { alpha = a.value }
            .clip(CircleShape)
            .background(color),
    )
}

@Composable
private fun NodeSwitcherFooter(
    currentName: String,
    open: Boolean,
    onToggle: () -> Unit,
) {
    val colors = RivetTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val switchLabel = stringResource(R.string.current_node, currentName)
    Row(
        Modifier
            .fillMaxWidth()
            .background(if (pressed) colors.panel2 else Color.Transparent)
            .then(Modifier.drawTopBorder(colors.line))
            .semantics {
                contentDescription = switchLabel
                this.role = Role.Button
            }
            .clickable(
                interactionSource = interaction,
                indication = null,
                role = Role.Button,
                onClick = onToggle,
            )
            .padding(horizontal = 16.dp, vertical = 12.dp)
            .sizeIn(minHeight = 44.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            currentName,
            color = colors.inkDim,
            style = RivetType.mono11,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Text(
            if (open) "▾" else "▴",
            color = colors.inkDim,
            style = RivetType.mono10,
        )
    }
}

@Composable
private fun NodeSheet(
    model: NodeSheetModel,
    onDismiss: () -> Unit,
    onSelect: (NodeSheetRow) -> Unit,
    onRemove: (NodeSheetRow) -> Unit,
    onSaveDiscovered: (NodeSheetRow) -> Unit,
) {
    val colors = RivetTheme.colors
    RivetModalSheet(onDismiss = onDismiss) {
        Text(
            stringResource(R.string.nodes_label).uppercase(),
            color = colors.inkDim,
            style = RivetType.mono10.copy(
                fontWeight = FontWeight.Normal,
                letterSpacing = 0.025.em,
            ),
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
        )
        if (model.saved.isEmpty()) {
            Text(
                stringResource(R.string.no_saved_nodes),
                color = colors.inkDim,
                style = RivetType.xs,
                modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            )
        }
        model.saved.forEach { row ->
            NodeSheetSavedRow(row, onSelect = { onSelect(row) }, onRemove = { onRemove(row) })
        }
        if (model.discovered.isNotEmpty()) {
            Text(
                stringResource(R.string.on_the_mesh).uppercase(),
                color = colors.inkDim,
                style = RivetType.mono10.copy(letterSpacing = 0.025.em),
                modifier = Modifier.padding(start = 8.dp, end = 8.dp, top = 8.dp, bottom = 4.dp),
            )
            model.discovered.forEach { row ->
                Text(
                    discoveredNodeLabel(row.name, row.sessions),
                    color = colors.inkDim,
                    style = RivetType.xs.copy(fontFamily = RivetType.mono11.fontFamily),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(Radius.sm))
                        .clickable(role = Role.Button, onClick = { onSaveDiscovered(row) })
                        .padding(horizontal = 8.dp, vertical = 6.dp),
                )
            }
        }
        if (model.meshUnavailable) {
            Text(
                stringResource(R.string.mesh_unavailable),
                color = colors.inkDim,
                style = RivetType.mono10,
                modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            )
        }
    }
}

@Composable
private fun NodeSheetSavedRow(row: NodeSheetRow, onSelect: () -> Unit, onRemove: () -> Unit) {
    val colors = RivetTheme.colors
    Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            "${row.marker} ${row.name}",
            color = if (row.current) colors.em else colors.inkDim,
            style = RivetType.xs.copy(fontFamily = RivetType.mono11.fontFamily),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .weight(1f)
                .alpha(if (row.selectable) 1f else 0.5f)
                .clip(RoundedCornerShape(Radius.sm))
                .clickable(enabled = row.selectable, role = Role.Button, onClick = onSelect)
                .padding(horizontal = 8.dp, vertical = 6.dp),
        )
        val health = stringResource(if (row.online) R.string.health_online else R.string.health_offline)
        Box(
            Modifier
                .size(6.dp)
                .clip(CircleShape)
                .background(if (row.online) colors.em else colors.inkDim)
                .semantics { contentDescription = health },
        )
        if (row.error != null) {
            Text(row.error, color = colors.red, style = RivetType.mono10, maxLines = 1)
        }
        if (row.removable) {
            val removeLabel = stringResource(R.string.remove_node, row.name)
            Box(
                Modifier
                    .sizeIn(minWidth = 44.dp, minHeight = 44.dp)
                    .semantics {
                        contentDescription = removeLabel
                        this.role = Role.Button
                    }
                    .clickable(role = Role.Button, onClick = onRemove),
                contentAlignment = Alignment.Center,
            ) {
                Text("✕", color = colors.inkDim, style = RivetType.sm)
            }
        }
    }
}

@Composable
private fun AgentActionSheet(
    name: String,
    onDismiss: () -> Unit,
    onStartOver: () -> Unit,
    onNew: () -> Unit,
) {
    val colors = RivetTheme.colors
    RivetModalSheet(onDismiss = onDismiss) {
        Text(name, color = colors.em, style = RivetType.sm.copy(fontWeight = FontWeight.SemiBold), modifier = Modifier.padding(8.dp))
        SheetAction(R.drawable.lucide_rotate_ccw, stringResource(R.string.agent_start_over), colors.ink, onStartOver)
        SheetAction(R.drawable.lucide_plus, stringResource(R.string.agent_new_conversation), colors.ink, onNew)
    }
}

@Composable
private fun SheetAction(
    icon: Int,
    label: String,
    tint: Color,
    onClick: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .sizeIn(minHeight = 44.dp)
            .clip(RoundedCornerShape(Radius.sm))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Lucide(icon, null, tint = tint, modifier = Modifier.size(16.dp))
        Text(label, color = tint, style = RivetType.sm)
    }
}

private fun Modifier.drawEndBorder(color: Color): Modifier =
    drawBehind {
        val stroke = 1.dp.toPx()
        drawLine(color, Offset(size.width - stroke / 2f, 0f), Offset(size.width - stroke / 2f, size.height), stroke)
    }

private fun Modifier.drawTopBorder(color: Color): Modifier =
    drawBehind {
        val stroke = 1.dp.toPx()
        drawLine(color, Offset(0f, stroke / 2f), Offset(size.width, stroke / 2f), stroke)
    }
