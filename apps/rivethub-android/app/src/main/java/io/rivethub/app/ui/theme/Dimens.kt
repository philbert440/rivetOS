package io.rivethub.app.ui.theme

import androidx.compose.ui.unit.dp

/** Desktop Tailwind radius scale (`rounded` / `rounded-md` / `rounded-lg` / `rounded-xl` / `rounded-full`). */
object Radius {
    val sm = 4.dp
    val md = 6.dp
    val lg = 8.dp
    val xl = 12.dp
    val full = 999.dp
}

/** Blueprint grid step — `background-size: 32px 32px` on desktop `body`. */
object Grid {
    val step = 32.dp
}

object Dimens {
    val radius4 = Radius.sm
    val radius6 = Radius.md
    val radius8 = Radius.lg
    val radiusPill = Radius.full

    val touchTarget = 44.dp
    val bubbleMaxWidthFraction = 0.86f

    val line = 1.dp

    /** 8-dp spacing grid. Half-step (4) matches desktop `p-0.5` / `gap-0.5`. */
    val grid = 8.dp
    val gridHalf = 4.dp
    val grid2 = 16.dp
    val grid3 = 24.dp
    val grid4 = 32.dp

    val pillHeight = 20.dp
    val keyHeight = 40.dp
    val toggleTrackW = 36.dp
    val toggleTrackH = 20.dp
    val toggleKnob = 16.dp
    val bubblePadV = 10.dp
    val bubblePadH = 16.dp
    val composerPadTop = 12.dp
    val composerPadH = 16.dp
    val composerPadBottom = 10.dp

    val drawerWidth = 224.dp
    val pageHeader = 48.dp
    val denBotHeader = 28.dp
    val denBotEnroll = 64.dp
}
