package io.rivethub.app.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Desktop radius scale, per UI style ([LocalUiStyle]). Classic (the
 * Omarchy-style redesign) squares every corner (theme.css `--radius*: 0`),
 * so [md]/[lg]/[xl]/[xxl] are 0.dp there too. Material rounds them, on the
 * desktop scale: `rounded` 8 · md 10 · lg 12 · xl 16 · 2xl 20. [full] —
 * status dots, toggles, round icon buttons — is round in both, as
 * `rounded-full` is on the web.
 */
object Radius {
    val sm: Dp
        @Composable @ReadOnlyComposable get() = styled(8.dp)
    val md: Dp
        @Composable @ReadOnlyComposable get() = styled(10.dp)
    val lg: Dp
        @Composable @ReadOnlyComposable get() = styled(12.dp)
    val xl: Dp
        @Composable @ReadOnlyComposable get() = styled(16.dp)
    val xxl: Dp
        @Composable @ReadOnlyComposable get() = styled(20.dp)
    val full = 999.dp

    @Composable
    @ReadOnlyComposable
    private fun styled(material: Dp): Dp = if (LocalUiStyle.current == UiStyle.Material) material else 0.dp
}

// Semantic phone shapes, shared across components.
object Shape {
    val row: Dp
        @Composable @ReadOnlyComposable get() = Radius.sm
    val card: Dp
        @Composable @ReadOnlyComposable get() = Radius.xl
    val bubble: Dp
        @Composable @ReadOnlyComposable get() = Radius.xxl
    val control: Dp
        @Composable @ReadOnlyComposable get() = Radius.md
    val tight: Dp
        @Composable @ReadOnlyComposable get() = Radius.sm
}

object Dimens {
    val radius4: Dp
        @Composable @ReadOnlyComposable get() = Radius.sm
    val radius6: Dp
        @Composable @ReadOnlyComposable get() = Radius.md
    val radius8: Dp
        @Composable @ReadOnlyComposable get() = Radius.lg
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
