package io.rivethub.app.ui.term

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.PersistableBundle
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.exponentialDecay
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import io.rivethub.app.R
import io.rivethub.app.plane.TERM_LINE_HEIGHT
import io.rivethub.app.plane.TermKeys
import io.rivethub.app.plane.TermScroll
import io.rivethub.app.plane.TermStatus
import io.rivethub.app.plane.imeDelta
import io.rivethub.app.plane.termCellSizePx
import io.rivethub.app.plane.termColsRows
import io.rivethub.app.ui.components.KeyToolbar
import io.rivethub.app.ui.components.ToolbarKey
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.RivetFonts
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val IME_SENTINEL = "\u200B"
private const val RESIZE_DEBOUNCE_MS = 150L

/**
 * Full-bleed VT surface. Tap focuses and opens the IME; a one-finger
 * vertical drag (or two-finger drag) pages the local buffer. Horizontal
 * drags are left unconsumed. Tmux copy-mode history is out of scope.
 */
@Composable
fun TerminalPane(
    screen: AnsiScreen,
    rev: Int,
    fontSp: Int,
    status: TermStatus,
    onResize: (Int, Int) -> Unit,
    onBytes: (ByteArray) -> Unit,
    ctrl: Boolean,
    modifier: Modifier = Modifier,
) {
    val colors = RivetTheme.colors
    val density = LocalDensity.current
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val scroll = remember { TermScroll() }
    val scrollTick = remember { mutableIntStateOf(0) }
    val seenDropped = remember { mutableIntStateOf(0) }
    val seenCount = remember { mutableIntStateOf(0) }
    val lastRev = remember { mutableIntStateOf(Int.MIN_VALUE) }
    val flingJob = remember { mutableStateOf<Job?>(null) }
    val scope = rememberCoroutineScope()
    var ime by remember { mutableStateOf(TextFieldValue(IME_SENTINEL)) }
    var imeSeen by remember { mutableStateOf(IME_SENTINEL) }
    var pendingGeo by remember { mutableStateOf<Pair<Int, Int>?>(null) }
    val measurer = rememberTextMeasurer()
    val mono = TextStyle(
        fontFamily = RivetFonts.Mono,
        fontSize = fontSp.sp,
        fontWeight = FontWeight.Normal,
        lineHeight = TERM_LINE_HEIGHT.em,
    )
    val measured = remember(fontSp, density.density, density.fontScale, measurer) {
        // cellW = mean advance of 10 "M" so hinting averages out; cellH =
        // measured layout height of one line with lineHeight set above, so
        // glyph rows and the cursor rect share the same grid.
        val ten = measurer.measure(AnnotatedString("M".repeat(10)), style = mono)
        val one = measurer.measure(AnnotatedString("M"), style = mono)
        Triple(ten.size.width / 10f, one.size.height.toFloat(), one.firstBaseline)
    }
    val fallback = termCellSizePx(fontSp.toFloat(), density.density, density.fontScale)
    val cellW = measured.first.takeIf { it > 1f } ?: fallback.first
    val cellH = measured.second.takeIf { it > 1f } ?: fallback.second
    // Baseline of the mono "M" line; every run is drawn so its first baseline lands here,
    // so fallback-font glyphs (emoji, CJK) share the row's baseline instead of being centered.
    val cellBaseline = measured.third.takeIf { measured.second > 1f } ?: (cellH * 0.8f)
    val appCursor = remember(rev) { screen.applicationCursor }

    if (lastRev.intValue != rev) {
        lastRev.intValue = rev
        val d = (screen.scrollbackDroppedTotal - seenDropped.intValue).coerceAtLeast(0)
        val lc = screen.lineCount
        val grown = lc - seenCount.intValue
        if (grown < 0) {
            scroll.onResize(lc, screen.rows)
        } else if (d > 0 || grown > 0) {
            scroll.onLinesAppended(grown + d, d)
            scroll.onResize(lc, screen.rows)
        } else {
            scroll.onResize(lc, screen.rows)
        }
        seenDropped.intValue = screen.scrollbackDroppedTotal
        seenCount.intValue = lc
    }

    LaunchedEffect(pendingGeo) {
        val g = pendingGeo ?: return@LaunchedEffect
        delay(RESIZE_DEBOUNCE_MS)
        onResize(g.first, g.second)
    }

    Box(
        modifier
            .fillMaxSize()
            .background(colors.codeBg)
            .onSizeChanged { size ->
                val geo = termColsRows(size.width.toFloat(), size.height.toFloat(), cellW, cellH)
                if (geo != null) pendingGeo = geo
            }
            .pointerInput(cellH) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    // Cancel a running fling only once a NEW touch lands: awaitEachGesture
                    // re-enters before the fling coroutine has run, so cancelling above
                    // awaitFirstDown killed every fling before its first frame.
                    flingJob.value?.cancel()
                    val tracker = VelocityTracker()
                    tracker.addPosition(down.uptimeMillis, down.position)
                    var two = false
                    var moved = false
                    var axis = 0
                    var lastY = down.position.y
                    val slop = viewConfiguration.touchSlop
                    while (true) {
                        val ev = awaitPointerEvent()
                        val now = ev.changes.filter { it.pressed }
                        if (now.isEmpty()) break
                        if (now.size >= 2) {
                            now.forEach { it.consume() }
                            val y = now.map { it.position.y }.average().toFloat()
                            val x = now.map { it.position.x }.average().toFloat()
                            tracker.addPosition(now[0].uptimeMillis, Offset(x, y))
                            if (!two) {
                                two = true
                                lastY = y
                            } else {
                                val dy = y - lastY
                                if (dy != 0f) {
                                    moved = true
                                    scroll.dragBy(dy, cellH)
                                    scrollTick.intValue++
                                }
                                lastY = y
                            }
                        } else {
                            val p = now[0]
                            val fromDown = p.position - down.position
                            if (axis == 0 && fromDown.getDistance() > slop) {
                                moved = true
                                axis = if (kotlin.math.abs(fromDown.y) >= kotlin.math.abs(fromDown.x)) 1 else 2
                            }
                            if (axis == 1) {
                                p.consume()
                                tracker.addPosition(p.uptimeMillis, p.position)
                                val dy = p.position.y - lastY
                                if (dy != 0f) {
                                    scroll.dragBy(dy, cellH)
                                    scrollTick.intValue++
                                }
                                lastY = p.position.y
                            } else if (axis == 2) {
                                tracker.addPosition(p.uptimeMillis, p.position)
                            }
                        }
                    }
                    if (!two && !moved) {
                        focus.requestFocus()
                        keyboard?.show()
                    } else if (two || axis == 1) {
                        val vy = tracker.calculateVelocity().y
                        if (kotlin.math.abs(vy) >= viewConfiguration.minimumFlingVelocity) {
                            val fling = Animatable(0f)
                            flingJob.value = scope.launch {
                                var last = 0f
                                fling.snapTo(0f)
                                fling.animateDecay(vy, exponentialDecay()) {
                                    val d = value - last
                                    last = value
                                    if (d != 0f) {
                                        scroll.dragBy(d, cellH)
                                        scrollTick.intValue++
                                    }
                                }
                            }
                        }
                    }
                }
            },
    ) {
        val tick = scrollTick.intValue
        val first = scroll.visibleFirst(screen.lineCount, screen.rows)
        val lines = remember(rev, first, screen.rows, tick) { screen.snapshot(first, screen.rows) }
        Canvas(Modifier.fillMaxSize()) {
            var y = 0f
            for (line in lines) {
                for (span in line.spans) {
                    val x = span.startCol * cellW
                    val fg = spanFg(span, colors)
                    val bg = spanBg(span, colors)
                    val layout = measurer.measure(
                        AnnotatedString(span.text),
                        style = mono.copy(
                            color = fg,
                            fontWeight = if (span.bold) FontWeight.W700 else FontWeight.Normal,
                            textDecoration = if (span.underline) TextDecoration.Underline else TextDecoration.None,
                        ),
                    )
                    if (span.bg != AnsiScreen.DEFAULT_BG) {
                        drawRect(
                            color = bg,
                            topLeft = Offset(x, y),
                            size = Size(span.text.length * cellW, cellH),
                        )
                    }
                    val textY = y + (cellBaseline - layout.firstBaseline)
                    drawText(layout, topLeft = Offset(x, textY))
                }
                y += cellH
            }
        }
        BasicTextField(
            value = ime,
            onValueChange = { next ->
                // Append-only: send the characters that were ADDED since the last value we saw.
                // Never synthesize backspaces from a shrinking value — Compose state can lag a
                // fast key stream and a stale value would delete real characters in the TUI.
                // Deletion reaches the PTY as a hardware Backspace key event (password-type field).
                val cur = next.text
                val clean = imeDelta(imeSeen, cur, IME_SENTINEL)
                if (clean.isNotEmpty()) onBytes(TermKeys.ime(clean, ctrl))
                if (cur.length > 256 || !cur.startsWith(IME_SENTINEL)) {
                    imeSeen = IME_SENTINEL
                    ime = TextFieldValue(IME_SENTINEL, selection = TextRange(IME_SENTINEL.length))
                } else {
                    imeSeen = cur
                    ime = next
                }
            },
            modifier = Modifier
                .size(1.dp)
                .offset { IntOffset(0, 0) }
                .focusRequester(focus)
                .onPreviewKeyEvent { e ->
                    if (e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                    val bytes = when (e.key) {
                        Key.Enter, Key.NumPadEnter -> TermKeys.ENTER
                        Key.Backspace -> TermKeys.BACKSPACE
                        Key.Tab -> TermKeys.TAB
                        Key.Escape -> TermKeys.ESC
                        Key.DirectionUp -> TermKeys.up(appCursor)
                        Key.DirectionDown -> TermKeys.down(appCursor)
                        Key.DirectionLeft -> TermKeys.left(appCursor)
                        Key.DirectionRight -> TermKeys.right(appCursor)
                        else -> null
                    }
                    if (bytes != null) {
                        onBytes(bytes)
                        true
                    } else false
                },
            keyboardOptions = KeyboardOptions(
                // Password-type: no composition, no suggestions, no autocorrect — the terminal is the line editor.
                keyboardType = KeyboardType.Password,
                autoCorrect = false,
                imeAction = ImeAction.None,
            ),
            cursorBrush = SolidColor(Color.Transparent),
            textStyle = RivetType.monoTerminal.copy(color = Color.Transparent, fontSize = 1.sp),
        )
        val attachedLabel = stringResource(R.string.term_status_attached)
        val label = when (status) {
            TermStatus.Connecting -> stringResource(R.string.term_status_connecting)
            TermStatus.Attached -> attachedLabel
            TermStatus.Exited -> stringResource(R.string.term_status_exited)
            TermStatus.Closed -> stringResource(R.string.term_status_closed)
        }
        if (status != TermStatus.Attached) {
            Text(
                label,
                color = colors.inkDim,
                style = RivetType.monoPill,
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .background(colors.panel2)
                    .offset(x = Dimens.grid, y = Dimens.gridHalf),
            )
        }
    }
}

