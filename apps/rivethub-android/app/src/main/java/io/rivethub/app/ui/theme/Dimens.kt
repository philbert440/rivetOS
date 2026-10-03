package io.rivethub.app.ui.theme

import androidx.compose.ui.unit.dp

/**
 * Desktop radius scale. The Omarchy-style redesign squares every corner
 * (theme.css `--radius*: 0`); only [full] — status dots, toggles, round
 * icon buttons — stays round, as `rounded-full` does on the web.
 *
 * [md]/[lg]/[xl]/[xxl] are kept as named 0.dp aliases so call sites that
 * still say `Radius.xl` (bubbles, cards) compile; they are not distinct sizes.
 */
object Radius {
    val sm = 0.dp
    /** Alias of [sm] — every non-[full] radius is 0.dp. */
    val md = 0.dp
    /** Alias of [sm] — every non-[full] radius is 0.dp. */
    val lg = 0.dp
    /** Alias of [sm] — every non-[full] radius is 0.dp. */
    val xl = 0.dp
    /** Alias of [sm] — every non-[full] radius is 0.dp. */
    val xxl = 0.dp
    val full = 999.dp
}

// Semantic phone shapes, shared across components.
object Shape {
    val row = Radius.sm
    val card = Radius.xl
    val bubble = Radius.xxl
    val control = Radius.md
    val tight = Radius.sm
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

    /** Drawer v2 (UX-SPEC §2): the phone drawer sheet is about 300dp. */
    val drawerWidth = 300.dp
    val pageHeader = 48.dp
    /** Brand mark text sizes: header (top bar, drawer) and the enroll / launch hero. */
    val brandHeaderSp = 20
    val brandHeroSp = 40
}
