package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.plane.Dot
import io.rivethub.app.plane.NodeDots
import io.rivethub.app.plane.dotLabelKeys
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

/**
 * Drawer v2 node status strip (UX-SPEC §2 item 1): `agent` · `mesh` · `hub`
 * labelled dots. [dots] is derived by `plane/NodeStatus.kt nodeDots` from
 * state the app already holds; this composable only draws it. The whole strip
 * is one button — a tap asks for ONE refresh ([onRefresh]); nothing here runs
 * on a clock.
 */
@Composable
fun NodeStatusStrip(
    dots: NodeDots,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val cd = stringResource(R.string.node_status_cd)
    val parts = dotLabelKeys().map { key ->
        val dot = when (key) {
            "agent" -> dots.agent
            "mesh" -> dots.mesh
            else -> dots.hub
        }
        dotLabel(key) to dot
    }
    val spoken = parts.map { (label, dot) -> "$label ${dotStateLabel(dot)}" }
    val full = (listOf(cd) + spoken).joinToString(", ")
    Row(
        modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp)
            .sizeIn(minHeight = 44.dp)
            .clip(RoundedCornerShape(Radius.sm))
            .clickable(role = Role.Button, onClick = onRefresh)
            .clearAndSetSemantics {
                contentDescription = full
                role = Role.Button
            }
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        parts.forEach { (label, dot) -> StatusDot(label, dot) }
    }
}

@Composable
private fun StatusDot(label: String, dot: Dot) {
    val colors = RivetTheme.colors
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        val shape = Modifier
            .size(8.dp)
            .clip(CircleShape)
        Box(
            when (dot) {
                Dot.Up -> shape.background(colors.em)
                Dot.Down -> shape.background(colors.red)
                Dot.Unknown -> shape.border(1.dp, colors.inkDim, CircleShape)
            },
        )
        Text(label, color = colors.inkDim, style = RivetType.mono11, maxLines = 1)
    }
}

@Composable
private fun dotLabel(key: String): String = stringResource(
    when (key) {
        "agent" -> R.string.dot_agent
        "mesh" -> R.string.dot_mesh
        else -> R.string.dot_hub
    },
)

@Composable
private fun dotStateLabel(dot: Dot): String = stringResource(
    when (dot) {
        Dot.Up -> R.string.dot_state_up
        Dot.Down -> R.string.dot_state_down
        Dot.Unknown -> R.string.dot_state_unknown
    },
)