private fun spanFg(span: TermSpan, colors: io.rivethub.app.ui.theme.RivetColors): Color {
    val base = when (span.fg) {
        AnsiScreen.DEFAULT_FG -> colors.ink
        AnsiScreen.DEFAULT_BG -> colors.codeBg
        AnsiScreen.CURSOR -> colors.em
        else -> Color(span.fg)
    }
    return when {
        span.dim && span.fg == AnsiScreen.DEFAULT_FG -> colors.inkDim
        span.dim -> base.copy(alpha = 0.6f)
        else -> base
    }
}

private fun spanBg(span: TermSpan, colors: io.rivethub.app.ui.theme.RivetColors): Color = when (span.bg) {
    AnsiScreen.DEFAULT_BG -> colors.codeBg
    AnsiScreen.DEFAULT_FG -> colors.ink
    AnsiScreen.CURSOR -> colors.em
    else -> Color(span.bg)
}

@Composable
fun TerminalKeyBar(
    ctrl: Boolean,
    onCtrl: () -> Unit,
    onCtrlLock: () -> Unit,
    onBytes: (ByteArray) -> Unit,
    onPaste: () -> Unit,
    attachCommand: String?,
    onOpenInTerminal: () -> Unit,
    onDetach: () -> Unit,
    applicationCursor: Boolean = false,
    modifier: Modifier = Modifier,
) {
    var menu by remember { mutableStateOf(false) }
    val pasteCd = stringResource(R.string.term_paste)
    val menuCd = stringResource(R.string.cd_term_menu)
    val keys = listOf(
        ToolbarKey.Label("esc", stringResource(R.string.term_esc)),
        ToolbarKey.Label("tab", stringResource(R.string.term_tab)),
        ToolbarKey.Sticky("ctrl", stringResource(R.string.term_ctrl)),
        ToolbarKey.Label("up", stringResource(R.string.term_up)),
        ToolbarKey.Label("down", stringResource(R.string.term_down)),
        ToolbarKey.Label("left", stringResource(R.string.term_left)),
        ToolbarKey.Label("right", stringResource(R.string.term_right)),
        ToolbarKey.Label("paste", pasteCd),
        ToolbarKey.IconAction("menu", R.drawable.lucide_ellipsis, menuCd),
    )
    Box(modifier.fillMaxWidth()) {
        KeyToolbar(
            keys = keys,
            latched = if (ctrl) setOf("ctrl") else emptySet(),
            onKey = { key ->
                when (key.id) {
                    "esc" -> onBytes(TermKeys.ESC)
                    "tab" -> onBytes(TermKeys.TAB)
                    "ctrl" -> onCtrl()
                    "up" -> onBytes(TermKeys.up(applicationCursor))
                    "down" -> onBytes(TermKeys.down(applicationCursor))
                    "left" -> onBytes(TermKeys.left(applicationCursor))
                    "right" -> onBytes(TermKeys.right(applicationCursor))
                    "paste" -> onPaste()
                    "menu" -> menu = true
                }
            },
            onLongKey = { key ->
                if (key.id == "ctrl") onCtrlLock()
            },
        )
        DropdownMenu(
            expanded = menu,
            onDismissRequest = { menu = false },
            containerColor = RivetTheme.colors.panel,
        ) {
            if (attachCommand != null) {
                DropdownMenuItem(
                    text = {
                        Text(
                            stringResource(R.string.action_open_in_terminal),
                            color = RivetTheme.colors.ink,
                            style = RivetType.body,
                        )
                    },
                    onClick = {
                        menu = false
                        onOpenInTerminal()
                    },
                )
            }
            DropdownMenuItem(
                text = {
                    Text(
                        stringResource(R.string.action_detach),
                        color = RivetTheme.colors.ink,
                        style = RivetType.body,
                    )
                },
                onClick = {
                    menu = false
                    onDetach()
                },
            )
        }
    }
}

fun clipboardText(context: Context): String? {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    val clip = cm.primaryClip ?: return null
    if (clip.itemCount == 0) return null
    return clip.getItemAt(0).coerceToText(context)?.toString()
}

fun copyText(context: Context, text: String, sensitive: Boolean = false) {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    val clip = ClipData.newPlainText("terminal", text)
    if (sensitive && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        clip.description.extras = PersistableBundle().apply {
            putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
        }
    }
    cm.setPrimaryClip(clip)
}
